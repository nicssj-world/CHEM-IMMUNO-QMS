-- Phase 3: location-owned temperature and humidity monitoring.
-- All privileged implementations remain in ci_private; public RPCs are invoker wrappers.
-- No session search_path changes or changes to prior migrations.

alter table public.ci_location_env_configs
  add column check_times time[] not null default '{}',
  add column monitoring_state text not null default 'active',
  add column pause_reason text,
  add constraint ci_env_config_state_chk check (monitoring_state in ('active', 'paused')),
  add constraint ci_env_config_pause_chk check (monitoring_state <> 'paused' or nullif(btrim(pause_reason), '') is not null),
  add constraint ci_env_config_times_count_chk check (cardinality(check_times) between 0 and 4);
alter table public.ci_location_env_configs
  add constraint ci_env_config_identity_uq unique (id, location_id, warehouse_id);

create function ci_private.guard_environment_schedule() returns trigger language plpgsql set search_path = '' as $$
declare v_time time; v_previous time; v_count integer := 0;
begin
  foreach v_time in array new.check_times loop
    if v_time is null or (v_count > 0 and v_time <= v_previous) then
      raise exception 'CI_ENV_SCHEDULE_INVALID';
    end if;
    v_previous := v_time;
    v_count := v_count + 1;
  end loop;
  if v_count > 4 then raise exception 'CI_ENV_SCHEDULE_INVALID'; end if;
  return new;
end $$;
revoke all on function ci_private.guard_environment_schedule() from public, anon, authenticated;
create trigger ci_env_config_schedule_guard before insert on public.ci_location_env_configs
  for each row execute function ci_private.guard_environment_schedule();

-- Preserve schedule and pause fields when Phase 1 callers supply only range fields.
create or replace function ci_private.apply_location_env_config(p_location_id uuid, p_warehouse_id smallint, p_env jsonb) returns uuid
language plpgsql set search_path = '' as $$
declare
  v_current public.ci_location_env_configs;
  v_temp_on boolean; v_temp_min numeric(5,2); v_temp_max numeric(5,2);
  v_hum_on boolean; v_rh_min numeric(5,2); v_rh_max numeric(5,2);
  v_times time[]; v_state text; v_pause text; v_id uuid;
begin
  select * into v_current from public.ci_location_env_configs
    where location_id = p_location_id order by effective_from desc limit 1;
  begin
    if p_env ?| array['temperature_monitored','temp_min_c','temp_max_c','humidity_monitored','rh_min_pct','rh_max_pct'] then
      -- A Phase 1 range payload still treats omitted range fields as off/empty.
      v_temp_on := coalesce((p_env->>'temperature_monitored')::boolean, false);
      v_temp_min := nullif(p_env->>'temp_min_c', '')::numeric(5,2);
      v_temp_max := nullif(p_env->>'temp_max_c', '')::numeric(5,2);
      v_hum_on := coalesce((p_env->>'humidity_monitored')::boolean, false);
      v_rh_min := nullif(p_env->>'rh_min_pct', '')::numeric(5,2);
      v_rh_max := nullif(p_env->>'rh_max_pct', '')::numeric(5,2);
    else
      v_temp_on := coalesce(v_current.temperature_monitored, false);
      v_temp_min := v_current.temp_min_c; v_temp_max := v_current.temp_max_c;
      v_hum_on := coalesce(v_current.humidity_monitored, false);
      v_rh_min := v_current.rh_min_pct; v_rh_max := v_current.rh_max_pct;
    end if;
    v_times := coalesce(v_current.check_times, '{}'::time[]);
    if p_env ? 'check_times' then
      if jsonb_typeof(p_env->'check_times') <> 'array' then raise exception 'CI_ENV_SCHEDULE_INVALID'; end if;
      select coalesce(array_agg(value::time order by ord), '{}'::time[]) into v_times
        from jsonb_array_elements_text(p_env->'check_times') with ordinality as item(value, ord);
    end if;
    v_state := case when p_env ? 'monitoring_state' then p_env->>'monitoring_state' else coalesce(v_current.monitoring_state, 'active') end;
    v_pause := case when p_env ? 'pause_reason' then nullif(btrim(p_env->>'pause_reason'), '') else v_current.pause_reason end;
  exception when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format then
    raise exception 'CI_ENV_CONFIG_INVALID';
  end;
  if v_state = 'active' then v_pause := null; end if;
  if v_current.id is not null and (v_current.temperature_monitored, v_current.temp_min_c, v_current.temp_max_c,
    v_current.humidity_monitored, v_current.rh_min_pct, v_current.rh_max_pct,
    v_current.check_times, v_current.monitoring_state, v_current.pause_reason)
    is not distinct from (v_temp_on, v_temp_min, v_temp_max, v_hum_on, v_rh_min, v_rh_max, v_times, v_state, v_pause) then
    return null;
  end if;
  if v_current.id is null and not v_temp_on and not v_hum_on
    and v_temp_min is null and v_temp_max is null and v_rh_min is null and v_rh_max is null then return null; end if;
  begin
    insert into public.ci_location_env_configs
      (warehouse_id, location_id, effective_from, temperature_monitored, temp_min_c, temp_max_c,
       humidity_monitored, rh_min_pct, rh_max_pct, check_times, monitoring_state, pause_reason, created_by)
    values (p_warehouse_id, p_location_id, ci_private.next_updated_at(v_current.effective_from),
      v_temp_on, v_temp_min, v_temp_max, v_hum_on, v_rh_min, v_rh_max, v_times, v_state, v_pause, auth.uid())
    returning id into v_id;
  exception when check_violation or not_null_violation then raise exception 'CI_ENV_CONFIG_INVALID'; end;
  return v_id;
