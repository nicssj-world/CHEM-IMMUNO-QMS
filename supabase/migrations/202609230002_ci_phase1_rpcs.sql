-- All mutations run as the authenticated actor and commit atomically in one PostgreSQL transaction.
create function ci_private.audit(p_warehouse_id smallint,p_action text,p_table text,p_id text,p_reason text default null)
returns void language sql security definer set search_path = '' as $$
 insert into public.ci_audit_logs(actor_id,warehouse_id,action,entity_table,entity_id,reason)
 values (auth.uid(),p_warehouse_id,p_action,p_table,p_id,p_reason)
$$;
create function ci_private.lock_products(p_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  for v_id in select distinct x from unnest(p_ids) x order by x loop
    perform 1 from public.ci_products where id=v_id for update;
    if not found then raise exception 'CI_PRODUCT_NOT_FOUND'; end if;
  end loop;
end $$;
create function ci_private.new_product(p_warehouse smallint,p_type text,p_name text,p_packing text,p_batch uuid,p_sheet text,p_row integer,p_raw jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_next integer; v_prefix text; v_id uuid;
begin
  select code into v_prefix from public.ci_warehouses where id=p_warehouse;
  if v_prefix is null then raise exception 'CI_WAREHOUSE_INVALID'; end if;
  update public.ci_product_code_counters set next_number=next_number+1 where warehouse_id=p_warehouse returning next_number-1 into v_next;
  insert into public.ci_products(warehouse_id,product_code,product_type,source_name,display_name,packing_size_raw,import_batch_id,source_sheet,source_row,raw_source)
  values(p_warehouse,v_prefix||'-'||lpad(v_next::text,4,'0'),p_type,p_name,p_name,p_packing,p_batch,p_sheet,p_row,p_raw)
  returning id into v_id;
  return v_id;
end $$;
create function public.ci_create_product(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_wh smallint; v_id uuid; v_actor uuid;
begin
  v_wh := (p_data->>'warehouse_id')::smallint;
  v_actor := ci_private.require_role(v_wh,array['admin','supervisor']);
  if p_data ? 'product_code' or p_data ? 'actor_id' then raise exception 'CI_SERVER_GENERATED_FIELDS'; end if;
  if nullif(btrim(p_data->>'current_ref'),'') is null or nullif(btrim(p_data->>'manufacturer_barcode'),'') is null then
    raise exception 'CI_PRODUCT_IDENTIFIERS_REQUIRED'; end if;
  v_id := ci_private.new_product(v_wh,p_data->>'product_type',p_data->>'source_name',p_data->>'packing_size_raw',null,null,null,null);
  if p_data ? 'display_name' then update public.ci_products set display_name=p_data->>'display_name' where id=v_id; end if;
  insert into public.ci_product_identifiers(product_id,warehouse_id,kind,value,source)
  values(v_id,v_wh,'REF_CURRENT',p_data->>'current_ref','manual'),
        (v_id,v_wh,'MANUFACTURER_BARCODE',p_data->>'manufacturer_barcode','manual');
  perform ci_private.audit(v_wh,'CREATE','ci_products',v_id::text);
  return v_id;
end $$;
create function public.ci_update_product(p_id uuid,p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_wh smallint;
begin
  select warehouse_id into v_wh from public.ci_products where id=p_id;
  perform ci_private.require_role(v_wh,array['admin','supervisor']);
  if p_data - array['display_name','packing_size_raw','active','product_type','base_stock_unit'] <> '{}'::jsonb then raise exception 'CI_PRODUCT_FIELD_NOT_EDITABLE'; end if;
  update public.ci_products set
    display_name=coalesce(p_data->>'display_name',display_name),
    packing_size_raw=case when p_data ? 'packing_size_raw' then p_data->>'packing_size_raw' else packing_size_raw end,
    active=coalesce((p_data->>'active')::boolean,active),
    product_type=coalesce(p_data->>'product_type',product_type),
    base_stock_unit=coalesce(p_data->>'base_stock_unit',base_stock_unit)
  where id=p_id;
end $$;
create function public.ci_delete_product(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_wh smallint;
begin
  select warehouse_id into v_wh from public.ci_products where id=p_id for update;
  perform ci_private.require_role(v_wh,array['admin']);
  if exists(select 1 from public.ci_stock_lots where product_id=p_id)
     or exists(select 1 from public.ci_invoice_lines where product_id=p_id) then
    raise exception 'CI_PRODUCT_HAS_OPERATIONAL_HISTORY';
  end if;
  delete from public.ci_product_platforms where product_id=p_id;
  delete from public.ci_product_relations where source_product_id=p_id or target_product_id=p_id;
  delete from public.ci_products where id=p_id;
  perform ci_private.audit(v_wh,'HARD_DELETE','ci_products',p_id::text);
end $$;
create function public.ci_save_product_identifier(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_wh smallint;v_id uuid;v_product uuid;
begin
  v_product := (p_data->>'product_id')::uuid;
  select warehouse_id into v_wh from public.ci_products where id=v_product;
  perform ci_private.require_role(v_wh,array['admin','supervisor']);
  if p_data ? 'id' then
    v_id := (p_data->>'id')::uuid;
    update public.ci_product_identifiers set kind=p_data->>'kind',value=p_data->>'value',source=coalesce(p_data->>'source','manual')
      where id=v_id and product_id=v_product;
    if not found then raise exception 'CI_IDENTIFIER_NOT_FOUND'; end if;
  else
    insert into public.ci_product_identifiers(product_id,warehouse_id,kind,value,source,approved)
    values(v_product,v_wh,p_data->>'kind',p_data->>'value',coalesce(p_data->>'source','manual'),true) returning id into v_id;
  end if;
  return v_id;
end $$;
create function public.ci_delete_product_identifier(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_wh smallint;v_kind text;
begin
  select warehouse_id,kind into v_wh,v_kind from public.ci_product_identifiers where id=p_id;
  perform ci_private.require_role(v_wh,array['admin','supervisor']);
  if v_kind='REF_CURRENT' then raise exception 'CI_CURRENT_REF_REQUIRED'; end if;
  delete from public.ci_product_identifiers where id=p_id;
end $$;
create function public.ci_save_product_relation(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_wh smallint;v_source uuid;v_id uuid;
begin
  v_source := (p_data->>'source_product_id')::uuid;
  select warehouse_id into v_wh from public.ci_products where id=v_source;
  perform ci_private.require_role(v_wh,array['admin','supervisor']);
  if p_data ? 'id' then
    v_id := (p_data->>'id')::uuid;
    update public.ci_product_relations set target_product_id=(p_data->>'target_product_id')::uuid,
      relation_type=p_data->>'relation_type',note=p_data->>'note'
      where id=v_id and source_product_id=v_source;
    if not found then raise exception 'CI_RELATION_NOT_FOUND'; end if;
  else
    insert into public.ci_product_relations(warehouse_id,source_product_id,target_product_id,relation_type,note,source_text)
    values(v_wh,v_source,(p_data->>'target_product_id')::uuid,p_data->>'relation_type',p_data->>'note',p_data->>'source_text') returning id into v_id;
  end if;
  return v_id;
end $$;
create function public.ci_delete_product_relation(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_wh smallint;
begin
  select warehouse_id into v_wh from public.ci_product_relations where id=p_id;
  perform ci_private.require_role(v_wh,array['admin','supervisor']);
  delete from public.ci_product_relations where id=p_id;
  if not found then raise exception 'CI_RELATION_NOT_FOUND'; end if;
end $$;
create function public.ci_save_product_platform(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_wh smallint;v_id uuid;v_product uuid;
begin
  v_product := (p_data->>'product_id')::uuid;
  select warehouse_id into v_wh from public.ci_products where id=v_product;
  perform ci_private.require_role(v_wh,array['admin','supervisor']);
  if p_data ? 'id' then
    v_id := (p_data->>'id')::uuid;
    update public.ci_product_platforms set platform_id=(p_data->>'platform_id')::uuid,source_text=p_data->>'source_text'
    where id=v_id and product_id=v_product;
    if not found then raise exception 'CI_PLATFORM_MAP_NOT_FOUND'; end if;
  else
    insert into public.ci_product_platforms(product_id,platform_id,warehouse_id,source_text)
    values(v_product,(p_data->>'platform_id')::uuid,v_wh,p_data->>'source_text') returning id into v_id;
  end if;
  return v_id;
end $$;
create function public.ci_delete_product_platform(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_wh smallint;
begin
  select warehouse_id into v_wh from public.ci_product_platforms where id=p_id;
  perform ci_private.require_role(v_wh,array['admin','supervisor']);
  delete from public.ci_product_platforms where id=p_id;
end $$;
create function public.ci_create_location(p_warehouse_id smallint,p_code text,p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform ci_private.require_role(p_warehouse_id,array['admin','supervisor']);
  insert into public.ci_locations(warehouse_id,code,name) values(p_warehouse_id,p_code,p_name) returning id into v_id;
  perform ci_private.audit(p_warehouse_id,'CREATE','ci_locations',v_id::text);
  return v_id;
end $$;
create function public.ci_create_vendor(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not ci_private.can_admin_any() then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  insert into public.ci_vendors(name) values(p_name) returning id into v_id;
  perform ci_private.audit(null,'CREATE','ci_vendors',v_id::text);
  return v_id;
end $$;
create function public.ci_upsert_user_access(p_user_id uuid,p_ephis_id text,p_warehouse_id smallint,p_role text,p_active boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
declare v_existing text;
begin
  -- Provisioning changes an account's cross-warehouse identity; require both admins.
  perform ci_private.require_role(1::smallint,array['admin']);
  perform ci_private.require_role(2::smallint,array['admin']);
  if not exists(select 1 from auth.users where id=p_user_id) or nullif(btrim(p_ephis_id),'') is null then
    raise exception 'CI_AUTH_USER_OR_EPHIS_INVALID'; end if;
  select ephis_id into v_existing from public.ci_user_profiles where user_id=p_user_id;
  if v_existing is not null and v_existing<>p_ephis_id then raise exception 'CI_EPHIS_ID_IMMUTABLE'; end if;
  insert into public.ci_user_profiles(user_id,ephis_id) values(p_user_id,p_ephis_id)
    on conflict (user_id) do update set active=true;
  insert into public.ci_user_access(user_id,warehouse_id,role,active)
    values(p_user_id,p_warehouse_id,p_role,p_active)
    on conflict (user_id,warehouse_id) do update set role=excluded.role,active=excluded.active;
  perform ci_private.audit(p_warehouse_id,'UPSERT','ci_user_access',p_user_id::text);
end $$;

-- Shared movement writer. The lot lock serializes all locations for that lot.
create function ci_private.add_movement(p_transaction uuid,p_warehouse smallint,p_lot uuid,p_location uuid,p_delta numeric)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_delta is null or p_delta=0 then raise exception 'CI_ZERO_MOVEMENT'; end if;
  insert into public.ci_stock_movement_lines(transaction_id,warehouse_id,lot_id,location_id,quantity_delta)
  values(p_transaction,p_warehouse,p_lot,p_location,p_delta);
end $$;
create function ci_private.idempotent_transaction(p_wh smallint,p_kind text,p_key text,p_hash text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;v_hash text;
begin
  select id,request_hash into v_id,v_hash from public.ci_stock_transactions
    where warehouse_id=p_wh and kind=p_kind and idempotency_key=p_key;
  if v_id is not null and v_hash<>p_hash then raise exception 'CI_IDEMPOTENCY_PAYLOAD_CONFLICT'; end if;
  return v_id;
end $$;

create function public.ci_create_invoice(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;v_actor uuid := auth.uid();v_line jsonb;v_product uuid;v_wh smallint;v_i integer:=0;
begin
  if v_actor is null then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  if jsonb_typeof(p_data->'lines')<>'array' or jsonb_array_length(p_data->'lines')=0 then raise exception 'CI_INVOICE_LINES_REQUIRED'; end if;
  for v_line in select value from jsonb_array_elements(p_data->'lines') loop
    v_product := (v_line->>'product_id')::uuid;
    select warehouse_id into v_wh from public.ci_products where id=v_product and active;
    perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
  end loop;
  insert into public.ci_invoices(vendor_id,invoice_number,invoice_date,po_number,created_by)
  values((p_data->>'vendor_id')::uuid,p_data->>'invoice_number',(p_data->>'invoice_date')::date,p_data->>'po_number',v_actor) returning id into v_id;
  for v_line in select value from jsonb_array_elements(p_data->'lines') loop
    v_i:=v_i+1; v_product := (v_line->>'product_id')::uuid;
    select warehouse_id into v_wh from public.ci_products where id=v_product;
    insert into public.ci_invoice_lines(invoice_id,warehouse_id,product_id,ordered_quantity,line_number)
    values(v_id,v_wh,v_product,(v_line->>'quantity')::numeric,v_i);
    perform ci_private.audit(v_wh,'CREATE','ci_invoices',v_id::text);
  end loop;
  return v_id;
end $$;

create function public.ci_confirm_receipt(p_invoice_id uuid,p_lines jsonb,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_line jsonb;v_wh smallint;v_product uuid;v_invoice_line uuid;v_qty numeric;
  v_lot uuid;v_location uuid;v_expiry date;v_lot_number text;v_receipt uuid;v_tx uuid;
  v_hash text:=md5(p_invoice_id::text||p_lines::text);
  v_existing uuid;v_result jsonb:='[]'::jsonb;v_ordered numeric;v_received numeric;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key)='' then raise exception 'CI_IDEMPOTENCY_KEY_REQUIRED'; end if;
  if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'CI_RECEIPT_LINES_REQUIRED'; end if;
  -- Stable invoice lock also serializes two partial receipts against the same ordered quantity.
  perform 1 from public.ci_invoices where id=p_invoice_id and status='open' for update;
  if not found then
    -- A fully received invoice may be retried with the same key.
    if not exists(select 1 from public.ci_invoices where id=p_invoice_id) then raise exception 'CI_INVOICE_NOT_FOUND'; end if;
  end if;
  perform ci_private.lock_products(array(
    select distinct il.product_id from jsonb_array_elements(p_lines) x
      join public.ci_invoice_lines il on il.id=(x.value->>'invoice_line_id')::uuid
      where il.invoice_id=p_invoice_id));
  for v_wh in select distinct il.warehouse_id from jsonb_array_elements(p_lines) x
      join public.ci_invoice_lines il on il.id=(x.value->>'invoice_line_id')::uuid
      order by il.warehouse_id loop
    perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
    v_existing:=ci_private.idempotent_transaction(v_wh,'receive',p_idempotency_key,v_hash);
    if v_existing is not null then
      v_result:=v_result||jsonb_build_object('warehouse_id',v_wh,'transaction_id',v_existing);
      continue;
    end if;
    if not exists(select 1 from public.ci_invoices where id=p_invoice_id and status='open') then raise exception 'CI_INVOICE_NOT_OPEN'; end if;
    insert into public.ci_receipts(invoice_id,warehouse_id,received_by)
      values(p_invoice_id,v_wh,auth.uid()) returning id into v_receipt;
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
      select coalesce(sum(quantity),0) into v_received from public.ci_receipt_lines where invoice_line_id=v_invoice_line;
      if v_received+v_qty>v_ordered then raise exception 'CI_RECEIPT_EXCEEDS_INVOICE'; end if;
      v_location:=(v_line->>'location_id')::uuid;
      if not exists(select 1 from public.ci_locations where id=v_location and warehouse_id=v_wh and active)
        then raise exception 'CI_LOCATION_INVALID'; end if;
      v_lot_number:=btrim(v_line->>'lot_number');
      v_expiry:=(v_line->>'expiry_date')::date;
      if v_lot_number is null or v_lot_number='' or v_expiry is null then raise exception 'CI_LOT_EXPIRY_REQUIRED'; end if;
      insert into public.ci_stock_lots(warehouse_id,product_id,lot_number,expiry_date)
        values(v_wh,v_product,v_lot_number,v_expiry)
        on conflict (warehouse_id,product_id,lot_number) do nothing;
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

create function public.ci_issue_stock(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_product uuid:=(p_data->>'product_id')::uuid;v_wh smallint;v_lot uuid:=(p_data->>'lot_id')::uuid;
  v_location uuid:=(p_data->>'location_id')::uuid;v_qty numeric:=(p_data->>'quantity')::numeric;
  v_key text:=p_data->>'idempotency_key';v_hash text:=md5(p_data::text);
  v_tx uuid;v_first_lot uuid;v_expiry date;v_purpose text:=p_data->>'purpose';
begin
  select warehouse_id into v_wh from public.ci_products where id=v_product and active;
  perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
  if v_qty is null or v_qty<=0 then raise exception 'CI_ISSUE_QUANTITY_INVALID'; end if;
  if v_key is null or btrim(v_key)='' then raise exception 'CI_IDEMPOTENCY_KEY_REQUIRED'; end if;
  perform ci_private.lock_products(array[v_product]);
  v_tx:=ci_private.idempotent_transaction(v_wh,'issue',v_key,v_hash);
  if v_tx is not null then return v_tx; end if;
  select expiry_date into v_expiry from public.ci_stock_lots where id=v_lot and product_id=v_product and warehouse_id=v_wh for update;
  if v_expiry is null or v_expiry<current_date then raise exception 'CI_EXPIRED_OR_INVALID_LOT'; end if;
  if not exists(select 1 from public.ci_locations where id=v_location and warehouse_id=v_wh and active) then raise exception 'CI_LOCATION_INVALID'; end if;
  select lot_id into v_first_lot from public.ci_stock_balances
    where product_id=v_product and warehouse_id=v_wh and expiry_date>=current_date and balance>0
    order by expiry_date,lot_number,lot_id limit 1;
  if v_first_lot is distinct from v_lot and nullif(btrim(p_data->>'override_reason'),'') is null then
    raise exception 'CI_FEFO_OVERRIDE_REASON_REQUIRED';
  end if;
  insert into public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id,reason,purpose)
    values(v_wh,'issue',v_key,v_hash,auth.uid(),p_data->>'override_reason',v_purpose) returning id into v_tx;
  perform ci_private.add_movement(v_tx,v_wh,v_lot,v_location,-v_qty);
  perform ci_private.audit(v_wh,'ISSUE','ci_stock_transactions',v_tx::text,p_data->>'override_reason');
  return v_tx;
end $$;

create function public.ci_transfer_stock(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_lot uuid:=(p_data->>'lot_id')::uuid;v_wh smallint;v_product uuid;
  v_from uuid:=(p_data->>'from_location_id')::uuid;v_to uuid:=(p_data->>'to_location_id')::uuid;
  v_qty numeric:=(p_data->>'quantity')::numeric;v_key text:=p_data->>'idempotency_key';
  v_hash text:=md5(p_data::text);v_tx uuid;
begin
  select warehouse_id,product_id into v_wh,v_product from public.ci_stock_lots where id=v_lot;
  perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
  if v_qty is null or v_qty<=0 or v_from=v_to then raise exception 'CI_TRANSFER_INVALID'; end if;
  if v_key is null or btrim(v_key)='' then raise exception 'CI_IDEMPOTENCY_KEY_REQUIRED'; end if;
  perform ci_private.lock_products(array[v_product]);
  v_tx:=ci_private.idempotent_transaction(v_wh,'transfer',v_key,v_hash);
  if v_tx is not null then return v_tx; end if;
  if (select count(*) from public.ci_locations where id in (v_from,v_to) and warehouse_id=v_wh and active)<>2 then
    raise exception 'CI_LOCATION_INVALID'; end if;
  insert into public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id)
    values(v_wh,'transfer',v_key,v_hash,auth.uid()) returning id into v_tx;
  perform ci_private.add_movement(v_tx,v_wh,v_lot,v_from,-v_qty);
  perform ci_private.add_movement(v_tx,v_wh,v_lot,v_to,v_qty);
  perform ci_private.audit(v_wh,'TRANSFER','ci_stock_transactions',v_tx::text);
  return v_tx;
end $$;

create function public.ci_adjust_stock(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_lot uuid:=(p_data->>'lot_id')::uuid;v_wh smallint;v_product uuid;
  v_location uuid:=(p_data->>'location_id')::uuid;v_delta numeric:=(p_data->>'quantity_delta')::numeric;
  v_reason text:=p_data->>'reason';v_key text:=p_data->>'idempotency_key';
  v_hash text:=md5(p_data::text);v_tx uuid;
begin
  select warehouse_id,product_id into v_wh,v_product from public.ci_stock_lots where id=v_lot;
  perform ci_private.require_role(v_wh,array['admin','supervisor']);
  if v_delta is null or v_delta=0 or nullif(btrim(v_reason),'') is null then raise exception 'CI_ADJUSTMENT_REASON_OR_QUANTITY_INVALID'; end if;
  if v_key is null or btrim(v_key)='' then raise exception 'CI_IDEMPOTENCY_KEY_REQUIRED'; end if;
  perform ci_private.lock_products(array[v_product]);
  v_tx:=ci_private.idempotent_transaction(v_wh,'adjustment',v_key,v_hash);
  if v_tx is not null then return v_tx; end if;
  if not exists(select 1 from public.ci_locations where id=v_location and warehouse_id=v_wh and active) then raise exception 'CI_LOCATION_INVALID'; end if;
  insert into public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id,reason)
    values(v_wh,'adjustment',v_key,v_hash,auth.uid(),v_reason) returning id into v_tx;
  perform ci_private.add_movement(v_tx,v_wh,v_lot,v_location,v_delta);
  perform ci_private.audit(v_wh,'ADJUST','ci_stock_transactions',v_tx::text,v_reason);
  return v_tx;
end $$;

create function public.ci_reverse_transaction(p_source_id uuid,p_reason text,p_idempotency_key text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_source public.ci_stock_transactions%rowtype;v_tx uuid;v_line record;
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
  perform ci_private.audit(v_source.warehouse_id,'REVERSE','ci_stock_transactions',v_tx::text,p_reason);
  return v_tx;
end $$;

create function public.ci_dispose_expired_stock(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_lot uuid:=(p_data->>'lot_id')::uuid;v_wh smallint;v_product uuid;v_expiry date;
  v_location uuid:=(p_data->>'location_id')::uuid;v_qty numeric:=(p_data->>'quantity')::numeric;
  v_reason text:=p_data->>'reason';v_key text:=p_data->>'idempotency_key';
  v_hash text:=md5(p_data::text);v_tx uuid;
begin
  select warehouse_id,product_id,expiry_date into v_wh,v_product,v_expiry from public.ci_stock_lots where id=v_lot;
  perform ci_private.require_role(v_wh,array['admin','supervisor']);
  if v_expiry>=current_date then raise exception 'CI_LOT_NOT_EXPIRED'; end if;
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

create function public.ci_create_stock_count(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_wh smallint:=(p_data->>'warehouse_id')::smallint;v_count uuid;v_line jsonb;
  v_lot uuid;v_location uuid;v_product uuid;v_balance numeric;v_movement_count bigint;
begin
  perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
  if jsonb_typeof(p_data->'lines')<>'array' or jsonb_array_length(p_data->'lines')=0 then raise exception 'CI_COUNT_LINES_REQUIRED'; end if;
  perform ci_private.lock_products(array(
    select distinct l.product_id from jsonb_array_elements(p_data->'lines') x
      join public.ci_stock_lots l on l.id=(x.value->>'lot_id')::uuid where l.warehouse_id=v_wh));
  insert into public.ci_stock_counts(warehouse_id,created_by,note)
    values(v_wh,auth.uid(),p_data->>'note') returning id into v_count;
  for v_line in select value from jsonb_array_elements(p_data->'lines') loop
    v_lot:=(v_line->>'lot_id')::uuid;v_location:=(v_line->>'location_id')::uuid;
    if not exists(select 1 from public.ci_stock_lots where id=v_lot and warehouse_id=v_wh)
      or not exists(select 1 from public.ci_locations where id=v_location and warehouse_id=v_wh)
      then raise exception 'CI_COUNT_SCOPE_INVALID'; end if;
    select coalesce(sum(quantity_delta),0),count(*) into v_balance,v_movement_count
      from public.ci_stock_movement_lines where lot_id=v_lot and location_id=v_location;
    insert into public.ci_stock_count_lines(count_id,warehouse_id,lot_id,location_id,snapshot_quantity,snapshot_movement_count)
      values(v_count,v_wh,v_lot,v_location,v_balance,v_movement_count);
  end loop;
  perform ci_private.audit(v_wh,'SNAPSHOT','ci_stock_counts',v_count::text);
  return v_count;
end $$;
create function public.ci_set_stock_count_line(p_line_id uuid,p_physical_quantity numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare v_wh smallint;v_status text;
begin
  select cl.warehouse_id,c.status into v_wh,v_status from public.ci_stock_count_lines cl
    join public.ci_stock_counts c on c.id=cl.count_id where cl.id=p_line_id;
  perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
  if v_status<>'draft' or p_physical_quantity is null or p_physical_quantity<0 then raise exception 'CI_COUNT_LINE_INVALID'; end if;
  update public.ci_stock_count_lines set physical_quantity=p_physical_quantity where id=p_line_id;
  perform ci_private.audit(v_wh,'ENTER_PHYSICAL','ci_stock_count_lines',p_line_id::text);
end $$;
create function public.ci_approve_stock_count(p_count_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_count public.ci_stock_counts%rowtype;v_line record;v_balance numeric;v_n bigint;
  v_tx uuid;v_changed boolean:=false;
begin
  select * into v_count from public.ci_stock_counts where id=p_count_id for update;
  if not found then raise exception 'CI_COUNT_NOT_FOUND'; end if;
  perform ci_private.require_role(v_count.warehouse_id,array['admin','supervisor']);
  if v_count.status<>'draft' or nullif(btrim(p_reason),'') is null then raise exception 'CI_COUNT_APPROVAL_INVALID'; end if;
  if exists(select 1 from public.ci_stock_count_lines where count_id=p_count_id and physical_quantity is null) then raise exception 'CI_COUNT_INCOMPLETE'; end if;
  perform ci_private.lock_products(array(
    select distinct l.product_id from public.ci_stock_count_lines cl
    join public.ci_stock_lots l on l.id=cl.lot_id where cl.count_id=p_count_id));
  for v_line in select * from public.ci_stock_count_lines where count_id=p_count_id order by lot_id,location_id loop
    select coalesce(sum(quantity_delta),0),count(*) into v_balance,v_n from public.ci_stock_movement_lines
      where lot_id=v_line.lot_id and location_id=v_line.location_id;
    if v_n<>v_line.snapshot_movement_count or v_balance<>v_line.snapshot_quantity then v_changed:=true; end if;
  end loop;
  if v_changed then
    update public.ci_stock_counts set status='stale' where id=p_count_id;
    perform ci_private.audit(v_count.warehouse_id,'STALE','ci_stock_counts',p_count_id::text,'Ledger changed after snapshot');
    return jsonb_build_object('status','stale','transaction_id',null);
  end if;
  insert into public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id,reason)
    values(v_count.warehouse_id,'adjustment','count:'||p_count_id::text,
      md5(p_count_id::text||p_reason),auth.uid(),p_reason) returning id into v_tx;
  for v_line in select * from public.ci_stock_count_lines where count_id=p_count_id order by lot_id,location_id loop
    if v_line.physical_quantity<>v_line.snapshot_quantity then
      perform ci_private.add_movement(v_tx,v_count.warehouse_id,v_line.lot_id,v_line.location_id,
        v_line.physical_quantity-v_line.snapshot_quantity);
    end if;
  end loop;
  update public.ci_stock_counts set status='approved',approved_by=auth.uid(),approved_at=now() where id=p_count_id;
  perform ci_private.audit(v_count.warehouse_id,'APPROVE','ci_stock_counts',p_count_id::text,p_reason);
  return jsonb_build_object('status','approved','transaction_id',v_tx);
end $$;

-- Limit PostgREST exposure to deliberate entry points.
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.ci_create_product(jsonb),public.ci_update_product(uuid,jsonb),public.ci_delete_product(uuid),
  public.ci_save_product_identifier(jsonb),public.ci_delete_product_identifier(uuid),
  public.ci_save_product_relation(jsonb),public.ci_delete_product_relation(uuid),
  public.ci_save_product_platform(jsonb),public.ci_delete_product_platform(uuid),
  public.ci_create_location(smallint,text,text),public.ci_create_vendor(text),
  public.ci_upsert_user_access(uuid,text,smallint,text,boolean),
  public.ci_create_invoice(jsonb),public.ci_confirm_receipt(uuid,jsonb,text),
  public.ci_issue_stock(jsonb),public.ci_transfer_stock(jsonb),public.ci_adjust_stock(jsonb),
  public.ci_reverse_transaction(uuid,text,text),public.ci_dispose_expired_stock(jsonb),
  public.ci_create_stock_count(jsonb),public.ci_set_stock_count_line(uuid,numeric),public.ci_approve_stock_count(uuid,text)
to authenticated;
-- SECURITY DEFINER helpers must stay private to this non-exposed schema.
revoke all on all functions in schema ci_private from public,anon,authenticated;
grant execute on function ci_private.can_read(smallint),ci_private.can_admin_any(),ci_private.has_role(smallint,text[]) to authenticated;
