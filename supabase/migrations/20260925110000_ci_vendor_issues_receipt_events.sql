-- Vendor evaluation port from LABCBH-Stock, phase 2: receipt event numbers, revisable receipt assessments,
-- LABCBH-style vendor issues (automatic + manual, resolve, cancel, evidence attachments).
set local search_path = '';

-- ---------------------------------------------------------------------------
-- Module settings: receipts before this date are "not required" (legacy 8-criteria assessments), as in LABCBH.
-- ---------------------------------------------------------------------------
create table public.ci_vendor_evaluation_settings (
  singleton boolean primary key default true check (singleton),
  assessment_required_from date not null,
  created_at timestamptz not null default now()
);
insert into public.ci_vendor_evaluation_settings (assessment_required_from) values ((now() at time zone 'Asia/Bangkok')::date);
alter table public.ci_vendor_evaluation_settings enable row level security;
create policy ci_vendor_eval_settings_read on public.ci_vendor_evaluation_settings for select to authenticated using (auth.uid() is not null);
grant select on public.ci_vendor_evaluation_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Receipt event numbers RC-{FY พ.ศ.}-{0001}
-- ---------------------------------------------------------------------------
create table public.ci_receipt_event_numbers (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null unique references public.ci_receipts(id),
  warehouse_id smallint not null references public.ci_warehouses(id),
  fiscal_year integer not null check (fiscal_year between 2500 and 3000),
  sequence_number integer not null check (sequence_number > 0),
  event_number text not null unique,
  assigned_retroactively boolean not null default false,
  assigned_at timestamptz not null default now(),
  unique (fiscal_year, sequence_number)
);
alter table public.ci_receipt_event_numbers enable row level security;
create policy ci_receipt_event_numbers_read on public.ci_receipt_event_numbers for select to authenticated using (ci_private.can_read(warehouse_id));
grant select on public.ci_receipt_event_numbers to authenticated;

create function ci_private.assign_receipt_event_number(p_receipt_id uuid, p_retroactive boolean) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_receipt public.ci_receipts%rowtype;
  v_fy integer;
  v_seq integer;
begin
  select * into v_receipt from public.ci_receipts where id = p_receipt_id;
  if not found then raise exception 'CI_RECEIPT_NOT_FOUND'; end if;
  if exists (select 1 from public.ci_receipt_event_numbers where receipt_id = p_receipt_id) then return; end if;
  v_fy := ci_private.fiscal_year_be((v_receipt.received_at at time zone 'Asia/Bangkok')::date);
  perform pg_advisory_xact_lock(86420, v_fy);
  select coalesce(max(sequence_number), 0) + 1 into v_seq from public.ci_receipt_event_numbers where fiscal_year = v_fy;
  insert into public.ci_receipt_event_numbers (receipt_id, warehouse_id, fiscal_year, sequence_number, event_number, assigned_retroactively)
  values (p_receipt_id, v_receipt.warehouse_id, v_fy, v_seq, 'RC-' || v_fy || '-' || lpad(v_seq::text, 4, '0'), p_retroactive);
end $$;
revoke all on function ci_private.assign_receipt_event_number(uuid, boolean) from public, anon, authenticated;

create function ci_private.receipt_event_on_insert() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform ci_private.assign_receipt_event_number(new.id, false);
  return new;
end $$;
create trigger ci_receipts_event_number after insert on public.ci_receipts for each row execute function ci_private.receipt_event_on_insert();

-- Existing receipts are numbered in the order they were received.
do $$
declare v_id uuid;
begin
  for v_id in select id from public.ci_receipts order by received_at, id loop
    perform ci_private.assign_receipt_event_number(v_id, true);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Assessments: audit columns, revisions, legacy rows normalised to the five criteria.
-- ---------------------------------------------------------------------------
alter table public.ci_receipt_assessments
  add column updated_at timestamptz,
  add column updated_by uuid references auth.users(id);
update public.ci_receipt_assessments set has_complaint = false where has_complaint is null;

