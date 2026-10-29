-- CHEM-IMMUNO: transactional multi-item issues and amendable invoice quantities.
-- No historical receipt or stock transaction is rewritten.
create table public.ci_issue_groups (
 id uuid primary key default gen_random_uuid(),
 created_by uuid not null references auth.users(id),
 client_key uuid not null,
 request_hash text not null,
 purpose text not null check(purpose in ('Routine','QC','Calibration','Verification/Validation','Repeat/Troubleshooting','Waste','Other')),
 status text not null default 'pending' check(status in ('pending','picking','closed','cancelled')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 closed_at timestamptz,
 unique(created_by,client_key)
);
create index ci_issue_groups_owner_created on public.ci_issue_groups(created_by,created_at desc);

create table public.ci_issue_group_lines (
 id uuid primary key default gen_random_uuid(),
 group_id uuid not null references public.ci_issue_groups(id),
 warehouse_id smallint not null references public.ci_warehouses(id),
 product_id uuid not null,
 lot_id uuid not null,
 location_id uuid not null,
 quantity numeric(18,3) not null check(quantity>0 and quantity=trunc(quantity)),
 override_reason text,
 picked boolean not null default false,
 unique(group_id,lot_id,location_id),
 foreign key(product_id,warehouse_id) references public.ci_products(id,warehouse_id),
 foreign key(lot_id,warehouse_id) references public.ci_stock_lots(id,warehouse_id),
 foreign key(location_id,warehouse_id) references public.ci_locations(id,warehouse_id)
);
create index ci_issue_group_lines_group on public.ci_issue_group_lines(group_id);
create table public.ci_issue_group_transactions (
 group_id uuid not null references public.ci_issue_groups(id),
 warehouse_id smallint not null references public.ci_warehouses(id),
 transaction_id uuid not null unique references public.ci_stock_transactions(id),
 primary key(group_id,warehouse_id)
);

alter table public.ci_issue_groups enable row level security;
alter table public.ci_issue_group_lines enable row level security;
alter table public.ci_issue_group_transactions enable row level security;
revoke all on public.ci_issue_groups,public.ci_issue_group_lines,public.ci_issue_group_transactions from public,anon,authenticated;
grant select on public.ci_issue_groups,public.ci_issue_group_lines,public.ci_issue_group_transactions to authenticated;
create policy ci_issue_groups_owner_read on public.ci_issue_groups
 for select to authenticated using (created_by=(select auth.uid()));
create policy ci_issue_group_lines_owner_read on public.ci_issue_group_lines
 for select to authenticated using (
  exists(select 1 from public.ci_issue_groups g where g.id=group_id and g.created_by=(select auth.uid()))
 );
create policy ci_issue_group_transactions_owner_read on public.ci_issue_group_transactions
 for select to authenticated using (
  exists(select 1 from public.ci_issue_groups g where g.id=group_id and g.created_by=(select auth.uid()))
 );

create function ci_private.ci_create_issue_group(p_data jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare
 v_actor uuid:=auth.uid(); v_key uuid; v_id uuid; v_hash text:=md5(p_data::text);
 v_existing public.ci_issue_groups%rowtype;
 v_line jsonb; v_product uuid; v_lot uuid; v_location uuid; v_wh smallint;
 v_qty numeric; v_purpose text:=p_data->>'purpose';
begin
 if v_actor is null then raise exception 'CI_ACCESS_DENIED' using errcode='42501';end if;
 if p_data is null or jsonb_typeof(p_data->'lines')<>'array'
  or jsonb_array_length(p_data->'lines') not between 1 and 100
  or length(p_data::text)>100000
 then raise exception 'CI_ISSUE_GROUP_LINES_INVALID'; end if;
 v_key:=(p_data->>'client_key')::uuid;
 if v_key is null then raise exception 'CI_IDEMPOTENCY_KEY_REQUIRED';end if;
 if v_purpose is null or v_purpose not in ('Routine','QC','Calibration','Verification/Validation','Repeat/Troubleshooting','Waste','Other')
 then raise exception 'CI_ISSUE_PURPOSE_INVALID';end if;
 perform pg_advisory_xact_lock(hashtext(v_actor::text),hashtext(v_key::text));
 select * into v_existing from public.ci_issue_groups where created_by=v_actor and client_key=v_key for update;
 if found then
   if v_existing.request_hash<>v_hash then raise exception 'CI_IDEMPOTENCY_PAYLOAD_CONFLICT';end if;
   return v_existing.id;
 end if;
 -- Validate every item before inserting anything, and reject duplicate LOT/location.
 if (select count(distinct (x.value->>'lot_id',x.value->>'location_id'))
     from jsonb_array_elements(p_data->'lines') x) <> jsonb_array_length(p_data->'lines')
 then raise exception 'CI_ISSUE_DUPLICATE_LOT_LOCATION';end if;
 for v_line in select value from jsonb_array_elements(p_data->'lines') loop
   v_product:=(v_line->>'product_id')::uuid;
   v_lot:=(v_line->>'lot_id')::uuid;
   v_location:=(v_line->>'location_id')::uuid;
   v_qty:=(v_line->>'quantity')::numeric;
   select warehouse_id into v_wh from public.ci_products where id=v_product and active;
   if v_wh is null then raise exception 'CI_ISSUE_PRODUCT_INVALID';end if;
   perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
   if v_qty is null or v_qty<=0 or v_qty<>trunc(v_qty) or v_qty>1000000
     or not exists(select 1 from public.ci_stock_lots where id=v_lot and product_id=v_product and warehouse_id=v_wh)
     or not exists(select 1 from public.ci_locations where id=v_location and warehouse_id=v_wh and active)
   then raise exception 'CI_ISSUE_GROUP_LINE_INVALID';end if;
 end loop;
 insert into public.ci_issue_groups(created_by,client_key,request_hash,purpose)
 values(v_actor,v_key,v_hash,v_purpose) returning id into v_id;
 for v_line in select value from jsonb_array_elements(p_data->'lines') loop
   v_product:=(v_line->>'product_id')::uuid;
   select warehouse_id into v_wh from public.ci_products where id=v_product;
   insert into public.ci_issue_group_lines(group_id,warehouse_id,product_id,lot_id,location_id,quantity,override_reason)
   values(v_id,v_wh,v_product,(v_line->>'lot_id')::uuid,(v_line->>'location_id')::uuid,
      (v_line->>'quantity')::numeric,nullif(btrim(v_line->>'override_reason'),''));
 end loop;
 return v_id;
end $$;

create function ci_private.ci_set_issue_group_picked(p_group uuid,p_line uuid,p_picked boolean)
returns void language plpgsql security definer set search_path='' as $$
declare g public.ci_issue_groups%rowtype;
begin
 select * into g from public.ci_issue_groups where id=p_group and created_by=auth.uid() for update;
 if not found then raise exception 'CI_ISSUE_GROUP_NOT_FOUND' using errcode='42501';end if;
 if g.status not in ('pending','picking') then raise exception 'CI_ISSUE_GROUP_FINAL';end if;
 if p_picked is null then raise exception 'CI_ISSUE_PICK_INVALID';end if;
 update public.ci_issue_group_lines set picked=p_picked where id=p_line and group_id=p_group;
 if not found then raise exception 'CI_ISSUE_LINE_NOT_FOUND';end if;
 update public.ci_issue_groups set status=case when exists(
   select 1 from public.ci_issue_group_lines where group_id=p_group and picked
 ) then 'picking' else 'pending' end, updated_at=now() where id=p_group;
end $$;

create function ci_private.ci_complete_issue_group(p_group uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare
 g public.ci_issue_groups%rowtype; v_wh smallint; v_tx uuid; r record;
 v_first uuid; v_expiry date; v_balance numeric; v_hash text;
begin
 select * into g from public.ci_issue_groups where id=p_group and created_by=auth.uid() for update;
 if not found then raise exception 'CI_ISSUE_GROUP_NOT_FOUND' using errcode='42501';end if;
 if g.status='closed' then return g.id;end if;
 if g.status not in ('pending','picking') then raise exception 'CI_ISSUE_GROUP_FINAL';end if;
 if not exists(select 1 from public.ci_issue_group_lines where group_id=p_group)
  or exists(select 1 from public.ci_issue_group_lines where group_id=p_group and not picked)
 then raise exception 'CI_ISSUE_PICKING_INCOMPLETE';end if;
 perform ci_private.lock_products(array(select distinct product_id
    from public.ci_issue_group_lines where group_id=p_group order by product_id));
 -- Validate all quantities against current balances under the product locks.
 for r in select l.*,p.active from public.ci_issue_group_lines l
  join public.ci_products p on p.id=l.product_id
  where l.group_id=p_group order by l.product_id,l.lot_id,l.location_id loop
   perform ci_private.require_role(r.warehouse_id,array['admin','supervisor','staff']);
   if not r.active then raise exception 'CI_ISSUE_PRODUCT_INACTIVE';end if;
   select expiry_date into v_expiry from public.ci_stock_lots
     where id=r.lot_id and product_id=r.product_id and warehouse_id=r.warehouse_id;
   if v_expiry is null or v_expiry<current_date then raise exception 'CI_EXPIRED_OR_INVALID_LOT';end if;
   if not exists(select 1 from public.ci_locations where id=r.location_id and warehouse_id=r.warehouse_id and active)
   then raise exception 'CI_LOCATION_INVALID';end if;
   select coalesce(sum(quantity_delta),0) into v_balance from public.ci_stock_movement_lines
     where lot_id=r.lot_id and location_id=r.location_id;
   if v_balance<r.quantity then raise exception 'CI_ISSUE_STOCK_CHANGED';end if;
   select lot_id into v_first from public.ci_fefo_candidates
     where warehouse_id=r.warehouse_id and product_id=r.product_id
     order by expiry_date,lot_number,lot_id limit 1;
   if v_first is distinct from r.lot_id and nullif(btrim(r.override_reason),'') is null
   then raise exception 'CI_FEFO_OVERRIDE_REASON_REQUIRED';end if;
 end loop;
 -- All warehouses are written within the same SQL transaction: no partial stock deduction.
 for v_wh in select distinct warehouse_id from public.ci_issue_group_lines
   where group_id=p_group order by warehouse_id loop
   v_hash:=md5(p_group::text||':'||v_wh::text);
   insert into public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id,purpose,reason)
     values(v_wh,'issue',p_group::text,v_hash,auth.uid(),g.purpose,'Issue group '||p_group::text)
     returning id into v_tx;
   for r in select * from public.ci_issue_group_lines where group_id=p_group and warehouse_id=v_wh
     order by product_id,lot_id,location_id loop
     perform ci_private.add_movement(v_tx,v_wh,r.lot_id,r.location_id,-r.quantity);
   end loop;
   insert into public.ci_issue_group_transactions(group_id,warehouse_id,transaction_id)
     values(p_group,v_wh,v_tx);
   perform ci_private.audit(v_wh,'ISSUE_GROUP','ci_stock_transactions',v_tx::text);
 end loop;
 update public.ci_issue_groups set status='closed',closed_at=now(),updated_at=now() where id=p_group;
 return p_group;
end $$;

create function ci_private.ci_issue_group_now(p_data jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_group uuid;
begin
 v_group:=ci_private.ci_create_issue_group(p_data);
 update public.ci_issue_group_lines set picked=true where group_id=v_group
  and exists(select 1 from public.ci_issue_groups g where g.id=v_group and g.created_by=auth.uid() and g.status in ('pending','picking'));
 return ci_private.ci_complete_issue_group(v_group);
end $$;

create function ci_private.ci_cancel_issue_group(p_group uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.ci_issue_groups where id=p_group and created_by=auth.uid() for update;
 if not found then raise exception 'CI_ISSUE_GROUP_NOT_FOUND' using errcode='42501';end if;
 update public.ci_issue_groups set status='cancelled',updated_at=now()
 where id=p_group and status in ('pending','picking');
 if not found then raise exception 'CI_ISSUE_GROUP_FINAL';end if;
end $$;

-- Increase original invoice capacity or add new products, preserving confirmed receipt ledger.
-- Editing posted receipt quantities continues to use the existing ci_edit_receipt workflow.
create function ci_private.ci_amend_invoice(p_id uuid,p_header jsonb,p_lines jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare inv public.ci_invoices%rowtype; x jsonb; v_product uuid;
 v_wh smallint; v_qty numeric; v_id uuid; v_line_number integer;
 v_seen uuid[]:='{}'::uuid[]; v_number text; v_date date; v_po text;
begin
 select * into inv from public.ci_invoices where id=p_id for update;
 if not found or inv.status='cancelled' then raise exception 'CI_INVOICE_NOT_EDITABLE';end if;
 if auth.uid() is null then raise exception 'CI_ACCESS_DENIED' using errcode='42501';end if;
 for v_wh in select distinct warehouse_id from public.ci_invoice_lines where invoice_id=p_id order by warehouse_id loop
   perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
 end loop;
 if p_header is null or jsonb_typeof(p_header)<>'object'
  or p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)>100
 then raise exception 'CI_INVOICE_AMEND_INVALID';end if;
 v_number:=btrim(p_header->>'invoice_number');
 v_date:=(p_header->>'invoice_date')::date;
 v_po:=nullif(btrim(p_header->>'po_number'),'');
 if v_number is null or length(v_number) not between 1 and 120 or v_date is null
 or length(coalesce(v_po,''))>200 then raise exception 'CI_INVOICE_HEADER_INVALID';end if;
 if exists(select 1 from public.ci_invoices i where i.id<>p_id and i.vendor_id=inv.vendor_id
   and i.invoice_number=v_number and i.status<>'cancelled') then raise exception 'CI_INVOICE_EXISTS';end if;
 v_line_number:=(select coalesce(max(line_number),0) from public.ci_invoice_lines where invoice_id=p_id);
 for x in select value from jsonb_array_elements(p_lines) loop
   v_product:=(x->>'product_id')::uuid;
   v_qty:=(x->>'quantity')::numeric;
   select warehouse_id into v_wh from public.ci_products where id=v_product and active;
   if v_wh is null or v_qty is null or v_qty<=0 or v_qty<>trunc(v_qty) or v_qty>1000000
     or v_product=any(v_seen) then raise exception 'CI_INVOICE_AMEND_LINE_INVALID';end if;
   v_seen:=array_append(v_seen,v_product);
   perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
 end loop;
 update public.ci_invoices set invoice_number=v_number,invoice_date=v_date,po_number=v_po
   where id=p_id;
 for x in select value from jsonb_array_elements(p_lines) loop
   v_product:=(x->>'product_id')::uuid;v_qty:=(x->>'quantity')::numeric;
   select id into v_id from public.ci_invoice_lines where invoice_id=p_id and product_id=v_product
      order by line_number limit 1 for update;
   if v_id is not null then
     update public.ci_invoice_lines set ordered_quantity=ordered_quantity+v_qty where id=v_id;
   else
     v_line_number:=v_line_number+1;
     select warehouse_id into v_wh from public.ci_products where id=v_product;
     insert into public.ci_invoice_lines(invoice_id,warehouse_id,product_id,ordered_quantity,line_number)
       values(p_id,v_wh,v_product,v_qty,v_line_number);
   end if;
 end loop;
 if jsonb_array_length(p_lines)>0 then update public.ci_invoices set status='open' where id=p_id;end if;
 for v_wh in select distinct warehouse_id from public.ci_invoice_lines where invoice_id=p_id order by warehouse_id loop
  perform ci_private.audit(v_wh,'AMEND','ci_invoices',p_id::text,'Additional receiving capacity');
 end loop;
end $$;

create function public.ci_create_issue_group(p_data jsonb) returns uuid
 language sql security definer set search_path='' as $$
 select ci_private.ci_create_issue_group($1) $$;
create function public.ci_set_issue_group_picked(p_group uuid,p_line uuid,p_picked boolean) returns void
 language sql security definer set search_path='' as $$
 select ci_private.ci_set_issue_group_picked($1,$2,$3) $$;
create function public.ci_complete_issue_group(p_group uuid) returns uuid
 language sql security definer set search_path='' as $$
 select ci_private.ci_complete_issue_group($1) $$;
create function public.ci_issue_group_now(p_data jsonb) returns uuid
 language sql security definer set search_path='' as $$
 select ci_private.ci_issue_group_now($1) $$;
create function public.ci_cancel_issue_group(p_group uuid) returns void
 language sql security definer set search_path='' as $$
 select ci_private.ci_cancel_issue_group($1) $$;
create function public.ci_amend_invoice(p_id uuid,p_header jsonb,p_lines jsonb) returns void
 language sql security definer set search_path='' as $$
 select ci_private.ci_amend_invoice($1,$2,$3) $$;

revoke all on function
 ci_private.ci_create_issue_group(jsonb),ci_private.ci_set_issue_group_picked(uuid,uuid,boolean),
 ci_private.ci_complete_issue_group(uuid),ci_private.ci_issue_group_now(jsonb),
 ci_private.ci_cancel_issue_group(uuid),ci_private.ci_amend_invoice(uuid,jsonb,jsonb)
 from public,anon,authenticated;
revoke all on function
 public.ci_create_issue_group(jsonb),public.ci_set_issue_group_picked(uuid,uuid,boolean),
 public.ci_complete_issue_group(uuid),public.ci_issue_group_now(jsonb),
 public.ci_cancel_issue_group(uuid),public.ci_amend_invoice(uuid,jsonb,jsonb)
 from public,anon,authenticated;
grant execute on function
 public.ci_create_issue_group(jsonb),public.ci_set_issue_group_picked(uuid,uuid,boolean),
 public.ci_complete_issue_group(uuid),public.ci_issue_group_now(jsonb),
 public.ci_cancel_issue_group(uuid),public.ci_amend_invoice(uuid,jsonb,jsonb)
 to authenticated;
