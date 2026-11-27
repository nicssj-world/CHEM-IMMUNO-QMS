-- Phase 2 of the CHEM-IMMUNO CBH next workstream: Morning Talk.
--
-- Scoped daily briefings (ALL / CHE / IMM) with attendees who acknowledge for themselves, a shared checklist and action items.
-- Design rules (docs/CHEM-IMMUNO-CBH-NEXT-WORKSTREAM-PLAN.md, Phase 2):
--   * Reads follow row-level security on the warehouse scope; every write is a published ci_private RPC that checks the actor.
--   * Actor helpers (auth.uid()) and candidate helpers (an explicit user id) are separate functions and are never interchangeable.
--   * CHE / IMM are resolved by ci_warehouses.code; no function, policy or test assumes a numeric warehouse id.
--   * Acknowledgement is self-only and is enforced by the RPC AND by a trigger; nothing can acknowledge for another user.
--   * Talks are cancelled, never deleted; actions are cancelled, never deleted; completed evidence is never silently removed.
--
-- Migration hygiene: no session-level configuration statements; every object reference is schema-qualified and every
-- function declares its own `set search_path = ''`.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.ci_morning_talks (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  warehouse_id smallint,
  talk_date date not null default ((now() at time zone 'Asia/Bangkok')::date),
  title text not null,
  agenda text,
  status text not null default 'active',
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id),
  cancel_reason text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  constraint ci_morning_talks_scope_chk check (scope in ('ALL', 'CHE', 'IMM')),
  constraint ci_morning_talks_scope_warehouse_chk check ((scope = 'ALL') = (warehouse_id is null)),
  constraint ci_morning_talks_warehouse_code_fk foreign key (warehouse_id, scope) references public.ci_warehouses (id, code),
  constraint ci_morning_talks_title_chk check (title = btrim(title) and char_length(title) between 1 and 200),
  constraint ci_morning_talks_agenda_chk check (agenda is null or char_length(agenda) between 1 and 5000),
  constraint ci_morning_talks_status_chk check (status in ('active', 'cancelled')),
  constraint ci_morning_talks_cancel_chk check (
    (status = 'cancelled') = (cancelled_at is not null)
    and (cancelled_at is not null) = (cancelled_by is not null)
    and (cancelled_at is not null) = (cancel_reason is not null)
    and (cancel_reason is null or char_length(cancel_reason) between 1 and 500)
  )
);
create index ci_morning_talks_date_idx on public.ci_morning_talks (talk_date desc, created_at desc);
create index ci_morning_talks_warehouse_date_idx on public.ci_morning_talks (warehouse_id, talk_date desc);

create table public.ci_morning_talk_attendees (
  talk_id uuid not null references public.ci_morning_talks(id) on delete cascade,
  warehouse_id smallint,
  user_id uuid not null references public.ci_user_profiles(user_id),
  assigned_at timestamptz not null default now(),
  assigned_by uuid not null references auth.users(id),
  acknowledged_at timestamptz,
  constraint ci_morning_talk_attendees_pkey primary key (talk_id, user_id),
  constraint ci_morning_talk_attendees_ack_chk check (acknowledged_at is null or acknowledged_at >= assigned_at)
);
create index ci_morning_talk_attendees_user_idx on public.ci_morning_talk_attendees (user_id, acknowledged_at);

create table public.ci_morning_talk_checklist_items (
  id uuid primary key default gen_random_uuid(),
  talk_id uuid not null references public.ci_morning_talks(id) on delete cascade,
  warehouse_id smallint,
  sort_order integer not null,
  title text not null,
  completed_at timestamptz,
  completed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ci_morning_talk_checklist_sort_chk check (sort_order >= 0),
  constraint ci_morning_talk_checklist_title_chk check (title = btrim(title) and char_length(title) between 1 and 240),
  constraint ci_morning_talk_checklist_completion_chk check ((completed_at is null) = (completed_by is null))
);
create index ci_morning_talk_checklist_talk_idx on public.ci_morning_talk_checklist_items (talk_id, sort_order);