create table public.ci_receipt_assessment_revisions (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.ci_receipt_assessments(id),
  warehouse_id smallint not null references public.ci_warehouses(id),
  revision_number integer not null check (revision_number > 0),
  before_state jsonb not null,
  after_state jsonb not null,
  changed_at timestamptz not null default now(),
  changed_by uuid not null references auth.users(id),
  unique (assessment_id, revision_number)
);
alter table public.ci_receipt_assessment_revisions enable row level security;
create policy ci_assessment_revision_read on public.ci_receipt_assessment_revisions for select to authenticated using (ci_private.can_read(warehouse_id));
grant select on public.ci_receipt_assessment_revisions to authenticated;

-- One place turns the posted answers into stored columns and enforces the LABCBH rules.
create function ci_private.normalize_assessment(p_data jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_product boolean := (p_data->>'correct_product')::boolean;
  v_quantity boolean := (p_data->>'correct_quantity')::boolean;
  v_packaging boolean := (p_data->>'packaging_ok')::boolean;
  v_documentation boolean := (p_data->>'documentation_complete')::boolean;
  v_temperature_required boolean := (p_data->>'temperature_required')::boolean;
  v_temperature_ok boolean := (p_data->>'temperature_ok')::boolean;
  v_complaint boolean := coalesce((p_data->>'has_complaint')::boolean, false);
  v_notes text := nullif(btrim(coalesce(p_data->>'notes', '')), '');
  v_other text := nullif(btrim(coalesce(p_data->>'other_reason_detail', '')), '');
  v_reasons text[];
  v_problem boolean;
begin
  if v_product is null or v_quantity is null or v_packaging is null or v_documentation is null or v_temperature_required is null then
    raise exception 'CI_RECEIPT_ASSESSMENT_REQUIRED';
  end if;
  if jsonb_typeof(coalesce(p_data->'reason_codes', '[]'::jsonb)) <> 'array' then raise exception 'CI_RECEIPT_REASON_INVALID'; end if;
  select coalesce(array_agg(distinct value), '{}') into v_reasons from jsonb_array_elements_text(coalesce(p_data->'reason_codes', '[]'::jsonb));
  if not v_reasons <@ array['urgent_need','no_alternative','usable_condition','vendor_will_correct','documentation_pending','consume_before_expiry','approved_exception','other']::text[] then
    raise exception 'CI_RECEIPT_REASON_INVALID';
  end if;
  if not v_temperature_required then v_temperature_ok := null;
  elsif v_temperature_ok is null then raise exception 'CI_RECEIPT_ASSESSMENT_REQUIRED'; end if;

  -- The discrepancy flag that feeds vendor metrics is derived here, never trusted from the client.
  v_problem := not v_packaging or not v_documentation or not v_product or not v_quantity
    or (v_temperature_required and not v_temperature_ok) or v_complaint;
  if v_problem then
    if cardinality(v_reasons) = 0 then raise exception 'CI_RECEIPT_REASON_REQUIRED'; end if;
    if v_notes is null then raise exception 'CI_RECEIPT_NOTE_REQUIRED'; end if;
  elsif cardinality(v_reasons) > 0 then
    raise exception 'CI_RECEIPT_REASON_NOT_ALLOWED';
  end if;
  if 'other' = any(v_reasons) and v_other is null then raise exception 'CI_RECEIPT_OTHER_REASON_REQUIRED'; end if;

  return jsonb_build_object(
    'correct_product', v_product, 'correct_quantity', v_quantity, 'packaging_ok', v_packaging,
    'temperature_required', v_temperature_required, 'temperature_ok', v_temperature_ok,
    'shelf_life_ok', (p_data->>'shelf_life_ok')::boolean, 'documentation_complete', v_documentation,
    'has_complaint', v_complaint, 'delivery_discrepancy', v_problem, 'reason_codes', to_jsonb(v_reasons),
    'other_reason_detail', case when 'other' = any(v_reasons) then v_other end, 'notes', v_notes);
end $$;
revoke all on function ci_private.normalize_assessment(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Vendor issues, LABCBH shape.
-- ---------------------------------------------------------------------------
alter table public.ci_vendor_issues drop constraint ci_vendor_issues_status_check;
alter table public.ci_vendor_issues rename column resolution to resolution_note;
alter table public.ci_vendor_issues
  add column issue_type text not null default 'other',
  add column source_kind text not null default 'manual',
  add column receipt_id uuid references public.ci_receipts(id),
  add column assessment_id uuid references public.ci_receipt_assessments(id),
  add column receipt_line_id uuid references public.ci_receipt_lines(id),
  add column invoice_line_id uuid references public.ci_invoice_lines(id),
  add column resolution_action text,
  add column cancelled_reason text,
  add column cancelled_note text,
  add column cancelled_at timestamptz,
  add column cancelled_by uuid references auth.users(id),
  add column updated_at timestamptz not null default now();
update public.ci_vendor_issues set resolution_action = 'other' where status = 'resolved';
update public.ci_vendor_issues set resolution_note = 'ไม่ระบุรายละเอียด (ข้อมูลก่อนใช้แบบฟอร์มใหม่)' where status = 'resolved' and nullif(btrim(coalesce(resolution_note, '')), '') is null;

alter table public.ci_vendor_issues
  add constraint ci_vendor_issues_status_check check (status in ('open', 'resolved', 'cancelled')),
  add constraint ci_vendor_issues_type_check check (issue_type in ('packaging_damage','documentation_discrepancy','temperature_out_of_range','complaint','quantity_discrepancy','expiry_non_compliant','item_discrepancy','other')),
  add constraint ci_vendor_issues_source_check check (
    (source_kind = 'assessment' and assessment_id is not null and receipt_line_id is null and invoice_line_id is null)
    or (source_kind = 'receipt_line' and receipt_line_id is not null and assessment_id is null and invoice_line_id is null)
    or (source_kind = 'invoice_closure' and invoice_line_id is not null and assessment_id is null and receipt_line_id is null)
    or (source_kind = 'manual' and assessment_id is null and receipt_line_id is null and invoice_line_id is null)),
  add constraint ci_vendor_issues_resolution_action_check check (resolution_action is null or resolution_action in ('vendor_replaced_goods','vendor_supplied_documents','vendor_clarified_accepted','credit_note_received','verified_no_impact','vendor_warned','other')),
  add constraint ci_vendor_issues_cancel_reason_check check (cancelled_reason is null or cancelled_reason in ('duplicate','opened_in_error','other','assessment_corrected','invoice_reopened')),
  add constraint ci_vendor_issues_state_check check (
    (status = 'open' and resolution_action is null and resolution_note is null and resolved_at is null and resolved_by is null and cancelled_reason is null and cancelled_at is null and cancelled_by is null)
    or (status = 'resolved' and resolution_action is not null and length(btrim(coalesce(resolution_note, ''))) > 0 and resolved_at is not null and resolved_by is not null and cancelled_reason is null and cancelled_at is null and cancelled_by is null)
    or (status = 'cancelled' and cancelled_reason is not null and cancelled_at is not null and cancelled_by is not null
        and ((resolution_action is null and resolution_note is null and resolved_at is null and resolved_by is null)
          or (resolution_action is not null and length(btrim(coalesce(resolution_note, ''))) > 0 and resolved_at is not null and resolved_by is not null)))),
  add constraint ci_vendor_issues_cancel_note_check check (cancelled_reason is distinct from 'other' or length(btrim(coalesce(cancelled_note, ''))) > 0);

create unique index ci_vendor_issues_assessment_key on public.ci_vendor_issues (assessment_id, issue_type) where source_kind = 'assessment' and status <> 'cancelled';
create unique index ci_vendor_issues_receipt_line_key on public.ci_vendor_issues (receipt_line_id, issue_type) where source_kind = 'receipt_line' and status <> 'cancelled';
create unique index ci_vendor_issues_invoice_line_key on public.ci_vendor_issues (invoice_line_id, issue_type) where source_kind = 'invoice_closure' and status <> 'cancelled';
create index ci_vendor_issues_vendor_idx on public.ci_vendor_issues (vendor_id, warehouse_id, created_at desc);

-- Evidence files, private bucket ci-vendor-issues.
create table public.ci_vendor_issue_attachments (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.ci_vendor_issues(id),
  warehouse_id smallint not null references public.ci_warehouses(id),
  object_key text not null unique,
  file_name text not null check (length(btrim(file_name)) between 1 and 255),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  uploaded_by uuid not null references auth.users(id),
  uploaded_at timestamptz not null default now()
);
create index ci_vendor_issue_attachments_issue_idx on public.ci_vendor_issue_attachments (issue_id);
alter table public.ci_vendor_issue_attachments enable row level security;
create policy ci_vendor_issue_attachment_read on public.ci_vendor_issue_attachments for select to authenticated using (ci_private.can_read(warehouse_id));
grant select on public.ci_vendor_issue_attachments to authenticated;

do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('ci-vendor-issues', 'ci-vendor-issues', false, 10485760, array['image/jpeg','image/png','image/webp','application/pdf'])
    on conflict (id) do nothing;
  end if;
  if to_regclass('storage.objects') is not null then
    execute $policy$create policy ci_vendor_issue_evidence_read on storage.objects for select to authenticated using (
      bucket_id = 'ci-vendor-issues' and exists (select 1 from public.ci_vendor_issue_attachments a where a.object_key = name and ci_private.can_read(a.warehouse_id)))$policy$;
    execute $policy$create policy ci_vendor_issue_evidence_write on storage.objects for insert to authenticated with check (
      bucket_id = 'ci-vendor-issues' and exists (select 1 from public.ci_vendor_issue_attachments a where a.object_key = name and a.uploaded_by = auth.uid()
        and ci_private.has_role(a.warehouse_id, array['admin','supervisor','staff'])))$policy$;
    execute $policy$create policy ci_vendor_issue_evidence_delete on storage.objects for delete to authenticated using (
      bucket_id = 'ci-vendor-issues' and not exists (select 1 from public.ci_vendor_issue_attachments a where a.object_key = name))$policy$;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Automatic issues.
-- ---------------------------------------------------------------------------
create function ci_private.reconcile_assessment_issues(p_assessment_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_a public.ci_receipt_assessments%rowtype;
  v_vendor uuid; v_invoice uuid;
  v_desired text[] := array[]::text[];
  v_type text;
  v_actor uuid := auth.uid();
begin
  select * into v_a from public.ci_receipt_assessments where id = p_assessment_id for update;
  if not found then raise exception 'CI_RECEIPT_NOT_FOUND'; end if;
  select i.vendor_id, i.id into v_vendor, v_invoice from public.ci_receipts r join public.ci_invoices i on i.id = r.invoice_id where r.id = v_a.receipt_id;
  if not v_a.packaging_ok then v_desired := array_append(v_desired, 'packaging_damage'); end if;
  if not v_a.documentation_complete then v_desired := array_append(v_desired, 'documentation_discrepancy'); end if;
  if not (v_a.correct_product and v_a.correct_quantity) then v_desired := array_append(v_desired, 'item_discrepancy'); end if;
  if v_a.temperature_required and v_a.temperature_ok is false then v_desired := array_append(v_desired, 'temperature_out_of_range'); end if;
  if coalesce(v_a.has_complaint, false) then v_desired := array_append(v_desired, 'complaint'); end if;

  foreach v_type in array v_desired loop
    insert into public.ci_vendor_issues (vendor_id, warehouse_id, invoice_id, receipt_id, description, issue_type, source_kind, assessment_id, created_by)
    values (v_vendor, v_a.warehouse_id, v_invoice, v_a.receipt_id, coalesce(v_a.notes, 'พบความผิดปกติจากผลตรวจรับ'), v_type, 'assessment', v_a.id, coalesce(v_actor, v_a.assessed_by))
    on conflict (assessment_id, issue_type) where source_kind = 'assessment' and status <> 'cancelled' do nothing;
  end loop;

  update public.ci_vendor_issues set status = 'cancelled', cancelled_reason = 'assessment_corrected',
    cancelled_note = 'ยกเลิกอัตโนมัติหลังแก้ไขผลตรวจรับ', cancelled_at = now(), cancelled_by = coalesce(v_actor, v_a.assessed_by), updated_at = now()
  where source_kind = 'assessment' and assessment_id = p_assessment_id and status <> 'cancelled' and not (issue_type = any(v_desired));
end $$;
revoke all on function ci_private.reconcile_assessment_issues(uuid) from public, anon, authenticated;

-- LOT expiry earlier than the receipt date is an expiry-compliance issue for the vendor (LABCBH expiry_non_compliant).
create function ci_private.reconcile_receipt_line_issues(p_receipt_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_r public.ci_receipts%rowtype;
  v_vendor uuid; v_from date;
  v_line record;
begin
  select * into v_r from public.ci_receipts where id = p_receipt_id;
  if not found then return; end if;
  select assessment_required_from into v_from from public.ci_vendor_evaluation_settings;
  if (v_r.received_at at time zone 'Asia/Bangkok')::date < v_from then return; end if;
  select vendor_id into v_vendor from public.ci_invoices where id = v_r.invoice_id;
  for v_line in
    select rl.id as line_id, lot.lot_number, lot.expiry_date, p.product_code
    from public.ci_receipt_lines rl join public.ci_stock_lots lot on lot.id = rl.lot_id join public.ci_products p on p.id = lot.product_id
    where rl.receipt_id = p_receipt_id and lot.expiry_date < (v_r.received_at at time zone 'Asia/Bangkok')::date
  loop
    insert into public.ci_vendor_issues (vendor_id, warehouse_id, invoice_id, receipt_id, description, issue_type, source_kind, receipt_line_id, created_by)
    values (v_vendor, v_r.warehouse_id, v_r.invoice_id, p_receipt_id,
            'สินค้าหมดอายุก่อนวันรับ: ' || v_line.product_code || ' LOT ' || v_line.lot_number || ' หมดอายุ ' || v_line.expiry_date::text,
            'expiry_non_compliant', 'receipt_line', v_line.line_id, coalesce(auth.uid(), v_r.received_by))
    on conflict (receipt_line_id, issue_type) where source_kind = 'receipt_line' and status <> 'cancelled' do nothing;
  end loop;
end $$;
revoke all on function ci_private.reconcile_receipt_line_issues(uuid) from public, anon, authenticated;

-- Saving the assessment also opens the issues its answers imply and checks LOT expiry for the same receipt.
create or replace function ci_private.ci_save_receipt_assessment(p_receipt_id uuid, p_data jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_wh smallint; v_id uuid; v jsonb;
begin
  select warehouse_id into v_wh from public.ci_receipts where id = p_receipt_id;
  perform ci_private.require_role(v_wh, array['admin','supervisor','staff']);
  v := ci_private.normalize_assessment(p_data);
  insert into public.ci_receipt_assessments(receipt_id, warehouse_id, correct_product, correct_quantity, packaging_ok, temperature_required, temperature_ok,
    shelf_life_ok, documentation_complete, delivery_discrepancy, notes, has_complaint, reason_codes, other_reason_detail, assessed_by)
  values (p_receipt_id, v_wh, (v->>'correct_product')::boolean, (v->>'correct_quantity')::boolean, (v->>'packaging_ok')::boolean, (v->>'temperature_required')::boolean,
    (v->>'temperature_ok')::boolean, (v->>'shelf_life_ok')::boolean, (v->>'documentation_complete')::boolean, (v->>'delivery_discrepancy')::boolean, v->>'notes',
    (v->>'has_complaint')::boolean, array(select jsonb_array_elements_text(v->'reason_codes')), v->>'other_reason_detail', auth.uid())
  returning id into v_id;
  perform ci_private.reconcile_assessment_issues(v_id);
  perform ci_private.reconcile_receipt_line_issues(p_receipt_id);
  return v_id;
end $$;

create function ci_private.ci_update_receipt_assessment(p_assessment_id uuid, p_data jsonb) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_old public.ci_receipt_assessments%rowtype;
  v_new public.ci_receipt_assessments%rowtype;
  v jsonb;
  v_actor uuid;
  v_rev integer;
begin
  select * into v_old from public.ci_receipt_assessments where id = p_assessment_id for update;
  if not found then raise exception 'CI_RECEIPT_ASSESSMENT_NOT_FOUND'; end if;
  v_actor := ci_private.require_role(v_old.warehouse_id, array['admin','supervisor']);
  v := ci_private.normalize_assessment(p_data);
  update public.ci_receipt_assessments set
    correct_product = (v->>'correct_product')::boolean, correct_quantity = (v->>'correct_quantity')::boolean, packaging_ok = (v->>'packaging_ok')::boolean,
    temperature_required = (v->>'temperature_required')::boolean, temperature_ok = (v->>'temperature_ok')::boolean,
    documentation_complete = (v->>'documentation_complete')::boolean, delivery_discrepancy = (v->>'delivery_discrepancy')::boolean,
    notes = v->>'notes', has_complaint = (v->>'has_complaint')::boolean, reason_codes = array(select jsonb_array_elements_text(v->'reason_codes')),
    other_reason_detail = v->>'other_reason_detail', updated_at = clock_timestamp(), updated_by = v_actor
  where id = p_assessment_id returning * into v_new;
  if to_jsonb(v_old) - 'updated_at' - 'updated_by' = to_jsonb(v_new) - 'updated_at' - 'updated_by' then
    raise exception 'CI_RECEIPT_ASSESSMENT_UNCHANGED';
  end if;
  select coalesce(max(revision_number), 0) + 1 into v_rev from public.ci_receipt_assessment_revisions where assessment_id = p_assessment_id;
  insert into public.ci_receipt_assessment_revisions (assessment_id, warehouse_id, revision_number, before_state, after_state, changed_by)
  values (p_assessment_id, v_old.warehouse_id, v_rev, to_jsonb(v_old), to_jsonb(v_new), v_actor);
  perform ci_private.reconcile_assessment_issues(p_assessment_id);
  perform ci_private.audit(v_old.warehouse_id, 'REVISE', 'ci_receipt_assessments', p_assessment_id::text);
end $$;

-- Closing an invoice short opens a "quantity discrepancy" per outstanding line; reopening it cancels them.
create or replace function ci_private.ci_close_invoice_short(p_invoice_id uuid, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_wh smallint;
  v_vendor uuid;
  v_line record;
begin
  perform ci_private.require_any_role(array['admin','supervisor']);
  select vendor_id into v_vendor from public.ci_invoices where id = p_invoice_id for update;
  if not found then raise exception 'CI_INVOICE_NOT_FOUND'; end if;
  if not exists (select 1 from public.ci_invoices where id = p_invoice_id and status = 'open') then raise exception 'CI_INVOICE_NOT_OPEN'; end if;
  if v_reason is null then raise exception 'CI_REASON_REQUIRED'; end if;
  if not exists (select 1 from public.ci_invoice_line_progress where invoice_id = p_invoice_id and remaining_quantity > 0) then raise exception 'CI_INVOICE_NOTHING_OUTSTANDING'; end if;
  for v_wh in select distinct warehouse_id from public.ci_invoice_line_progress where invoice_id = p_invoice_id and remaining_quantity > 0 loop
    perform ci_private.require_role(v_wh, array['admin','supervisor']);
  end loop;
  update public.ci_invoices set status = 'closed_short', closed_short_at = clock_timestamp(), closed_short_by = auth.uid(), closed_short_reason = v_reason where id = p_invoice_id;
  for v_line in
    select pr.invoice_line_id, pr.warehouse_id, pr.ordered_quantity, pr.received_quantity, pr.remaining_quantity, p.product_code
    from public.ci_invoice_line_progress pr join public.ci_products p on p.id = pr.product_id
    where pr.invoice_id = p_invoice_id and pr.remaining_quantity > 0
  loop
    insert into public.ci_vendor_issues (vendor_id, warehouse_id, invoice_id, description, issue_type, source_kind, invoice_line_id, created_by)
    values (v_vendor, v_line.warehouse_id, p_invoice_id,
            'จำนวนส่งมอบไม่ครบ: ' || v_line.product_code || ' สั่ง ' || trim_scale(v_line.ordered_quantity)::text || ' รับ ' || trim_scale(v_line.received_quantity)::text || ' ค้าง ' || trim_scale(v_line.remaining_quantity)::text || ' · ' || v_reason,
            'quantity_discrepancy', 'invoice_closure', v_line.invoice_line_id, auth.uid())
    on conflict (invoice_line_id, issue_type) where source_kind = 'invoice_closure' and status <> 'cancelled' do nothing;
  end loop;
  for v_wh in select distinct warehouse_id from public.ci_invoice_lines where invoice_id = p_invoice_id loop
    perform ci_private.audit(v_wh, 'CLOSE_SHORT', 'ci_invoices', p_invoice_id::text, v_reason);
  end loop;
end $$;

create function ci_private.cancel_closure_issues_on_reopen() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'closed_short' and new.status <> 'closed_short' then
    update public.ci_vendor_issues set status = 'cancelled', cancelled_reason = 'invoice_reopened', cancelled_note = 'ยกเลิกอัตโนมัติเมื่อ Invoice ถูกเปิดใหม่',
      cancelled_at = now(), cancelled_by = coalesce(auth.uid(), old.closed_short_by), updated_at = now()
    where source_kind = 'invoice_closure' and invoice_id = new.id and status <> 'cancelled';
  end if;
  return new;
end $$;
create trigger ci_invoices_cancel_closure_issues after update of status on public.ci_invoices
  for each row execute function ci_private.cancel_closure_issues_on_reopen();

-- ---------------------------------------------------------------------------
-- Manual issue RPCs (old name-only ones are replaced).
-- ---------------------------------------------------------------------------
drop function public.ci_create_vendor_issue(uuid, smallint, uuid, text);
drop function ci_private.ci_create_vendor_issue(uuid, smallint, uuid, text);
drop function public.ci_resolve_vendor_issue(uuid, text);
drop function ci_private.ci_resolve_vendor_issue(uuid, text);

create function ci_private.ci_open_vendor_issue(p_vendor_id uuid, p_warehouse_id smallint, p_issue_type text, p_description text, p_invoice_id uuid default null) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_description text := nullif(btrim(coalesce(p_description, '')), '');
begin
  perform ci_private.require_role(p_warehouse_id, array['admin','supervisor','staff']);
  if v_description is null then raise exception 'CI_ISSUE_DESCRIPTION_REQUIRED'; end if;
  if not exists (select 1 from public.ci_vendors where id = p_vendor_id) then raise exception 'CI_VENDOR_NOT_FOUND'; end if;
  if p_invoice_id is not null and not exists (
    select 1 from public.ci_invoices i join public.ci_invoice_lines l on l.invoice_id = i.id where i.id = p_invoice_id and i.vendor_id = p_vendor_id and l.warehouse_id = p_warehouse_id
  ) then raise exception 'CI_VENDOR_INVOICE_INVALID'; end if;
  insert into public.ci_vendor_issues (vendor_id, warehouse_id, invoice_id, description, issue_type, source_kind, created_by)
  values (p_vendor_id, p_warehouse_id, p_invoice_id, v_description, p_issue_type, 'manual', auth.uid()) returning id into v_id;
  return v_id;
end $$;

create function ci_private.ci_resolve_vendor_issue(p_id uuid, p_action text, p_note text) returns void language plpgsql security definer set search_path = '' as $$
declare v_issue public.ci_vendor_issues%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into v_issue from public.ci_vendor_issues where id = p_id for update;
  if not found then raise exception 'CI_ISSUE_NOT_FOUND'; end if;
  perform ci_private.require_role(v_issue.warehouse_id, array['admin','supervisor']);
  if p_action is null or v_note is null then raise exception 'CI_ISSUE_RESOLUTION_REQUIRED'; end if;
  if v_issue.status <> 'open' then raise exception 'CI_ISSUE_NOT_OPEN'; end if;
  update public.ci_vendor_issues set status = 'resolved', resolution_action = p_action, resolution_note = v_note, resolved_at = now(), resolved_by = auth.uid(), updated_at = now() where id = p_id;
end $$;

create function ci_private.ci_cancel_vendor_issue(p_id uuid, p_reason text, p_note text) returns void language plpgsql security definer set search_path = '' as $$
declare v_issue public.ci_vendor_issues%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into v_issue from public.ci_vendor_issues where id = p_id for update;
  if not found then raise exception 'CI_ISSUE_NOT_FOUND'; end if;
  perform ci_private.require_role(v_issue.warehouse_id, array['admin']);
  if p_reason not in ('duplicate','opened_in_error','other') then raise exception 'CI_ISSUE_CANCEL_REASON_INVALID'; end if;
  if p_reason = 'other' and v_note is null then raise exception 'CI_ISSUE_CANCEL_NOTE_REQUIRED'; end if;
  if v_issue.status = 'cancelled' then raise exception 'CI_ISSUE_ALREADY_CANCELLED'; end if;
  update public.ci_vendor_issues set status = 'cancelled', cancelled_reason = p_reason, cancelled_note = v_note, cancelled_at = now(), cancelled_by = auth.uid(), updated_at = now() where id = p_id;
end $$;

create function ci_private.ci_register_vendor_issue_attachment(p_issue_id uuid, p_file_name text, p_mime text, p_size bigint) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_issue public.ci_vendor_issues%rowtype; v_id uuid := gen_random_uuid(); v_key text;
begin
  select * into v_issue from public.ci_vendor_issues where id = p_issue_id;
  if not found then raise exception 'CI_ISSUE_NOT_FOUND'; end if;
  perform ci_private.require_role(v_issue.warehouse_id, array['admin','supervisor','staff']);
  -- Evidence is gathered while the issue is being worked; a closed issue's evidence is a record and cannot be added to or removed.
  if v_issue.status <> 'open' then raise exception 'CI_ISSUE_NOT_OPEN'; end if;
  v_key := p_issue_id::text || '/' || v_id::text;
  insert into public.ci_vendor_issue_attachments (id, issue_id, warehouse_id, object_key, file_name, mime_type, size_bytes, uploaded_by)
  values (v_id, p_issue_id, v_issue.warehouse_id, v_key, btrim(p_file_name), p_mime, p_size, auth.uid());
  return jsonb_build_object('attachment_id', v_id, 'object_key', v_key);
end $$;

-- Undo for an upload that failed after registering, or a wrong file; the uploader or a supervisor may remove it while the issue is open.
create function ci_private.ci_remove_vendor_issue_attachment(p_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v_att public.ci_vendor_issue_attachments%rowtype;
begin
  select * into v_att from public.ci_vendor_issue_attachments where id = p_id for update;
  if not found then raise exception 'CI_ATTACHMENT_NOT_FOUND'; end if;
  perform ci_private.require_role(v_att.warehouse_id, array['admin','supervisor','staff']);
  if v_att.uploaded_by <> auth.uid() and not ci_private.has_role(v_att.warehouse_id, array['admin','supervisor']) then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  if not exists (select 1 from public.ci_vendor_issues where id = v_att.issue_id and status = 'open') then raise exception 'CI_ISSUE_NOT_OPEN'; end if;
  delete from public.ci_vendor_issue_attachments where id = p_id;
  perform ci_private.audit(v_att.warehouse_id, 'DELETE', 'ci_vendor_issue_attachments', p_id::text);
end $$;

-- Cancelled issues are history, not workload.
create or replace view public.ci_vendor_metrics with (security_invoker = true) as
with receipt_metrics as (
  select i.vendor_id, r.warehouse_id, ci_private.fiscal_year_be((r.received_at at time zone 'Asia/Bangkok')::date) - 543 as fiscal_year,
         count(*) as receipt_count, count(a.id) as assessed_count, count(*) filter (where a.delivery_discrepancy = true) as discrepancy_count
  from public.ci_receipts r join public.ci_invoices i on i.id = r.invoice_id left join public.ci_receipt_assessments a on a.receipt_id = r.id
  group by 1, 2, 3
), issue_metrics as (
  select vendor_id, warehouse_id, ci_private.fiscal_year_be((created_at at time zone 'Asia/Bangkok')::date) - 543 as fiscal_year,
         count(*) as issue_count, count(*) filter (where status = 'open') as open_issue_count
  from public.ci_vendor_issues where status <> 'cancelled' group by 1, 2, 3
)
select coalesce(r.vendor_id, i.vendor_id) as vendor_id, coalesce(r.warehouse_id, i.warehouse_id) as warehouse_id, coalesce(r.fiscal_year, i.fiscal_year) as fiscal_year,
       coalesce(r.receipt_count, 0) as receipt_count, coalesce(r.assessed_count, 0) as assessed_count, coalesce(r.discrepancy_count, 0) as discrepancy_count,
       coalesce(i.issue_count, 0) as issue_count, coalesce(i.open_issue_count, 0) as open_issue_count
from receipt_metrics r full outer join issue_metrics i using (vendor_id, warehouse_id, fiscal_year);
grant select on public.ci_vendor_metrics to authenticated;

select ci_private.publish_rpc('ci_private.ci_update_receipt_assessment(uuid, jsonb)'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_open_vendor_issue(uuid, smallint, text, text, uuid)'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_resolve_vendor_issue(uuid, text, text)'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_cancel_vendor_issue(uuid, text, text)'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_register_vendor_issue_attachment(uuid, text, text, bigint)'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_remove_vendor_issue_attachment(uuid)'::regprocedure);

notify pgrst, 'reload schema';
