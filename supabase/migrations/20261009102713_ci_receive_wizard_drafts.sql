-- Four-step receiving wizard drafts are distinct from signed invoices and stock.
-- Actual Invoice, CHE/IMM receipts and assessments are created atomically at final confirmation.
create table public.ci_receive_wizard_drafts (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id),
  vendor_id uuid not null references public.ci_vendors(id),
  invoice_number text not null check(length(btrim(invoice_number)) between 1 and 120),
  invoice_date date not null,
  po_number text,
  lines jsonb not null default '[]'::jsonb check(jsonb_typeof(lines)='array'),
  assessment jsonb,
  step smallint not null default 2 check(step between 1 and 4),
  confirmation_key uuid not null default gen_random_uuid(),
  status text not null default 'draft' check(status in ('draft','submitted')),
  invoice_id uuid references public.ci_invoices(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ci_receive_wizard_state check(
    (status='draft' and invoice_id is null)
    or (status='submitted' and invoice_id is not null)
  )
);
create index ci_receive_wizard_owner_latest on public.ci_receive_wizard_drafts(created_by,updated_at desc);
create unique index ci_receive_wizard_active_owner_invoice on public.ci_receive_wizard_drafts(
  created_by,vendor_id,lower(btrim(invoice_number))
) where status='draft';
alter table public.ci_receive_wizard_drafts enable row level security;
revoke all on public.ci_receive_wizard_drafts from public,anon;
grant select on public.ci_receive_wizard_drafts to authenticated;
create policy ci_receive_wizard_owner_read on public.ci_receive_wizard_drafts
 for select to authenticated using (created_by=auth.uid());

create function ci_private.ci_receive_draft_require_actor() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare v_actor uuid:=auth.uid();
begin
 if v_actor is null or not exists(
  select 1 from public.ci_user_profiles p join public.ci_user_access a on a.user_id=p.user_id
  where p.user_id=v_actor and p.active and a.active and a.role in ('staff','supervisor','admin')
 ) then raise exception 'CI_ACCESS_DENIED' using errcode='42501';end if;
 return v_actor;
end $$;

create function ci_private.ci_receive_draft_header_check(p_vendor uuid,p_number text,p_date date,p_po text)
returns void language plpgsql stable security definer set search_path='' as $$
begin
 if p_number is null or length(btrim(p_number)) not between 1 and 120 or p_date is null
 or p_vendor is null or p_po is not null and length(p_po)>200
 or not exists(select 1 from public.ci_vendors where id=p_vendor and active)
 then raise exception 'CI_RECEIVE_HEADER_INVALID';end if;
end $$;

