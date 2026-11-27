-- Phase 1 of the CHEM-IMMUNO CBH next workstream: Location Master.
--
-- * ci_locations becomes a storage/facility master: type, one level of parent (fridge -> shelf), room, description,
--   storage condition, Portal equipment link, stable QR token, audit trail and optimistic-lock timestamp.
-- * ci_location_env_configs is the append-only, versioned temperature / humidity RANGE foundation. Readings, schedules and
--   excursions belong to a later phase and are intentionally absent.
-- * ci_private.environment_monitor_location_id resolves which location owns environment monitoring for a location.
--
-- Migration hygiene (docs/CHEM-IMMUNO-CBH-NEXT-WORKSTREAM-PLAN.md section 11): there is deliberately NO session-level
-- search_path statement in this file. Every reference to a schema object is qualified, and every function declares its own
-- `set search_path = ''`, so nothing here depends on the session search_path.
--
-- Pre-check for the Production dry run (must return 0 rows before applying):
--   select id, code, name from public.ci_locations
--   where code <> btrim(code) or char_length(btrim(code)) not between 1 and 40
--      or name <> btrim(name) or char_length(btrim(name)) not between 1 and 120;

-- ---------------------------------------------------------------------------
-- 1. ci_locations columns
-- ---------------------------------------------------------------------------
alter table public.ci_locations
  add column location_type text not null default 'other',
  add column parent_location_id uuid,
  add column room text,
  add column description text,
  add column storage_condition text,
  add column portal_equipment_url text,
  add column portal_equipment_label text,
  add column qr_token text not null default pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''),
  add column qr_token_rotated_at timestamptz,
  add column updated_at timestamptz not null default now(),
  add column updated_by uuid references auth.users(id);

-- Existing rows were never edited, so their last change is their creation. Done before the audit trigger exists.
update public.ci_locations set updated_at = created_at;

alter table public.ci_locations
  add constraint ci_locations_qr_token_key unique (qr_token),
  add constraint ci_locations_qr_token_format_chk check (qr_token ~ '^[0-9a-f]{32}$'),
  add constraint ci_locations_type_chk check (location_type in ('room','refrigerator','freezer','cabinet','shelf','rack','bench','other')),
  add constraint ci_locations_parent_fk foreign key (parent_location_id, warehouse_id) references public.ci_locations (id, warehouse_id),
  add constraint ci_locations_not_own_parent_chk check (parent_location_id is null or parent_location_id <> id),
  add constraint ci_locations_room_chk check (room is null or char_length(room) between 1 and 120),
  add constraint ci_locations_description_chk check (description is null or char_length(description) between 1 and 1000),
  add constraint ci_locations_storage_condition_chk check (storage_condition is null or char_length(storage_condition) between 1 and 120),
  add constraint ci_locations_portal_url_chk check (portal_equipment_url is null or (portal_equipment_url ~ '^https://[^[:space:]]+$' and char_length(portal_equipment_url) <= 500)),
  add constraint ci_locations_portal_label_chk check (portal_equipment_label is null or (portal_equipment_url is not null and char_length(portal_equipment_label) between 1 and 120)),
  add constraint ci_locations_code_format_chk check (code = btrim(code) and char_length(code) between 1 and 40) not valid,
  add constraint ci_locations_name_format_chk check (name = btrim(name) and char_length(name) between 1 and 120) not valid;
alter table public.ci_locations validate constraint ci_locations_code_format_chk;
alter table public.ci_locations validate constraint ci_locations_name_format_chk;

