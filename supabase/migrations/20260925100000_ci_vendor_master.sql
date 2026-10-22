-- Vendor evaluation port from LABCBH-Stock, phase 1: vendor master data and closing an invoice short.
set local search_path = '';

-- ---------------------------------------------------------------------------
-- Shared helpers for the vendor-evaluation migrations.
-- ---------------------------------------------------------------------------

-- Publishes a ci_private implementation as a public security-invoker wrapper with identical contract and grants,
-- the same shape 20260924133953_ci_private_rpc_dispatchers.sql produced (tests/db/security-boundary.test.ts enforces it).
create function ci_private.publish_rpc(p_function regprocedure) returns void language plpgsql set search_path = '' as $$
declare
  v_fn record;
  v_args text;
  v_body text;
begin
  select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_arguments, pg_catalog.pg_get_function_arguments(p.oid) as arguments,
         pg_catalog.pg_get_function_result(p.oid) as result_type, p.pronargs, p.proretset, p.provolatile, p.proisstrict, p.proparallel
    into v_fn
    from pg_catalog.pg_proc p
   where p.oid = p_function and p.pronamespace = 'ci_private'::pg_catalog.regnamespace and p.prosecdef and p.proname like 'ci\_%' escape '\';
  if not found then raise exception 'CI_PUBLISH_RPC_REQUIRES_PRIVATE_DEFINER: %', p_function; end if;

  execute pg_catalog.format('revoke all on function ci_private.%I(%s) from public, anon', v_fn.proname, v_fn.identity_arguments);
  execute pg_catalog.format('grant execute on function ci_private.%I(%s) to authenticated', v_fn.proname, v_fn.identity_arguments);

  select pg_catalog.string_agg('$' || n::text, ', ' order by n) into v_args from pg_catalog.generate_series(1, v_fn.pronargs) n;
  v_body := pg_catalog.format(case when v_fn.proretset then 'select * from ci_private.%I(%s)' else 'select ci_private.%I(%s)' end, v_fn.proname, coalesce(v_args, ''));
  execute pg_catalog.format(
    'create or replace function public.%I(%s) returns %s language sql %s %s %s security invoker set search_path = %L as %L',
    v_fn.proname, v_fn.arguments, v_fn.result_type,
    case v_fn.provolatile when 'i' then 'immutable' when 's' then 'stable' else 'volatile' end,
    case when v_fn.proisstrict then 'strict' else 'called on null input' end,
    case v_fn.proparallel when 's' then 'parallel safe' when 'r' then 'parallel restricted' else 'parallel unsafe' end,
    '', v_body);
  execute pg_catalog.format('revoke all on function public.%I(%s) from public, anon, authenticated, service_role', v_fn.proname, v_fn.identity_arguments);
  execute pg_catalog.format('grant execute on function public.%I(%s) to authenticated', v_fn.proname, v_fn.identity_arguments);
end $$;
revoke all on function ci_private.publish_rpc(regprocedure) from public, anon, authenticated;

-- Vendors are shared by both warehouses, so master-data changes need admin or supervisor in either one.
create function ci_private.require_any_role(p_roles text[]) returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null or not exists (
    select 1 from public.ci_user_profiles p join public.ci_user_access a on a.user_id = p.user_id
    where p.user_id = v_actor and p.active and a.active and a.role = any(p_roles)
  ) then raise exception 'CI_ACCESS_DENIED' using errcode = '42501'; end if;
  return v_actor;
end $$;
revoke all on function ci_private.require_any_role(text[]) from public, anon, authenticated;

-- Thai Buddhist-era fiscal year (1 Oct – 30 Sep), as LABCBH-Stock uses for vendor evaluation: 2026-10-01 → 2570.
create function ci_private.fiscal_year_be(p_date date) returns integer language sql immutable set search_path = '' as $$
  select extract(year from p_date)::integer + 543 + case when extract(month from p_date) >= 10 then 1 else 0 end
$$;
revoke all on function ci_private.fiscal_year_be(date) from public, anon;
grant execute on function ci_private.fiscal_year_be(date) to authenticated;