end $$;

create table public.ci_environment_readings (
  id uuid primary key default gen_random_uuid(),
  warehouse_id smallint not null,
  location_id uuid not null,
  config_id uuid not null,
  observed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  check_date date not null,
  round_no smallint,
  entry_kind text not null,
  corrects_reading_id uuid unique references public.ci_environment_readings(id),
  temperature_c numeric(5,2),
  humidity_rh numeric(5,2),
  temperature_status text not null,
  humidity_status text not null,
  overall_status text not null,
  source text not null,
  note text,
  reason text,
  entry_mode text not null,
  excursion_id uuid,
  recorded_by uuid not null references auth.users(id),
  client_request_id uuid not null,
  constraint ci_env_reading_location_fk foreign key (location_id, warehouse_id) references public.ci_locations(id, warehouse_id),
  constraint ci_env_reading_config_fk foreign key (config_id, location_id, warehouse_id) references public.ci_location_env_configs(id, location_id, warehouse_id),
  constraint ci_env_reading_identity_uq unique (id, location_id, warehouse_id),
  constraint ci_env_reading_kind_chk check (entry_kind in ('original','correction','void')),
  constraint ci_env_reading_chain_chk check ((entry_kind = 'original') = (corrects_reading_id is null)),
  constraint ci_env_reading_reason_chk check (((entry_kind = 'original' and entry_mode = 'live' and overall_status <> 'incomplete') or nullif(btrim(reason), '') is not null)),
  constraint ci_env_reading_temp_chk check (temperature_c is null or temperature_c between -100 and 100),
  constraint ci_env_reading_rh_chk check (humidity_rh is null or humidity_rh between 0 and 100),
  constraint ci_env_reading_temp_status_chk check (temperature_status in ('in_range','out_of_range','not_monitored','missing')),
  constraint ci_env_reading_rh_status_chk check (humidity_status in ('in_range','out_of_range','not_monitored','missing')),
  constraint ci_env_reading_overall_chk check (overall_status in ('in_range','out_of_range','incomplete','void')),
  constraint ci_env_reading_source_chk check (source in ('manual','qr')),
  constraint ci_env_reading_mode_chk check (entry_mode in ('live','late')),
  constraint ci_env_reading_round_chk check (round_no is null or round_no between 1 and 4),
  constraint ci_env_reading_note_chk check (note is null or char_length(note) <= 1000),
  constraint ci_env_reading_request_uq unique (recorded_by, client_request_id)
);
create index ci_env_reading_location_observed_idx on public.ci_environment_readings(location_id, observed_at desc);
create index ci_env_reading_warehouse_date_idx on public.ci_environment_readings(warehouse_id, check_date);
create index ci_env_reading_round_idx on public.ci_environment_readings(location_id, check_date, round_no);
create trigger ci_env_reading_immutable before update or delete on public.ci_environment_readings
  for each row execute function ci_private.guard_immutable();
alter table public.ci_environment_readings enable row level security;
revoke all on public.ci_environment_readings from anon, authenticated;
grant select on public.ci_environment_readings to authenticated;
create policy ci_env_reading_read on public.ci_environment_readings for select to authenticated
  using (ci_private.can_read(warehouse_id));