create index ci_locations_parent_idx on public.ci_locations (parent_location_id) where parent_location_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Guards: hierarchy depth, immutable code once history exists, immutable warehouse
-- ---------------------------------------------------------------------------
create function ci_private.guard_location_hierarchy() returns trigger language plpgsql set search_path = '' as $$
declare v_parent public.ci_locations;
begin
  if tg_op = 'UPDATE' and new.warehouse_id is distinct from old.warehouse_id then
    raise exception 'CI_LOCATION_WAREHOUSE_IMMUTABLE';
  end if;
  if new.parent_location_id is null then return new; end if;
  if new.parent_location_id = new.id then raise exception 'CI_LOCATION_PARENT_INVALID'; end if;
  -- The share lock makes a concurrent change that would give the parent a parent of its own (or a child) wait for this row.
  select * into v_parent from public.ci_locations where id = new.parent_location_id and warehouse_id = new.warehouse_id for share;
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
revoke all on function ci_private.guard_location_hierarchy() from public, anon, authenticated;
create trigger ci_locations_hierarchy_guard before insert or update on public.ci_locations
  for each row execute function ci_private.guard_location_hierarchy();

-- Historical reports display the current code, so it must not change once a receipt, movement or count references it.
create function ci_private.guard_location_code() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.code is distinct from old.code and (
       exists (select 1 from public.ci_stock_movement_lines where location_id = old.id)
    or exists (select 1 from public.ci_receipt_lines where location_id = old.id)
    or exists (select 1 from public.ci_stock_count_lines where location_id = old.id)
  ) then raise exception 'CI_LOCATION_CODE_IMMUTABLE'; end if;
  return new;
end $$;
revoke all on function ci_private.guard_location_code() from public, anon, authenticated;
create trigger ci_locations_code_guard before update of code on public.ci_locations
  for each row execute function ci_private.guard_location_code();

-- Full old/new evidence for create, edit, activate/deactivate, Portal link and QR rotation.
create trigger ci_locations_audit after insert or update on public.ci_locations
  for each row execute function ci_private.audit_change();

-- Stock may never enter an inactive location. The existing stock RPCs check `active` with a plain read before writing, and the
-- ledger's foreign key only takes a KEY SHARE lock, so without this guard a receipt, transfer, adjustment, count approval or
-- reversal committed concurrently with ci_set_location_active could land stock in a location that had just been deactivated
-- at zero balance. Taking a SHARE lock on the location row here serialises every stock-increasing line with deactivation:
-- whichever commits first wins, and the loser either sees the location inactive (this raise) or sees the stock
-- (CI_LOCATION_HAS_STOCK). Lines that remove stock are unaffected, so stock can still leave a location as before.
-- Lock order: this runs after ci_movement_balance (triggers fire in name order), i.e. products -> LOT -> location; nothing
-- that locks a location ever waits on a LOT or product lock, so no new deadlock cycle is possible.
create function ci_private.guard_movement_location_active() returns trigger language plpgsql set search_path = '' as $$
declare v_active boolean;
begin
  if new.quantity_delta <= 0 then return new; end if;
  select l.active into v_active from public.ci_locations l where l.id = new.location_id and l.warehouse_id = new.warehouse_id for share;
  if found and not v_active then raise exception 'CI_LOCATION_INACTIVE'; end if;
  return new;
end $$;
revoke all on function ci_private.guard_movement_location_active() from public, anon, authenticated;
create trigger ci_movement_location_active before insert on public.ci_stock_movement_lines
  for each row execute function ci_private.guard_movement_location_active();

-- Supports the per-location balance check in ci_set_location_active and per-location stock reads (Location Detail).
create index ci_movement_location_idx on public.ci_stock_movement_lines (location_id, lot_id);

