-- Shared CHE + IMM physical location master. All historical IDs are preserved.
-- The legacy ci_locations.warehouse_id remains provenance for paused environment history.
-- Eligibility for CHE/IMM stock comes exclusively from ci_location_warehouses.
-- IMPORTANT: do not treat similarly named existing locations as one physical place.
--
-- Safety: transaction migration, FK backfill, zero deletes. Apply only after read-only
-- Production preflight and after confirming the correct Supabase project.
--
-- Require the expected canonical tables before any DDL.
do $preflight$
begin
  if to_regclass('public.ci_locations') is null
    or to_regclass('public.ci_products') is null
    or to_regclass('public.ci_receipt_lines') is null
    or to_regclass('public.ci_stock_movement_lines') is null
    or to_regclass('public.ci_stock_count_lines') is null
    or to_regclass('public.ci_location_env_configs') is null
  then raise exception 'CI_SHARED_LOCATIONS_SCHEMA_PRECHECK_FAILED'; end if;
end $preflight$;

-- Both warehouses can use the same physical location ID. Legacy rows are NOT
-- cloned and the mapping has no stock quantities; Product/LOT ledgers remain
-- partitioned by their existing warehouse_id.
create table public.ci_location_warehouses (
  location_id uuid not null references public.ci_locations(id),
  warehouse_id smallint not null references public.ci_warehouses(id),
  primary key(location_id, warehouse_id)
);
insert into public.ci_location_warehouses(location_id,warehouse_id)
select l.id,w.id from public.ci_locations l cross join public.ci_warehouses w;

-- New locations become available to BOTH warehouses atomically.
create function ci_private.add_shared_location_warehouses() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.ci_location_warehouses(location_id,warehouse_id)
  select new.id,id from public.ci_warehouses;
  return new;
end $$;
revoke all on function ci_private.add_shared_location_warehouses() from public,anon,authenticated;
create trigger ci_locations_share_after_insert after insert on public.ci_locations
  for each row execute function ci_private.add_shared_location_warehouses();

-- Keep legacy physical identifiers stable. Duplicate codes already in the two
-- separate catalogs are NOT merged automatically; prevent NEW duplicates.
create function ci_private.guard_shared_location_code() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists(
    select 1 from public.ci_locations existing
    where existing.id <> new.id and lower(btrim(existing.code)) = lower(btrim(new.code))
  ) then raise exception 'CI_LOCATION_CODE_EXISTS'; end if;
  return new;
end $$;
revoke all on function ci_private.guard_shared_location_code() from public,anon,authenticated;
create trigger ci_locations_unique_new_code before insert or update of code on public.ci_locations
  for each row execute function ci_private.guard_shared_location_code();

-- Location FK validates the warehouse/location association rather than requiring
-- that the location was created by that warehouse.
do $constraints$
declare v record;
begin
  for v in
    select conrelid::regclass as owner_table, conname
    from pg_constraint
    where contype='f' and confrelid='public.ci_locations'::regclass
      and conrelid in ('public.ci_products'::regclass,'public.ci_receipt_lines'::regclass,
        'public.ci_stock_movement_lines'::regclass,'public.ci_stock_count_lines'::regclass)
  loop
    execute format('alter table %s drop constraint %I', v.owner_table,v.conname);
  end loop;
end $constraints$;
alter table public.ci_products add constraint ci_products_default_location_fk
  foreign key(default_location_id,warehouse_id)
  references public.ci_location_warehouses(location_id,warehouse_id);
alter table public.ci_receipt_lines add constraint ci_receipt_lines_shared_location_fk
  foreign key(location_id,warehouse_id)
  references public.ci_location_warehouses(location_id,warehouse_id);
alter table public.ci_stock_movement_lines add constraint ci_stock_movement_lines_shared_location_fk
  foreign key(location_id,warehouse_id)
  references public.ci_location_warehouses(location_id,warehouse_id);
alter table public.ci_stock_count_lines add constraint ci_stock_count_lines_shared_location_fk
  foreign key(location_id,warehouse_id)
  references public.ci_location_warehouses(location_id,warehouse_id);

