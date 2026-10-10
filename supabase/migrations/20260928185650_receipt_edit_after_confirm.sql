-- A confirmed receipt remains the same receipt and receive transaction when an authorised user corrects it.
-- The scoped context exists only inside the transaction running ci_edit_receipt; clients have no table access.
create table ci_private.receipt_edit_context (
  transaction_key bigint not null,
  receipt_id uuid not null,
  receive_transaction_id uuid not null,
  actor_id uuid not null,
  primary key (transaction_key, receipt_id)
);
revoke all on ci_private.receipt_edit_context from public, anon, authenticated;

create function ci_private.guard_receipt_line_edit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_receipt uuid;
begin
  if tg_op = 'DELETE' then v_receipt := old.receipt_id; else v_receipt := new.receipt_id; end if;
  if tg_op = 'UPDATE' and (old.receipt_id is distinct from new.receipt_id or old.warehouse_id is distinct from new.warehouse_id) then
    raise exception 'CI_CONFIRMED_HISTORY_IMMUTABLE';
  end if;
  if not exists (
    select 1 from ci_private.receipt_edit_context c
    where c.transaction_key = txid_current() and c.receipt_id = v_receipt and c.actor_id = auth.uid()
  ) then raise exception 'CI_CONFIRMED_HISTORY_IMMUTABLE'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function ci_private.guard_receipt_line_edit() from public, anon, authenticated;
drop trigger ci_receipt_line_immutable on public.ci_receipt_lines;
create trigger ci_receipt_line_immutable before update or delete on public.ci_receipt_lines
  for each row execute function ci_private.guard_receipt_line_edit();

create function ci_private.guard_receipt_movement_edit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_transaction uuid; v_receipt uuid;
begin
  if tg_op = 'DELETE' then v_transaction := old.transaction_id; else v_transaction := new.transaction_id; end if;
  select tx.receipt_id into v_receipt
  from public.ci_stock_transactions tx
  where tx.id = v_transaction and tx.kind = 'receive' and tx.receipt_id is not null;
  if v_receipt is null or not exists (
    select 1 from ci_private.receipt_edit_context c
    where c.transaction_key = txid_current() and c.receipt_id = v_receipt
      and c.receive_transaction_id = v_transaction and c.actor_id = auth.uid()
  ) then raise exception 'CI_CONFIRMED_HISTORY_IMMUTABLE'; end if;
  if tg_op = 'UPDATE' and old.transaction_id is distinct from new.transaction_id then
    raise exception 'CI_CONFIRMED_HISTORY_IMMUTABLE';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function ci_private.guard_receipt_movement_edit() from public, anon, authenticated;
drop trigger ci_movement_immutable on public.ci_stock_movement_lines;
create trigger ci_movement_immutable before update or delete on public.ci_stock_movement_lines
  for each row execute function ci_private.guard_receipt_movement_edit();

-- Existing stock history still prevents arbitrary LOT edits. A receipt editor may correct expiry only for a LOT
-- already represented by that same receipt; a conflicting LOT master remains an error.
create or replace function ci_private.guard_lot() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and exists(select 1 from public.ci_stock_movement_lines where lot_id = old.id) then
    raise exception 'CI_LOT_HAS_HISTORY';
  end if;
  if tg_op = 'UPDATE' and exists(select 1 from public.ci_stock_movement_lines where lot_id = old.id)
    and (new.product_id is distinct from old.product_id or new.warehouse_id is distinct from old.warehouse_id
      or new.lot_number is distinct from old.lot_number or new.expiry_date is distinct from old.expiry_date) then
    if new.product_id is distinct from old.product_id or new.warehouse_id is distinct from old.warehouse_id
      or new.lot_number is distinct from old.lot_number
      or not exists (
        select 1 from ci_private.receipt_edit_context c
        join public.ci_receipt_lines rl on rl.receipt_id = c.receipt_id and rl.lot_id = old.id
        where c.transaction_key = txid_current() and c.actor_id = auth.uid()
      ) then raise exception 'CI_LOT_IDENTITY_IMMUTABLE'; end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- Exclude fully reversed receipts from both remaining-quantity display and receipt capacity checks.