-- ---------------------------------------------------------------------------
-- 3. ci_location_env_configs: append-only temperature / humidity ranges
-- ---------------------------------------------------------------------------
create table public.ci_location_env_configs (
  id uuid primary key default gen_random_uuid(),
  warehouse_id smallint not null,
  location_id uuid not null,
  effective_from timestamptz not null default now(),
  temperature_monitored boolean not null,
  temp_min_c numeric(5,2),
  temp_max_c numeric(5,2),
  humidity_monitored boolean not null,
  rh_min_pct numeric(5,2),
  rh_max_pct numeric(5,2),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint ci_location_env_configs_location_fk foreign key (location_id, warehouse_id) references public.ci_locations (id, warehouse_id),
  constraint ci_location_env_configs_effective_uq unique (location_id, effective_from),
  constraint ci_location_env_configs_temperature_chk check (
    (not temperature_monitored and temp_min_c is null and temp_max_c is null)
    or (temperature_monitored
        and (temp_min_c is not null or temp_max_c is not null)
        and (temp_min_c is null or temp_min_c between -100 and 100)
        and (temp_max_c is null or temp_max_c between -100 and 100)
        and (temp_min_c is null or temp_max_c is null or temp_min_c < temp_max_c))
  ),
  constraint ci_location_env_configs_humidity_chk check (
    (not humidity_monitored and rh_min_pct is null and rh_max_pct is null)
    or (humidity_monitored
        and (rh_min_pct is not null or rh_max_pct is not null)
        and (rh_min_pct is null or rh_min_pct between 0 and 100)
        and (rh_max_pct is null or rh_max_pct between 0 and 100)
        and (rh_min_pct is null or rh_max_pct is null or rh_min_pct < rh_max_pct))
  )
);
create index ci_location_env_configs_current_idx on public.ci_location_env_configs (location_id, effective_from desc);

create trigger ci_location_env_configs_immutable before update or delete on public.ci_location_env_configs
  for each row execute function ci_private.guard_immutable();
create trigger ci_location_env_configs_audit after insert on public.ci_location_env_configs
  for each row execute function ci_private.audit_change();

alter table public.ci_location_env_configs enable row level security;
revoke all on public.ci_location_env_configs from anon, authenticated;
grant select on public.ci_location_env_configs to authenticated;
create policy ci_location_env_configs_read on public.ci_location_env_configs for select to authenticated
  using (ci_private.can_read(warehouse_id));

