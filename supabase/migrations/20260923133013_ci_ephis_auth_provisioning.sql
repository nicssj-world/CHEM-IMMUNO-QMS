-- Bind each CHEM-IMMUNO Auth account to one normalized Ephis identity.
alter table public.ci_user_profiles add column display_name text;
update public.ci_user_profiles
set ephis_id=lower(btrim(ephis_id)), display_name=coalesce(nullif(btrim(display_name),''),btrim(ephis_id));
alter table public.ci_user_profiles alter column display_name set not null;
alter table public.ci_user_profiles add constraint ci_user_profiles_ephis_normalized_check
  check (ephis_id=lower(btrim(ephis_id)) and ephis_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$');
alter table public.ci_user_profiles add constraint ci_user_profiles_display_name_check
  check (length(btrim(display_name)) between 1 and 120);
create unique index ci_user_profiles_ephis_normalized_uidx
  on public.ci_user_profiles (lower(btrim(ephis_id)));

-- The browser submits Ephis ID only. The trusted database function resolves the
-- target Auth UUID from its deterministic internal email address.
create function public.ci_provision_user(
  p_ephis_id text,
  p_display_name text,
  p_role text,
  p_warehouse_ids smallint[],
  p_active boolean
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ephis text;
  v_email text;
  v_user_id uuid;
  v_existing_ephis text;
  v_warehouses smallint[];
  v_warehouse smallint;
begin
  perform ci_private.require_role(1::smallint,array['admin']);
  perform ci_private.require_role(2::smallint,array['admin']);

  v_ephis:=lower(btrim(coalesce(p_ephis_id,'')));
  if v_ephis !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then raise exception 'CI_EPHIS_ID_INVALID'; end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 120 then raise exception 'CI_DISPLAY_NAME_INVALID'; end if;
  if p_role is null or p_role not in ('admin','supervisor','staff','viewer') then raise exception 'CI_USER_ROLE_INVALID'; end if;
  if p_active is null then raise exception 'CI_USER_ACTIVE_REQUIRED'; end if;
  if p_warehouse_ids is null or exists(select 1 from unnest(p_warehouse_ids) requested(id) where id is null or id not in (1,2)) then
    raise exception 'CI_USER_WAREHOUSE_INVALID';
  end if;
  select coalesce(array_agg(distinct id order by id),'{}'::smallint[]) into v_warehouses from unnest(p_warehouse_ids) requested(id);
  if p_active and cardinality(v_warehouses)=0 then raise exception 'CI_ACTIVE_USER_NEEDS_WAREHOUSE'; end if;

  v_email:='ephis.'||v_ephis||'@chem-immuno.internal';
  select u.id into v_user_id from auth.users u where lower(u.email)=v_email;
  if v_user_id is null then raise exception 'CI_AUTH_USER_NOT_FOUND'; end if;
  select p.ephis_id into v_existing_ephis from public.ci_user_profiles p where p.user_id=v_user_id;
  if v_existing_ephis is not null and v_existing_ephis<>v_ephis then raise exception 'CI_EPHIS_ID_IMMUTABLE'; end if;
  if exists(select 1 from public.ci_user_profiles p where lower(btrim(p.ephis_id))=v_ephis and p.user_id<>v_user_id) then
    raise exception 'CI_EPHIS_ID_ALREADY_ASSIGNED';
  end if;

  insert into public.ci_user_profiles(user_id,ephis_id,display_name,active)
  values(v_user_id,v_ephis,btrim(p_display_name),p_active)
  on conflict(user_id) do update set display_name=excluded.display_name,active=excluded.active;

  update public.ci_user_access
  set active=false
  where user_id=v_user_id and active and (not (warehouse_id=any(v_warehouses)) or not p_active);

  foreach v_warehouse in array v_warehouses loop
    insert into public.ci_user_access(user_id,warehouse_id,role,active)
    values(v_user_id,v_warehouse,p_role,p_active)
    on conflict(user_id,warehouse_id) do update set role=excluded.role,active=excluded.active;
  end loop;

  perform ci_private.audit(null,'PROVISION','ci_user_profiles',v_user_id::text);
end $$;

-- One-time bootstrap is restricted to a service-role JWT and refuses to
-- escalate or replace any existing application user.
create function public.ci_bootstrap_first_admin(p_ephis_id text,p_display_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_ephis text;
  v_email text;
  v_user_id uuid;
begin
  if auth.jwt()->>'role' is distinct from 'service_role' then
    raise exception 'CI_BOOTSTRAP_SERVICE_ROLE_REQUIRED' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(74628391021::bigint);

  v_ephis:=lower(btrim(coalesce(p_ephis_id,'')));
  if v_ephis !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then raise exception 'CI_EPHIS_ID_INVALID'; end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 120 then raise exception 'CI_DISPLAY_NAME_INVALID'; end if;
  v_email:='ephis.'||v_ephis||'@chem-immuno.internal';
  select u.id into v_user_id from auth.users u where lower(u.email)=v_email;
  if v_user_id is null then raise exception 'CI_AUTH_USER_NOT_FOUND'; end if;

  if exists(select 1 from public.ci_user_profiles p where p.user_id=v_user_id and p.ephis_id=v_ephis and p.active
      and exists(select 1 from public.ci_user_access a where a.user_id=v_user_id and a.warehouse_id=1 and a.role='admin' and a.active)
      and exists(select 1 from public.ci_user_access a where a.user_id=v_user_id and a.warehouse_id=2 and a.role='admin' and a.active)) then
    return;
  end if;
  if exists(select 1 from public.ci_user_profiles) then raise exception 'CI_BOOTSTRAP_NOT_FIRST_APPLICATION_USER'; end if;
  if exists(select 1 from public.ci_user_profiles p where lower(btrim(p.ephis_id))=v_ephis) then raise exception 'CI_EPHIS_ID_ALREADY_ASSIGNED'; end if;

  insert into public.ci_user_profiles(user_id,ephis_id,display_name,active)
  values(v_user_id,v_ephis,btrim(p_display_name),true);
  insert into public.ci_user_access(user_id,warehouse_id,role,active)
  values(v_user_id,1,'admin',true),(v_user_id,2,'admin',true);
  perform ci_private.audit(null,'BOOTSTRAP_ADMIN','ci_user_profiles',v_user_id::text);
end $$;

-- Retire the legacy RPC whose target Auth UUID came from a browser field.
revoke all on function public.ci_upsert_user_access(uuid,text,smallint,text,boolean) from public,anon,authenticated;
revoke all on function public.ci_provision_user(text,text,text,smallint[],boolean) from public,anon,authenticated;
grant execute on function public.ci_provision_user(text,text,text,smallint[],boolean) to authenticated;
revoke all on function public.ci_bootstrap_first_admin(text,text) from public,anon,authenticated;
grant execute on function public.ci_bootstrap_first_admin(text,text) to service_role;
