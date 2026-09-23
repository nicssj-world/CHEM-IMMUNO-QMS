-- Keep purpose mandatory for all issued stock.
alter table public.ci_stock_transactions
  add constraint ci_issue_purpose_required check (kind <> 'issue' or purpose is not null);

-- A fully received invoice may be received again after an entire receipt
-- transaction has been reversed. The reversed receipt no longer contributes
-- to ordered quantity progress.
create or replace view public.ci_invoice_line_progress
with (security_invoker=true) as
select il.id as invoice_line_id,il.invoice_id,il.warehouse_id,il.product_id,
       il.ordered_quantity,
       coalesce(sum(case when reversal.id is null then rl.quantity else 0 end),0)::numeric(18,3) as received_quantity,
       (il.ordered_quantity-coalesce(sum(case when reversal.id is null then rl.quantity else 0 end),0))::numeric(18,3) as remaining_quantity
from public.ci_invoice_lines il
left join public.ci_receipt_lines rl on rl.invoice_line_id=il.id
left join public.ci_receipts receipt on receipt.id=rl.receipt_id
left join public.ci_stock_transactions received_tx on received_tx.receipt_id=receipt.id and received_tx.kind='receive'
left join public.ci_stock_transactions reversal on reversal.source_transaction_id=received_tx.id and reversal.kind='reversal'
group by il.id;
grant select on public.ci_invoice_line_progress to authenticated;

create or replace view public.ci_fefo_candidates with (security_invoker=true) as
select * from public.ci_stock_balances
where balance > 0 and expiry_date >= (pg_catalog.now() at time zone 'Asia/Bangkok')::date;
grant select on public.ci_fefo_candidates to authenticated;

create or replace function public.ci_issue_stock(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_product uuid:=(p_data->>'product_id')::uuid;v_wh smallint;v_lot uuid:=(p_data->>'lot_id')::uuid;
  v_location uuid:=(p_data->>'location_id')::uuid;v_qty numeric:=(p_data->>'quantity')::numeric;
  v_key text:=p_data->>'idempotency_key';v_hash text:=md5(p_data::text);
  v_tx uuid;v_first_lot uuid;v_expiry date;v_purpose text:=p_data->>'purpose';
  v_today date:=(pg_catalog.now() at time zone 'Asia/Bangkok')::date;
begin
  select warehouse_id into v_wh from public.ci_products where id=v_product and active;
  perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
  if v_qty is null or v_qty<=0 then raise exception 'CI_ISSUE_QUANTITY_INVALID'; end if;
  if v_purpose is null or v_purpose not in ('Routine','QC','Calibration','Verification/Validation','Repeat/Troubleshooting','Waste','Other') then
    raise exception 'CI_ISSUE_PURPOSE_REQUIRED'; end if;
  if v_key is null or btrim(v_key)='' then raise exception 'CI_IDEMPOTENCY_KEY_REQUIRED'; end if;
  perform ci_private.lock_products(array[v_product]);
  v_tx:=ci_private.idempotent_transaction(v_wh,'issue',v_key,v_hash);
  if v_tx is not null then return v_tx; end if;
  select expiry_date into v_expiry from public.ci_stock_lots where id=v_lot and product_id=v_product and warehouse_id=v_wh for update;
  if v_expiry is null or v_expiry<v_today then raise exception 'CI_EXPIRED_OR_INVALID_LOT'; end if;
  if not exists(select 1 from public.ci_locations where id=v_location and warehouse_id=v_wh and active) then raise exception 'CI_LOCATION_INVALID'; end if;
  select lot_id into v_first_lot from public.ci_stock_balances
    where product_id=v_product and warehouse_id=v_wh and expiry_date>=v_today and balance>0
    order by expiry_date,lot_number,lot_id limit 1;
  if v_first_lot is distinct from v_lot and nullif(btrim(p_data->>'override_reason'),'') is null then
    raise exception 'CI_FEFO_OVERRIDE_REASON_REQUIRED'; end if;
  insert into public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id,reason,purpose)
    values(v_wh,'issue',v_key,v_hash,auth.uid(),p_data->>'override_reason',v_purpose) returning id into v_tx;
  perform ci_private.add_movement(v_tx,v_wh,v_lot,v_location,-v_qty);
  perform ci_private.audit(v_wh,'ISSUE','ci_stock_transactions',v_tx::text,p_data->>'override_reason');
  return v_tx;
end $$;

