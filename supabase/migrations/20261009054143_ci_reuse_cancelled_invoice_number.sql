-- Allow reusing an Invoice number once all previous invoices with the same vendor/number
-- are cancelled. Historical Invoice IDs, receipt lines, stock movements and audits remain intact.
-- Active statuses include open, closed and closed_short. The partial UNIQUE index, not a UI
-- preflight, is the concurrency-safe arbiter for inserts and edits.
--
-- The existing composite UNIQUE constraint counts cancelled invoices and must be replaced.
-- The DDL runs as one database migration transaction; no data is deleted or rewritten.
do $preflight$
begin
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.ci_invoices'::regclass
      and conname = 'ci_invoices_vendor_id_invoice_number_key' and contype = 'u'
  ) then raise exception 'CI_INVOICE_REUSE_UNIQUE_CONSTRAINT_MISSING'; end if;
  if exists (
    select 1 from public.ci_invoices
    where status <> 'cancelled'
    group by vendor_id,invoice_number having count(*) > 1
  ) then raise exception 'CI_INVOICE_REUSE_ACTIVE_DUPLICATES'; end if;
end $preflight$;

alter table public.ci_invoices drop constraint ci_invoices_vendor_id_invoice_number_key;
create unique index ci_invoices_active_vendor_invoice_unique
  on public.ci_invoices(vendor_id, invoice_number) where status <> 'cancelled';

-- Receipt corrections can rename an ACTIVE invoice to a number that exists
-- only on cancelled historical invoices. This preserves every other existing
-- validation and all receipt/stock safeguards in the canonical editor.
create or replace function ci_private.ci_edit_receipt(p_receipt_id uuid, p_data jsonb) returns uuid
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
        where location.id = (entry.value->>'location_id')::uuid and location.active and ci_private.location_available_for_warehouse(v_receipt.warehouse_id, location.id)
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
      if exists(select 1 from public.ci_invoices other where other.vendor_id = v_invoice.vendor_id and other.invoice_number = v_header_number and other.id <> v_invoice.id and other.status <> 'cancelled') then
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

notify pgrst,'reload schema';
