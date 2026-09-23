-- Forward-only Phase 2 extension. Phase 1 catalog and ledger remain authoritative.
alter table public.ci_product_identifiers drop constraint ci_product_identifiers_kind_check;
alter table public.ci_product_identifiers add constraint ci_product_identifiers_kind_check
 check(kind in ('REF_CURRENT','REF_LEGACY','MANUFACTURER_BARCODE','GTIN','HIBC_PCN','HIBC_PRIMARY','GS1_AI240','OTHER'));
create table public.ci_scan_events (
 id uuid primary key default gen_random_uuid(),
 warehouse_id smallint not null references public.ci_warehouses(id),
 invoice_id uuid references public.ci_invoices(id),
 invoice_line_id uuid references public.ci_invoice_lines(id),
 raw_payload text not null check (length(raw_payload) between 1 and 4096),
 symbology text not null,
 parsed_fields jsonb not null default '{}'::jsonb,
 parse_warnings jsonb not null default '[]'::jsonb,
 product_id uuid,
 actor_id uuid not null references auth.users(id),
 scanned_at timestamptz not null default now(),
 foreign key(product_id,warehouse_id) references public.ci_products(id,warehouse_id)
);
create index ci_scan_events_invoice_idx on public.ci_scan_events(invoice_id,scanned_at desc);

create table public.ci_identifier_mapping_requests (
 id uuid primary key default gen_random_uuid(),
 warehouse_id smallint not null,
 product_id uuid not null,
 identifier_kind text not null check(identifier_kind in ('GTIN','HIBC_PRIMARY','GS1_AI240','OTHER')),
 identifier_value text not null check(length(btrim(identifier_value)) > 0 and identifier_value=btrim(identifier_value)),
 raw_payload text not null,
 status text not null default 'proposed' check(status in ('proposed','approved','rejected')),
 proposed_by uuid not null references auth.users(id),
 proposed_at timestamptz not null default now(),
 decided_by uuid references auth.users(id),
 decided_at timestamptz,
 decision_reason text,
 foreign key(product_id,warehouse_id) references public.ci_products(id,warehouse_id),
 check ((status='proposed')=(decided_at is null))
);
create unique index ci_one_open_identifier_request on public.ci_identifier_mapping_requests(identifier_kind,identifier_value) where status='proposed';

create table public.ci_attachments (
 id uuid primary key default gen_random_uuid(),
 invoice_id uuid not null references public.ci_invoices(id),
 warehouse_id smallint not null references public.ci_warehouses(id),
 attachment_type text not null check(attachment_type in ('invoice_photo','delivery_note','other')),
 object_key text not null unique,
 mime_type text not null check(mime_type in ('image/jpeg','image/png','image/heic','application/pdf')),
 size_bytes bigint not null check(size_bytes between 1 and 10485760),
 uploaded_by uuid not null references auth.users(id),
 uploaded_at timestamptz not null default now()
);
create index ci_attachments_invoice_idx on public.ci_attachments(invoice_id);