create or replace function public.ci_dispose_expired_stock(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_lot uuid:=(p_data->>'lot_id')::uuid;v_wh smallint;v_product uuid;v_expiry date;
  v_location uuid:=(p_data->>'location_id')::uuid;v_qty numeric:=(p_data->>'quantity')::numeric;
  v_reason text:=p_data->>'reason';v_key text:=p_data->>'idempotency_key';
  v_hash text:=md5(p_data::text);v_tx uuid;
begin
  select warehouse_id,product_id,expiry_date into v_wh,v_product,v_expiry from public.ci_stock_lots where id=v_lot;
  perform ci_private.require_role(v_wh,array['admin','supervisor']);
  if v_expiry >= (pg_catalog.now() at time zone 'Asia/Bangkok')::date then raise exception 'CI_LOT_NOT_EXPIRED'; end if;
  if v_qty is null or v_qty<=0 or nullif(btrim(v_reason),'') is null then raise exception 'CI_DISPOSAL_INVALID'; end if;
  if nullif(btrim(v_key),'') is null then raise exception 'CI_IDEMPOTENCY_KEY_REQUIRED'; end if;
  perform ci_private.lock_products(array[v_product]);
  v_tx:=ci_private.idempotent_transaction(v_wh,'expired_disposal',v_key,v_hash);
  if v_tx is not null then return v_tx; end if;
  insert into public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id,reason)
    values(v_wh,'expired_disposal',v_key,v_hash,auth.uid(),v_reason) returning id into v_tx;
  perform ci_private.add_movement(v_tx,v_wh,v_lot,v_location,-v_qty);
  perform ci_private.audit(v_wh,'EXPIRED_DISPOSAL','ci_stock_transactions',v_tx::text,v_reason);
  return v_tx;
end $$;

create or replace function public.ci_confirm_receipt(p_invoice_id uuid,p_lines jsonb,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_line jsonb;v_wh smallint;v_product uuid;v_invoice_line uuid;v_qty numeric;
  v_lot uuid;v_location uuid;v_expiry date;v_lot_number text;v_receipt uuid;v_tx uuid;
  v_hash text:=md5(p_invoice_id::text||p_lines::text);
  v_existing uuid;v_result jsonb:='[]'::jsonb;v_ordered numeric;v_received numeric;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key)='' then raise exception 'CI_IDEMPOTENCY_KEY_REQUIRED'; end if;
  if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'CI_RECEIPT_LINES_REQUIRED'; end if;
  perform 1 from public.ci_invoices where id=p_invoice_id and status='open' for update;
  if not found and not exists(select 1 from public.ci_invoices where id=p_invoice_id) then raise exception 'CI_INVOICE_NOT_FOUND'; end if;
  perform ci_private.lock_products(array(
    select distinct il.product_id from jsonb_array_elements(p_lines) x
    join public.ci_invoice_lines il on il.id=(x.value->>'invoice_line_id')::uuid where il.invoice_id=p_invoice_id));
  for v_wh in select distinct il.warehouse_id from jsonb_array_elements(p_lines) x
    join public.ci_invoice_lines il on il.id=(x.value->>'invoice_line_id')::uuid order by il.warehouse_id loop
    perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
    v_existing:=ci_private.idempotent_transaction(v_wh,'receive',p_idempotency_key,v_hash);
    if v_existing is not null then
      v_result:=v_result||jsonb_build_object('warehouse_id',v_wh,'transaction_id',v_existing);
      continue;
    end if;
    if not exists(select 1 from public.ci_invoices where id=p_invoice_id and status='open') then raise exception 'CI_INVOICE_NOT_OPEN'; end if;
    insert into public.ci_receipts(invoice_id,warehouse_id,received_by) values(p_invoice_id,v_wh,auth.uid()) returning id into v_receipt;
    insert into public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id,receipt_id)
      values(v_wh,'receive',p_idempotency_key,v_hash,auth.uid(),v_receipt) returning id into v_tx;
    for v_line in select x.value from jsonb_array_elements(p_lines) x
      join public.ci_invoice_lines il on il.id=(x.value->>'invoice_line_id')::uuid
      where il.warehouse_id=v_wh order by il.product_id,il.id loop
      v_invoice_line:=(v_line->>'invoice_line_id')::uuid;
      select product_id,ordered_quantity into v_product,v_ordered from public.ci_invoice_lines
        where id=v_invoice_line and invoice_id=p_invoice_id and warehouse_id=v_wh for update;
      v_qty:=(v_line->>'quantity')::numeric;
      if v_qty is null or v_qty<=0 then raise exception 'CI_RECEIPT_QUANTITY_INVALID'; end if;
      select coalesce(sum(rl.quantity),0) into v_received
      from public.ci_receipt_lines rl
      join public.ci_receipts receipt on receipt.id=rl.receipt_id
      join public.ci_stock_transactions received_tx on received_tx.receipt_id=receipt.id and received_tx.kind='receive'
      left join public.ci_stock_transactions reversal on reversal.source_transaction_id=received_tx.id and reversal.kind='reversal'
      where rl.invoice_line_id=v_invoice_line and reversal.id is null;
      if v_received+v_qty>v_ordered then raise exception 'CI_RECEIPT_EXCEEDS_INVOICE'; end if;
      v_location:=(v_line->>'location_id')::uuid;
      if not exists(select 1 from public.ci_locations where id=v_location and warehouse_id=v_wh and active) then raise exception 'CI_LOCATION_INVALID'; end if;
      v_lot_number:=btrim(v_line->>'lot_number');v_expiry:=(v_line->>'expiry_date')::date;
      if v_lot_number is null or v_lot_number='' or v_expiry is null then raise exception 'CI_LOT_EXPIRY_REQUIRED'; end if;
      insert into public.ci_stock_lots(warehouse_id,product_id,lot_number,expiry_date)
        values(v_wh,v_product,v_lot_number,v_expiry) on conflict (warehouse_id,product_id,lot_number) do nothing;
      select id into v_lot from public.ci_stock_lots
        where warehouse_id=v_wh and product_id=v_product and lot_number=v_lot_number and expiry_date=v_expiry for update;
      if v_lot is null then raise exception 'CI_LOT_EXPIRY_CONFLICT'; end if;
      insert into public.ci_receipt_lines(receipt_id,invoice_line_id,warehouse_id,lot_id,location_id,quantity)
        values(v_receipt,v_invoice_line,v_wh,v_lot,v_location,v_qty);
      perform ci_private.add_movement(v_tx,v_wh,v_lot,v_location,v_qty);
    end loop;
    perform ci_private.audit(v_wh,'CONFIRM','ci_receipts',v_receipt::text);
    v_result:=v_result||jsonb_build_object('warehouse_id',v_wh,'transaction_id',v_tx);
  end loop;
  if exists(select 1 from public.ci_invoice_lines where invoice_id=p_invoice_id)
    and not exists(select 1 from public.ci_invoice_line_progress where invoice_id=p_invoice_id and remaining_quantity>0) then
    update public.ci_invoices set status='closed' where id=p_invoice_id;
  end if;
  return v_result;
