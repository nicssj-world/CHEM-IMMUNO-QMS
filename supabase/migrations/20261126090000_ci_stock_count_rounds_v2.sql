-- Stock count rounds v2: scoped rounds, per-line "counted" checklist, partial finalize,
-- per-line conflict detection and safe deletion of rounds that never adjusted stock.
--
-- Additive and backward compatible:
--  * no ledger row (ci_stock_transactions / ci_stock_movement_lines) is changed or deleted;
--  * the existing RPCs keep their contracts, so the previous app version keeps working
--    while this migration is live (ci_set_stock_count_line now also records who counted);
--  * existing lines that already have a physical quantity are marked counted.

do $preflight$
begin
  if to_regclass('public.ci_unified_stock_counts') is null
    or to_regclass('public.ci_location_warehouses') is null
    or to_regprocedure('ci_private.ci_create_stock_count(jsonb)') is null
  then raise exception 'CI_COUNT_ROUNDS_V2_PREREQUISITE_MISSING'; end if;
end $preflight$;

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
alter table public.ci_stock_count_lines
  add column counted_by uuid references auth.users(id),
  add column counted_at timestamptz,
  add column needs_recount boolean not null default false;

-- "Counted" is counted_at; legacy rows that already carry a physical quantity were counted.
update public.ci_stock_count_lines cl
set counted_at = coalesce(c.approved_at, c.created_at)
from public.ci_stock_counts c
where c.id = cl.count_id and cl.physical_quantity is not null and cl.counted_at is null;

alter table public.ci_stock_count_lines add constraint ci_stock_count_lines_counted_consistent
  check ((counted_at is null) = (physical_quantity is null));

create index ci_stock_count_lines_count_idx on public.ci_stock_count_lines(count_id);

alter table public.ci_unified_stock_counts
  add column scope_type text not null default 'all'
    check (scope_type in ('all','locations','group','products')),
  add column scope jsonb not null default '{}'::jsonb,
  add column client_key uuid,
  add column request_hash text;
create unique index ci_unified_stock_counts_client_key
  on public.ci_unified_stock_counts(created_by, client_key) where client_key is not null;

-- A round scoped to one group is readable by everyone who can read that group.
drop policy ci_unified_stock_counts_read on public.ci_unified_stock_counts;
create policy ci_unified_stock_counts_read on public.ci_unified_stock_counts
  for select to authenticated
  using ((che_count_id is null or ci_private.can_read(1::smallint))
     and (imm_count_id is null or ci_private.can_read(2::smallint)));

-- Progress per internal count, so the round list never downloads every line.
create view public.ci_stock_count_progress with (security_invoker=true) as
select count_id, warehouse_id,
  count(*)::integer as total_lines,
  count(*) filter (where counted_at is not null)::integer as counted_lines,
  count(*) filter (where counted_at is not null and physical_quantity <> snapshot_quantity)::integer as variance_lines,
  count(*) filter (where needs_recount)::integer as recount_lines
from public.ci_stock_count_lines
group by count_id, warehouse_id;
revoke all on public.ci_stock_count_progress from public, anon;
grant select on public.ci_stock_count_progress to authenticated;