alter table public.ci_locations drop constraint ci_locations_parent_fk;
alter table public.ci_locations add constraint ci_locations_parent_fk
  foreign key(parent_location_id) references public.ci_locations(id);

-- A location is physically shared, but users still need at least one ACTIVE
-- CHE/IMM account to read it; creating/editing requires supervisor/admin.
drop policy ci_locations_read on public.ci_locations;
create policy ci_locations_read on public.ci_locations for select to authenticated
using (ci_private.can_read(1::smallint) or ci_private.can_read(2::smallint));

create function ci_private.location_available_for_warehouse(
  p_wh smallint, p_id uuid, p_active boolean default true
) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.ci_location_warehouses link
    join public.ci_locations l on l.id=link.location_id
    where link.warehouse_id=p_wh and link.location_id=p_id
      and (not p_active or l.active)
  )
$$;
revoke all on function ci_private.location_available_for_warehouse(smallint,uuid,boolean)
  from public,anon,authenticated;

create function ci_private.require_shared_location_manager() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (
    ci_private.has_role(1::smallint,array['admin','supervisor'])
    or ci_private.has_role(2::smallint,array['admin','supervisor'])
  ) then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
end $$;
revoke all on function ci_private.require_shared_location_manager() from public,anon,authenticated;

-- ci_private.guard_location_hierarchy
create or replace function ci_private.guard_location_hierarchy() returns trigger language plpgsql set search_path = '' as $$
declare v_parent public.ci_locations;
begin
  if tg_op = 'UPDATE' and new.warehouse_id is distinct from old.warehouse_id then
    raise exception 'CI_LOCATION_WAREHOUSE_IMMUTABLE';
  end if;
  if new.parent_location_id is null then return new; end if;
  if new.parent_location_id = new.id then raise exception 'CI_LOCATION_PARENT_INVALID'; end if;
  -- The share lock makes a concurrent change that would give the parent a parent of its own (or a child) wait for this row.
  select * into v_parent from public.ci_locations where id = new.parent_location_id for share;
  if not found then raise exception 'CI_LOCATION_PARENT_INVALID'; end if;
  -- Maximum depth 2 (a parent is always top-level), which also makes cycles impossible.
  if v_parent.parent_location_id is not null then raise exception 'CI_LOCATION_HIERARCHY_DEPTH'; end if;
  if tg_op = 'UPDATE' and exists (select 1 from public.ci_locations c where c.parent_location_id = new.id) then
    raise exception 'CI_LOCATION_HAS_CHILDREN';
  end if;
  -- An active child may not appear under an inactive parent: checked here, under the parent's share lock, because the RPCs'
  -- own pre-checks read the parent without a lock and could race a concurrent deactivation of that parent.
  if new.active and not v_parent.active then
    if tg_op = 'INSERT' then raise exception 'CI_LOCATION_PARENT_INACTIVE'; end if;
    if new.parent_location_id is distinct from old.parent_location_id or not old.active then raise exception 'CI_LOCATION_PARENT_INACTIVE'; end if;
  end if;
  return new;
end $$;

-- ci_private.guard_movement_location_active
create or replace function ci_private.guard_movement_location_active() returns trigger language plpgsql set search_path = '' as $$
declare v_active boolean;
begin
  if new.quantity_delta <= 0 then return new; end if;
  select ci_private.location_available_for_warehouse(new.warehouse_id, new.location_id) into v_active;
  if not coalesce(v_active, false) then raise exception 'CI_LOCATION_INACTIVE'; end if;
  return new;
end $$;

-- ci_private.lock_location_for_supervisor
create or replace function ci_private.lock_location_for_supervisor(p_location_id uuid) returns public.ci_locations
language plpgsql security definer set search_path = '' as $$
declare
  v_warehouse smallint;
  v_row public.ci_locations;
begin
  select warehouse_id into v_warehouse from public.ci_locations where id = p_location_id;
  if not found then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  perform ci_private.require_shared_location_manager();
  select * into v_row from public.ci_locations where id = p_location_id for update;
  return v_row;
end $$;