create table public.ci_morning_talk_actions (
  id uuid primary key default gen_random_uuid(),
  talk_id uuid not null references public.ci_morning_talks(id) on delete cascade,
  warehouse_id smallint,
  title text not null,
  owner_id uuid not null references public.ci_user_profiles(user_id),
  due_date date,
  status text not null default 'todo',
  note text,
  completed_at timestamptz,
  completed_by uuid references auth.users(id),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  constraint ci_morning_talk_actions_title_chk check (title = btrim(title) and char_length(title) between 1 and 240),
  constraint ci_morning_talk_actions_status_chk check (status in ('todo', 'in_progress', 'done', 'cancelled')),
  constraint ci_morning_talk_actions_note_chk check (note is null or char_length(note) between 1 and 1000),
  constraint ci_morning_talk_actions_completion_chk check (
    (status = 'done') = (completed_at is not null) and (completed_at is null) = (completed_by is null)
  )
);
create index ci_morning_talk_actions_open_due_idx on public.ci_morning_talk_actions (due_date) where status in ('todo', 'in_progress');
create index ci_morning_talk_actions_owner_idx on public.ci_morning_talk_actions (owner_id, status);
create index ci_morning_talk_actions_talk_idx on public.ci_morning_talk_actions (talk_id);

-- ---------------------------------------------------------------------------
-- 2. Warehouse-code resolution and actor helpers (judge auth.uid())
-- ---------------------------------------------------------------------------
-- Codes are authoritative. An unknown code fails closed instead of evaluating against null.
create function ci_private.warehouse_id_by_code(p_code text) returns smallint
language plpgsql stable security definer set search_path = '' as $$
declare v_id smallint;
begin
  select w.id into v_id from public.ci_warehouses w where w.code = p_code;
  if v_id is null then raise exception 'CI_WAREHOUSE_NOT_FOUND'; end if;
  return v_id;
end $$;
revoke all on function ci_private.warehouse_id_by_code(text) from public, anon, authenticated;