-- ---------------------------------------------------------------------------
-- Vendor master (LABCBH vendors table).
-- ---------------------------------------------------------------------------
alter table public.ci_vendors
  add column vendor_code text,
  add column legal_name text,
  add column tax_id text,
  add column tax_branch_code text not null default '00000',
  add column address text,
  add column contact_person text,
  add column phone text,
  add column email text,
  add column note text,
  add column created_by uuid references auth.users(id),
  add column updated_at timestamptz not null default now(),
  add column updated_by uuid references auth.users(id);

-- Existing vendors get sequential codes in creation order; people can rename them afterwards.
update public.ci_vendors v set vendor_code = numbered.code
from (select id, 'V-' || lpad(row_number() over (order by created_at, name)::text, 4, '0') as code from public.ci_vendors) numbered
where numbered.id = v.id;

alter table public.ci_vendors
  alter column vendor_code set not null,
  add constraint ci_vendors_code_check check (length(btrim(vendor_code)) > 0),
  add constraint ci_vendors_legal_name_check check (legal_name is null or length(btrim(legal_name)) > 0),
  add constraint ci_vendors_tax_id_check check (tax_id is null or tax_id ~ '^[0-9]{13}$'),
  add constraint ci_vendors_tax_branch_check check (tax_branch_code ~ '^[0-9]{5}$'),
  add constraint ci_vendors_email_check check (email is null or email like '%@%');
create unique index ci_vendors_code_key on public.ci_vendors (upper(btrim(vendor_code)));
create unique index ci_vendors_name_ci_key on public.ci_vendors (lower(btrim(name)));
create unique index ci_vendors_tax_key on public.ci_vendors (tax_id, tax_branch_code) where tax_id is not null;

create function ci_private.vendor_text(p_data jsonb, p_key text) returns text language sql immutable set search_path = '' as $$
  select nullif(btrim(coalesce(p_data ->> p_key, '')), '')
$$;
revoke all on function ci_private.vendor_text(jsonb, text) from public, anon, authenticated;

create function ci_private.assert_vendor_unique(p_id uuid, p_code text, p_name text, p_tax_id text, p_branch text) returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from public.ci_vendors v where upper(btrim(v.vendor_code)) = upper(p_code) and v.id is distinct from p_id) then raise exception 'CI_VENDOR_CODE_TAKEN'; end if;
  if exists (select 1 from public.ci_vendors v where lower(btrim(v.name)) = lower(p_name) and v.id is distinct from p_id) then raise exception 'CI_VENDOR_NAME_TAKEN'; end if;
  if p_tax_id is not null and exists (select 1 from public.ci_vendors v where v.tax_id = p_tax_id and v.tax_branch_code = p_branch and v.id is distinct from p_id) then raise exception 'CI_VENDOR_TAX_TAKEN'; end if;
end $$;
revoke all on function ci_private.assert_vendor_unique(uuid, text, text, text, text) from public, anon, authenticated;

create function ci_private.assert_vendor_fields(p_data jsonb) returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'CI_VENDOR_FIELD_INVALID'; end if;
  if exists (select 1 from jsonb_object_keys(p_data) k where k not in ('vendorCode','name','legalName','taxId','taxBranchCode','address','contactPerson','phone','email','note')) then
    raise exception 'CI_VENDOR_FIELD_INVALID';
  end if;
end $$;
revoke all on function ci_private.assert_vendor_fields(jsonb) from public, anon, authenticated;

-- The old name-only RPC is replaced; every caller moves to the full vendor record.
drop function public.ci_create_vendor(text);
drop function ci_private.ci_create_vendor(text);