-- ci_private.ci_create_location_v2
create or replace function ci_private.ci_create_location_v2(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_warehouse smallint := nullif(p->>'warehouse_id', '')::smallint;
  v_parent uuid := nullif(p->>'parent_location_id', '')::uuid;
  v_parent_active boolean;
  v_id uuid;
begin
  perform ci_private.require_role(v_warehouse, array['admin','supervisor']);
  if v_parent is not null then
    select active into v_parent_active from public.ci_locations where id = v_parent;
    if not found then raise exception 'CI_LOCATION_PARENT_INVALID'; end if;
    if not v_parent_active then raise exception 'CI_LOCATION_PARENT_INACTIVE'; end if;
  end if;
  begin
    insert into public.ci_locations (warehouse_id, code, name, location_type, parent_location_id, room, description, storage_condition, portal_equipment_url, portal_equipment_label, updated_by)
    values (
      v_warehouse, btrim(p->>'code'), btrim(p->>'name'), coalesce(nullif(btrim(p->>'location_type'), ''), 'other'), v_parent,
      nullif(btrim(p->>'room'), ''), nullif(btrim(p->>'description'), ''), nullif(btrim(p->>'storage_condition'), ''),
      nullif(btrim(p->>'portal_equipment_url'), ''), nullif(btrim(p->>'portal_equipment_label'), ''), auth.uid()
    ) returning id into v_id;
  exception
    when unique_violation then raise exception 'CI_LOCATION_CODE_EXISTS';
    when check_violation or not_null_violation then raise exception 'CI_LOCATION_FIELD_INVALID';
  end;
  -- Monitoring moved to Lab Management Portal; never create a duplicate config here.
  return v_id;
end $$;

-- ci_private.ci_update_location
create or replace function ci_private.ci_update_location(p_id uuid, p jsonb, p_expected_updated_at timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.ci_locations;
  v_parent uuid;
  v_parent_active boolean;
  v_portal_url text;
begin
  v_row := ci_private.lock_location_for_supervisor(p_id);
  if p_expected_updated_at is null or v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'CI_STALE_UPDATE';
  end if;
  v_parent := case when p ? 'parent_location_id' then nullif(p->>'parent_location_id', '')::uuid else v_row.parent_location_id end;
  if v_parent is not null and v_parent is distinct from v_row.parent_location_id then
    select active into v_parent_active from public.ci_locations where id = v_parent;
    if not found then raise exception 'CI_LOCATION_PARENT_INVALID'; end if;
    if not v_parent_active then raise exception 'CI_LOCATION_PARENT_INACTIVE'; end if;
  end if;
  v_portal_url := case when p ? 'portal_equipment_url' then nullif(btrim(p->>'portal_equipment_url'), '') else v_row.portal_equipment_url end;
  begin
    update public.ci_locations set
      code = case when p ? 'code' then btrim(p->>'code') else code end,
      name = case when p ? 'name' then btrim(p->>'name') else name end,
      location_type = case when p ? 'location_type' then coalesce(nullif(btrim(p->>'location_type'), ''), 'other') else location_type end,
      parent_location_id = v_parent,
      room = case when p ? 'room' then nullif(btrim(p->>'room'), '') else room end,
      description = case when p ? 'description' then nullif(btrim(p->>'description'), '') else description end,
      storage_condition = case when p ? 'storage_condition' then nullif(btrim(p->>'storage_condition'), '') else storage_condition end,
      portal_equipment_url = v_portal_url,
      portal_equipment_label = case when v_portal_url is null then null when p ? 'portal_equipment_label' then nullif(btrim(p->>'portal_equipment_label'), '') else portal_equipment_label end,
      updated_at = ci_private.next_updated_at(v_row.updated_at),
      updated_by = auth.uid()
    where id = p_id;
  exception
    when unique_violation then raise exception 'CI_LOCATION_CODE_EXISTS';
    when check_violation or not_null_violation then raise exception 'CI_LOCATION_FIELD_INVALID';
  end;
  -- Legacy environment settings remain untouched; monitoring is managed centrally.
end $$;

-- public.ci_create_location
create or replace function ci_private.ci_create_location(p_warehouse_id smallint,p_code text,p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform ci_private.require_role(p_warehouse_id,array['admin','supervisor']);
  insert into public.ci_locations(warehouse_id,code,name) values(p_warehouse_id,p_code,p_name) returning id into v_id;
  perform ci_private.audit(p_warehouse_id,'CREATE','ci_locations',v_id::text);
  return v_id;
end $$;

-- ci_private.ci_set_location_active
create or replace function ci_private.ci_set_location_active(p_id uuid, p_active boolean, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.ci_locations;
  v_reason text := nullif(btrim(p_reason), '');
begin
  v_row := ci_private.lock_location_for_supervisor(p_id);
  if p_active is null or v_reason is null then raise exception 'CI_REASON_REQUIRED'; end if;
  if v_row.active = p_active then return; end if;
  if p_active then
    if v_row.parent_location_id is not null and not exists (select 1 from public.ci_locations where id = v_row.parent_location_id and active) then
      raise exception 'CI_LOCATION_PARENT_INACTIVE';
    end if;
  else
    if exists (select 1 from public.ci_locations c where c.parent_location_id = p_id and c.active) then
      raise exception 'CI_LOCATION_HAS_ACTIVE_CHILDREN';
    end if;
    -- Stock is derived from the ledger, never stored on the location. Balances cannot go negative, so any non-zero LOT balance blocks it.
    if exists (
      select 1 from public.ci_stock_movement_lines m where m.location_id = p_id
      group by m.lot_id having sum(m.quantity_delta) <> 0
    ) then raise exception 'CI_LOCATION_HAS_STOCK'; end if;
    if exists (select 1 from public.ci_products p where p.default_location_id = p_id and p.active) then
      raise exception 'CI_LOCATION_IS_PRODUCT_DEFAULT';
    end if;
  end if;
  update public.ci_locations set active = p_active, updated_at = ci_private.next_updated_at(v_row.updated_at), updated_by = auth.uid() where id = p_id;
  perform ci_private.audit(v_row.warehouse_id, case when p_active then 'ACTIVATE' else 'DEACTIVATE' end, 'ci_locations', p_id::text, v_reason);
end $$;

-- ci_private.ci_create_product
create or replace function ci_private.ci_create_product(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_wh smallint; v_id uuid; v_actor uuid; v_default_location uuid;
begin
  v_wh := (p_data->>'warehouse_id')::smallint;
  v_actor := ci_private.require_role(v_wh,array['admin','supervisor']);
  if p_data ? 'product_code' or p_data ? 'actor_id' then raise exception 'CI_SERVER_GENERATED_FIELDS'; end if;
  if nullif(btrim(p_data->>'current_ref'),'') is null or nullif(btrim(p_data->>'manufacturer_barcode'),'') is null then
    raise exception 'CI_PRODUCT_IDENTIFIERS_REQUIRED'; end if;
  begin v_default_location := nullif(p_data->>'default_location_id','')::uuid;
  exception when invalid_text_representation then raise exception 'CI_LOCATION_INVALID'; end;
  if v_default_location is not null and not exists(select 1 from public.ci_locations where id=v_default_location and active and ci_private.location_available_for_warehouse(v_wh,v_default_location)) then
    raise exception 'CI_LOCATION_INVALID';
  end if;
  v_id := ci_private.new_product(v_wh,p_data->>'product_type',p_data->>'source_name',p_data->>'packing_size_raw',null,null,null,null);
  if p_data ? 'display_name' then update public.ci_products set display_name=p_data->>'display_name' where id=v_id; end if;
  if v_default_location is not null then update public.ci_products set default_location_id=v_default_location where id=v_id; end if;
  insert into public.ci_product_identifiers(product_id,warehouse_id,kind,value,source)
  values(v_id,v_wh,'REF_CURRENT',p_data->>'current_ref','manual'),
        (v_id,v_wh,'MANUFACTURER_BARCODE',p_data->>'manufacturer_barcode','manual');
  perform ci_private.audit(v_wh,'CREATE','ci_products',v_id::text);
  return v_id;
end $$;

-- ci_private.ci_update_product
create or replace function ci_private.ci_update_product(p_id uuid,p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_wh smallint; v_has_default boolean := p_data ? 'default_location_id'; v_default_location uuid;
begin
  select warehouse_id into v_wh from public.ci_products where id=p_id;
  perform ci_private.require_role(v_wh,array['admin','supervisor']);
  if p_data - array['display_name','packing_size_raw','active','product_type','base_stock_unit','default_location_id'] <> '{}'::jsonb then raise exception 'CI_PRODUCT_FIELD_NOT_EDITABLE'; end if;
  if v_has_default then
    begin v_default_location := nullif(p_data->>'default_location_id','')::uuid;
    exception when invalid_text_representation then raise exception 'CI_LOCATION_INVALID'; end;
    -- Clearing (NULL) is always allowed; only assigning a specific Location requires it to exist, match the
    -- Product's own warehouse, and be active right now.
    if v_default_location is not null and not exists(select 1 from public.ci_locations where id=v_default_location and active and ci_private.location_available_for_warehouse(v_wh,v_default_location)) then
      raise exception 'CI_LOCATION_INVALID';
    end if;
  end if;
  update public.ci_products set
    display_name=coalesce(p_data->>'display_name',display_name),
    packing_size_raw=case when p_data ? 'packing_size_raw' then p_data->>'packing_size_raw' else packing_size_raw end,
    active=coalesce((p_data->>'active')::boolean,active),
    product_type=coalesce(p_data->>'product_type',product_type),
    base_stock_unit=coalesce(p_data->>'base_stock_unit',base_stock_unit),
    default_location_id=case when v_has_default then v_default_location else default_location_id end
  where id=p_id;
end $$;

-- public.ci_confirm_receipt
create or replace function ci_private.ci_confirm_receipt(p_invoice_id uuid,p_lines jsonb,p_idempotency_key text)
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
      if not exists(select 1 from public.ci_locations where id=v_location and active and ci_private.location_available_for_warehouse(v_wh,v_location))
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

-- public.ci_issue_stock
create or replace function ci_private.ci_issue_stock(p_data jsonb)
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
  if not exists(select 1 from public.ci_locations where id=v_location and active and ci_private.location_available_for_warehouse(v_wh,v_location)) then raise exception 'CI_LOCATION_INVALID'; end if;
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

-- public.ci_transfer_stock
create or replace function ci_private.ci_transfer_stock(p_data jsonb)
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
  if not (ci_private.location_available_for_warehouse(v_wh,v_from) and ci_private.location_available_for_warehouse(v_wh,v_to)) then
    raise exception 'CI_LOCATION_INVALID'; end if;
  insert into public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id)
    values(v_wh,'transfer',v_key,v_hash,auth.uid()) returning id into v_tx;
  perform ci_private.add_movement(v_tx,v_wh,v_lot,v_from,-v_qty);
  perform ci_private.add_movement(v_tx,v_wh,v_lot,v_to,v_qty);
  perform ci_private.audit(v_wh,'TRANSFER','ci_stock_transactions',v_tx::text);
  return v_tx;
end $$;

-- public.ci_create_stock_count
create or replace function ci_private.ci_create_stock_count(p_data jsonb)
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
      or not exists(select 1 from public.ci_locations where id=v_location and ci_private.location_available_for_warehouse(v_wh,v_location, false))
      then raise exception 'CI_COUNT_SCOPE_INVALID'; end if;
    select coalesce(sum(quantity_delta),0),count(*) into v_balance,v_movement_count
      from public.ci_stock_movement_lines where lot_id=v_lot and location_id=v_location;
    insert into public.ci_stock_count_lines(count_id,warehouse_id,lot_id,location_id,snapshot_quantity,snapshot_movement_count)
      values(v_count,v_wh,v_lot,v_location,v_balance,v_movement_count);
  end loop;
  perform ci_private.audit(v_wh,'SNAPSHOT','ci_stock_counts',v_count::text);
  return v_count;
end $$;

-- ci_private.ci_adjust_stock
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
  if not exists(select 1 from public.ci_locations where id = v_location and active and ci_private.location_available_for_warehouse(v_wh, v_location)) then raise exception 'CI_LOCATION_INVALID'; end if;

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

-- ci_private.ci_edit_receipt
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
-- Re-publishing is not necessary: existing public ci_ wrappers forward to
-- SECURITY DEFINER ci_private functions and remain unchanged.
notify pgrst,'reload schema';