create table public.ci_receipt_assessments (
 id uuid primary key default gen_random_uuid(),
 receipt_id uuid not null unique references public.ci_receipts(id),
 warehouse_id smallint not null references public.ci_warehouses(id),
 correct_product boolean,
 correct_quantity boolean,
 packaging_ok boolean,
 temperature_required boolean,
 temperature_ok boolean,
 shelf_life_ok boolean,
 documentation_complete boolean,
 delivery_discrepancy boolean,
 notes text,
 assessed_by uuid not null references auth.users(id),
 assessed_at timestamptz not null default now(),
 check(correct_product is not null and correct_quantity is not null and packaging_ok is not null
  and temperature_required is not null and (temperature_required=false or temperature_ok is not null)
  and shelf_life_ok is not null and documentation_complete is not null and delivery_discrepancy is not null)
);
create table public.ci_vendor_issues (
 id uuid primary key default gen_random_uuid(),
 vendor_id uuid not null references public.ci_vendors(id),
 warehouse_id smallint not null references public.ci_warehouses(id),
 invoice_id uuid references public.ci_invoices(id),
 description text not null check(length(btrim(description))>0),
 status text not null default 'open' check(status in ('open','resolved')),
 resolution text,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 resolved_by uuid references auth.users(id),
 resolved_at timestamptz
);
create table public.ci_vendor_evaluations (
 id uuid primary key default gen_random_uuid(),
 vendor_id uuid not null references public.ci_vendors(id),
 warehouse_id smallint not null references public.ci_warehouses(id),
 fiscal_year integer not null check(fiscal_year between 2000 and 3000),
 evidence jsonb not null default '{}'::jsonb,
 score numeric,
 decision text,
 evaluator_id uuid not null references auth.users(id),
 reviewer_id uuid references auth.users(id),
 approver_id uuid references auth.users(id),
 status text not null default 'draft' check(status in ('draft','reviewed','approved')),
 created_at timestamptz not null default now(),
 reviewed_at timestamptz,
 approved_at timestamptz,
 unique(vendor_id,warehouse_id,fiscal_year)
);
create table public.ci_reorder_settings (
 product_id uuid primary key,
 warehouse_id smallint not null,
 mode text not null check(mode in ('manual','automatic')),
 manual_rop_packs numeric(18,3) check(manual_rop_packs>=0),
 lead_time_days integer check(lead_time_days>=0),
 safety_stock numeric(18,3) check(safety_stock>=0),
 target_coverage_days integer check(target_coverage_days>0),
 order_pack_quantity numeric(18,3) check(order_pack_quantity>0),
 updated_by uuid not null references auth.users(id),
 updated_at timestamptz not null default now(),
 foreign key(product_id,warehouse_id) references public.ci_products(id,warehouse_id)
);