create or replace view public.ci_invoice_line_progress with (security_invoker = true) as
select il.id as invoice_line_id, il.invoice_id, il.warehouse_id, il.product_id,
       il.ordered_quantity,
       coalesce(sum(rl.quantity) filter (where receipt.id is null or reversal.id is null), 0)::numeric(18,3) as received_quantity,
       (il.ordered_quantity - coalesce(sum(rl.quantity) filter (where receipt.id is null or reversal.id is null), 0))::numeric(18,3) as remaining_quantity
from public.ci_invoice_lines il
left join public.ci_receipt_lines rl on rl.invoice_line_id = il.id
left join public.ci_receipts receipt on receipt.id = rl.receipt_id
left join public.ci_stock_transactions received_tx on received_tx.receipt_id = receipt.id and received_tx.kind = 'receive'
left join public.ci_stock_transactions reversal on reversal.source_transaction_id = received_tx.id and reversal.kind = 'reversal'
group by il.id;
grant select on public.ci_invoice_line_progress to authenticated;

create or replace function ci_private.reconcile_receipt_line_issues(p_receipt_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_receipt public.ci_receipts%rowtype;
  v_vendor uuid;
  v_from date;
  v_line record;
begin
  select * into v_receipt from public.ci_receipts where id = p_receipt_id;
  if not found then return; end if;
  select assessment_required_from into v_from from public.ci_vendor_evaluation_settings;
  if (v_receipt.received_at at time zone 'Asia/Bangkok')::date < v_from then return; end if;
  select vendor_id into v_vendor from public.ci_invoices where id = v_receipt.invoice_id;

  update public.ci_vendor_issues issue set status = 'cancelled', cancelled_reason = 'assessment_corrected',
    cancelled_note = 'ยกเลิกอัตโนมัติหลังแก้ไขใบรับเข้า', cancelled_at = now(),
    cancelled_by = coalesce(auth.uid(), v_receipt.received_by), updated_at = now()
  where issue.receipt_id = p_receipt_id and issue.source_kind = 'receipt_line' and issue.status <> 'cancelled'
    and not exists (
      select 1 from public.ci_receipt_lines rl join public.ci_stock_lots lot on lot.id = rl.lot_id
      where rl.id = issue.receipt_line_id and rl.receipt_id = p_receipt_id
        and lot.expiry_date < (v_receipt.received_at at time zone 'Asia/Bangkok')::date
    );

  for v_line in
    select rl.id as line_id, lot.lot_number, lot.expiry_date, p.product_code
    from public.ci_receipt_lines rl join public.ci_stock_lots lot on lot.id = rl.lot_id
    join public.ci_products p on p.id = lot.product_id
    where rl.receipt_id = p_receipt_id and lot.expiry_date < (v_receipt.received_at at time zone 'Asia/Bangkok')::date
  loop
    insert into public.ci_vendor_issues (vendor_id, warehouse_id, invoice_id, receipt_id, description, issue_type, source_kind, receipt_line_id, created_by)
    values (v_vendor, v_receipt.warehouse_id, v_receipt.invoice_id, p_receipt_id,
      'สินค้าหมดอายุก่อนวันรับ: ' || v_line.product_code || ' LOT ' || v_line.lot_number || ' หมดอายุ ' || v_line.expiry_date::text,
      'expiry_non_compliant', 'receipt_line', v_line.line_id, coalesce(auth.uid(), v_receipt.received_by))
    on conflict (receipt_line_id, issue_type) where source_kind = 'receipt_line' and status <> 'cancelled'
    do update set description = excluded.description, updated_at = now();
  end loop;
end $$;
revoke all on function ci_private.reconcile_receipt_line_issues(uuid) from public, anon, authenticated;

create function ci_private.ci_edit_receipt(p_receipt_id uuid, p_data jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_receipt public.ci_receipts%rowtype;
  v_invoice public.ci_invoices%rowtype;
  v_actor uuid;
  v_receive_tx uuid;
  v_line jsonb;
  v_existing record;
  v_invoice_line uuid;
  v_lot_id uuid;
  v_lot_number text;
  v_expiry date;
  v_location uuid;
  v_quantity numeric;
  v_movement_id uuid;
  v_input_count integer;
  v_header_number text;
  v_header_date date;
  v_header_po text;
  v_header_changed boolean := false;
  v_assessment jsonb;
  v_assessment_row public.ci_receipt_assessments%rowtype;
  v_assessment_reasons text[];
  v_remaining boolean;
  v_progress record;
begin
  if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'CI_RECEIPT_EDIT_DATA_INVALID'; end if;
  if p_data - array['lines','invoice','assessment'] <> '{}'::jsonb then raise exception 'CI_RECEIPT_EDIT_DATA_INVALID'; end if;
  select * into v_receipt from public.ci_receipts where id = p_receipt_id for update;
  if not found then raise exception 'CI_RECEIPT_EDIT_NOT_FOUND'; end if;
  v_actor := ci_private.require_role(v_receipt.warehouse_id, array['admin','supervisor']);
  select * into v_invoice from public.ci_invoices where id = v_receipt.invoice_id for update;
  if not found then raise exception 'CI_INVOICE_NOT_FOUND'; end if;
  if v_invoice.status = 'cancelled' then raise exception 'CI_RECEIPT_EDIT_INVOICE_CANCELLED'; end if;
  select id into v_receive_tx from public.ci_stock_transactions
    where receipt_id = p_receipt_id and kind = 'receive' for update;
  if v_receive_tx is null then raise exception 'CI_RECEIPT_EDIT_LEDGER_MISMATCH'; end if;
  if exists(select 1 from public.ci_stock_transactions where source_transaction_id = v_receive_tx and kind = 'reversal') then
    raise exception 'CI_RECEIPT_EDIT_REVERSED';
  end if;
  if jsonb_typeof(p_data->'lines') is distinct from 'array' then raise exception 'CI_RECEIPT_EDIT_LINES_REQUIRED'; end if;
  if jsonb_array_length(p_data->'lines') = 0 then raise exception 'CI_RECEIPT_EDIT_LINES_REQUIRED'; end if;
  v_input_count := jsonb_array_length(p_data->'lines');
  if v_input_count > 200 then raise exception 'CI_RECEIPT_EDIT_LINES_INVALID'; end if;

  if exists (select 1 from jsonb_array_elements(p_data->'lines') entry where jsonb_typeof(entry.value) is distinct from 'object') then
    raise exception 'CI_RECEIPT_EDIT_LINE_INVALID';
  end if;
  if exists (select 1 from jsonb_array_elements(p_data->'lines') entry
    where entry.value - array['receipt_line_id','invoice_line_id','quantity','lot_number','expiry_date','location_id'] <> '{}'::jsonb) then
    raise exception 'CI_RECEIPT_EDIT_LINE_INVALID';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_data->'lines') entry
    where not (entry.value ? 'invoice_line_id' and entry.value ? 'quantity' and entry.value ? 'lot_number' and entry.value ? 'expiry_date' and entry.value ? 'location_id')
      or nullif(btrim(entry.value->>'lot_number'), '') is null
      or coalesce(nullif(entry.value->>'expiry_date', ''), '') = ''
      or coalesce((entry.value->>'quantity') !~ '^[0-9]+$', true)
      or coalesce((entry.value->>'quantity')::numeric <= 0, true)
      or nullif(entry.value->>'receipt_line_id', '') is not null and not exists (
        select 1 from public.ci_receipt_lines old_line where old_line.id = (entry.value->>'receipt_line_id')::uuid and old_line.receipt_id = p_receipt_id
      )
      or not exists (
        select 1 from public.ci_invoice_lines il
        where il.id = (entry.value->>'invoice_line_id')::uuid and il.invoice_id = v_receipt.invoice_id and il.warehouse_id = v_receipt.warehouse_id
      )
      or not exists (
        select 1 from public.ci_locations location
        where location.id = (entry.value->>'location_id')::uuid and location.warehouse_id = v_receipt.warehouse_id and location.active
      )
  ) then raise exception 'CI_RECEIPT_EDIT_LINE_INVALID'; end if;
  if (select count(*) from jsonb_array_elements(p_data->'lines') entry where nullif(entry.value->>'receipt_line_id','') is not null)
     <> (select count(distinct (entry.value->>'receipt_line_id')::uuid) from jsonb_array_elements(p_data->'lines') entry where nullif(entry.value->>'receipt_line_id','') is not null) then
    raise exception 'CI_RECEIPT_EDIT_LINE_INVALID';
  end if;

  -- Invoice-line totals include other active receipts but replace this receipt's previous contribution.
  for v_progress in select distinct entry.value->>'invoice_line_id' as invoice_line_id from jsonb_array_elements(p_data->'lines') entry loop
    if (select coalesce(sum((entry.value->>'quantity')::numeric), 0) from jsonb_array_elements(p_data->'lines') entry
        where (entry.value->>'invoice_line_id')::uuid = v_progress.invoice_line_id::uuid)
       + (select coalesce(sum(rl.quantity), 0)
          from public.ci_receipt_lines rl join public.ci_receipts r on r.id = rl.receipt_id
          left join public.ci_stock_transactions tx on tx.receipt_id = r.id and tx.kind = 'receive'
          left join public.ci_stock_transactions reversal on reversal.source_transaction_id = tx.id and reversal.kind = 'reversal'
          where rl.invoice_line_id = v_progress.invoice_line_id::uuid and r.id <> p_receipt_id and reversal.id is null)
       > (select il.ordered_quantity from public.ci_invoice_lines il where il.id = v_progress.invoice_line_id::uuid) then
      raise exception 'CI_RECEIPT_EDIT_EXCEEDS_INVOICE';
    end if;
  end loop;

  perform ci_private.lock_products(array(
    select distinct x.product_id from (
      select lot.product_id from public.ci_receipt_lines rl join public.ci_stock_lots lot on lot.id = rl.lot_id where rl.receipt_id = p_receipt_id
      union all
      select il.product_id from jsonb_array_elements(p_data->'lines') entry join public.ci_invoice_lines il on il.id = (entry.value->>'invoice_line_id')::uuid
    ) x order by x.product_id
  ));

  if p_data->'invoice' is not null and p_data->'invoice' <> 'null'::jsonb then
    if jsonb_typeof(p_data->'invoice') is distinct from 'object' then raise exception 'CI_RECEIPT_EDIT_INVOICE_FIELDS_INVALID'; end if;
    if (p_data->'invoice') - array['invoice_number','invoice_date','po_number'] <> '{}'::jsonb
      or not (p_data->'invoice' ? 'invoice_number' and p_data->'invoice' ? 'invoice_date' and p_data->'invoice' ? 'po_number') then
      raise exception 'CI_RECEIPT_EDIT_INVOICE_FIELDS_INVALID';
    end if;
    v_header_number := nullif(btrim(p_data->'invoice'->>'invoice_number'), '');
    v_header_date := (p_data->'invoice'->>'invoice_date')::date;
    v_header_po := nullif(btrim(p_data->'invoice'->>'po_number'), '');
    if v_header_number is null or v_header_date is null then raise exception 'CI_RECEIPT_EDIT_INVOICE_FIELDS_INVALID'; end if;
    v_header_changed := v_header_number is distinct from v_invoice.invoice_number
      or v_header_date is distinct from v_invoice.invoice_date or v_header_po is distinct from v_invoice.po_number;
    if v_header_changed then
      for v_input_count in select distinct warehouse_id from public.ci_invoice_lines where invoice_id = v_invoice.id order by warehouse_id loop
        perform ci_private.require_role(v_input_count::smallint, array['admin','supervisor']);
      end loop;
      if exists(select 1 from public.ci_invoices other where other.vendor_id = v_invoice.vendor_id and other.invoice_number = v_header_number and other.id <> v_invoice.id) then
        raise exception 'CI_RECEIPT_EDIT_INVOICE_NUMBER_CONFLICT';
      end if;
      update public.ci_invoices set invoice_number = v_header_number, invoice_date = v_header_date, po_number = v_header_po where id = v_invoice.id;
      for v_input_count in select distinct warehouse_id from public.ci_invoice_lines where invoice_id = v_invoice.id order by warehouse_id loop
        perform ci_private.audit(v_input_count::smallint, 'EDIT', 'ci_invoices', v_invoice.id::text, 'แก้ไขข้อมูล Invoice ผ่านใบรับเข้า');
      end loop;
    end if;
  end if;

  insert into ci_private.receipt_edit_context(transaction_key, receipt_id, receive_transaction_id, actor_id)
    values (txid_current(), p_receipt_id, v_receive_tx, v_actor);

  -- Resolve/insert target LOT masters. Only a LOT already on this receipt (or with no ledger history) may have its
  -- expiry corrected in place; other existing LOTs keep their established master expiry.
  for v_line in select value from jsonb_array_elements(p_data->'lines') loop
    select il.id, il.product_id into v_invoice_line, v_lot_id
      from public.ci_invoice_lines il where il.id = (v_line->>'invoice_line_id')::uuid;
    v_lot_number := btrim(v_line->>'lot_number');
    v_expiry := (v_line->>'expiry_date')::date;
    v_location := (v_line->>'location_id')::uuid;
    v_quantity := (v_line->>'quantity')::numeric;
    insert into public.ci_stock_lots(warehouse_id, product_id, lot_number, expiry_date)
      values (v_receipt.warehouse_id, v_lot_id, v_lot_number, v_expiry)
      on conflict (warehouse_id, product_id, lot_number) do nothing;
    select id into v_lot_id from public.ci_stock_lots
      where warehouse_id = v_receipt.warehouse_id and product_id = (select product_id from public.ci_invoice_lines where id = v_invoice_line)
        and lot_number = v_lot_number for update;
    if not found then raise exception 'CI_RECEIPT_EDIT_LOT_INVALID'; end if;
    if (select expiry_date from public.ci_stock_lots where id = v_lot_id) is distinct from v_expiry then
      if exists(select 1 from public.ci_stock_movement_lines where lot_id = v_lot_id)
        and not exists(select 1 from public.ci_receipt_lines where receipt_id = p_receipt_id and lot_id = v_lot_id) then
        raise exception 'CI_LOT_EXPIRY_CONFLICT';
      end if;
      update public.ci_stock_lots set expiry_date = v_expiry where id = v_lot_id;
    end if;
  end loop;

  -- The line ledger must be a one-for-one representation of the receipt before it can be safely rewritten.
  if exists (
    with old_lines as (
      select lot_id, location_id, count(*)::bigint line_count, sum(quantity)::numeric quantity
      from public.ci_receipt_lines where receipt_id = p_receipt_id group by lot_id, location_id
    ), movements as (
      select lot_id, location_id, count(*)::bigint line_count, sum(quantity_delta)::numeric quantity
      from public.ci_stock_movement_lines where transaction_id = v_receive_tx group by lot_id, location_id
    )
    select 1 from old_lines full join movements using (lot_id, location_id)
    where old_lines.line_count is distinct from movements.line_count or old_lines.quantity is distinct from movements.quantity
  ) then raise exception 'CI_RECEIPT_EDIT_LEDGER_MISMATCH'; end if;

  -- Check the final ledger balance for every source and target LOT/location before changing any movement.
  if exists (
    with original as (
      select lot_id, location_id, sum(quantity_delta)::numeric quantity
      from public.ci_stock_movement_lines where transaction_id = v_receive_tx group by lot_id, location_id
    ), desired as (
      select lot.id as lot_id, (entry.value->>'location_id')::uuid as location_id, sum((entry.value->>'quantity')::numeric)::numeric quantity
      from jsonb_array_elements(p_data->'lines') entry
      join public.ci_invoice_lines il on il.id = (entry.value->>'invoice_line_id')::uuid
      join public.ci_stock_lots lot on lot.warehouse_id = v_receipt.warehouse_id and lot.product_id = il.product_id and lot.lot_number = btrim(entry.value->>'lot_number')
      group by lot.id, (entry.value->>'location_id')::uuid
    ), affected as (
      select lot_id, location_id from original union select lot_id, location_id from desired
    )
    select 1 from affected a
    left join original old using (lot_id, location_id)
    left join desired new using (lot_id, location_id)
    left join lateral (select coalesce(sum(m.quantity_delta), 0)::numeric balance from public.ci_stock_movement_lines m where m.lot_id = a.lot_id and m.location_id = a.location_id) current_balance on true
    where current_balance.balance - coalesce(old.quantity, 0) + coalesce(new.quantity, 0) < 0
  ) then raise exception 'CI_RECEIPT_EDIT_STOCK_NEGATIVE'; end if;

  for v_existing in select * from public.ci_receipt_lines where receipt_id = p_receipt_id order by id for update loop
    select entry.value into v_line from jsonb_array_elements(p_data->'lines') entry
      where nullif(entry.value->>'receipt_line_id', '')::uuid = v_existing.id limit 1;
    if not found then
      select id into v_movement_id from public.ci_stock_movement_lines
        where transaction_id = v_receive_tx and lot_id = v_existing.lot_id and location_id = v_existing.location_id
          and quantity_delta = v_existing.quantity order by id limit 1;
      if v_movement_id is null then raise exception 'CI_RECEIPT_EDIT_LEDGER_MISMATCH'; end if;
      delete from public.ci_stock_movement_lines where id = v_movement_id;
      update public.ci_vendor_issues set source_kind = 'manual', receipt_line_id = null, updated_at = now()
        where receipt_line_id = v_existing.id and source_kind = 'receipt_line';
      delete from public.ci_receipt_lines where id = v_existing.id;
    else
      v_invoice_line := (v_line->>'invoice_line_id')::uuid;
      v_lot_number := btrim(v_line->>'lot_number');
      v_expiry := (v_line->>'expiry_date')::date;
      v_location := (v_line->>'location_id')::uuid;
      v_quantity := (v_line->>'quantity')::numeric;
      select lot.id into v_lot_id from public.ci_stock_lots lot join public.ci_invoice_lines il on il.product_id = lot.product_id
        where il.id = v_invoice_line and lot.warehouse_id = v_receipt.warehouse_id and lot.lot_number = v_lot_number;
      select id into v_movement_id from public.ci_stock_movement_lines
        where transaction_id = v_receive_tx and lot_id = v_existing.lot_id and location_id = v_existing.location_id
          and quantity_delta = v_existing.quantity order by id limit 1;
      if v_movement_id is null or v_lot_id is null then raise exception 'CI_RECEIPT_EDIT_LEDGER_MISMATCH'; end if;
      update public.ci_stock_movement_lines set lot_id = v_lot_id, location_id = v_location, quantity_delta = v_quantity where id = v_movement_id;
      update public.ci_receipt_lines set invoice_line_id = v_invoice_line, lot_id = v_lot_id, location_id = v_location, quantity = v_quantity where id = v_existing.id;
    end if;
  end loop;

  for v_line in select value from jsonb_array_elements(p_data->'lines')
    where nullif(value->>'receipt_line_id', '') is null loop
    v_invoice_line := (v_line->>'invoice_line_id')::uuid;
    v_lot_number := btrim(v_line->>'lot_number');
    v_location := (v_line->>'location_id')::uuid;
    v_quantity := (v_line->>'quantity')::numeric;
    select lot.id into v_lot_id from public.ci_stock_lots lot join public.ci_invoice_lines il on il.product_id = lot.product_id
      where il.id = v_invoice_line and lot.warehouse_id = v_receipt.warehouse_id and lot.lot_number = v_lot_number;
    if v_lot_id is null then raise exception 'CI_RECEIPT_EDIT_LOT_INVALID'; end if;
    insert into public.ci_receipt_lines(receipt_id, invoice_line_id, warehouse_id, lot_id, location_id, quantity)
      values (p_receipt_id, v_invoice_line, v_receipt.warehouse_id, v_lot_id, v_location, v_quantity);
    perform ci_private.add_movement(v_receive_tx, v_receipt.warehouse_id, v_lot_id, v_location, v_quantity);
  end loop;

  if p_data->'assessment' is not null and p_data->'assessment' <> 'null'::jsonb then
    v_assessment := ci_private.normalize_assessment(p_data->'assessment');
    select * into v_assessment_row from public.ci_receipt_assessments where receipt_id = p_receipt_id for update;
    if not found then
      perform ci_private.ci_save_receipt_assessment(p_receipt_id, p_data->'assessment');
    else
      v_assessment_reasons := array(select jsonb_array_elements_text(v_assessment->'reason_codes'));
      if v_assessment_row.correct_product is distinct from (v_assessment->>'correct_product')::boolean
        or v_assessment_row.correct_quantity is distinct from (v_assessment->>'correct_quantity')::boolean
        or v_assessment_row.packaging_ok is distinct from (v_assessment->>'packaging_ok')::boolean
        or v_assessment_row.temperature_required is distinct from (v_assessment->>'temperature_required')::boolean
        or v_assessment_row.temperature_ok is distinct from (v_assessment->>'temperature_ok')::boolean
        or v_assessment_row.documentation_complete is distinct from (v_assessment->>'documentation_complete')::boolean
        or v_assessment_row.has_complaint is distinct from (v_assessment->>'has_complaint')::boolean
        or v_assessment_row.delivery_discrepancy is distinct from (v_assessment->>'delivery_discrepancy')::boolean
        or v_assessment_row.notes is distinct from (v_assessment->>'notes')
        or v_assessment_row.reason_codes is distinct from v_assessment_reasons
        or v_assessment_row.other_reason_detail is distinct from (v_assessment->>'other_reason_detail') then
        perform ci_private.ci_update_receipt_assessment(v_assessment_row.id, p_data->'assessment');
      end if;
    end if;
  end if;

  perform ci_private.reconcile_receipt_line_issues(p_receipt_id);
  select exists(select 1 from public.ci_invoice_line_progress where invoice_id = v_invoice.id and remaining_quantity > 0) into v_remaining;
  if v_remaining then
    update public.ci_invoices set status = 'open' where id = v_invoice.id and status in ('closed','closed_short');
  else
    update public.ci_invoices set status = 'closed' where id = v_invoice.id and status = 'open';
  end if;
  delete from ci_private.receipt_edit_context where transaction_key = txid_current() and receipt_id = p_receipt_id;
  perform ci_private.audit(v_receipt.warehouse_id, 'EDIT', 'ci_receipts', p_receipt_id::text, 'แก้ไขใบรับเข้าที่บันทึกแล้ว');
  return p_receipt_id;
