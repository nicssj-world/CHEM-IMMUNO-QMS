-- Unified count rounds across the two immutable CHE/IMM ledgers.
-- Additive only: existing lot IDs, movements, scopes, history and RLS remain unchanged.
create table public.ci_unified_stock_counts (
  id uuid primary key default gen_random_uuid(),
  che_count_id uuid unique references public.ci_stock_counts(id),
  imm_count_id uuid unique references public.ci_stock_counts(id),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  note text,
  constraint ci_unified_count_members_present check (che_count_id is not null or imm_count_id is not null),
  constraint ci_unified_count_note_length check (length(coalesce(note, '')) <= 1000)
);
alter table public.ci_unified_stock_counts enable row level security;
revoke all on public.ci_unified_stock_counts from public, anon;
grant select on public.ci_unified_stock_counts to authenticated;
create policy ci_unified_stock_counts_read on public.ci_unified_stock_counts
  for select to authenticated
  using (ci_private.can_read(1::smallint) and ci_private.can_read(2::smallint));

create function ci_private.ci_create_unified_stock_count(p_note text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_wh smallint;
  v_lines jsonb;
  v_count_id uuid;
  v_che uuid;
  v_imm uuid;
  v_batch uuid;
begin
  -- The single visible inventory requires access to both independent internal scopes.
  perform ci_private.require_role(1::smallint,array['admin','supervisor','staff']);
  perform ci_private.require_role(2::smallint,array['admin','supervisor','staff']);
  if length(coalesce(p_note,'')) > 1000 then raise exception 'CI_COUNT_NOTE_TOO_LONG'; end if;

  -- A single function call is one database transaction. If either count creation fails,
  -- neither internal snapshot nor the unified batch is committed.
  for v_wh in select id from public.ci_warehouses where id in (1,2) order by id loop
    select jsonb_agg(jsonb_build_object('lot_id',b.lot_id,'location_id',b.location_id)
      order by b.lot_id,b.location_id) into v_lines
    from public.ci_stock_balances b
    where b.warehouse_id=v_wh and b.balance>0;
    if v_lines is not null then
      v_count_id := ci_private.ci_create_stock_count(
        jsonb_build_object('warehouse_id',v_wh,'note',coalesce(p_note,''),'lines',v_lines));
      if v_wh=1 then v_che:=v_count_id; else v_imm:=v_count_id; end if;
    end if;
  end loop;
  if v_che is null and v_imm is null then raise exception 'CI_COUNT_NO_STOCK'; end if;

  insert into public.ci_unified_stock_counts(che_count_id,imm_count_id,created_by,note)
  values(v_che,v_imm,auth.uid(),p_note) returning id into v_batch;
  return v_batch;
end $$;
revoke all on function ci_private.ci_create_unified_stock_count(text) from public,anon;
grant execute on function ci_private.ci_create_unified_stock_count(text) to authenticated;
create function public.ci_create_unified_stock_count(p_note text)
returns uuid language sql set search_path = ''
as $$ select ci_private.ci_create_unified_stock_count($1) $$;
revoke all on function public.ci_create_unified_stock_count(text) from public,anon;
grant execute on function public.ci_create_unified_stock_count(text) to authenticated;

create function ci_private.ci_approve_unified_stock_count(p_batch_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_batch public.ci_unified_stock_counts%rowtype;
  v_count uuid;
  v_result jsonb;
begin
  if nullif(btrim(coalesce(p_reason,'')),'') is null or length(p_reason)>1000 then
    raise exception 'CI_COUNT_APPROVAL_REASON_REQUIRED';
  end if;
  perform ci_private.require_role(1::smallint,array['admin','supervisor']);
  perform ci_private.require_role(2::smallint,array['admin','supervisor']);
  select * into v_batch from public.ci_unified_stock_counts
  where id=p_batch_id for update;
  if not found then raise exception 'CI_COUNT_NOT_FOUND'; end if;
  for v_count in select member from (values(v_batch.che_count_id),(v_batch.imm_count_id)) as counts(member)
      where member is not null loop
    if not exists (select 1 from public.ci_stock_counts
       where id=v_count and status='draft') then raise exception 'CI_COUNT_APPROVAL_INVALID'; end if;
    if exists (select 1 from public.ci_stock_count_lines
       where count_id=v_count and physical_quantity is null) then raise exception 'CI_COUNT_INCOMPLETE'; end if;
  end loop;
  -- An incomplete/stale second count raises and rolls back any earlier approval/movements.
  for v_count in select member from (values(v_batch.che_count_id),(v_batch.imm_count_id)) as counts(member)
      where member is not null loop
    v_result:=ci_private.ci_approve_stock_count(v_count,p_reason);
    if v_result->>'status' <> 'approved' then raise exception 'CI_UNIFIED_COUNT_STALE'; end if;
  end loop;
  return jsonb_build_object('status','approved','batch_id',p_batch_id);
end $$;
revoke all on function ci_private.ci_approve_unified_stock_count(uuid,text) from public,anon;
grant execute on function ci_private.ci_approve_unified_stock_count(uuid,text) to authenticated;
create function public.ci_approve_unified_stock_count(p_batch_id uuid,p_reason text)
returns jsonb language sql set search_path = ''
as $$ select ci_private.ci_approve_unified_stock_count($1,$2) $$;
revoke all on function public.ci_approve_unified_stock_count(uuid,text) from public,anon;
grant execute on function public.ci_approve_unified_stock_count(uuid,text) to authenticated;
