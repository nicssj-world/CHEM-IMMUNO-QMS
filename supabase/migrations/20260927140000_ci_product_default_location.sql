-- Product -> Default Location: an OPTIONAL preferred/recommended storage location for a Product, used only to
-- preselect a location when receiving. It is not where the product's stock actually is - actual stock remains
-- determined exclusively by the append-only ci_stock_movement_lines ledger (via ci_stock_balances), unchanged by
-- this migration. A Product may still have stock in many Locations at once, and moving stock never touches this
-- column. No automatic backfill: every existing row gets NULL.
--
-- ci_create_product/ci_update_product were Phase 1's public SECURITY DEFINER functions; 20260924133953 moved every
-- such function to ci_private and generated a SECURITY INVOKER public wrapper for it (the same shape publish_rpc
-- builds for newer code), so their live implementations are ci_private.ci_create_product/ci_update_product today.
-- They are extended here with CREATE OR REPLACE targeting ci_private directly - the already-published public
-- wrapper keeps resolving to them unchanged. Signatures are unchanged - the new field travels inside the existing
-- p_data jsonb payload.

alter table public.ci_products
  add column default_location_id uuid,
  add constraint ci_products_default_location_fk foreign key (default_location_id, warehouse_id) references public.ci_locations (id, warehouse_id);
-- Looked up by the Location deactivation guard below (and by "which products default here" style queries later).
create index ci_products_default_location_idx on public.ci_products (default_location_id) where default_location_id is not null;

-- Validates "exists, same warehouse as the Product, and active" as one check, the same shape every receiving/transfer
-- RPC already uses for CI_LOCATION_INVALID. NULL always clears the default; it never has to be active or valid.
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
  if v_default_location is not null and not exists(select 1 from public.ci_locations where id=v_default_location and warehouse_id=v_wh and active) then
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
    if v_default_location is not null and not exists(select 1 from public.ci_locations where id=v_default_location and warehouse_id=v_wh and active) then
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

-- Extends the Phase 3 deactivation guard: a Location that an active Product still points to as its default cannot be
-- deactivated out from under it. The user must change or clear that Product's default first - this function never
-- clears it automatically. An inactive Product's stale default does not block cleanup (same "only active references
-- count" reasoning as the existing active-children check just above it).
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