-- ---------------------------------------------------------------------------
-- Create a scoped round (idempotent per actor + client key)
-- ---------------------------------------------------------------------------
create function ci_private.ci_create_stock_count_round(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_key uuid;
  v_hash text;
  v_note text := nullif(btrim(coalesce(p_data->>'note','')),'');
  v_type text := coalesce(p_data->>'scope_type','all');
  v_allow_parallel boolean := coalesce((p_data->>'allow_parallel')::boolean,false);
  v_whs smallint[];
  v_wh smallint;
  v_locations uuid[];
  v_products uuid[];
  v_lines jsonb;
  v_count uuid;
  v_che uuid;
  v_imm uuid;
  v_batch uuid;
  v_existing public.ci_unified_stock_counts%rowtype;
  v_scope jsonb := '{}'::jsonb;
begin
  if v_actor is null then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  if p_data is null or length(p_data::text) > 100000 then raise exception 'CI_COUNT_SCOPE_INVALID'; end if;
  begin
    v_key := (p_data->>'client_key')::uuid;
  exception when others then raise exception 'CI_IDEMPOTENCY_KEY_REQUIRED';
  end;
  if v_key is null then raise exception 'CI_IDEMPOTENCY_KEY_REQUIRED'; end if;
  if length(coalesce(v_note,'')) > 1000 then raise exception 'CI_COUNT_NOTE_TOO_LONG'; end if;
  if v_type not in ('all','locations','group','products') then raise exception 'CI_COUNT_SCOPE_INVALID'; end if;
  -- allow_parallel only expresses intent; it is not part of the request identity.
  v_hash := md5((p_data - 'allow_parallel')::text);

  -- Double click / network retry with the same key returns the same round.
  perform pg_advisory_xact_lock(hashtext(v_actor::text), hashtext(v_key::text));
  select * into v_existing from public.ci_unified_stock_counts
  where created_by=v_actor and client_key=v_key;
  if found then
    if v_existing.request_hash is distinct from v_hash then raise exception 'CI_IDEMPOTENCY_PAYLOAD_CONFLICT'; end if;
    return v_existing.id;
  end if;

  if v_type='group' then
    begin v_wh := (p_data->'scope'->>'warehouse_id')::smallint;
    exception when others then raise exception 'CI_COUNT_SCOPE_INVALID'; end;
    if v_wh is null or v_wh not in (1,2) then raise exception 'CI_COUNT_SCOPE_INVALID'; end if;
    perform ci_private.require_role(v_wh,array['admin','supervisor','staff']);
    v_whs := array[v_wh];
    v_scope := jsonb_build_object('warehouse_id',v_wh);
  else
    select array_agg(id order by id) into v_whs from public.ci_warehouses
    where id in (1,2) and ci_private.has_role(id,array['admin','supervisor','staff']);
    if v_whs is null then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  end if;

  if v_type='locations' then
    begin
      select array_agg(distinct x::uuid) into v_locations
      from jsonb_array_elements_text(coalesce(p_data->'scope'->'location_ids','[]'::jsonb)) x;
    exception when others then raise exception 'CI_COUNT_SCOPE_INVALID'; end;
    if v_locations is null or cardinality(v_locations) > 500
      or exists(select 1 from unnest(v_locations) x where not exists(select 1 from public.ci_locations l where l.id=x))
    then raise exception 'CI_COUNT_SCOPE_INVALID'; end if;
    v_scope := jsonb_build_object('location_ids',to_jsonb(v_locations));
    -- A refrigerator includes the shelves inside it (hierarchy depth is at most two).
    select array_agg(distinct id) into v_locations from public.ci_locations
    where id = any(v_locations) or parent_location_id = any(v_locations);
  elsif v_type='products' then
    begin
      select array_agg(distinct x::uuid) into v_products
      from jsonb_array_elements_text(coalesce(p_data->'scope'->'product_ids','[]'::jsonb)) x;
    exception when others then raise exception 'CI_COUNT_SCOPE_INVALID'; end;
    if v_products is null or cardinality(v_products) > 2000 then raise exception 'CI_COUNT_SCOPE_INVALID'; end if;
    -- Every chosen product must exist and belong to a group the actor may count.
    if exists(select 1 from unnest(v_products) x
              where not exists(select 1 from public.ci_products p where p.id=x and p.warehouse_id = any(v_whs)))
    then raise exception 'CI_COUNT_SCOPE_INVALID'; end if;
    select array_agg(distinct warehouse_id order by warehouse_id) into v_whs
    from public.ci_products where id = any(v_products);
    v_scope := jsonb_build_object('product_ids',to_jsonb(v_products));
  end if;

  -- Starting another round while one is still open must be a deliberate choice.
  if not v_allow_parallel and exists(
    select 1 from public.ci_unified_stock_counts b
    join public.ci_stock_counts c on c.id in (b.che_count_id,b.imm_count_id)
    where c.status='draft' and c.warehouse_id = any(v_whs)
  ) then raise exception 'CI_COUNT_OPEN_ROUND_EXISTS'; end if;

  foreach v_wh in array v_whs loop
    select jsonb_agg(jsonb_build_object('lot_id',b.lot_id,'location_id',b.location_id)
      order by b.lot_id,b.location_id) into v_lines
    from public.ci_stock_balances b
    where b.warehouse_id=v_wh and b.balance>0
      and (v_locations is null or b.location_id = any(v_locations))
      and (v_products is null or b.product_id = any(v_products));
    if v_lines is not null then
      v_count := ci_private.ci_create_stock_count(
        jsonb_build_object('warehouse_id',v_wh,'note',coalesce(v_note,''),'lines',v_lines));
      if v_wh=1 then v_che:=v_count; else v_imm:=v_count; end if;
    end if;
  end loop;
  if v_che is null and v_imm is null then raise exception 'CI_COUNT_NO_STOCK'; end if;

  insert into public.ci_unified_stock_counts(che_count_id,imm_count_id,created_by,note,scope_type,scope,client_key,request_hash)
  values(v_che,v_imm,v_actor,v_note,v_type,v_scope,v_key,v_hash) returning id into v_batch;
  return v_batch;
end $$;

-- ---------------------------------------------------------------------------
-- Mark one line counted (with its physical quantity) or not counted
-- ---------------------------------------------------------------------------
create function ci_private.ci_set_stock_count_line_state(p_count_id uuid,p_line_id uuid,p_counted boolean,p_physical_quantity numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_count public.ci_stock_counts%rowtype; v_line public.ci_stock_count_lines%rowtype;
begin
  if auth.uid() is null then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  -- Share lock: concurrent counters proceed together, but finalize/delete (FOR UPDATE) wait.
  select * into v_count from public.ci_stock_counts where id=p_count_id for share;
  if not found then raise exception 'CI_COUNT_NOT_FOUND'; end if;
  perform ci_private.require_role(v_count.warehouse_id,array['admin','supervisor','staff']);
  if v_count.status<>'draft' then raise exception 'CI_COUNT_NOT_EDITABLE'; end if;
  if p_counted is null then raise exception 'CI_COUNT_LINE_INVALID'; end if;
  if p_counted then
    if p_physical_quantity is null or p_physical_quantity<0 or p_physical_quantity>100000000
      or p_physical_quantity<>round(p_physical_quantity,3)
    then raise exception 'CI_COUNT_LINE_INVALID'; end if;
    update public.ci_stock_count_lines
      set physical_quantity=p_physical_quantity,counted_at=now(),counted_by=auth.uid(),needs_recount=false
      where id=p_line_id and count_id=p_count_id returning * into v_line;
  else
    -- Undo keeps the line in the round; it simply becomes "not counted" again.
    update public.ci_stock_count_lines
      set physical_quantity=null,counted_at=null,counted_by=null
      where id=p_line_id and count_id=p_count_id returning * into v_line;
  end if;
  if v_line.id is null then raise exception 'CI_COUNT_LINE_NOT_FOUND'; end if;
  perform ci_private.audit(v_count.warehouse_id,case when p_counted then 'ENTER_PHYSICAL' else 'CLEAR_PHYSICAL' end,
    'ci_stock_count_lines',p_line_id::text);
  return jsonb_build_object('line_id',v_line.id,'counted',v_line.counted_at is not null,
    'physical_quantity',v_line.physical_quantity,'counted_at',v_line.counted_at);
end $$;

-- The previous entry point keeps its contract and now records who counted.
create or replace function ci_private.ci_set_stock_count_line(p_line_id uuid,p_physical_quantity numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare v_count uuid;
begin
  select count_id into v_count from public.ci_stock_count_lines where id=p_line_id;
  if v_count is null then raise exception 'CI_COUNT_LINE_INVALID'; end if;
  if p_physical_quantity is null or p_physical_quantity<0 then raise exception 'CI_COUNT_LINE_INVALID'; end if;
  perform ci_private.ci_set_stock_count_line_state(v_count,p_line_id,true,p_physical_quantity);
exception when others then
  if sqlerrm in ('CI_COUNT_NOT_EDITABLE','CI_COUNT_LINE_NOT_FOUND') then raise exception 'CI_COUNT_LINE_INVALID'; end if;
  raise;
end $$;

-- ---------------------------------------------------------------------------
-- Resolve a round id (unified batch or standalone legacy count) to its members
-- ---------------------------------------------------------------------------
create function ci_private.count_round_members(p_round_id uuid, out o_members uuid[], out o_owner uuid, out o_batch boolean)
language plpgsql security definer set search_path = '' as $$
declare v_batch public.ci_unified_stock_counts%rowtype; v_owner uuid;
begin
  select * into v_batch from public.ci_unified_stock_counts where id=p_round_id for update;
  if found then
    o_members := array(select x from unnest(array[v_batch.che_count_id,v_batch.imm_count_id]) x where x is not null order by x);
    o_owner := v_batch.created_by; o_batch := true; return;
  end if;
  -- A member of a unified round is managed through its round only.
  if exists(select 1 from public.ci_unified_stock_counts where che_count_id=p_round_id or imm_count_id=p_round_id)
  then raise exception 'CI_COUNT_ROUND_INVALID'; end if;
  select created_by into v_owner from public.ci_stock_counts where id=p_round_id;
  if v_owner is null then raise exception 'CI_COUNT_NOT_FOUND'; end if;
  o_members := array[p_round_id]; o_owner := v_owner; o_batch := false;
end $$;

-- ---------------------------------------------------------------------------
-- Finalize: adjust only counted lines that differ; uncounted lines keep their balance
-- ---------------------------------------------------------------------------
create function ci_private.ci_finalize_stock_count_round(p_round_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r record; v_member record; v_line record;
  v_locked integer; v_counted integer; v_total integer;
  v_balance numeric; v_n bigint; v_conflicts integer := 0; v_adjusted integer := 0; v_tx uuid;
begin
  if auth.uid() is null then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  select * into r from ci_private.count_round_members(p_round_id);
  select count(*) into v_locked from (
    select id from public.ci_stock_counts where id = any(r.o_members) order by id for update) locked;
  if v_locked<>cardinality(r.o_members) then raise exception 'CI_COUNT_NOT_FOUND'; end if;
  for v_member in select * from public.ci_stock_counts where id = any(r.o_members) order by id loop
    perform ci_private.require_role(v_member.warehouse_id,array['admin','supervisor']);
  end loop;
  -- Approving twice is a no-op, never a second adjustment.
  if not exists(select 1 from public.ci_stock_counts where id = any(r.o_members) and status<>'approved') then
    return jsonb_build_object('status','approved','already',true);
  end if;
  if exists(select 1 from public.ci_stock_counts where id = any(r.o_members) and status<>'draft') then
    raise exception 'CI_COUNT_NOT_EDITABLE';
  end if;
  select count(*) filter (where counted_at is not null), count(*) into v_counted, v_total
  from public.ci_stock_count_lines where count_id = any(r.o_members);
  if v_counted=0 then raise exception 'CI_COUNT_NOTHING_COUNTED'; end if;

  perform ci_private.lock_products(array(
    select distinct l.product_id from public.ci_stock_count_lines cl
    join public.ci_stock_lots l on l.id=cl.lot_id
    where cl.count_id = any(r.o_members) and cl.counted_at is not null));

  -- Only counted lines matter. A counted line whose stock moved after it was snapshotted is
  -- reopened against the current balance so nobody overwrites newer stock with an old count.
  for v_line in select * from public.ci_stock_count_lines
    where count_id = any(r.o_members) and counted_at is not null order by count_id,lot_id,location_id loop
    select coalesce(sum(quantity_delta),0),count(*) into v_balance,v_n
    from public.ci_stock_movement_lines where lot_id=v_line.lot_id and location_id=v_line.location_id;
    if v_n<>v_line.snapshot_movement_count or v_balance<>v_line.snapshot_quantity then
      update public.ci_stock_count_lines
        set snapshot_quantity=greatest(v_balance,0),snapshot_movement_count=v_n,
            physical_quantity=null,counted_at=null,counted_by=null,needs_recount=true
        where id=v_line.id;
      v_conflicts := v_conflicts+1;
    end if;
  end loop;
  if v_conflicts>0 then
    for v_member in select * from public.ci_stock_counts where id = any(r.o_members) order by id loop
      perform ci_private.audit(v_member.warehouse_id,'RECOUNT_REQUIRED','ci_stock_counts',v_member.id::text,
        'Stock moved after counting; lines reopened');
    end loop;
    return jsonb_build_object('status','recount','recount_lines',v_conflicts);
  end if;

  for v_member in select * from public.ci_stock_counts where id = any(r.o_members) order by id loop
    v_tx := null;
    if exists(select 1 from public.ci_stock_count_lines where count_id=v_member.id
              and counted_at is not null and physical_quantity<>snapshot_quantity) then
      insert into public.ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id,reason)
      values(v_member.warehouse_id,'adjustment','count:'||v_member.id::text,
        md5('count-round:'||v_member.id::text),auth.uid(),'ตรวจนับคลังน้ำยา') returning id into v_tx;
      for v_line in select * from public.ci_stock_count_lines where count_id=v_member.id
        and counted_at is not null and physical_quantity<>snapshot_quantity order by lot_id,location_id loop
        perform ci_private.add_movement(v_tx,v_member.warehouse_id,v_line.lot_id,v_line.location_id,
          v_line.physical_quantity-v_line.snapshot_quantity);
        v_adjusted := v_adjusted+1;
      end loop;
    end if;
    update public.ci_stock_counts set status='approved',approved_by=auth.uid(),approved_at=now() where id=v_member.id;
    perform ci_private.audit(v_member.warehouse_id,'APPROVE','ci_stock_counts',v_member.id::text,
      case when v_counted<v_total then 'Partial count' else 'Complete count' end);
  end loop;
  return jsonb_build_object('status','approved','already',false,'counted_lines',v_counted,
    'total_lines',v_total,'adjusted_lines',v_adjusted,'partial',v_counted<v_total);
end $$;

-- ---------------------------------------------------------------------------
-- Delete rounds that never adjusted stock (all-or-nothing for the whole selection)
-- ---------------------------------------------------------------------------
create function ci_private.ci_delete_stock_count_rounds(p_round_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare v_id uuid; r record; v_member record; v_locked integer; v_deleted integer := 0;
begin
  if auth.uid() is null then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  if p_round_ids is null or cardinality(p_round_ids) not between 1 and 100 then raise exception 'CI_COUNT_ROUND_INVALID'; end if;
  for v_id in select distinct x from unnest(p_round_ids) x where x is not null order by x loop
    select * into r from ci_private.count_round_members(v_id);
    select count(*) into v_locked from (
      select id from public.ci_stock_counts where id = any(r.o_members) order by id for update) locked;
    if v_locked<>cardinality(r.o_members) then raise exception 'CI_COUNT_NOT_FOUND'; end if;
    for v_member in select * from public.ci_stock_counts where id = any(r.o_members) order by id loop
      -- Admins manage every round in their groups; the creator may delete their own round.
      if not (ci_private.has_role(v_member.warehouse_id,array['admin'])
        or (r.o_owner=auth.uid() and ci_private.has_role(v_member.warehouse_id,array['admin','supervisor','staff'])))
      then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
      -- Decide on the stored state and on ledger evidence, never on what a page showed.
      if v_member.status='approved' or exists(
        select 1 from public.ci_stock_transactions t
        where t.warehouse_id=v_member.warehouse_id and t.kind='adjustment' and t.idempotency_key='count:'||v_member.id::text)
      then raise exception 'CI_COUNT_ROUND_FINAL'; end if;
    end loop;
    if r.o_batch then delete from public.ci_unified_stock_counts where id=v_id; end if;
    delete from public.ci_stock_count_lines where count_id = any(r.o_members);
    for v_member in select * from public.ci_stock_counts where id = any(r.o_members) order by id loop
      perform ci_private.audit(v_member.warehouse_id,'DELETE','ci_stock_counts',v_member.id::text,
        'Unadjusted count round deleted');
    end loop;
    delete from public.ci_stock_counts where id = any(r.o_members);
    v_deleted := v_deleted+1;
  end loop;
  return v_deleted;
end $$;

-- ---------------------------------------------------------------------------
-- Grants: implementations stay private; public wrappers are invoker-only.
-- ---------------------------------------------------------------------------
revoke all on function ci_private.ci_create_stock_count_round(jsonb) from public,anon;
revoke all on function ci_private.ci_set_stock_count_line_state(uuid,uuid,boolean,numeric) from public,anon;
revoke all on function ci_private.ci_finalize_stock_count_round(uuid) from public,anon;
revoke all on function ci_private.ci_delete_stock_count_rounds(uuid[]) from public,anon;
revoke all on function ci_private.count_round_members(uuid) from public,anon,authenticated;
grant execute on function ci_private.ci_create_stock_count_round(jsonb) to authenticated;
grant execute on function ci_private.ci_set_stock_count_line_state(uuid,uuid,boolean,numeric) to authenticated;
grant execute on function ci_private.ci_finalize_stock_count_round(uuid) to authenticated;
grant execute on function ci_private.ci_delete_stock_count_rounds(uuid[]) to authenticated;

create function public.ci_create_stock_count_round(p_data jsonb)
returns uuid language sql set search_path = '' as $$ select ci_private.ci_create_stock_count_round($1) $$;
create function public.ci_set_stock_count_line_state(p_count_id uuid,p_line_id uuid,p_counted boolean,p_physical_quantity numeric)
returns jsonb language sql set search_path = '' as $$ select ci_private.ci_set_stock_count_line_state($1,$2,$3,$4) $$;
create function public.ci_finalize_stock_count_round(p_round_id uuid)
returns jsonb language sql set search_path = '' as $$ select ci_private.ci_finalize_stock_count_round($1) $$;
create function public.ci_delete_stock_count_rounds(p_round_ids uuid[])
returns integer language sql set search_path = '' as $$ select ci_private.ci_delete_stock_count_rounds($1) $$;
revoke all on function public.ci_create_stock_count_round(jsonb) from public,anon;
revoke all on function public.ci_set_stock_count_line_state(uuid,uuid,boolean,numeric) from public,anon;
revoke all on function public.ci_finalize_stock_count_round(uuid) from public,anon;
revoke all on function public.ci_delete_stock_count_rounds(uuid[]) from public,anon;
grant execute on function public.ci_create_stock_count_round(jsonb) to authenticated;
grant execute on function public.ci_set_stock_count_line_state(uuid,uuid,boolean,numeric) to authenticated;
grant execute on function public.ci_finalize_stock_count_round(uuid) to authenticated;
grant execute on function public.ci_delete_stock_count_rounds(uuid[]) to authenticated;