create table public.ci_environment_excursions (
  id uuid primary key default gen_random_uuid(),
  warehouse_id smallint not null,
  location_id uuid not null,
  opened_reading_id uuid not null,
  opened_at timestamptz not null default now(),
  parameters text[] not null,
  status text not null default 'open',
  immediate_action text,
  acknowledged_by uuid references auth.users(id),
  acknowledged_at timestamptz,
  resolution_note text,
  equipment_referred boolean not null default false,
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint ci_env_excursion_location_fk foreign key (location_id, warehouse_id) references public.ci_locations(id, warehouse_id),
  constraint ci_env_excursion_opened_fk foreign key (opened_reading_id, location_id, warehouse_id)
    references public.ci_environment_readings(id, location_id, warehouse_id) deferrable initially deferred,
  constraint ci_env_excursion_status_chk check (status in ('open','acknowledged','resolved')),
  constraint ci_env_excursion_parameters_chk check (cardinality(parameters) between 1 and 2 and parameters <@ array['temperature','humidity']::text[]),
  constraint ci_env_excursion_pairs_chk check (
    (status = 'open' and acknowledged_by is null and acknowledged_at is null and resolved_by is null and resolved_at is null and resolution_note is null)
    or (status = 'acknowledged' and acknowledged_by is not null and acknowledged_at is not null and nullif(btrim(immediate_action),'') is not null and resolved_by is null and resolved_at is null and resolution_note is null)
    or (status = 'resolved' and resolved_by is not null and resolved_at is not null and nullif(btrim(resolution_note),'') is not null
      and ((acknowledged_by is null and acknowledged_at is null) or (acknowledged_by is not null and acknowledged_at is not null and nullif(btrim(immediate_action),'') is not null)))
  )
);
create unique index ci_env_excursion_one_unresolved_idx on public.ci_environment_excursions(location_id) where status <> 'resolved';
create index ci_env_excursion_warehouse_status_idx on public.ci_environment_excursions(warehouse_id, status, opened_at desc);
alter table public.ci_environment_readings add constraint ci_env_reading_excursion_fk foreign key (excursion_id) references public.ci_environment_excursions(id);
create trigger ci_env_excursion_audit after insert or update on public.ci_environment_excursions
  for each row execute function ci_private.audit_change();
alter table public.ci_environment_excursions enable row level security;
revoke all on public.ci_environment_excursions from anon, authenticated;
grant select on public.ci_environment_excursions to authenticated;
create policy ci_env_excursion_read on public.ci_environment_excursions for select to authenticated
  using (ci_private.can_read(warehouse_id));

create view public.ci_environment_effective_readings with (security_invoker = true) as
  select r.* from public.ci_environment_readings r
  where r.entry_kind <> 'void' and not exists
    (select 1 from public.ci_environment_readings successor where successor.corrects_reading_id = r.id);
revoke all on public.ci_environment_effective_readings from public, anon, authenticated;
grant select on public.ci_environment_effective_readings to authenticated;

-- Bangkok round number is based on the observation's local time. The first window starts at midnight.
create function ci_private.environment_round(p_times time[], p_observed_at timestamptz) returns smallint
language plpgsql immutable set search_path = '' as $$
declare v_local time := (p_observed_at at time zone 'Asia/Bangkok')::time; v_index integer;
begin
  if cardinality(p_times) = 0 then return null; end if;
  for v_index in 2..cardinality(p_times) loop
    if v_local < p_times[v_index] then return (v_index - 1)::smallint; end if;
  end loop;
  return cardinality(p_times)::smallint;
end $$;
revoke all on function ci_private.environment_round(time[], timestamptz) from public, anon, authenticated;

create function ci_private.environment_parameter_status(p_monitored boolean, p_value numeric, p_min numeric, p_max numeric) returns text
language sql immutable set search_path = '' as $$
  select case when not p_monitored then 'not_monitored' when p_value is null then 'missing'
    when (p_min is not null and p_value < p_min) or (p_max is not null and p_value > p_max) then 'out_of_range'
    else 'in_range' end
$$;
revoke all on function ci_private.environment_parameter_status(boolean, numeric, numeric, numeric) from public, anon, authenticated;