-- ---------------------------------------------------------------------------
-- 4. Monitored-container resolution (SECURITY DEFINER; never relies on RLS)
-- ---------------------------------------------------------------------------
-- Returns the location that owns environment monitoring for p_location_id: itself when its current config monitors at least
-- one parameter, else its parent when the parent does, else null. The caller must be able to read the target's warehouse;
-- a missing target and a forbidden target are indistinguishable (both null) and nothing about either is revealed.
create function ci_private.environment_monitor_location_id(p_location_id uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_warehouse smallint;
  v_parent uuid;
  v_parent_warehouse smallint;
  v_own boolean;
begin
  if p_location_id is null then return null; end if;
  select l.warehouse_id, l.parent_location_id into v_warehouse, v_parent from public.ci_locations l where l.id = p_location_id;
  if not found or not ci_private.can_read(v_warehouse) then return null; end if;

  select c.temperature_monitored or c.humidity_monitored into v_own
    from public.ci_location_env_configs c where c.location_id = p_location_id order by c.effective_from desc limit 1;
  if coalesce(v_own, false) then return p_location_id; end if;

  if v_parent is null then return null; end if;
  -- Same warehouse by the composite FK; asserted again as defence in depth.
  select p.warehouse_id into v_parent_warehouse from public.ci_locations p where p.id = v_parent;
  if not found or v_parent_warehouse is distinct from v_warehouse then return null; end if;
  v_own := null;
  select c.temperature_monitored or c.humidity_monitored into v_own
    from public.ci_location_env_configs c where c.location_id = v_parent order by c.effective_from desc limit 1;
  if coalesce(v_own, false) then return v_parent; end if;
  return null;
end $$;
revoke all on function ci_private.environment_monitor_location_id(uuid) from public, anon, authenticated;

-- publish_rpc only publishes ci_-prefixed private definers, so the published name carries the prefix. The un-prefixed
-- function above stays the single implementation that other private RPCs call directly.
create function ci_private.ci_environment_monitor_location_id(p_location_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select ci_private.environment_monitor_location_id(p_location_id)
$$;
select ci_private.publish_rpc('ci_private.ci_environment_monitor_location_id(uuid)'::pg_catalog.regprocedure);

-- ---------------------------------------------------------------------------
-- 5. Private helpers
-- ---------------------------------------------------------------------------
-- A strictly newer timestamp than the previous one, so the optimistic lock always sees a change.
create function ci_private.next_updated_at(p_previous timestamptz) returns timestamptz
language sql volatile set search_path = '' as $$
  select greatest(clock_timestamp(), p_previous + interval '1 microsecond')
$$;
revoke all on function ci_private.next_updated_at(timestamptz) from public, anon, authenticated;

-- Locks a location for a supervisor/admin write. A missing location and a forbidden one raise the same error, so the RPCs
-- cannot be used to probe which ids exist in other warehouses.
create function ci_private.lock_location_for_supervisor(p_location_id uuid) returns public.ci_locations
language plpgsql security definer set search_path = '' as $$
declare
  v_warehouse smallint;
  v_row public.ci_locations;
begin
  select warehouse_id into v_warehouse from public.ci_locations where id = p_location_id;
  if not found then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  perform ci_private.require_role(v_warehouse, array['admin','supervisor']);
  select * into v_row from public.ci_locations where id = p_location_id for update;
  return v_row;
end $$;
revoke all on function ci_private.lock_location_for_supervisor(uuid) from public, anon, authenticated;

-- Appends a range version when (and only when) the requested configuration differs from the current one.
create function ci_private.apply_location_env_config(p_location_id uuid, p_warehouse_id smallint, p_env jsonb) returns uuid
language plpgsql set search_path = '' as $$
declare
  v_temp_on boolean;
  v_temp_min numeric(5,2);
  v_temp_max numeric(5,2);
  v_hum_on boolean;
  v_rh_min numeric(5,2);
  v_rh_max numeric(5,2);
  v_current public.ci_location_env_configs;
  v_id uuid;
begin
  begin
    v_temp_on := coalesce((p_env->>'temperature_monitored')::boolean, false);
    v_temp_min := nullif(p_env->>'temp_min_c', '')::numeric(5,2);
    v_temp_max := nullif(p_env->>'temp_max_c', '')::numeric(5,2);
    v_hum_on := coalesce((p_env->>'humidity_monitored')::boolean, false);
    v_rh_min := nullif(p_env->>'rh_min_pct', '')::numeric(5,2);
    v_rh_max := nullif(p_env->>'rh_max_pct', '')::numeric(5,2);
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'CI_ENV_CONFIG_INVALID';
  end;

  select * into v_current from public.ci_location_env_configs where location_id = p_location_id order by effective_from desc limit 1;
  if found then
    if (v_current.temperature_monitored, v_current.temp_min_c, v_current.temp_max_c, v_current.humidity_monitored, v_current.rh_min_pct, v_current.rh_max_pct)
       is not distinct from (v_temp_on, v_temp_min, v_temp_max, v_hum_on, v_rh_min, v_rh_max) then
      return null;
    end if;
  elsif not v_temp_on and not v_hum_on and v_temp_min is null and v_temp_max is null and v_rh_min is null and v_rh_max is null then
    return null;
  end if;

  begin
    insert into public.ci_location_env_configs (warehouse_id, location_id, effective_from, temperature_monitored, temp_min_c, temp_max_c, humidity_monitored, rh_min_pct, rh_max_pct, created_by)
    values (p_warehouse_id, p_location_id, ci_private.next_updated_at(v_current.effective_from), v_temp_on, v_temp_min, v_temp_max, v_hum_on, v_rh_min, v_rh_max, auth.uid())
    returning id into v_id;
  exception when check_violation then
    raise exception 'CI_ENV_CONFIG_INVALID';
  end;
  return v_id;
end $$;
revoke all on function ci_private.apply_location_env_config(uuid, smallint, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Location RPCs (admin or supervisor of the location's own warehouse)
-- ---------------------------------------------------------------------------
create function ci_private.ci_create_location_v2(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_warehouse smallint := nullif(p->>'warehouse_id', '')::smallint;
  v_parent uuid := nullif(p->>'parent_location_id', '')::uuid;
  v_parent_active boolean;
  v_id uuid;
begin
  perform ci_private.require_role(v_warehouse, array['admin','supervisor']);
  if v_parent is not null then
    select active into v_parent_active from public.ci_locations where id = v_parent and warehouse_id = v_warehouse;
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
  if jsonb_typeof(p->'env') = 'object' then
    perform ci_private.apply_location_env_config(v_id, v_warehouse, p->'env');
  end if;
  return v_id;
end $$;
select ci_private.publish_rpc('ci_private.ci_create_location_v2(jsonb)'::pg_catalog.regprocedure);

-- Keys that are absent from p are left unchanged; keys that are present replace the stored value (null/'' clears it).
create function ci_private.ci_update_location(p_id uuid, p jsonb, p_expected_updated_at timestamptz) returns void
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
    select active into v_parent_active from public.ci_locations where id = v_parent and warehouse_id = v_row.warehouse_id;
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
  if jsonb_typeof(p->'env') = 'object' then
    perform ci_private.apply_location_env_config(p_id, v_row.warehouse_id, p->'env');
  end if;
end $$;
select ci_private.publish_rpc('ci_private.ci_update_location(uuid, jsonb, timestamptz)'::pg_catalog.regprocedure);

create function ci_private.ci_set_location_active(p_id uuid, p_active boolean, p_reason text) returns void
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
  end if;
  update public.ci_locations set active = p_active, updated_at = ci_private.next_updated_at(v_row.updated_at), updated_by = auth.uid() where id = p_id;
  perform ci_private.audit(v_row.warehouse_id, case when p_active then 'ACTIVATE' else 'DEACTIVATE' end, 'ci_locations', p_id::text, v_reason);
end $$;
select ci_private.publish_rpc('ci_private.ci_set_location_active(uuid, boolean, text)'::pg_catalog.regprocedure);

-- Rotating the token invalidates every printed label for this location at once.
create function ci_private.ci_rotate_location_qr_token(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.ci_locations;
  v_reason text := nullif(btrim(p_reason), '');
begin
  v_row := ci_private.lock_location_for_supervisor(p_id);
  if v_reason is null then raise exception 'CI_REASON_REQUIRED'; end if;
  update public.ci_locations set
    qr_token = pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''),
    qr_token_rotated_at = clock_timestamp(),
    updated_at = ci_private.next_updated_at(v_row.updated_at),
    updated_by = auth.uid()
  where id = p_id;
  perform ci_private.audit(v_row.warehouse_id, 'QR_ROTATE', 'ci_locations', p_id::text, v_reason);
end $$;
select ci_private.publish_rpc('ci_private.ci_rotate_location_qr_token(uuid, text)'::pg_catalog.regprocedure);

-- Returns the new config version id, or null when the requested ranges equal the current ones (no version is created).
create function ci_private.ci_set_location_env_config(p_location_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.ci_locations;
  v_id uuid;
begin
  v_row := ci_private.lock_location_for_supervisor(p_location_id);
  v_id := ci_private.apply_location_env_config(p_location_id, v_row.warehouse_id, p);
  -- A range change moves the location's timestamp too, so an edit form opened before it cannot silently overwrite it.
  if v_id is not null then
    update public.ci_locations set updated_at = ci_private.next_updated_at(v_row.updated_at), updated_by = auth.uid() where id = p_location_id;
  end if;
  return v_id;
end $$;
select ci_private.publish_rpc('ci_private.ci_set_location_env_config(uuid, jsonb)'::pg_catalog.regprocedure);