end $$;

create or replace function public.ci_reverse_transaction(p_source_id uuid,p_reason text,p_idempotency_key text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_source public.ci_stock_transactions%rowtype;v_tx uuid;v_line record;v_invoice_id uuid;
  v_hash text:=md5(p_source_id::text||coalesce(p_reason,'')||coalesce(p_idempotency_key,''));
begin
  select * into v_source from public.ci_stock_transactions where id=p_source_id;
  if not found or v_source.kind='reversal' then raise exception 'CI_REVERSAL_SOURCE_INVALID'; end if;
  perform ci_private.require_role(v_source.warehouse_id,array['admin','supervisor']);
  if nullif(btrim(p_reason),'') is null then raise exception 'CI_REVERSAL_REASON_REQUIRED'; end if;
  if nullif(btrim(p_idempotency_key),'') is null then raise exception 'CI_IDEMPOTENCY_KEY_REQUIRED'; end if;
  perform ci_private.lock_products(array(
    select distinct l.product_id from public.ci_stock_movement_lines m
    join public.ci_stock_lots l on l.id=m.lot_id where m.transaction_id=p_source_id));
  v_tx:=ci_private.idempotent_transaction(v_source.warehouse_id,'reversal',p_idempotency_key,v_hash);
  if v_tx is not null then return v_tx; end if;
  if exists(select 1 from public.ci_stock_transactions where source_transaction_id=p_source_id) then raise exception 'CI_ALREADY_REVERSED'; end if;
  insert into public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id,reason,source_transaction_id)
    values(v_source.warehouse_id,'reversal',p_idempotency_key,v_hash,auth.uid(),p_reason,p_source_id) returning id into v_tx;
  for v_line in select lot_id,location_id,-sum(quantity_delta) as delta
    from public.ci_stock_movement_lines where transaction_id=p_source_id
    group by lot_id,location_id having sum(quantity_delta)<>0 order by lot_id,location_id loop
    perform ci_private.add_movement(v_tx,v_source.warehouse_id,v_line.lot_id,v_line.location_id,v_line.delta);
  end loop;
  if v_source.receipt_id is not null then
    select invoice_id into v_invoice_id from public.ci_receipts where id=v_source.receipt_id;
    if v_invoice_id is not null then
      update public.ci_invoices set status='open' where id=v_invoice_id;
      perform ci_private.audit(v_source.warehouse_id,'REOPEN_AFTER_RECEIPT_REVERSAL','ci_invoices',v_invoice_id::text,p_reason);
    end if;
  end if;
  perform ci_private.audit(v_source.warehouse_id,'REVERSE','ci_stock_transactions',v_tx::text,p_reason);
  return v_tx;
end $$;

revoke all on function public.ci_reverse_transaction(uuid,text,text) from public,anon,authenticated;
grant execute on function public.ci_reverse_transaction(uuid,text,text) to authenticated;
revoke all on all functions in schema ci_private from public,anon,authenticated;
grant execute on function ci_private.can_read(smallint),ci_private.can_admin_any(),ci_private.has_role(smallint,text[]) to authenticated;