create function ci_private.environment_reading_result(p_reading public.ci_environment_readings) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p_reading.id, 'location_id', p_reading.location_id,
    'observed_at', p_reading.observed_at, 'check_date', p_reading.check_date,
    'round_no', p_reading.round_no, 'temperature_c', p_reading.temperature_c,
    'humidity_rh', p_reading.humidity_rh, 'temperature_status', p_reading.temperature_status,
    'humidity_status', p_reading.humidity_status, 'overall_status', p_reading.overall_status,
    'entry_mode', p_reading.entry_mode, 'excursion_id', p_reading.excursion_id,
    'config', (select to_jsonb(c) - 'created_by' - 'created_at' from public.ci_location_env_configs c where c.id = p_reading.config_id))
$$;
revoke all on function ci_private.environment_reading_result(public.ci_environment_readings) from public, anon, authenticated;

create function ci_private.ci_record_environment_reading(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_location_id uuid; v_request_id uuid; v_warehouse smallint; v_actor uuid;
  v_location public.ci_locations; v_current public.ci_location_env_configs; v_config public.ci_location_env_configs;
  v_existing public.ci_environment_readings; v_reading public.ci_environment_readings;
  v_observed timestamptz; v_temp numeric; v_hum numeric; v_temp_status text; v_hum_status text;
  v_overall text; v_mode text := 'live'; v_source text; v_note text; v_reason text;
  v_excursion uuid; v_parameters text[]; v_reading_id uuid := gen_random_uuid();
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'CI_ENV_PAYLOAD_INVALID'; end if;
  begin
    v_location_id := (p->>'location_id')::uuid;
    v_request_id := (p->>'client_request_id')::uuid;
  exception when invalid_text_representation then raise exception 'CI_ENV_PAYLOAD_INVALID'; end;
  if v_location_id is null or v_request_id is null then raise exception 'CI_ENV_PAYLOAD_INVALID'; end if;
  -- A missing target and a target in a different warehouse have the same public error.
  select warehouse_id into v_warehouse from public.ci_locations where id = v_location_id;
  if not found then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  v_actor := ci_private.require_role(v_warehouse, array['admin','supervisor','staff']);
  select * into v_location from public.ci_locations where id = v_location_id for update;
  if ci_private.environment_monitor_location_id(v_location_id) is distinct from v_location_id then
    raise exception 'CI_ENV_NOT_MONITORED_LOCATION';
  end if;
  select * into v_current from public.ci_location_env_configs where location_id = v_location_id order by effective_from desc limit 1;
  begin
    v_source := coalesce(nullif(p->>'source',''), 'manual');
    v_note := nullif(btrim(p->>'note'), '');
    v_reason := nullif(btrim(p->>'reason'), '');
    v_temp := nullif(p->>'temperature_c','')::numeric;
    v_hum := nullif(p->>'humidity_rh','')::numeric;
    v_observed := coalesce(nullif(p->>'observed_at','')::timestamptz, now());
  exception when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format then
    raise exception 'CI_ENV_PAYLOAD_INVALID';
  end;
  if v_source not in ('manual','qr') or v_observed > now() or v_observed < now() - interval '72 hours'
    or v_temp is not null and (v_temp < -100 or v_temp > 100 or v_temp <> round(v_temp,2))
    or v_hum is not null and (v_hum < 0 or v_hum > 100 or v_hum <> round(v_hum,2))
    or char_length(coalesce(v_note,'')) > 1000 then raise exception 'CI_ENV_PAYLOAD_INVALID'; end if;
  -- The target lock serializes retries for this location, including two separate DB sessions.
  select * into v_existing from public.ci_environment_readings where recorded_by = v_actor and client_request_id = v_request_id;
  if v_existing.id is not null then
    if v_existing.entry_kind = 'original' and v_existing.location_id = v_location_id and v_existing.source = v_source
      and (nullif(p->>'observed_at','') is null or v_existing.observed_at = v_observed)
      and v_existing.temperature_c is not distinct from v_temp and v_existing.humidity_rh is not distinct from v_hum
      and v_existing.note is not distinct from v_note and v_existing.reason is not distinct from v_reason then
      return ci_private.environment_reading_result(v_existing);
    end if;
    raise exception 'CI_IDEMPOTENCY_CONFLICT';
  end if;
  if not v_location.active then raise exception 'CI_LOCATION_INACTIVE'; end if;
  if v_current.monitoring_state <> 'active' then raise exception 'CI_ENV_PAUSED'; end if;
  if v_observed < now() - interval '15 minutes' then
    if not ci_private.has_role(v_warehouse, array['admin','supervisor']) then raise exception 'CI_ENV_LATE_FORBIDDEN'; end if;
    if v_reason is null then raise exception 'CI_REASON_REQUIRED'; end if;
    v_mode := 'late';
  end if;
  select * into v_config from public.ci_location_env_configs
    where location_id = v_location_id and effective_from <= v_observed order by effective_from desc limit 1;
  if v_config.id is null then raise exception 'CI_ENV_CONFIG_NOT_IN_FORCE'; end if;
  if (not v_config.temperature_monitored and v_temp is not null) or (not v_config.humidity_monitored and v_hum is not null) then
    raise exception 'CI_ENV_PARAMETER_NOT_MONITORED';
  end if;
  v_temp_status := ci_private.environment_parameter_status(v_config.temperature_monitored, v_temp, v_config.temp_min_c, v_config.temp_max_c);
  v_hum_status := ci_private.environment_parameter_status(v_config.humidity_monitored, v_hum, v_config.rh_min_pct, v_config.rh_max_pct);
  v_overall := case when 'out_of_range' in (v_temp_status, v_hum_status) then 'out_of_range'
    when 'missing' in (v_temp_status, v_hum_status) then 'incomplete' else 'in_range' end;
  if v_overall = 'incomplete' and v_reason is null then raise exception 'CI_REASON_REQUIRED'; end if;
  if v_overall = 'out_of_range' then
    select id into v_excursion from public.ci_environment_excursions
      where location_id = v_location_id and status <> 'resolved' for update;
    if v_excursion is null then
      v_parameters := array_remove(array[
        case when v_temp_status = 'out_of_range' then 'temperature' end,
        case when v_hum_status = 'out_of_range' then 'humidity' end]::text[], null);
      insert into public.ci_environment_excursions
        (warehouse_id, location_id, opened_reading_id, opened_at, parameters)
      values (v_warehouse, v_location_id, v_reading_id, v_observed, v_parameters)
      returning id into v_excursion;
    end if;
  end if;
  begin
    insert into public.ci_environment_readings
      (id, warehouse_id, location_id, config_id, observed_at, check_date, round_no,
       entry_kind, temperature_c, humidity_rh, temperature_status, humidity_status, overall_status,
       source, note, reason, entry_mode, excursion_id, recorded_by, client_request_id)
    values (v_reading_id, v_warehouse, v_location_id, v_config.id, v_observed,
      (v_observed at time zone 'Asia/Bangkok')::date, ci_private.environment_round(v_config.check_times, v_observed),
      'original', v_temp, v_hum, v_temp_status, v_hum_status, v_overall,
      v_source, v_note, v_reason, v_mode, v_excursion, v_actor, v_request_id)
    returning * into v_reading;
  exception when unique_violation then raise exception 'CI_IDEMPOTENCY_CONFLICT'; end;
  return ci_private.environment_reading_result(v_reading);
end $$;
select ci_private.publish_rpc('ci_private.ci_record_environment_reading(jsonb)'::pg_catalog.regprocedure);

create function ci_private.ci_correct_environment_reading(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_target public.ci_environment_readings; v_reading public.ci_environment_readings;
  v_config public.ci_location_env_configs; v_actor uuid; v_kind text; v_reason text;
  v_temp numeric; v_hum numeric; v_temp_status text; v_hum_status text; v_overall text;
  v_request uuid; v_excursion uuid; v_reading_id uuid := gen_random_uuid(); v_parameters text[];
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'CI_ENV_PAYLOAD_INVALID'; end if;
  begin
    select * into v_target from public.ci_environment_readings where id = (p->>'reading_id')::uuid;
    v_request := (p->>'client_request_id')::uuid;
    v_kind := p->>'entry_kind';
    v_reason := nullif(btrim(p->>'reason'), '');
    v_temp := nullif(p->>'temperature_c','')::numeric;
    v_hum := nullif(p->>'humidity_rh','')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'CI_ENV_PAYLOAD_INVALID'; end;
  if v_target.id is null or not ci_private.can_read(v_target.warehouse_id) then
    raise exception 'CI_ACCESS_DENIED' using errcode = '42501';
  end if;
  v_actor := ci_private.require_role(v_target.warehouse_id, array['admin','supervisor','staff']);
  if v_request is null or v_kind not in ('correction','void') or v_reason is null then raise exception 'CI_ENV_PAYLOAD_INVALID'; end if;
  if not ci_private.has_role(v_target.warehouse_id, array['admin','supervisor']) and
    (v_target.recorded_by <> v_actor or v_target.check_date <> (now() at time zone 'Asia/Bangkok')::date) then
    raise exception 'CI_ACCESS_DENIED' using errcode = '42501';
  end if;
  -- The location lock also serializes creating an excursion from a corrected value.
  perform 1 from public.ci_locations where id = v_target.location_id for update;
  perform 1 from public.ci_environment_readings where id = v_target.id for update;
  if v_target.entry_kind = 'void' or exists
    (select 1 from public.ci_environment_readings where corrects_reading_id = v_target.id) then
    raise exception 'CI_ALREADY_CORRECTED';
  end if;
  if exists (select 1 from public.ci_environment_readings where recorded_by = v_actor and client_request_id = v_request) then
    raise exception 'CI_IDEMPOTENCY_CONFLICT';
  end if;
  select * into v_config from public.ci_location_env_configs where id = v_target.config_id;
  if v_kind = 'correction' then
    if (not v_config.temperature_monitored and v_temp is not null) or (not v_config.humidity_monitored and v_hum is not null) then
      raise exception 'CI_ENV_PARAMETER_NOT_MONITORED';
    end if;
    if (v_temp is not null and (v_temp < -100 or v_temp > 100 or v_temp <> round(v_temp,2)))
      or (v_hum is not null and (v_hum < 0 or v_hum > 100 or v_hum <> round(v_hum,2))) then
      raise exception 'CI_ENV_PAYLOAD_INVALID';
    end if;
    v_temp_status := ci_private.environment_parameter_status(v_config.temperature_monitored, v_temp, v_config.temp_min_c, v_config.temp_max_c);
    v_hum_status := ci_private.environment_parameter_status(v_config.humidity_monitored, v_hum, v_config.rh_min_pct, v_config.rh_max_pct);
    v_overall := case when 'out_of_range' in (v_temp_status, v_hum_status) then 'out_of_range'
      when 'missing' in (v_temp_status, v_hum_status) then 'incomplete' else 'in_range' end;
  else
    if v_temp is not null or v_hum is not null then raise exception 'CI_ENV_PAYLOAD_INVALID'; end if;
    v_temp_status := v_target.temperature_status; v_hum_status := v_target.humidity_status; v_overall := 'void';
  end if;
  if v_overall = 'out_of_range' then
    select id into v_excursion from public.ci_environment_excursions
      where location_id = v_target.location_id and status <> 'resolved' for update;
    if v_excursion is null then
      v_parameters := array_remove(array[
        case when v_temp_status = 'out_of_range' then 'temperature' end,
        case when v_hum_status = 'out_of_range' then 'humidity' end]::text[], null);
      insert into public.ci_environment_excursions(warehouse_id, location_id, opened_reading_id, opened_at, parameters)
      values (v_target.warehouse_id, v_target.location_id, v_reading_id, now(), v_parameters)
      returning id into v_excursion;
    end if;
  end if;
  begin
    insert into public.ci_environment_readings
      (id, warehouse_id, location_id, config_id, observed_at, check_date, round_no, entry_kind, corrects_reading_id,
       temperature_c, humidity_rh, temperature_status, humidity_status, overall_status, source,
       note, reason, entry_mode, excursion_id, recorded_by, client_request_id)
    values (v_reading_id, v_target.warehouse_id, v_target.location_id, v_target.config_id, v_target.observed_at,
      v_target.check_date, v_target.round_no, v_kind, v_target.id, v_temp, v_hum,
      v_temp_status, v_hum_status, v_overall, v_target.source, nullif(btrim(p->>'note'), ''),
      v_reason, v_target.entry_mode, v_excursion, v_actor, v_request)
    returning * into v_reading;
  exception when unique_violation then
    if exists (select 1 from public.ci_environment_readings where corrects_reading_id = v_target.id) then
      raise exception 'CI_ALREADY_CORRECTED';
    end if;
    raise exception 'CI_IDEMPOTENCY_CONFLICT';
  end;
  return ci_private.environment_reading_result(v_reading);
end $$;
select ci_private.publish_rpc('ci_private.ci_correct_environment_reading(jsonb)'::pg_catalog.regprocedure);

create function ci_private.ci_acknowledge_environment_excursion(p_id uuid, p_immediate_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_row public.ci_environment_excursions; v_actor uuid; v_action text := nullif(btrim(p_immediate_action),'');
begin
  select * into v_row from public.ci_environment_excursions where id = p_id;
  if v_row.id is null or not ci_private.can_read(v_row.warehouse_id) then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  v_actor := ci_private.require_role(v_row.warehouse_id, array['admin','supervisor','staff']);
  if v_action is null then raise exception 'CI_REASON_REQUIRED'; end if;
  update public.ci_environment_excursions set status = 'acknowledged', immediate_action = v_action,
    acknowledged_by = v_actor, acknowledged_at = now(), updated_at = now()
    where id = p_id and status = 'open';
  if not found then raise exception 'CI_ENV_EXCURSION_STATE'; end if;
end $$;
select ci_private.publish_rpc('ci_private.ci_acknowledge_environment_excursion(uuid, text)'::pg_catalog.regprocedure);

create function ci_private.ci_resolve_environment_excursion(p_id uuid, p_resolution_note text, p_equipment_referred boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_row public.ci_environment_excursions; v_actor uuid; v_note text := nullif(btrim(p_resolution_note),'');
begin
  select * into v_row from public.ci_environment_excursions where id = p_id;
  if v_row.id is null or not ci_private.can_read(v_row.warehouse_id) then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  v_actor := ci_private.require_role(v_row.warehouse_id, array['admin','supervisor']);
  if v_note is null then raise exception 'CI_REASON_REQUIRED'; end if;
  update public.ci_environment_excursions set status = 'resolved', resolution_note = v_note,
    equipment_referred = coalesce(p_equipment_referred, false), resolved_by = v_actor,
    resolved_at = now(), updated_at = now()
    where id = p_id and status in ('open','acknowledged');
  if not found then raise exception 'CI_ENV_EXCURSION_STATE'; end if;
end $$;
select ci_private.publish_rpc('ci_private.ci_resolve_environment_excursion(uuid, text, boolean)'::pg_catalog.regprocedure);

-- A testable clock argument keeps Bangkok boundary behavior deterministic in DB tests.
create function ci_private.environment_day_status_at(p_warehouse_id smallint, p_date date, p_now timestamptz)
returns table(location_id uuid, round_no smallint, due_time time, state text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform ci_private.require_role(p_warehouse_id, array['admin','supervisor','staff','viewer']);
  if p_date is null then
    raise exception 'CI_ENV_DATE_INVALID';
  end if;
  return query
  with versions as (
    select c.*, lead(c.effective_from) over (partition by c.location_id order by c.effective_from) as next_from
    from public.ci_location_env_configs c
    join public.ci_locations l on l.id = c.location_id and l.warehouse_id = c.warehouse_id
    where c.warehouse_id = p_warehouse_id and l.active and (c.temperature_monitored or c.humidity_monitored)
  ), candidate as (
    select c.location_id, c.effective_from, c.next_from, g.n::smallint as round_no, c.check_times[g.n] as due_time,
      case when g.n = 1 then p_date::timestamp else p_date + c.check_times[g.n] end as window_start,
      case when g.n < cardinality(c.check_times) then p_date + c.check_times[g.n + 1]
        else (p_date + 1)::timestamp end as window_end,
      c.monitoring_state
    from versions c cross join lateral pg_catalog.generate_series(1, cardinality(c.check_times)) as g(n)
    where c.effective_from < ((p_date + 1)::timestamp at time zone 'Asia/Bangkok')
  ), valid_rounds as (
    select candidate.* from candidate
    where candidate.window_start at time zone 'Asia/Bangkok' >= candidate.effective_from
      and (candidate.next_from is null or candidate.window_start at time zone 'Asia/Bangkok' < candidate.next_from)
  ), special as (
    select distinct on (c.location_id) c.location_id, null::smallint as round_no, null::time as due_time,
      greatest(c.effective_from, p_date::timestamp at time zone 'Asia/Bangkok') as start_at,
      c.monitoring_state, c.check_times
    from versions c
    where cardinality(c.check_times) = 0
      and c.effective_from < ((p_date + 1)::timestamp at time zone 'Asia/Bangkok')
      and (c.next_from is null or c.next_from > p_date::timestamp at time zone 'Asia/Bangkok')
    order by c.location_id, c.effective_from desc
  )
  select r.location_id, r.round_no, r.due_time,
    case when r.monitoring_state = 'paused' then 'paused'
      when exists (select 1 from public.ci_environment_effective_readings e
        where e.location_id = r.location_id and e.check_date = p_date
          and e.overall_status in ('in_range','out_of_range')
          and e.observed_at >= r.window_start at time zone 'Asia/Bangkok'
          and e.observed_at < r.window_end at time zone 'Asia/Bangkok') then 'satisfied'
      when p_now < p_date + r.due_time at time zone 'Asia/Bangkok' then 'upcoming'
      when p_now >= r.window_end at time zone 'Asia/Bangkok' then 'missed'
      else 'due' end as state
  from valid_rounds r
  union all
  select s.location_id, s.round_no, s.due_time,
    case when s.monitoring_state = 'paused' then 'paused' else 'unscheduled' end
  from special s
  order by location_id, round_no nulls first;
end $$;
revoke all on function ci_private.environment_day_status_at(smallint, date, timestamptz) from public, anon, authenticated;

create function ci_private.ci_environment_day_status(p_warehouse_id smallint, p_date date)
returns table(location_id uuid, round_no smallint, due_time time, state text)
language sql stable security definer set search_path = '' as $$
  select * from ci_private.environment_day_status_at(p_warehouse_id, p_date, now())
$$;
select ci_private.publish_rpc('ci_private.ci_environment_day_status(smallint, date)'::pg_catalog.regprocedure);

create function ci_private.ci_environment_month_report(p_warehouse_id smallint, p_month date, p_location_id uuid default null)
returns table(location_id uuid, check_date date, round_no smallint, due_time time,
  state text, reading jsonb, config jsonb, children text[], excursions jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare v_location uuid;
begin
  perform ci_private.require_role(p_warehouse_id, array['admin','supervisor','staff','viewer']);
  if p_month is null or p_month <> date_trunc('month', p_month::timestamp)::date then
    raise exception 'CI_ENV_MONTH_INVALID';
  end if;
  if p_location_id is not null then
    if not exists (select 1 from public.ci_locations where id = p_location_id and warehouse_id = p_warehouse_id) then
      raise exception 'CI_ACCESS_DENIED' using errcode = '42501';
    end if;
    v_location := ci_private.environment_monitor_location_id(p_location_id);
    if v_location is null then return; end if;
  end if;
  return query
  select s.location_id, s.check_date, s.round_no, s.due_time, s.state,
    (select to_jsonb(r) from public.ci_environment_effective_readings r
      where r.location_id = s.location_id and r.check_date = s.check_date
        and (s.round_no is null or r.round_no = s.round_no)
      order by case when s.state = 'satisfied' and r.overall_status in ('in_range','out_of_range') then 0 else 1 end,
        r.observed_at desc limit 1) as reading,
    (select to_jsonb(c) - 'created_by' from public.ci_location_env_configs c
      where c.location_id = s.location_id and c.effective_from <=
        (s.check_date + coalesce(s.due_time, time '23:59:59')) at time zone 'Asia/Bangkok'
      order by c.effective_from desc limit 1) as config,
    coalesce((select array_agg(l.code order by l.code) from public.ci_locations l
      where l.parent_location_id = s.location_id), '{}'::text[]) as children,
    coalesce((select jsonb_agg(to_jsonb(x) order by x.opened_at) from public.ci_environment_excursions x
      where x.location_id = s.location_id and (x.opened_at at time zone 'Asia/Bangkok')::date = s.check_date), '[]'::jsonb) as excursions
  from (
    select d::date as check_date, ds.location_id, ds.round_no, ds.due_time, ds.state
    from pg_catalog.generate_series(p_month::timestamp,
      (p_month + interval '1 month' - interval '1 day')::timestamp, interval '1 day') as d
    cross join lateral ci_private.environment_day_status_at(p_warehouse_id, d::date, now()) ds
    where v_location is null or ds.location_id = v_location
  ) s
  order by s.location_id, s.check_date, s.round_no nulls first;
end $$;
select ci_private.publish_rpc('ci_private.ci_environment_month_report(smallint, date, uuid)'::pg_catalog.regprocedure);

create function ci_private.ci_environment_actor_names(p_user_ids uuid[])
returns table(user_id uuid, display_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or cardinality(p_user_ids) > 500 then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  return query select p.user_id, p.display_name from public.ci_user_profiles p
    where p.user_id = any(p_user_ids) and exists (
      select 1 from public.ci_environment_readings r
      where r.recorded_by = p.user_id and ci_private.can_read(r.warehouse_id)
      union all
      select 1 from public.ci_environment_excursions x
      where (x.acknowledged_by = p.user_id or x.resolved_by = p.user_id) and ci_private.can_read(x.warehouse_id)
    );
end $$;
select ci_private.publish_rpc('ci_private.ci_environment_actor_names(uuid[])'::pg_catalog.regprocedure);
