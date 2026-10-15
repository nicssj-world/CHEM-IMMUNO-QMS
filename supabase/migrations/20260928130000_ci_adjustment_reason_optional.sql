create or replace function public.ci_adjust_stock(p_data jsonb)
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
    select warehouse_id,product_id,lot_number,expiry_date
      into v_wh,v_product,v_lot_number,v_lot_expiry
      from public.ci_stock_lots where id=v_lot for update;
    if not found then raise exception 'CI_STOCK_LOT_NOT_FOUND'; end if;
    if nullif(p_data->>'product_id','') is not null and v_product<>(p_data->>'product_id')::uuid then
      raise exception 'CI_ADJUSTMENT_PRODUCT_MISMATCH';
    end if;
    if nullif(p_data->>'warehouse_id','') is not null and v_wh<>(p_data->>'warehouse_id')::smallint then
      raise exception 'CI_WAREHOUSE_INVALID';
    end if;
    if nullif(p_data->>'lot_number','') is not null and v_lot_number<>btrim(p_data->>'lot_number') then
      raise exception 'CI_ADJUSTMENT_LOT_MISMATCH';
    end if;
    if nullif(p_data->>'expiry_date','') is not null and v_lot_expiry<>(p_data->>'expiry_date')::date then
      raise exception 'CI_LOT_EXPIRY_CONFLICT';
    end if;
  else
    if v_wh is null or v_product is null then raise exception 'CI_PRODUCT_NOT_FOUND'; end if;
    if v_lot_number is null or v_expiry is null then raise exception 'CI_LOT_EXPIRY_REQUIRED'; end if;
    select warehouse_id into v_product_wh
      from public.ci_products where id=v_product and active;
    if not found then raise exception 'CI_PRODUCT_NOT_FOUND'; end if;
    if v_product_wh<>v_wh then raise exception 'CI_PRODUCT_CODE_WAREHOUSE_MISMATCH'; end if;
  end if;

  perform ci_private.require_role(v_wh,array['admin','supervisor']);
  if v_delta is null or v_delta=0 then raise exception 'CI_ADJUSTMENT_QUANTITY_INVALID'; end if;
  if v_key is null or btrim(v_key)='' then raise exception 'CI_IDEMPOTENCY_KEY_REQUIRED'; end if;

  perform ci_private.lock_products(array[v_product]);
  v_tx:=ci_private.idempotent_transaction(v_wh,'adjustment',v_key,v_hash);
  if v_tx is not null then return v_tx; end if;
  if not exists(select 1 from public.ci_locations where id=v_location and warehouse_id=v_wh and active) then
    raise exception 'CI_LOCATION_INVALID';
  end if;

  if v_lot is null then
    if v_delta<0 then raise exception 'CI_ADJUSTMENT_NEW_LOT_MUST_INCREASE'; end if;
    insert into public.ci_stock_lots(warehouse_id,product_id,lot_number,expiry_date)
      values(v_wh,v_product,v_lot_number,v_expiry)
      on conflict (warehouse_id,product_id,lot_number) do nothing;
    select id,expiry_date into v_lot,v_lot_expiry
      from public.ci_stock_lots
      where warehouse_id=v_wh and product_id=v_product and lot_number=v_lot_number
      for update;
    if v_lot is null or v_lot_expiry<>v_expiry then raise exception 'CI_LOT_EXPIRY_CONFLICT'; end if;
  end if;

  insert into public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id,reason)
    values(v_wh,'adjustment',v_key,v_hash,auth.uid(),v_reason) returning id into v_tx;
  perform ci_private.add_movement(v_tx,v_wh,v_lot,v_location,v_delta);
  perform ci_private.audit(v_wh,'ADJUST','ci_stock_transactions',v_tx::text,v_reason);
  return v_tx;
end $$;