create function ci_private.ci_create_vendor(p_data jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := ci_private.require_any_role(array['admin','supervisor']);
  v_code text := ci_private.vendor_text(p_data, 'vendorCode');
  v_name text := ci_private.vendor_text(p_data, 'name');
  v_tax text := ci_private.vendor_text(p_data, 'taxId');
  v_branch text := coalesce(ci_private.vendor_text(p_data, 'taxBranchCode'), '00000');
  v_id uuid;
begin
  perform ci_private.assert_vendor_fields(p_data);
  if v_code is null or v_name is null then raise exception 'CI_VENDOR_CODE_NAME_REQUIRED'; end if;
  perform ci_private.assert_vendor_unique(null, v_code, v_name, v_tax, v_branch);
  insert into public.ci_vendors (vendor_code, name, legal_name, tax_id, tax_branch_code, address, contact_person, phone, email, note, created_by, updated_by)
  values (v_code, v_name, ci_private.vendor_text(p_data, 'legalName'), v_tax, v_branch, ci_private.vendor_text(p_data, 'address'),
          ci_private.vendor_text(p_data, 'contactPerson'), ci_private.vendor_text(p_data, 'phone'), ci_private.vendor_text(p_data, 'email'),
          ci_private.vendor_text(p_data, 'note'), v_actor, v_actor)
  returning id into v_id;
  perform ci_private.audit(null, 'CREATE', 'ci_vendors', v_id::text);
  return v_id;
end $$;

-- Partial patch like LABCBH update_vendor: a key that is present overwrites (blank clears), a missing key keeps the value.
create function ci_private.ci_update_vendor(p_id uuid, p_data jsonb, p_expected_updated_at timestamptz) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := ci_private.require_any_role(array['admin','supervisor']);
  v_old public.ci_vendors%rowtype;
  v_code text; v_name text; v_tax text; v_branch text;
begin
  perform ci_private.assert_vendor_fields(p_data);
  select * into v_old from public.ci_vendors where id = p_id for update;
  if not found then raise exception 'CI_VENDOR_NOT_FOUND'; end if;
  if v_old.updated_at is distinct from p_expected_updated_at then raise exception 'CI_STALE_DATA' using errcode = '40001'; end if;
  v_code := case when p_data ? 'vendorCode' then ci_private.vendor_text(p_data, 'vendorCode') else v_old.vendor_code end;
  v_name := case when p_data ? 'name' then ci_private.vendor_text(p_data, 'name') else v_old.name end;
  v_tax := case when p_data ? 'taxId' then ci_private.vendor_text(p_data, 'taxId') else v_old.tax_id end;
  v_branch := case when p_data ? 'taxBranchCode' then coalesce(ci_private.vendor_text(p_data, 'taxBranchCode'), '00000') else v_old.tax_branch_code end;
  if v_code is null or v_name is null then raise exception 'CI_VENDOR_CODE_NAME_REQUIRED'; end if;
  perform ci_private.assert_vendor_unique(p_id, v_code, v_name, v_tax, v_branch);
  update public.ci_vendors set
    vendor_code = v_code, name = v_name, tax_id = v_tax, tax_branch_code = v_branch,
    legal_name = case when p_data ? 'legalName' then ci_private.vendor_text(p_data, 'legalName') else legal_name end,
    address = case when p_data ? 'address' then ci_private.vendor_text(p_data, 'address') else address end,
    contact_person = case when p_data ? 'contactPerson' then ci_private.vendor_text(p_data, 'contactPerson') else contact_person end,
    phone = case when p_data ? 'phone' then ci_private.vendor_text(p_data, 'phone') else phone end,
    email = case when p_data ? 'email' then ci_private.vendor_text(p_data, 'email') else email end,
    note = case when p_data ? 'note' then ci_private.vendor_text(p_data, 'note') else note end,
    updated_at = clock_timestamp(), updated_by = v_actor
  where id = p_id;
  insert into public.ci_audit_logs (actor_id, warehouse_id, action, entity_table, entity_id, old_value, new_value)
  select v_actor, null, 'UPDATE', 'ci_vendors', p_id::text, to_jsonb(v_old), to_jsonb(v) from public.ci_vendors v where v.id = p_id;
end $$;

create function ci_private.ci_set_vendor_active(p_id uuid, p_active boolean, p_note text) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := ci_private.require_any_role(array['admin','supervisor']);
  v_current boolean;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select active into v_current from public.ci_vendors where id = p_id for update;
  if not found then raise exception 'CI_VENDOR_NOT_FOUND'; end if;
  if p_active is null then raise exception 'CI_VENDOR_FIELD_INVALID'; end if;
  if v_current = p_active then return; end if;
  if not p_active and v_note is null then raise exception 'CI_REASON_REQUIRED'; end if;
  update public.ci_vendors set active = p_active, updated_at = clock_timestamp(), updated_by = v_actor where id = p_id;
  perform ci_private.audit(null, case when p_active then 'ACTIVATE' else 'DEACTIVATE' end, 'ci_vendors', p_id::text, v_note);
end $$;

-- ---------------------------------------------------------------------------
-- Closing an invoice short (LABCBH purchase request "closed_short").
-- ---------------------------------------------------------------------------
alter table public.ci_invoices drop constraint ci_invoices_status_check;
alter table public.ci_invoices
  add column closed_short_at timestamptz,
  add column closed_short_by uuid references auth.users(id),
  add column closed_short_reason text,
  add constraint ci_invoices_status_check check (status in ('open','closed','closed_short','cancelled')),
  add constraint ci_invoices_closed_short_check check (
    (status = 'closed_short') = (closed_short_at is not null and closed_short_by is not null and length(btrim(coalesce(closed_short_reason, ''))) > 0)
  );

-- A receipt reversal reopens the invoice; clear the short-close stamp at the same time so the check above holds.
create function ci_private.clear_invoice_short_stamp() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'closed_short' and new.status <> 'closed_short' then
    new.closed_short_at := null; new.closed_short_by := null; new.closed_short_reason := null;
  end if;
  return new;
end $$;
create trigger ci_invoices_clear_short_stamp before update of status on public.ci_invoices
  for each row execute function ci_private.clear_invoice_short_stamp();

create function ci_private.ci_close_invoice_short(p_invoice_id uuid, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_wh smallint;
begin
  perform ci_private.require_any_role(array['admin','supervisor']);
  perform 1 from public.ci_invoices where id = p_invoice_id for update;
  if not found then raise exception 'CI_INVOICE_NOT_FOUND'; end if;
  if not exists (select 1 from public.ci_invoices where id = p_invoice_id and status = 'open') then raise exception 'CI_INVOICE_NOT_OPEN'; end if;
  if v_reason is null then raise exception 'CI_REASON_REQUIRED'; end if;
  if not exists (select 1 from public.ci_invoice_line_progress where invoice_id = p_invoice_id and remaining_quantity > 0) then raise exception 'CI_INVOICE_NOTHING_OUTSTANDING'; end if;
  -- Whoever closes short speaks for every warehouse that is still waiting on goods.
  for v_wh in select distinct warehouse_id from public.ci_invoice_line_progress where invoice_id = p_invoice_id and remaining_quantity > 0 loop
    perform ci_private.require_role(v_wh, array['admin','supervisor']);
  end loop;
  update public.ci_invoices set status = 'closed_short', closed_short_at = clock_timestamp(), closed_short_by = auth.uid(), closed_short_reason = v_reason where id = p_invoice_id;
  for v_wh in select distinct warehouse_id from public.ci_invoice_lines where invoice_id = p_invoice_id loop
    perform ci_private.audit(v_wh, 'CLOSE_SHORT', 'ci_invoices', p_invoice_id::text, v_reason);
  end loop;
end $$;

-- Vendor-level audit rows carry no warehouse; admins and supervisors of either warehouse read them (LABCBH vendor audit timeline).
create policy ci_audit_vendor_read on public.ci_audit_logs for select to authenticated using (
  warehouse_id is null and entity_table = 'ci_vendors' and exists (
    select 1 from public.ci_user_profiles p join public.ci_user_access a on a.user_id = p.user_id
    where p.user_id = auth.uid() and p.active and a.active and a.role in ('admin','supervisor')));

select ci_private.publish_rpc('ci_private.ci_create_vendor(jsonb)'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_update_vendor(uuid, jsonb, timestamptz)'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_set_vendor_active(uuid, boolean, text)'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_close_invoice_short(uuid, text)'::regprocedure);

notify pgrst, 'reload schema';