create function ci_private.ci_create_receive_draft(p_vendor uuid,p_number text,p_date date,p_po text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_id uuid;
begin
 v_actor:=ci_private.ci_receive_draft_require_actor();
 perform ci_private.ci_receive_draft_header_check(p_vendor,p_number,p_date,p_po);
 if exists(select 1 from public.ci_invoices where vendor_id=p_vendor
   and lower(btrim(invoice_number))=lower(btrim(p_number)) and status<>'cancelled')
 then raise exception 'CI_INVOICE_EXISTS';end if;
 select id into v_id from public.ci_receive_wizard_drafts
  where created_by=v_actor and vendor_id=p_vendor
  and lower(btrim(invoice_number))=lower(btrim(p_number)) and status='draft'
  order by created_at desc limit 1;
 if v_id is not null then return v_id;end if;
 insert into public.ci_receive_wizard_drafts(created_by,vendor_id,invoice_number,invoice_date,po_number)
 values(v_actor,p_vendor,btrim(p_number),p_date,nullif(btrim(p_po),''))
 returning id into v_id;
 return v_id;
end $$;

create function ci_private.ci_save_receive_draft(p_id uuid,p_header jsonb,p_lines jsonb,p_assessment jsonb,p_step smallint)
returns void language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_row public.ci_receive_wizard_drafts%rowtype;
  v_vendor uuid; v_number text;v_date date;v_po text;
begin
 v_actor:=ci_private.ci_receive_draft_require_actor();
 select * into v_row from public.ci_receive_wizard_drafts
  where id=p_id and created_by=v_actor for update;
 if not found then raise exception 'CI_RECEIVE_DRAFT_NOT_FOUND';end if;
 if v_row.status<>'draft' then raise exception 'CI_RECEIVE_DRAFT_SUBMITTED';end if;
 if p_step not between 1 and 4 or p_header is null or jsonb_typeof(p_header)<>'object'
   or p_lines is null or jsonb_typeof(p_lines)<>'array'
   or jsonb_array_length(p_lines)>250 or length(p_lines::text)>300000
 then raise exception 'CI_RECEIVE_DRAFT_INVALID';end if;
 v_vendor:=(p_header->>'vendorId')::uuid;
 v_number:=p_header->>'invoiceNumber';
 v_date:=(p_header->>'invoiceDate')::date;
 v_po:=p_header->>'poNumber';
 perform ci_private.ci_receive_draft_header_check(v_vendor,v_number,v_date,v_po);
 if exists(select 1 from public.ci_invoices where vendor_id=v_vendor
   and lower(btrim(invoice_number))=lower(btrim(v_number)) and status<>'cancelled')
 then raise exception 'CI_INVOICE_EXISTS';end if;
 update public.ci_receive_wizard_drafts
 set vendor_id=v_vendor,invoice_number=btrim(v_number),invoice_date=v_date,
     po_number=nullif(btrim(v_po),''),lines=p_lines,assessment=p_assessment,
     step=p_step,updated_at=now()
 where id=p_id;
end $$;

create function ci_private.ci_finalize_receive_draft(p_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare
 v_actor uuid;d public.ci_receive_wizard_drafts%rowtype;
 v_line jsonb;v_pack jsonb;v_product uuid;v_wh smallint;
 v_invoice uuid;v_invoice_line uuid;v_payload jsonb:='[]'::jsonb;
 v_receiving jsonb:='[]'::jsonb;v_quant numeric;v_received numeric;
 v_seen uuid[]:='{}'::uuid[];v_count int:=0;v_packages int:=0;
begin
 v_actor:=ci_private.ci_receive_draft_require_actor();
 select * into d from public.ci_receive_wizard_drafts
   where id=p_id and created_by=v_actor for update;
 if not found then raise exception 'CI_RECEIVE_DRAFT_NOT_FOUND';end if;
 if d.status='submitted' then return d.invoice_id;end if;
 perform ci_private.ci_receive_draft_header_check(d.vendor_id,d.invoice_number,d.invoice_date,d.po_number);
 if d.lines is null or jsonb_typeof(d.lines)<>'array'
   or jsonb_array_length(d.lines) not between 1 and 250
 then raise exception 'CI_INVOICE_LINES_REQUIRED';end if;
 if d.assessment is null or jsonb_typeof(d.assessment)<>'object'
 then raise exception 'CI_RECEIPT_ASSESSMENT_REQUIRED';end if;
 -- Prevent duplicate concurrent confirmations across two drafts with the same vendor+number.
 perform pg_advisory_xact_lock(hashtext(d.vendor_id::text),hashtext(lower(btrim(d.invoice_number))));
 if exists(select 1 from public.ci_invoices i where i.vendor_id=d.vendor_id
    and lower(btrim(i.invoice_number))=lower(btrim(d.invoice_number)) and i.status<>'cancelled')
 then raise exception 'CI_INVOICE_EXISTS';end if;

 for v_line in select value from jsonb_array_elements(d.lines) loop
   if jsonb_typeof(v_line)<>'object' then raise exception 'CI_RECEIVE_LINES_INVALID';end if;
   v_product:=(v_line->>'productId')::uuid;
   v_quant:=(v_line->>'orderedQuantity')::numeric;
   if v_product is null or v_product=any(v_seen) or v_quant is null
       or v_quant<=0 or v_quant<>trunc(v_quant) or v_quant>1000000
       or jsonb_typeof(v_line->'packages')<>'array'
   then raise exception 'CI_RECEIVE_LINES_INVALID';end if;
   v_seen:=array_append(v_seen,v_product);
   select warehouse_id into v_wh from public.ci_products where id=v_product and active;
   if v_wh is null then raise exception 'CI_PRODUCT_NOT_FOUND';end if;
   perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
   v_payload:=v_payload||jsonb_build_object('product_id',v_product,'quantity',v_quant::text);
   v_received:=0;
   for v_pack in select value from jsonb_array_elements(v_line->'packages') loop
     v_count:=v_count+1;
     if v_count>500 then raise exception 'CI_RECEIVE_TOO_MANY_LOTS';end if;
     if jsonb_typeof(v_pack)<>'object' then raise exception 'CI_RECEIVE_LINES_INVALID';end if;
     if v_pack->>'lot' is null or btrim(v_pack->>'lot')=''
       or length(btrim(v_pack->>'lot'))>100
       or v_pack->>'expiry' is null or v_pack->>'locationId' is null
       or (v_pack->>'quantity')::numeric is null
       or (v_pack->>'quantity')::numeric<=0
       or (v_pack->>'quantity')::numeric<>trunc((v_pack->>'quantity')::numeric)
     then raise exception 'CI_RECEIVE_LINES_INVALID';end if;
     v_received:=v_received+(v_pack->>'quantity')::numeric;
     v_packages:=v_packages+1;
   end loop;
   if v_received>v_quant then raise exception 'CI_RECEIPT_EXCEEDS_INVOICE';end if;
 end loop;
 if v_packages=0 then raise exception 'CI_RECEIPT_LINES_REQUIRED';end if;
 -- Reuse existing validation for conditional acceptance, missing justifications, etc.
 perform ci_private.normalize_assessment(d.assessment);

 v_invoice:=ci_private.ci_create_invoice(jsonb_build_object(
  'vendor_id',d.vendor_id,'invoice_number',d.invoice_number,
  'invoice_date',d.invoice_date,'po_number',d.po_number,'lines',v_payload));
 for v_line in select value from jsonb_array_elements(d.lines) loop
   v_product:=(v_line->>'productId')::uuid;
   select id into v_invoice_line from public.ci_invoice_lines
    where invoice_id=v_invoice and product_id=v_product;
   if v_invoice_line is null then raise exception 'CI_INVOICE_LINE_NOT_FOUND';end if;
   for v_pack in select value from jsonb_array_elements(v_line->'packages') loop
     v_receiving:=v_receiving||jsonb_build_object(
       'invoice_line_id',v_invoice_line,'quantity',v_pack->>'quantity',
       'lot_number',btrim(v_pack->>'lot'),'expiry_date',v_pack->>'expiry',
       'location_id',v_pack->>'locationId');
   end loop;
 end loop;
 perform ci_private.ci_confirm_receipt_assessed(v_invoice,v_receiving,d.confirmation_key::text,d.assessment);
 update public.ci_receive_wizard_drafts
   set status='submitted',invoice_id=v_invoice,step=4,updated_at=now()
   where id=p_id;
 return v_invoice;
end $$;

create function public.ci_create_receive_draft(p_vendor uuid,p_number text,p_date date,p_po text)
returns uuid language sql security definer set search_path='' as $$
 select ci_private.ci_create_receive_draft($1,$2,$3,$4) $$;
create function public.ci_save_receive_draft(p_id uuid,p_header jsonb,p_lines jsonb,p_assessment jsonb,p_step smallint)
returns void language sql security definer set search_path='' as $$
 select ci_private.ci_save_receive_draft($1,$2,$3,$4,$5) $$;
create function public.ci_finalize_receive_draft(p_id uuid)
returns uuid language sql security definer set search_path='' as $$
 select ci_private.ci_finalize_receive_draft($1) $$;

revoke all on function ci_private.ci_receive_draft_require_actor(),
ci_private.ci_receive_draft_header_check(uuid,text,date,text),
ci_private.ci_create_receive_draft(uuid,text,date,text),
ci_private.ci_save_receive_draft(uuid,jsonb,jsonb,jsonb,smallint),
ci_private.ci_finalize_receive_draft(uuid) from public,anon,authenticated;
revoke all on function public.ci_create_receive_draft(uuid,text,date,text),
 public.ci_save_receive_draft(uuid,jsonb,jsonb,jsonb,smallint),
 public.ci_finalize_receive_draft(uuid) from public,anon;
grant execute on function public.ci_create_receive_draft(uuid,text,date,text),
 public.ci_save_receive_draft(uuid,jsonb,jsonb,jsonb,smallint),
 public.ci_finalize_receive_draft(uuid) to authenticated;