create function ci_private.has_role_code(p_code text, p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select ci_private.has_role(ci_private.warehouse_id_by_code(p_code), p_roles)
$$;
revoke all on function ci_private.has_role_code(text, text[]) from public, anon, authenticated;

-- CHE / IMM: read access to that warehouse. ALL (null): active access to at least one warehouse.
create function ci_private.can_read_scope(p_warehouse_id smallint) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when p_warehouse_id is null then ci_private.has_any_access() else ci_private.can_read(p_warehouse_id) end
$$;
revoke all on function ci_private.can_read_scope(smallint) from public, anon;
grant execute on function ci_private.can_read_scope(smallint) to authenticated;

-- CHE / IMM: admin or supervisor of that warehouse. ALL (null): admin or supervisor in BOTH CHE and IMM.
create function ci_private.can_manage_scope(p_warehouse_id smallint) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when p_warehouse_id is null
    then ci_private.has_role_code('CHE', array['admin','supervisor']) and ci_private.has_role_code('IMM', array['admin','supervisor'])
    else ci_private.has_role(p_warehouse_id, array['admin','supervisor'])
  end
$$;
revoke all on function ci_private.can_manage_scope(smallint) from public, anon;
grant execute on function ci_private.can_manage_scope(smallint) to authenticated;

-- The CURRENT ACTOR may do work in the scope (staff or above). Never used to judge another user.
create function ci_private.can_work_scope(p_warehouse_id smallint) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when p_warehouse_id is null
    then ci_private.has_role_code('CHE', array['admin','supervisor','staff']) or ci_private.has_role_code('IMM', array['admin','supervisor','staff'])
    else ci_private.has_role(p_warehouse_id, array['admin','supervisor','staff'])
  end
$$;
revoke all on function ci_private.can_work_scope(smallint) from public, anon, authenticated;

create function ci_private.require_manage_scope(p_warehouse_id smallint) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not ci_private.can_manage_scope(p_warehouse_id) then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
end $$;
revoke all on function ci_private.require_manage_scope(smallint) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Candidate helpers (judge an explicit user id, never auth.uid()); not published, not executable by users
-- ---------------------------------------------------------------------------
create function ci_private.user_has_role(p_user_id uuid, p_warehouse_id smallint, p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and exists (
    select 1 from public.ci_user_profiles p join public.ci_user_access a on a.user_id = p.user_id
    where p.user_id = p_user_id and p.active and a.active and a.warehouse_id = p_warehouse_id and a.role = any(p_roles)
  )
$$;
revoke all on function ci_private.user_has_role(uuid, smallint, text[]) from public, anon, authenticated;

create function ci_private.user_has_role_code(p_user_id uuid, p_code text, p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select ci_private.user_has_role(p_user_id, ci_private.warehouse_id_by_code(p_code), p_roles)
$$;
revoke all on function ci_private.user_has_role_code(uuid, text, text[]) from public, anon, authenticated;

-- Attendee eligibility: any active role in the scope, viewers included.
create function ci_private.user_in_scope(p_user_id uuid, p_warehouse_id smallint) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when p_warehouse_id is null
    then ci_private.user_has_role_code(p_user_id, 'CHE', array['admin','supervisor','staff','viewer'])
      or ci_private.user_has_role_code(p_user_id, 'IMM', array['admin','supervisor','staff','viewer'])
    else ci_private.user_has_role(p_user_id, p_warehouse_id, array['admin','supervisor','staff','viewer'])
  end
$$;
revoke all on function ci_private.user_in_scope(uuid, smallint) from public, anon, authenticated;

-- Action-owner eligibility: staff or above; viewers can attend but never own an action.
create function ci_private.user_can_work_scope(p_user_id uuid, p_warehouse_id smallint) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when p_warehouse_id is null
    then ci_private.user_has_role_code(p_user_id, 'CHE', array['admin','supervisor','staff'])
      or ci_private.user_has_role_code(p_user_id, 'IMM', array['admin','supervisor','staff'])
    else ci_private.user_has_role(p_user_id, p_warehouse_id, array['admin','supervisor','staff'])
  end
$$;
revoke all on function ci_private.user_can_work_scope(uuid, smallint) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Guards
-- ---------------------------------------------------------------------------
-- Children carry their talk's warehouse (null for ALL); the trigger sets it, so it can never drift from the parent.
create function ci_private.morning_talk_sync_child() returns trigger language plpgsql set search_path = '' as $$
declare v_warehouse smallint; v_found boolean;
begin
  select true, t.warehouse_id into v_found, v_warehouse from public.ci_morning_talks t where t.id = new.talk_id;
  if not coalesce(v_found, false) then raise exception 'CI_MORNING_TALK_NOT_FOUND'; end if;
  if tg_op = 'UPDATE' and new.talk_id <> old.talk_id then raise exception 'CI_MORNING_TALK_CHILD_IMMUTABLE'; end if;
  new.warehouse_id := v_warehouse;
  return new;
end $$;
revoke all on function ci_private.morning_talk_sync_child() from public, anon, authenticated;
create trigger ci_mt_attendees_sync before insert or update on public.ci_morning_talk_attendees for each row execute function ci_private.morning_talk_sync_child();
create trigger ci_mt_checklist_sync before insert or update on public.ci_morning_talk_checklist_items for each row execute function ci_private.morning_talk_sync_child();
create trigger ci_mt_actions_sync before insert or update on public.ci_morning_talk_actions for each row execute function ci_private.morning_talk_sync_child();

create function ci_private.guard_morning_talk() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'CI_MORNING_TALK_NO_DELETE'; end if;
  if new.scope is distinct from old.scope or new.warehouse_id is distinct from old.warehouse_id then raise exception 'CI_MORNING_TALK_SCOPE_IMMUTABLE'; end if;
  if new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then raise exception 'CI_MORNING_TALK_CREATOR_IMMUTABLE'; end if;
  if old.status = 'cancelled' and new.status is distinct from old.status then raise exception 'CI_TALK_CANCELLED'; end if;
  return new;
end $$;
revoke all on function ci_private.guard_morning_talk() from public, anon, authenticated;
create trigger ci_mt_talks_guard before update or delete on public.ci_morning_talks for each row execute function ci_private.guard_morning_talk();

-- Acknowledgement is self-only and immutable once set; an acknowledged attendee cannot be removed.
create function ci_private.guard_morning_talk_attendee() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.acknowledged_at is not null then raise exception 'CI_ATTENDEE_ACKNOWLEDGED'; end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if new.user_id <> old.user_id or new.assigned_at is distinct from old.assigned_at or new.assigned_by is distinct from old.assigned_by then
      raise exception 'CI_MORNING_TALK_CHILD_IMMUTABLE';
    end if;
    if old.acknowledged_at is not null and new.acknowledged_at is distinct from old.acknowledged_at then raise exception 'CI_ACK_IMMUTABLE'; end if;
    if old.acknowledged_at is null and new.acknowledged_at is not null and auth.uid() is distinct from new.user_id then raise exception 'CI_ACK_SELF_ONLY'; end if;
  elsif new.acknowledged_at is not null then
    raise exception 'CI_ACK_SELF_ONLY';
  end if;
  return new;
end $$;
revoke all on function ci_private.guard_morning_talk_attendee() from public, anon, authenticated;
create trigger ci_mt_attendees_guard before insert or update or delete on public.ci_morning_talk_attendees for each row execute function ci_private.guard_morning_talk_attendee();

create function ci_private.guard_morning_talk_checklist() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.completed_at is not null then raise exception 'CI_CHECKLIST_ITEM_COMPLETED'; end if;
  return old;
end $$;
revoke all on function ci_private.guard_morning_talk_checklist() from public, anon, authenticated;
create trigger ci_mt_checklist_guard before delete on public.ci_morning_talk_checklist_items for each row execute function ci_private.guard_morning_talk_checklist();

create function ci_private.guard_morning_talk_action() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'CI_MORNING_ACTION_NO_DELETE';
end $$;
revoke all on function ci_private.guard_morning_talk_action() from public, anon, authenticated;
create trigger ci_mt_actions_guard before delete on public.ci_morning_talk_actions for each row execute function ci_private.guard_morning_talk_action();

-- ---------------------------------------------------------------------------
-- 5. Audit (existing infrastructure) and row-level security
-- ---------------------------------------------------------------------------
create trigger ci_morning_talks_audit after insert or update or delete on public.ci_morning_talks for each row execute function ci_private.audit_change();
create trigger ci_morning_talk_attendees_audit after insert or update or delete on public.ci_morning_talk_attendees for each row execute function ci_private.audit_change();
create trigger ci_morning_talk_checklist_audit after insert or update or delete on public.ci_morning_talk_checklist_items for each row execute function ci_private.audit_change();
create trigger ci_morning_talk_actions_audit after insert or update or delete on public.ci_morning_talk_actions for each row execute function ci_private.audit_change();

do $$ declare t text; begin
  foreach t in array array['ci_morning_talks', 'ci_morning_talk_attendees', 'ci_morning_talk_checklist_items', 'ci_morning_talk_actions'] loop
    execute pg_catalog.format('alter table public.%I enable row level security', t);
    execute pg_catalog.format('revoke all on public.%I from anon, authenticated', t);
    execute pg_catalog.format('grant select on public.%I to authenticated', t);
    execute pg_catalog.format('create policy %I on public.%I for select to authenticated using (ci_private.can_read_scope(warehouse_id))', t || '_read', t);
  end loop;
end $$;

-- CHE / IMM audit rows carry a warehouse_id and already follow ci_audit_read. ALL-scope rows have none: only someone who can manage ALL reads them.
create policy ci_audit_morning_talk_read on public.ci_audit_logs for select to authenticated using (
  warehouse_id is null
  and entity_table in ('ci_morning_talks', 'ci_morning_talk_attendees', 'ci_morning_talk_checklist_items', 'ci_morning_talk_actions')
  and ci_private.can_manage_scope(null)
);

-- ---------------------------------------------------------------------------
-- 6. RPC implementations (published at the end)
-- ---------------------------------------------------------------------------
-- Members of a scope for the create/edit picker. Eligibility is computed for each candidate, never from the caller's role.
create function ci_private.ci_list_scope_members(p_warehouse_id smallint default null)
returns table (user_id uuid, display_name text, position_title text, active boolean, attendee_eligible boolean, owner_eligible boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not ci_private.can_read_scope(p_warehouse_id) then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  return query
    select p.user_id, p.display_name, p.position_title, p.active,
           ci_private.user_in_scope(p.user_id, p_warehouse_id), ci_private.user_can_work_scope(p.user_id, p_warehouse_id)
    from public.ci_user_profiles p
    where p.active and ci_private.user_in_scope(p.user_id, p_warehouse_id)
    order by p.display_name, p.user_id;
end $$;

-- The scopes the current actor may manage. UI convenience only: every write RPC re-checks.
create function ci_private.ci_manageable_scopes() returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare v_scopes text[] := '{}';
begin
  if ci_private.can_manage_scope(null) then v_scopes := pg_catalog.array_append(v_scopes, 'ALL'); end if;
  if ci_private.can_manage_scope(ci_private.warehouse_id_by_code('CHE')) then v_scopes := pg_catalog.array_append(v_scopes, 'CHE'); end if;
  if ci_private.can_manage_scope(ci_private.warehouse_id_by_code('IMM')) then v_scopes := pg_catalog.array_append(v_scopes, 'IMM'); end if;
  return v_scopes;
end $$;

-- Display names of people who appear in Morning Talk data the caller can read. Nothing else is exposed, and ci_user_profiles RLS is untouched.
create function ci_private.ci_morning_talk_names(p_user_ids uuid[]) returns table (user_id uuid, display_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not ci_private.has_any_access() then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  if coalesce(cardinality(p_user_ids), 0) > 500 then raise exception 'CI_MORNING_TALK_LIMIT'; end if;
  return query
    select p.user_id, p.display_name from public.ci_user_profiles p
    where p.user_id = any(coalesce(p_user_ids, '{}'::uuid[]))
      and (
        exists (select 1 from public.ci_morning_talk_attendees a where a.user_id = p.user_id and ci_private.can_read_scope(a.warehouse_id))
        or exists (select 1 from public.ci_morning_talks t where p.user_id in (t.created_by, t.updated_by, t.cancelled_by) and ci_private.can_read_scope(t.warehouse_id))
        or exists (select 1 from public.ci_morning_talk_actions x where p.user_id in (x.owner_id, x.created_by, x.completed_by) and ci_private.can_read_scope(x.warehouse_id))
        or exists (select 1 from public.ci_morning_talk_checklist_items c where c.completed_by = p.user_id and ci_private.can_read_scope(c.warehouse_id))
      );
end $$;

-- Create or update a talk with its attendees, checklist and actions in ONE transaction.
-- Payload: { id?, expected_updated_at?, scope (create only), talk_date?, title, agenda?, attendees: [uuid],
--            checklist: [{ id?, title }],
--            actions: [{ id?, expected_updated_at? (required with id), cancel? (true = cancel this open action), title, owner_id, due_date?, note? }] }
-- Owners change an action's status and note through ci_update_morning_talk_action, which never touches the talk row, so the talk's
-- expected_updated_at cannot protect actions. Each existing action therefore carries its own version, and an action is cancelled only
-- when the payload says so explicitly: an action the form did not show (e.g. reopened after the form loaded) is left untouched.
create function ci_private.ci_save_morning_talk(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
  v_talk public.ci_morning_talks;
  v_scope text;
  v_warehouse smallint;
  v_title text := btrim(p->>'title');
  v_agenda text := nullif(btrim(p->>'agenda'), '');
  v_date date;
  v_attendees uuid[];
  v_checklist jsonb := coalesce(p->'checklist', '[]'::jsonb);
  v_actions jsonb := coalesce(p->'actions', '[]'::jsonb);
  v_item jsonb;
  v_ord bigint;
  v_item_id uuid;
  v_seen uuid[] := '{}';
  v_owner uuid;
  v_existing public.ci_morning_talk_actions;
  v_check_row public.ci_morning_talk_checklist_items;
  v_new_title text;
  v_due date;
  v_note text;
begin
  if v_actor is null then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  begin
    v_id := nullif(p->>'id', '')::uuid;
    if jsonb_typeof(v_checklist) <> 'array' or jsonb_typeof(v_actions) <> 'array' or jsonb_typeof(coalesce(p->'attendees', '[]'::jsonb)) <> 'array' then
      raise exception 'CI_MORNING_TALK_INVALID';
    end if;
    select coalesce(array_agg(distinct x::uuid), '{}') into v_attendees from jsonb_array_elements_text(coalesce(p->'attendees', '[]'::jsonb)) x;
    v_date := nullif(p->>'talk_date', '')::date;
  exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
    raise exception 'CI_MORNING_TALK_INVALID';
  end;
  if v_title is null or char_length(v_title) not between 1 and 200 or (v_agenda is not null and char_length(v_agenda) > 5000) then raise exception 'CI_MORNING_TALK_INVALID'; end if;
  if cardinality(v_attendees) > 100 or jsonb_array_length(v_checklist) > 30 or jsonb_array_length(v_actions) > 50 then raise exception 'CI_MORNING_TALK_LIMIT'; end if;
  if v_date is not null and abs(v_date - (now() at time zone 'Asia/Bangkok')::date) > 366 then raise exception 'CI_MORNING_TALK_INVALID'; end if;

  if v_id is null then
    v_scope := p->>'scope';
    if v_scope is null or v_scope not in ('ALL', 'CHE', 'IMM') then raise exception 'CI_MORNING_TALK_INVALID'; end if;
    v_warehouse := case when v_scope = 'ALL' then null else ci_private.warehouse_id_by_code(v_scope) end;
    -- Authority is evaluated here, at execution time, from the current grants.
    perform ci_private.require_manage_scope(v_warehouse);
    insert into public.ci_morning_talks (scope, warehouse_id, talk_date, title, agenda, created_by, updated_by)
    values (v_scope, v_warehouse, coalesce(v_date, (now() at time zone 'Asia/Bangkok')::date), v_title, v_agenda, v_actor, v_actor)
    returning * into v_talk;
    v_id := v_talk.id;
  else
    -- A missing talk and a forbidden one raise the same error.
    select t.warehouse_id, t.scope into v_warehouse, v_scope from public.ci_morning_talks t where t.id = v_id;
    if not found then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
    perform ci_private.require_manage_scope(v_warehouse);
    select * into v_talk from public.ci_morning_talks where id = v_id for update;
    if nullif(p->>'expected_updated_at', '') is null or v_talk.updated_at is distinct from (p->>'expected_updated_at')::timestamptz then raise exception 'CI_STALE_UPDATE'; end if;
    if v_talk.status <> 'active' then raise exception 'CI_TALK_CANCELLED'; end if;
    if p ? 'scope' and p->>'scope' is distinct from v_talk.scope then raise exception 'CI_MORNING_TALK_SCOPE_IMMUTABLE'; end if;
    update public.ci_morning_talks set title = v_title, agenda = v_agenda, talk_date = coalesce(v_date, talk_date),
      updated_by = v_actor, updated_at = ci_private.next_updated_at(v_talk.updated_at) where id = v_id;
  end if;

  -- Attendees: the removal of an acknowledged attendee is refused; only newly added people are eligibility-checked, so someone who
  -- already acknowledged and has since lost access cannot deadlock the edit.
  delete from public.ci_morning_talk_attendees a where a.talk_id = v_id and not (a.user_id = any(v_attendees));
  for v_owner in select u from unnest(v_attendees) u where not exists (select 1 from public.ci_morning_talk_attendees a where a.talk_id = v_id and a.user_id = u) loop
    if not ci_private.user_in_scope(v_owner, v_warehouse) then raise exception 'CI_ATTENDEE_NOT_ELIGIBLE'; end if;
    insert into public.ci_morning_talk_attendees (talk_id, user_id, assigned_by) values (v_id, v_owner, v_actor);
  end loop;

  -- Checklist: the payload order becomes the sort order; a completed item cannot be removed.
  for v_item, v_ord in select value, ordinality - 1 from jsonb_array_elements(v_checklist) with ordinality loop
    v_new_title := btrim(v_item->>'title');
    if v_new_title is null or char_length(v_new_title) not between 1 and 240 then raise exception 'CI_MORNING_TALK_INVALID'; end if;
    v_item_id := nullif(v_item->>'id', '')::uuid;
    if v_item_id is null then
      insert into public.ci_morning_talk_checklist_items (talk_id, sort_order, title) values (v_id, v_ord, v_new_title) returning id into v_item_id;
      v_seen := v_seen || v_item_id;
    else
      if v_item_id = any(v_seen) then raise exception 'CI_MORNING_TALK_INVALID'; end if;
      v_seen := v_seen || v_item_id;
      select * into v_check_row from public.ci_morning_talk_checklist_items where id = v_item_id and talk_id = v_id for update;
      if not found then raise exception 'CI_MORNING_TALK_INVALID'; end if;
      if v_check_row.title is distinct from v_new_title or v_check_row.sort_order <> v_ord then
        update public.ci_morning_talk_checklist_items set title = v_new_title, sort_order = v_ord, updated_at = now() where id = v_item_id;
      end if;
    end if;
  end loop;
  delete from public.ci_morning_talk_checklist_items c where c.talk_id = v_id and not (c.id = any(v_seen));
  v_seen := '{}';

  -- Actions: owners are judged as CANDIDATES for the talk's scope, whatever the caller's own role is. Actions are never deleted.
  for v_item in select value from jsonb_array_elements(v_actions) loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'CI_MORNING_TALK_INVALID'; end if;
    v_item_id := nullif(v_item->>'id', '')::uuid;
    if v_item_id is not null then
      if v_item_id = any(v_seen) then raise exception 'CI_MORNING_TALK_INVALID'; end if;
      v_seen := v_seen || v_item_id;
      select * into v_existing from public.ci_morning_talk_actions where id = v_item_id and talk_id = v_id for update;
      if not found then raise exception 'CI_MORNING_TALK_INVALID'; end if;
      -- The form must have seen this action as it is now; otherwise an owner's newer status or note would be overwritten.
      if nullif(v_item->>'expected_updated_at', '') is null or v_existing.updated_at is distinct from (v_item->>'expected_updated_at')::timestamptz then
        raise exception 'CI_STALE_UPDATE';
      end if;
      if coalesce((v_item->>'cancel')::boolean, false) then
        -- Explicit removal: an open action becomes cancelled (kept as evidence); a finished one cannot be cancelled from here.
        if v_existing.status not in ('todo', 'in_progress') then raise exception 'CI_MORNING_TALK_INVALID'; end if;
        update public.ci_morning_talk_actions set status = 'cancelled', updated_by = v_actor, updated_at = ci_private.next_updated_at(v_existing.updated_at) where id = v_item_id;
        continue;
      end if;
    end if;
    v_new_title := btrim(v_item->>'title');
    v_owner := nullif(v_item->>'owner_id', '')::uuid;
    v_due := nullif(v_item->>'due_date', '')::date;
    v_note := nullif(btrim(v_item->>'note'), '');
    if v_new_title is null or char_length(v_new_title) not between 1 and 240 or v_owner is null or (v_note is not null and char_length(v_note) > 1000) then raise exception 'CI_MORNING_TALK_INVALID'; end if;
    if v_item_id is null then
      if coalesce((v_item->>'cancel')::boolean, false) then raise exception 'CI_MORNING_TALK_INVALID'; end if;
      if not ci_private.user_can_work_scope(v_owner, v_warehouse) then raise exception 'CI_OWNER_NOT_ELIGIBLE'; end if;
      insert into public.ci_morning_talk_actions (talk_id, title, owner_id, due_date, note, created_by, updated_by) values (v_id, v_new_title, v_owner, v_due, v_note, v_actor, v_actor);
    else
      if v_existing.status in ('todo', 'in_progress') and not ci_private.user_can_work_scope(v_owner, v_warehouse) then raise exception 'CI_OWNER_NOT_ELIGIBLE'; end if;
      if v_existing.status in ('done', 'cancelled') and v_owner is distinct from v_existing.owner_id and not ci_private.user_can_work_scope(v_owner, v_warehouse) then raise exception 'CI_OWNER_NOT_ELIGIBLE'; end if;
      if v_existing.title is distinct from v_new_title or v_existing.owner_id is distinct from v_owner or v_existing.due_date is distinct from v_due or v_existing.note is distinct from v_note then
        update public.ci_morning_talk_actions set title = v_new_title, owner_id = v_owner, due_date = v_due, note = v_note,
          updated_by = v_actor, updated_at = ci_private.next_updated_at(v_existing.updated_at) where id = v_item_id;
      end if;
    end if;
  end loop;
  return v_id;
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
  -- A malformed uuid, date, timestamp or boolean in the JSON payload is a domain error, not a raw type error.
  raise exception 'CI_MORNING_TALK_INVALID';
end $$;

create function ci_private.ci_cancel_morning_talk(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_talk public.ci_morning_talks;
  v_reason text := nullif(btrim(p_reason), '');
begin
  select * into v_talk from public.ci_morning_talks where id = p_id;
  if not found then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  perform ci_private.require_manage_scope(v_talk.warehouse_id);
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'CI_REASON_REQUIRED'; end if;
  select * into v_talk from public.ci_morning_talks where id = p_id for update;
  if v_talk.status = 'cancelled' then raise exception 'CI_TALK_CANCELLED'; end if;
  update public.ci_morning_talks set status = 'cancelled', cancelled_at = clock_timestamp(), cancelled_by = auth.uid(), cancel_reason = v_reason,
    updated_by = auth.uid(), updated_at = ci_private.next_updated_at(v_talk.updated_at) where id = p_id;
  perform ci_private.audit(v_talk.warehouse_id, 'CANCEL', 'ci_morning_talks', p_id::text, v_reason);
end $$;

-- Self acknowledgement. There is deliberately no user parameter: only auth.uid() can acknowledge, once, for itself.
create function ci_private.ci_acknowledge_morning_talk(p_id uuid) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_status text;
  v_warehouse smallint;
  v_ack timestamptz;
begin
  if v_actor is null then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  select t.status, t.warehouse_id, a.acknowledged_at into v_status, v_warehouse, v_ack
    from public.ci_morning_talk_attendees a join public.ci_morning_talks t on t.id = a.talk_id
   where a.talk_id = p_id and a.user_id = v_actor for update of a;
  if not found then raise exception 'CI_NOT_ATTENDEE'; end if;
  if not ci_private.can_read_scope(v_warehouse) then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  if v_status <> 'active' then raise exception 'CI_TALK_CANCELLED'; end if;
  -- Idempotent: the first timestamp is kept and a repeat writes nothing (so it also adds no audit row).
  if v_ack is not null then return v_ack; end if;
  update public.ci_morning_talk_attendees set acknowledged_at = clock_timestamp() where talk_id = p_id and user_id = v_actor returning acknowledged_at into v_ack;
  return v_ack;
end $$;

create function ci_private.ci_set_morning_talk_checklist_item(p_item_id uuid, p_completed boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_item public.ci_morning_talk_checklist_items;
  v_status text;
begin
  if v_actor is null or p_completed is null then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  select * into v_item from public.ci_morning_talk_checklist_items where id = p_item_id;
  if not found then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  select t.status into v_status from public.ci_morning_talks t where t.id = v_item.talk_id;
  if not (ci_private.can_manage_scope(v_item.warehouse_id)
          or (ci_private.can_work_scope(v_item.warehouse_id)
              and exists (select 1 from public.ci_morning_talk_attendees a where a.talk_id = v_item.talk_id and a.user_id = v_actor))) then
    raise exception 'CI_ACCESS_DENIED' using errcode = '42501';
  end if;
  if v_status <> 'active' then raise exception 'CI_TALK_CANCELLED'; end if;
  select * into v_item from public.ci_morning_talk_checklist_items where id = p_item_id for update;
  if p_completed and v_item.completed_at is null then
    update public.ci_morning_talk_checklist_items set completed_at = clock_timestamp(), completed_by = v_actor, updated_at = now() where id = p_item_id;
  elsif not p_completed and v_item.completed_at is not null then
    update public.ci_morning_talk_checklist_items set completed_at = null, completed_by = null, updated_at = now() where id = p_item_id;
  end if;
end $$;

-- Status and note of one action. Title, owner and due date change only through ci_save_morning_talk (managers).
-- Works on a cancelled talk too: its actions stay open until they are done or cancelled.
create function ci_private.ci_update_morning_talk_action(p_id uuid, p_status text, p_note text, p_expected_updated_at timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_action public.ci_morning_talk_actions;
  v_note text := nullif(btrim(p_note), '');
begin
  if v_actor is null then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  select * into v_action from public.ci_morning_talk_actions where id = p_id;
  if not found then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  -- The owner counts only while still eligible: a downgraded or deactivated owner loses the right, a manager keeps it.
  if not (ci_private.can_manage_scope(v_action.warehouse_id) or (v_action.owner_id = v_actor and ci_private.can_work_scope(v_action.warehouse_id))) then
    raise exception 'CI_ACCESS_DENIED' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('todo', 'in_progress', 'done', 'cancelled') or (v_note is not null and char_length(v_note) > 1000) then raise exception 'CI_MORNING_TALK_INVALID'; end if;
  select * into v_action from public.ci_morning_talk_actions where id = p_id for update;
  if p_expected_updated_at is null or v_action.updated_at is distinct from p_expected_updated_at then raise exception 'CI_STALE_UPDATE'; end if;
  update public.ci_morning_talk_actions set
    status = p_status,
    note = case when p_note is null then note else v_note end,
    completed_at = case when p_status = 'done' then coalesce(v_action.completed_at, clock_timestamp()) else null end,
    completed_by = case when p_status = 'done' then coalesce(v_action.completed_by, v_actor) else null end,
    updated_by = v_actor, updated_at = ci_private.next_updated_at(v_action.updated_at)
  where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Publish the RPCs as SECURITY INVOKER wrappers (the implementations stay private)
-- ---------------------------------------------------------------------------
select ci_private.publish_rpc('ci_private.ci_list_scope_members(smallint)'::pg_catalog.regprocedure);
select ci_private.publish_rpc('ci_private.ci_manageable_scopes()'::pg_catalog.regprocedure);
select ci_private.publish_rpc('ci_private.ci_morning_talk_names(uuid[])'::pg_catalog.regprocedure);
select ci_private.publish_rpc('ci_private.ci_save_morning_talk(jsonb)'::pg_catalog.regprocedure);
select ci_private.publish_rpc('ci_private.ci_cancel_morning_talk(uuid, text)'::pg_catalog.regprocedure);
select ci_private.publish_rpc('ci_private.ci_acknowledge_morning_talk(uuid)'::pg_catalog.regprocedure);
select ci_private.publish_rpc('ci_private.ci_set_morning_talk_checklist_item(uuid, boolean)'::pg_catalog.regprocedure);
select ci_private.publish_rpc('ci_private.ci_update_morning_talk_action(uuid, text, text, timestamptz)'::pg_catalog.regprocedure);