do $$ declare t text; begin
 foreach t in array array['ci_scan_events','ci_identifier_mapping_requests','ci_attachments','ci_receipt_assessments','ci_vendor_issues','ci_vendor_evaluations','ci_reorder_settings'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;
create policy ci_scan_read on public.ci_scan_events for select to authenticated using(ci_private.can_read(warehouse_id));
create policy ci_mapping_read on public.ci_identifier_mapping_requests for select to authenticated using(ci_private.can_read(warehouse_id));
create policy ci_attachment_read on public.ci_attachments for select to authenticated using(ci_private.can_read(warehouse_id));
create policy ci_assessment_read on public.ci_receipt_assessments for select to authenticated using(ci_private.can_read(warehouse_id));
create policy ci_vendor_issue_read on public.ci_vendor_issues for select to authenticated using(ci_private.can_read(warehouse_id));
create policy ci_vendor_eval_read on public.ci_vendor_evaluations for select to authenticated using(ci_private.can_read(warehouse_id));
create policy ci_reorder_read on public.ci_reorder_settings for select to authenticated using(ci_private.can_read(warehouse_id));
create or replace function ci_private.audit_change() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_id text;v_warehouse smallint;v_row jsonb;
begin
 v_row:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 v_id:=coalesce(v_row->>'id',v_row->>'user_id',v_row->>'product_id');
 v_warehouse:=(v_row->>'warehouse_id')::smallint;
 insert into public.ci_audit_logs(actor_id,warehouse_id,action,entity_table,entity_id,old_value,new_value)
 values(auth.uid(),v_warehouse,tg_op,tg_table_name,v_id,
  case when tg_op='INSERT' then null else to_jsonb(old) end,
  case when tg_op='DELETE' then null else to_jsonb(new) end);
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger ci_mapping_audit after insert or update on public.ci_identifier_mapping_requests for each row execute function ci_private.audit_change();
create trigger ci_reorder_audit after insert or update on public.ci_reorder_settings for each row execute function ci_private.audit_change();
create trigger ci_assessment_audit after insert on public.ci_receipt_assessments for each row execute function ci_private.audit_change();
create trigger ci_vendor_issue_audit after insert or update on public.ci_vendor_issues for each row execute function ci_private.audit_change();
create trigger ci_vendor_eval_audit after insert or update on public.ci_vendor_evaluations for each row execute function ci_private.audit_change();

create function public.ci_record_scan(p_data jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_invoice_line uuid:=nullif(p_data->>'invoice_line_id','')::uuid; v_wh smallint:=(p_data->>'warehouse_id')::smallint; v_invoice uuid:=(p_data->>'invoice_id')::uuid; v_product uuid; v_id uuid;
begin
 if v_invoice_line is not null then
  select warehouse_id,invoice_id,product_id into v_wh,v_invoice,v_product from public.ci_invoice_lines where id=v_invoice_line;
 end if;
 perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
 if v_wh is null or (v_invoice is not null and not exists(select 1 from public.ci_invoice_lines where invoice_id=v_invoice and warehouse_id=v_wh)) then raise exception 'CI_INVOICE_LINE_NOT_FOUND'; end if;
 insert into public.ci_scan_events(warehouse_id,invoice_id,invoice_line_id,raw_payload,symbology,parsed_fields,parse_warnings,product_id,actor_id)
 values(v_wh,v_invoice,v_invoice_line,p_data->>'raw_payload',coalesce(p_data->>'symbology','manual'),coalesce(p_data->'parsed_fields','{}'::jsonb),coalesce(p_data->'parse_warnings','[]'::jsonb),v_product,auth.uid()) returning id into v_id;
 return v_id;
end $$;
create function public.ci_register_invoice_attachment(p_invoice_id uuid,p_warehouse_id smallint,p_type text,p_mime text,p_size bigint)
returns table(attachment_id uuid, object_key text) language plpgsql security definer set search_path='' as $$
declare v_id uuid:=gen_random_uuid();v_key text;
begin
 perform ci_private.require_role(p_warehouse_id,array['admin','supervisor','staff']);
 if not exists(select 1 from public.ci_invoice_lines where invoice_id=p_invoice_id and warehouse_id=p_warehouse_id) then raise exception 'CI_INVOICE_WAREHOUSE_INVALID'; end if;
 v_key:=p_invoice_id::text||'/'||v_id::text;
 insert into public.ci_attachments(id,invoice_id,warehouse_id,attachment_type,object_key,mime_type,size_bytes,uploaded_by)
 values(v_id,p_invoice_id,p_warehouse_id,p_type,v_key,p_mime,p_size,auth.uid());
 return query select v_id,v_key;
end $$;
create function public.ci_delete_invoice_attachment(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare v_attachment public.ci_attachments%rowtype;
begin
 select * into v_attachment from public.ci_attachments where id=p_id for update;
 if not found then raise exception 'CI_ATTACHMENT_NOT_FOUND'; end if;
 perform ci_private.require_role(v_attachment.warehouse_id,array['admin','supervisor','staff']);
 if not exists(select 1 from public.ci_invoices where id=v_attachment.invoice_id and status='open') then raise exception 'CI_INVOICE_NOT_OPEN'; end if;
 if exists(select 1 from public.ci_receipts where invoice_id=v_attachment.invoice_id) then raise exception 'CI_ATTACHMENT_CONFIRMED_EVIDENCE'; end if;
 if v_attachment.uploaded_by<>auth.uid() and not ci_private.has_role(v_attachment.warehouse_id,array['admin','supervisor']) then raise exception 'CI_ACCESS_DENIED'; end if;
 delete from public.ci_attachments where id=p_id;
 perform ci_private.audit(v_attachment.warehouse_id,'DELETE','ci_attachments',p_id::text,'Removed before receipt confirmation');
end $$;
create function public.ci_create_vendor_issue(p_vendor_id uuid,p_warehouse_id smallint,p_invoice_id uuid,p_description text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 perform ci_private.require_role(p_warehouse_id,array['admin','supervisor','staff']);
 if p_invoice_id is not null and not exists(select 1 from public.ci_invoices i join public.ci_invoice_lines l on l.invoice_id=i.id where i.id=p_invoice_id and i.vendor_id=p_vendor_id and l.warehouse_id=p_warehouse_id) then raise exception 'CI_VENDOR_INVOICE_INVALID'; end if;
 insert into public.ci_vendor_issues(vendor_id,warehouse_id,invoice_id,description,created_by)
 values(p_vendor_id,p_warehouse_id,p_invoice_id,p_description,auth.uid()) returning id into v_id;
 return v_id;
end $$;
create function public.ci_resolve_vendor_issue(p_id uuid,p_resolution text) returns void language plpgsql security definer set search_path='' as $$
declare v_wh smallint;
begin
 select warehouse_id into v_wh from public.ci_vendor_issues where id=p_id and status='open' for update;
 perform ci_private.require_role(v_wh,array['admin','supervisor']);
 if btrim(coalesce(p_resolution,''))='' then raise exception 'CI_RESOLUTION_REQUIRED'; end if;
 update public.ci_vendor_issues set status='resolved',resolution=p_resolution,resolved_by=auth.uid(),resolved_at=now() where id=p_id;
end $$;
create function public.ci_save_vendor_evaluation(p_vendor_id uuid,p_warehouse_id smallint,p_fiscal_year integer,p_evidence jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;v_metrics jsonb;
begin
 perform ci_private.require_role(p_warehouse_id,array['admin','supervisor']);
 select to_jsonb(m) into v_metrics from public.ci_vendor_metrics m where m.vendor_id=p_vendor_id and m.warehouse_id=p_warehouse_id and m.fiscal_year=p_fiscal_year;
 insert into public.ci_vendor_evaluations(vendor_id,warehouse_id,fiscal_year,evidence,evaluator_id)
 values(p_vendor_id,p_warehouse_id,p_fiscal_year,jsonb_build_object('objective_metrics',coalesce(v_metrics,'{}'::jsonb),'notes',p_evidence->>'notes'),auth.uid())
 on conflict(vendor_id,warehouse_id,fiscal_year) do update set evidence=excluded.evidence,evaluator_id=auth.uid()
 where ci_vendor_evaluations.status='draft' returning id into v_id;
 if v_id is null then raise exception 'CI_EVALUATION_FROZEN'; end if;
 return v_id;
end $$;
create function public.ci_advance_vendor_evaluation(p_id uuid,p_step text) returns void language plpgsql security definer set search_path='' as $$
declare v_wh smallint;v_status text;
begin
 select warehouse_id,status into v_wh,v_status from public.ci_vendor_evaluations where id=p_id for update;
 perform ci_private.require_role(v_wh,array['admin','supervisor']);
 if p_step='review' and v_status='draft' then
  update public.ci_vendor_evaluations set status='reviewed',reviewer_id=auth.uid(),reviewed_at=now() where id=p_id;
 elsif p_step='approve' and v_status='reviewed' then
  update public.ci_vendor_evaluations set status='approved',approver_id=auth.uid(),approved_at=now() where id=p_id;
 else raise exception 'CI_EVALUATION_STATE_INVALID'; end if;
end $$;
create function public.ci_propose_identifier_mapping(p_product_id uuid,p_kind text,p_value text,p_raw text) returns uuid language plpgsql security definer set search_path='' as $$
declare v_wh smallint;v_id uuid;
begin
 select warehouse_id into v_wh from public.ci_products where id=p_product_id and active;
 perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
 if p_kind not in ('GTIN','HIBC_PRIMARY','GS1_AI240','OTHER') or p_value is null or btrim(p_value)<>p_value or p_raw is null or btrim(p_raw)='' then raise exception 'CI_MAPPING_INVALID'; end if;
 insert into public.ci_identifier_mapping_requests(warehouse_id,product_id,identifier_kind,identifier_value,raw_payload,proposed_by)
 values(v_wh,p_product_id,p_kind,p_value,p_raw,auth.uid()) returning id into v_id;
 return v_id;
end $$;
create function public.ci_decide_identifier_mapping(p_id uuid,p_approve boolean,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare v_request public.ci_identifier_mapping_requests%rowtype;
begin
 select * into v_request from public.ci_identifier_mapping_requests where id=p_id for update;
 if not found or v_request.status<>'proposed' then raise exception 'CI_MAPPING_NOT_OPEN'; end if;
 perform ci_private.require_role(v_request.warehouse_id,array['admin','supervisor']);
 if btrim(coalesce(p_reason,''))='' then raise exception 'CI_MAPPING_REASON_REQUIRED'; end if;
 if p_approve then
  perform pg_advisory_xact_lock(hashtextextended(v_request.identifier_value,0));
  if exists(select 1 from public.ci_product_identifiers where value=v_request.identifier_value and approved and product_id<>v_request.product_id) then raise exception 'CI_IDENTIFIER_AMBIGUOUS'; end if;
  if exists(select 1 from public.ci_product_identifiers where kind=v_request.identifier_kind and value=v_request.identifier_value and product_id<>v_request.product_id) then raise exception 'CI_IDENTIFIER_AMBIGUOUS'; end if;
  insert into public.ci_product_identifiers(product_id,warehouse_id,kind,value,source,approved)
  values(v_request.product_id,v_request.warehouse_id,v_request.identifier_kind,v_request.identifier_value,'approved_scan_mapping',true)
  on conflict (kind,value) do update set approved=true,source='approved_scan_mapping';
 end if;
 update public.ci_identifier_mapping_requests set status=case when p_approve then 'approved' else 'rejected' end,
  decided_by=auth.uid(),decided_at=now(),decision_reason=p_reason where id=p_id;
end $$;
create function public.ci_save_receipt_assessment(p_receipt_id uuid,p_data jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_wh smallint;v_id uuid;
begin
 select warehouse_id into v_wh from public.ci_receipts where id=p_receipt_id;
 perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
 insert into public.ci_receipt_assessments(receipt_id,warehouse_id,correct_product,correct_quantity,packaging_ok,temperature_required,temperature_ok,shelf_life_ok,documentation_complete,delivery_discrepancy,notes,assessed_by)
 values(p_receipt_id,v_wh,(p_data->>'correct_product')::boolean,(p_data->>'correct_quantity')::boolean,(p_data->>'packaging_ok')::boolean,(p_data->>'temperature_required')::boolean,(p_data->>'temperature_ok')::boolean,(p_data->>'shelf_life_ok')::boolean,(p_data->>'documentation_complete')::boolean,(p_data->>'delivery_discrepancy')::boolean,p_data->>'notes',auth.uid()) returning id into v_id;
 return v_id;
end $$;
create function public.ci_confirm_receipt_assessed(p_invoice_id uuid,p_lines jsonb,p_idempotency_key text,p_assessment jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb;v_item jsonb;v_receipt uuid;v_tx uuid;
begin
 if p_assessment is null or not(p_assessment ? 'correct_product') or not(p_assessment ? 'correct_quantity') or not(p_assessment ? 'packaging_ok') or not(p_assessment ? 'temperature_required') or not(p_assessment ? 'shelf_life_ok') or not(p_assessment ? 'documentation_complete') or not(p_assessment ? 'delivery_discrepancy') then
  raise exception 'CI_RECEIPT_ASSESSMENT_REQUIRED';
 end if;
 v_result:=public.ci_confirm_receipt(p_invoice_id,p_lines,p_idempotency_key);
 for v_item in select value from jsonb_array_elements(v_result) loop
  v_tx:=(v_item->>'transaction_id')::uuid;
  select receipt_id into v_receipt from public.ci_stock_transactions where id=v_tx and receipt_id is not null;
  if v_receipt is not null and not exists(select 1 from public.ci_receipt_assessments where receipt_id=v_receipt) then
   perform public.ci_save_receipt_assessment(v_receipt,p_assessment);
  end if;
 end loop;
 return v_result;
end $$;
create function public.ci_save_reorder_settings(p_product_id uuid,p_data jsonb) returns void language plpgsql security definer set search_path='' as $$
declare v_wh smallint;
begin
 select warehouse_id into v_wh from public.ci_products where id=p_product_id;
 perform ci_private.require_role(v_wh,array['admin','supervisor']);
 insert into public.ci_reorder_settings(product_id,warehouse_id,mode,manual_rop_packs,lead_time_days,safety_stock,target_coverage_days,order_pack_quantity,updated_by)
 values(p_product_id,v_wh,p_data->>'mode',(p_data->>'manual_rop_packs')::numeric,(p_data->>'lead_time_days')::integer,(p_data->>'safety_stock')::numeric,(p_data->>'target_coverage_days')::integer,(p_data->>'order_pack_quantity')::numeric,auth.uid())
 on conflict(product_id) do update set mode=excluded.mode,manual_rop_packs=excluded.manual_rop_packs,lead_time_days=excluded.lead_time_days,safety_stock=excluded.safety_stock,target_coverage_days=excluded.target_coverage_days,order_pack_quantity=excluded.order_pack_quantity,updated_by=auth.uid(),updated_at=now();
end $$;

-- Signed movement deltas remove an issue when its reversal exists. Waste is not consumption.
create view public.ci_reorder_status with (security_invoker=true) as
with consumption as (
 select l.product_id, min(tx.created_at) filter(where tx.kind='issue' and tx.purpose in ('Routine','QC','Calibration','Verification/Validation','Repeat/Troubleshooting','Other')) first_issue,
  sum(case when tx.created_at >= now()-interval '90 days' and tx.kind='issue' and tx.purpose in ('Routine','QC','Calibration','Verification/Validation','Repeat/Troubleshooting','Other') then -m.quantity_delta
           when tx.created_at >= now()-interval '90 days' and source.created_at >= now()-interval '90 days' and tx.kind='reversal' and source.kind='issue' and source.purpose in ('Routine','QC','Calibration','Verification/Validation','Repeat/Troubleshooting','Other') then -m.quantity_delta else 0 end) net_issue
 from public.ci_stock_movement_lines m join public.ci_stock_transactions tx on tx.id=m.transaction_id
 left join public.ci_stock_transactions source on source.id=tx.source_transaction_id
 join public.ci_stock_lots l on l.id=m.lot_id
 group by l.product_id
), usable as (
 select product_id,sum(balance) usable_stock from public.ci_stock_balances
 where expiry_date >= (now() at time zone 'Asia/Bangkok')::date and balance>0 group by product_id
)
select p.id product_id,p.warehouse_id,s.mode,s.manual_rop_packs,s.lead_time_days,s.safety_stock,s.target_coverage_days,s.order_pack_quantity,
 coalesce(u.usable_stock,0)::numeric(18,3) usable_stock,
 case when c.first_issue <= now()-interval '90 days' then greatest(c.net_issue,0)/90 else null end average_daily_issue,
 case when s.mode='manual' and s.manual_rop_packs is not null and s.order_pack_quantity is not null then s.manual_rop_packs*s.order_pack_quantity
      when s.mode='automatic' and s.lead_time_days is not null and s.safety_stock is not null and c.first_issue <= now()-interval '90 days' then greatest(c.net_issue,0)/90*s.lead_time_days+s.safety_stock end rop,
 case when s.mode='automatic' and c.first_issue > now()-interval '90 days' then 'ต้องมีประวัติการเบิกใช้ครบ 90 วัน'
      when s.mode='automatic' and c.first_issue is null then 'ต้องมีประวัติการเบิกใช้ครบ 90 วัน'
      when s.mode='automatic' and (s.lead_time_days is null or s.safety_stock is null) then 'ต้องตั้งค่า lead time และ safety stock'
      when s.mode='manual' and (s.manual_rop_packs is null or s.order_pack_quantity is null) then 'ต้องตั้งค่า ROP และ order pack'
      when s.mode is null then 'ต้องตั้งค่า' end missing_reason,
 case when s.target_coverage_days is not null and s.order_pack_quantity is not null and c.first_issue <= now()-interval '90 days'
      then ceil(greatest(0,greatest(c.net_issue,0)/90*s.target_coverage_days-coalesce(u.usable_stock,0))/s.order_pack_quantity)*s.order_pack_quantity end suggested_order
from public.ci_products p left join public.ci_reorder_settings s on s.product_id=p.id
left join consumption c on c.product_id=p.id left join usable u on u.product_id=p.id;
grant select on public.ci_reorder_status to authenticated;

create view public.ci_vendor_metrics with (security_invoker=true) as
with receipt_metrics as (
 select i.vendor_id,r.warehouse_id,
  (extract(year from r.received_at at time zone 'Asia/Bangkok')::integer + case when extract(month from r.received_at at time zone 'Asia/Bangkok')>=10 then 1 else 0 end) fiscal_year,
  count(*) receipt_count,count(a.id) assessed_count,count(*) filter(where a.delivery_discrepancy=true) discrepancy_count
 from public.ci_receipts r join public.ci_invoices i on i.id=r.invoice_id
 left join public.ci_receipt_assessments a on a.receipt_id=r.id
 group by i.vendor_id,r.warehouse_id,fiscal_year
), issue_metrics as (
 select vendor_id,warehouse_id,
  (extract(year from created_at at time zone 'Asia/Bangkok')::integer + case when extract(month from created_at at time zone 'Asia/Bangkok')>=10 then 1 else 0 end) fiscal_year,
  count(*) issue_count,count(*) filter(where status='open') open_issue_count
 from public.ci_vendor_issues group by vendor_id,warehouse_id,fiscal_year
)
select coalesce(r.vendor_id,i.vendor_id) vendor_id,coalesce(r.warehouse_id,i.warehouse_id) warehouse_id,
 coalesce(r.fiscal_year,i.fiscal_year) fiscal_year,coalesce(r.receipt_count,0) receipt_count,
 coalesce(r.assessed_count,0) assessed_count,coalesce(r.discrepancy_count,0) discrepancy_count,
 coalesce(i.issue_count,0) issue_count,coalesce(i.open_issue_count,0) open_issue_count
from receipt_metrics r full outer join issue_metrics i using(vendor_id,warehouse_id,fiscal_year);
grant select on public.ci_vendor_metrics to authenticated;

create index ci_transactions_created_kind_idx on public.ci_stock_transactions(created_at,kind);
create index ci_lots_product_expiry_idx on public.ci_stock_lots(product_id,expiry_date);
do $$ begin
 if to_regclass('storage.objects') is not null then
  execute $policy$create policy ci_invoice_evidence_read on storage.objects for select to authenticated using (
   bucket_id='ci-invoice-evidence' and exists(select 1 from public.ci_attachments a where a.object_key=name and ci_private.can_read(a.warehouse_id)))$policy$;
  execute $policy$create policy ci_invoice_evidence_write on storage.objects for insert to authenticated with check (
   bucket_id='ci-invoice-evidence' and exists(select 1 from public.ci_attachments a where a.object_key=name and ci_private.has_role(a.warehouse_id,array['admin','supervisor','staff']) and a.uploaded_by=auth.uid()))$policy$;
  execute $policy$create policy ci_invoice_evidence_delete on storage.objects for delete to authenticated using (
   bucket_id='ci-invoice-evidence' and exists(select 1 from public.ci_attachments a join public.ci_invoices i on i.id=a.invoice_id where a.object_key=name and i.status='open' and not exists(select 1 from public.ci_receipts r where r.invoice_id=i.id) and ci_private.has_role(a.warehouse_id,array['admin','supervisor','staff']) and (a.uploaded_by=auth.uid() or ci_private.has_role(a.warehouse_id,array['admin','supervisor']))))$policy$;
 end if;
end $$;
revoke all on function public.ci_record_scan(jsonb),public.ci_register_invoice_attachment(uuid,smallint,text,text,bigint),public.ci_delete_invoice_attachment(uuid),public.ci_create_vendor_issue(uuid,smallint,uuid,text),public.ci_resolve_vendor_issue(uuid,text),public.ci_save_vendor_evaluation(uuid,smallint,integer,jsonb),public.ci_advance_vendor_evaluation(uuid,text),public.ci_propose_identifier_mapping(uuid,text,text,text),public.ci_decide_identifier_mapping(uuid,boolean,text),public.ci_save_receipt_assessment(uuid,jsonb),public.ci_confirm_receipt_assessed(uuid,jsonb,text,jsonb),public.ci_save_reorder_settings(uuid,jsonb) from public,anon;
grant execute on function public.ci_record_scan(jsonb),public.ci_register_invoice_attachment(uuid,smallint,text,text,bigint),public.ci_delete_invoice_attachment(uuid),public.ci_create_vendor_issue(uuid,smallint,uuid,text),public.ci_resolve_vendor_issue(uuid,text),public.ci_save_vendor_evaluation(uuid,smallint,integer,jsonb),public.ci_advance_vendor_evaluation(uuid,text),public.ci_propose_identifier_mapping(uuid,text,text,text),public.ci_decide_identifier_mapping(uuid,boolean,text),public.ci_save_receipt_assessment(uuid,jsonb),public.ci_confirm_receipt_assessed(uuid,jsonb,text,jsonb),public.ci_save_reorder_settings(uuid,jsonb) to authenticated;
