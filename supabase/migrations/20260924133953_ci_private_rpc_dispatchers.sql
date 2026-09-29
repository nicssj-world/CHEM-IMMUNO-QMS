set local search_path = '';

create temporary table ci_private_rpc_move on commit drop as
select
  p.oid as function_oid,
  p.proname,
  pg_get_function_identity_arguments(p.oid) as identity_arguments,
  pg_get_function_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid) as result_type,
  p.pronargs,
  p.proretset,
  p.provolatile,
  p.proisstrict,
  p.proparallel,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and p.prokind = 'f'
  and p.proname like 'ci\_%' escape '\';

do $migration$
declare
  v_function record;
  v_argument_list text;
  v_body text;
  v_volatility text;
  v_parallel text;
  v_sql text;
begin
  if not exists (select 1 from pg_temp.ci_private_rpc_move) then
    raise exception 'CI_RPC_MOVE_FOUND_NO_PRIVILEGED_FUNCTIONS';
  end if;

  if exists (select 1 from pg_temp.ci_private_rpc_move where anon_execute) then
    raise exception 'CI_RPC_MOVE_REFUSES_ANON_EXECUTABLE_FUNCTIONS';
  end if;

  if exists (select 1 from pg_temp.ci_private_rpc_move where service_role_execute) then
    execute 'grant usage on schema ci_private to service_role';
  end if;

  for v_function in select * from pg_temp.ci_private_rpc_move order by proname, identity_arguments loop
    if exists (
      select 1
      from pg_catalog.pg_proc p
      where p.pronamespace = 'ci_private'::pg_catalog.regnamespace
        and p.proname = v_function.proname
        and pg_get_function_identity_arguments(p.oid) = v_function.identity_arguments
    ) then
      raise exception 'CI_RPC_MOVE_PRIVATE_FUNCTION_COLLISION: % (%)', v_function.proname, v_function.identity_arguments;
    end if;

    execute pg_catalog.format(
      'alter function public.%I(%s) set schema ci_private',
      v_function.proname,
      v_function.identity_arguments
    );
    execute pg_catalog.format(
      'alter function ci_private.%I(%s) set search_path = %L',
      v_function.proname,
      v_function.identity_arguments,
      ''
    );

    select pg_catalog.string_agg('$' || argument_number::text, ', ' order by argument_number)
      into v_argument_list
      from pg_catalog.generate_series(1, v_function.pronargs) as argument_number;
    v_argument_list := coalesce(v_argument_list, '');

    if v_function.proretset then
      v_body := pg_catalog.format('select * from ci_private.%I(%s)', v_function.proname, v_argument_list);
    else
      v_body := pg_catalog.format('select ci_private.%I(%s)', v_function.proname, v_argument_list);
    end if;

    v_volatility := case v_function.provolatile
      when 'i' then 'immutable'
      when 's' then 'stable'
      else 'volatile'
    end;
    v_parallel := case v_function.proparallel
      when 's' then 'parallel safe'
      when 'r' then 'parallel restricted'
      else 'parallel unsafe'
    end;

    v_sql := pg_catalog.format(
      'create function public.%I(%s) returns %s language sql %s %s %s security invoker set search_path = %L as %L',
      v_function.proname,
      v_function.arguments,
      v_function.result_type,
      v_volatility,
      case when v_function.proisstrict then 'strict' else 'called on null input' end,
      v_parallel,
      '',
      v_body
    );
    execute v_sql;

    execute pg_catalog.format(
      'revoke all on function public.%I(%s) from public, anon, authenticated, service_role',
      v_function.proname,
      v_function.identity_arguments
    );
    if v_function.authenticated_execute then
      execute pg_catalog.format(
        'grant execute on function public.%I(%s) to authenticated',
        v_function.proname,
        v_function.identity_arguments
      );
    end if;
    if v_function.service_role_execute then
      execute pg_catalog.format(
        'grant execute on function public.%I(%s) to service_role',
        v_function.proname,
        v_function.identity_arguments
      );
    end if;
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_proc p
    where p.pronamespace = 'public'::pg_catalog.regnamespace
      and p.prosecdef
      and p.proname like 'ci\_%' escape '\'
  ) then
    raise exception 'CI_RPC_MOVE_PUBLIC_SECURITY_DEFINER_REMAINS';
  end if;

  perform pg_catalog.pg_notify('pgrst', 'reload schema');
end
$migration$;