exception
  when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
    raise exception 'CI_RECEIPT_EDIT_LINE_INVALID';
end $$;
revoke all on function ci_private.ci_edit_receipt(uuid, jsonb) from public, anon, authenticated;
select ci_private.publish_rpc('ci_private.ci_edit_receipt(uuid, jsonb)'::pg_catalog.regprocedure);

-- The optional-reason adjustment migration reintroduced a public definer. Keep the same RPC contract while
-- restoring the repository's private-implementation / invoker-wrapper boundary.
create or replace function ci_private.ci_adjust_stock(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_lot uuid := nullif(p_data->>'lot_id','')::uuid;
  v_wh smallint := nullif(p_data->>'warehouse_id','')::smallint;
  v_product uuid := nullif(p_data->>'product_id','')::uuid;
  v_location uuid := nullif(p_data->>'location_id','')::uuid;
  v_delta numeric := nullif(p_data->>'quantity_delta','')::numeric;
  v_reason text := nullif(btrim(p_data->>'reason'),'');
  v_key text := p_data->>'idempotency_key';
  v_hash text := md5(p_data::text);
  v_tx uuid;
  v_lot_number text := nullif(btrim(p_data->>'lot_number'),'');
  v_expiry date := nullif(p_data->>'expiry_date','')::date;
  v_lot_expiry date;
  v_product_wh smallint;
begin
  if v_lot is not null then
    select warehouse_id, product_id, lot_number, expiry_date into v_wh, v_product, v_lot_number, v_lot_expiry
    from public.ci_stock_lots where id = v_lot for update;
    if not found then raise exception 'CI_STOCK_LOT_NOT_FOUND'; end if;
    if nullif(p_data->>'product_id','') is not null and v_product <> (p_data->>'product_id')::uuid then raise exception 'CI_ADJUSTMENT_PRODUCT_MISMATCH'; end if;
    if nullif(p_data->>'warehouse_id','') is not null and v_wh <> (p_data->>'warehouse_id')::smallint then raise exception 'CI_WAREHOUSE_INVALID'; end if;
    if nullif(p_data->>'lot_number','') is not null and v_lot_number <> btrim(p_data->>'lot_number') then raise exception 'CI_ADJUSTMENT_LOT_MISMATCH'; end if;
    if nullif(p_data->>'expiry_date','') is not null and v_lot_expiry <> (p_data->>'expiry_date')::date then raise exception 'CI_LOT_EXPIRY_CONFLICT'; end if;
  else
    if v_wh is null or v_product is null then raise exception 'CI_PRODUCT_NOT_FOUND'; end if;
    if v_lot_number is null or v_expiry is null then raise exception 'CI_LOT_EXPIRY_REQUIRED'; end if;
    select warehouse_id into v_product_wh from public.ci_products where id = v_product and active;
    if not found then raise exception 'CI_PRODUCT_NOT_FOUND'; end if;
    if v_product_wh <> v_wh then raise exception 'CI_PRODUCT_CODE_WAREHOUSE_MISMATCH'; end if;
  end if;

  perform ci_private.require_role(v_wh, array['admin','supervisor']);
  if v_delta is null or v_delta = 0 then raise exception 'CI_ADJUSTMENT_QUANTITY_INVALID'; end if;
  if v_key is null or btrim(v_key) = '' then raise exception 'CI_IDEMPOTENCY_KEY_REQUIRED'; end if;
  perform ci_private.lock_products(array[v_product]);
  v_tx := ci_private.idempotent_transaction(v_wh, 'adjustment', v_key, v_hash);
  if v_tx is not null then return v_tx; end if;
  if not exists(select 1 from public.ci_locations where id = v_location and warehouse_id = v_wh and active) then raise exception 'CI_LOCATION_INVALID'; end if;

  if v_lot is null then
    if v_delta < 0 then raise exception 'CI_ADJUSTMENT_NEW_LOT_MUST_INCREASE'; end if;
    insert into public.ci_stock_lots(warehouse_id, product_id, lot_number, expiry_date)
    values(v_wh, v_product, v_lot_number, v_expiry) on conflict (warehouse_id, product_id, lot_number) do nothing;
    select id, expiry_date into v_lot, v_lot_expiry from public.ci_stock_lots
    where warehouse_id = v_wh and product_id = v_product and lot_number = v_lot_number for update;
    if v_lot is null or v_lot_expiry <> v_expiry then raise exception 'CI_LOT_EXPIRY_CONFLICT'; end if;
  end if;

  insert into public.ci_stock_transactions(warehouse_id, kind, idempotency_key, request_hash, actor_id, reason)
  values(v_wh, 'adjustment', v_key, v_hash, auth.uid(), v_reason) returning id into v_tx;
  perform ci_private.add_movement(v_tx, v_wh, v_lot, v_location, v_delta);
  perform ci_private.audit(v_wh, 'ADJUST', 'ci_stock_transactions', v_tx::text, v_reason);
  return v_tx;
end $$;
select ci_private.publish_rpc('ci_private.ci_adjust_stock(jsonb)'::pg_catalog.regprocedure);
