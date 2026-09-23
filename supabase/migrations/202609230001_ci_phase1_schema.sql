-- CHEM-IMMUNO CBH Phase 1. Apply to a disposable database before any deployment.
create extension if not exists pgcrypto;
create schema if not exists ci_private;
revoke all on schema ci_private from public, anon, authenticated;

create table public.ci_warehouses (
  id smallint primary key,
  code text not null unique check (code in ('CHE','IMM')),
  name text not null unique,
  created_at timestamptz not null default now(),
  unique (id, code)
);
insert into public.ci_warehouses(id,code,name) values
 (1,'CHE','CLINICAL CHEMISTRY'),(2,'IMM','IMMUNOLOGY');
create table public.ci_product_code_counters (
  warehouse_id smallint primary key references public.ci_warehouses(id),
  next_number integer not null default 1 check (next_number > 0)
);
insert into public.ci_product_code_counters(warehouse_id) values (1),(2);

create table public.ci_user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ephis_id text not null unique check (length(btrim(ephis_id)) > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.ci_user_access (
  user_id uuid not null references public.ci_user_profiles(user_id) on delete cascade,
  warehouse_id smallint not null references public.ci_warehouses(id),
  role text not null check (role in ('admin','supervisor','staff','viewer')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (user_id, warehouse_id)
);

create table public.ci_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_filename text not null,
  source_sha256 text not null check (source_sha256 ~ '^[A-Fa-f0-9]{64}$'),
  status text not null default 'staged' check (status in ('staged','applied','rejected')),
  payload jsonb not null,
  staged_by uuid not null references auth.users(id),
  staged_at timestamptz not null default now(),
  applied_by uuid references auth.users(id),
  applied_at timestamptz,
  check ((status = 'applied') = (applied_at is not null))
);
create table public.ci_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.ci_import_batches(id) on delete cascade,
  warehouse_id smallint not null references public.ci_warehouses(id),
  source_sheet text not null,
  source_row integer not null check (source_row > 0),
  raw_source jsonb not null,
  normalized jsonb not null,
  unique (batch_id, source_sheet, source_row)
);
create table public.ci_import_review_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.ci_import_batches(id) on delete cascade,
  warehouse_id smallint not null references public.ci_warehouses(id),
  source_sheet text not null,
  source_row integer not null check (source_row > 0),
  kind text not null,
  source_text text,
  details text not null,
  critical boolean not null default true,
  status text not null default 'open' check (status in ('open','approved_mapping','accepted_unlinked','accepted_source')),
  resolution_note text,
  resolution_data jsonb,
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  check ((status = 'open') = (resolved_at is null)),
  check (status = 'open' or length(btrim(resolution_note)) > 0)
);

create table public.ci_products (
  id uuid primary key default gen_random_uuid(),
  warehouse_id smallint not null references public.ci_warehouses(id),
  product_code text not null unique,
  product_type text not null check (product_type in ('reagent','calibrator','control','consumable')),
  source_name text not null check (length(btrim(source_name)) > 0),
  display_name text not null check (length(btrim(display_name)) > 0),
  packing_size_raw text,
  base_stock_unit text not null default 'pack' check (length(btrim(base_stock_unit)) > 0),
  active boolean not null default true,
  import_batch_id uuid references public.ci_import_batches(id),
  source_sheet text,
  source_row integer,
  raw_source jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, warehouse_id),
  unique (import_batch_id, source_sheet, source_row),
  check (product_code ~ '^(CHE|IMM)-[0-9]{4,}$')
);
create table public.ci_product_identifiers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  warehouse_id smallint not null,
  kind text not null check (kind in ('REF_CURRENT','REF_LEGACY','MANUFACTURER_BARCODE','GTIN','HIBC_PCN','GS1_AI240','OTHER')),
  value text not null check (length(btrim(value)) > 0 and value = btrim(value)),
  source text not null default 'manual',
  approved boolean not null default true,
  created_at timestamptz not null default now(),
  unique (kind, value),
  unique (product_id, kind, value),
  foreign key (product_id,warehouse_id) references public.ci_products(id,warehouse_id) on delete cascade
);
create unique index ci_one_current_ref_per_product on public.ci_product_identifiers(product_id) where kind = 'REF_CURRENT';
create unique index ci_one_manufacturer_barcode_per_product on public.ci_product_identifiers(product_id) where kind = 'MANUFACTURER_BARCODE';
create function ci_private.guard_identifier() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='UPDATE' and old.kind in ('REF_CURRENT','MANUFACTURER_BARCODE') and new.kind<>old.kind then
    raise exception 'CI_REQUIRED_IDENTIFIER_KIND_IMMUTABLE'; end if;
  if new.approved and exists (
    select 1 from public.ci_product_identifiers i
    where i.value=new.value and i.product_id<>new.product_id and i.approved and i.id<>new.id
  ) then raise exception 'CI_IDENTIFIER_AMBIGUOUS'; end if;
  return new;
end $$;
create trigger ci_identifier_guard before insert or update on public.ci_product_identifiers for each row execute function ci_private.guard_identifier();

create table public.ci_product_relations (
  id uuid primary key default gen_random_uuid(),
  warehouse_id smallint not null references public.ci_warehouses(id),
  source_product_id uuid not null,
  target_product_id uuid not null,
  relation_type text not null check (relation_type in ('uses_calibrator','uses_control','uses_consumable','compatible_with','replacement_for','other')),
  note text,
  source_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_product_id <> target_product_id),
  unique (source_product_id,target_product_id,relation_type),
  foreign key (source_product_id,warehouse_id) references public.ci_products(id,warehouse_id),
  foreign key (target_product_id,warehouse_id) references public.ci_products(id,warehouse_id)
);
create table public.ci_platforms (
  id uuid primary key default gen_random_uuid(),
  warehouse_id smallint not null references public.ci_warehouses(id),
  platform_key text not null,
  display_name text not null,
  is_group boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id,warehouse_id),
  unique (warehouse_id,platform_key)
);
insert into public.ci_platforms(warehouse_id,platform_key,display_name,is_group) values
 (1,'c503','c503',false),(1,'c703','c703',false),(1,'ISE','ISE',false),
 (1,'ise_neo','cobas pro ISE neo',false),(1,'c503_c703_ise','cobas pro c503 / c703 / ISE',true),
 (2,'e801','cobas e801 system',false);
create table public.ci_product_platforms (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  platform_id uuid not null,
  warehouse_id smallint not null,
  source_text text,
  source_sheet text,
  source_row integer,
  created_at timestamptz not null default now(),
  unique (product_id,platform_id),
  foreign key (product_id,warehouse_id) references public.ci_products(id,warehouse_id),
  foreign key (platform_id,warehouse_id) references public.ci_platforms(id,warehouse_id)
);

create table public.ci_vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.ci_locations (
  id uuid primary key default gen_random_uuid(),
  warehouse_id smallint not null references public.ci_warehouses(id),
  code text not null,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id,warehouse_id),
  unique (warehouse_id,code)
);
create table public.ci_stock_lots (
  id uuid primary key default gen_random_uuid(),
  warehouse_id smallint not null,
  product_id uuid not null,
  lot_number text not null check (length(btrim(lot_number)) > 0),
  expiry_date date not null,
  created_at timestamptz not null default now(),
  unique (id,warehouse_id),
  unique (warehouse_id,product_id,lot_number),
  foreign key (product_id,warehouse_id) references public.ci_products(id,warehouse_id)
);
create table public.ci_invoices (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.ci_vendors(id),
  invoice_number text not null check (length(btrim(invoice_number)) > 0),
  invoice_date date not null,
  po_number text,
  status text not null default 'open' check (status in ('open','closed','cancelled')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (vendor_id,invoice_number)
);
create table public.ci_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.ci_invoices(id),
  warehouse_id smallint not null,
  product_id uuid not null,
  ordered_quantity numeric(18,3) not null check (ordered_quantity > 0),
  line_number integer not null check (line_number > 0),
  created_at timestamptz not null default now(),
  unique (invoice_id,line_number),
  unique (id,warehouse_id),
  foreign key (product_id,warehouse_id) references public.ci_products(id,warehouse_id)
);
create table public.ci_receipts (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.ci_invoices(id),
  warehouse_id smallint not null references public.ci_warehouses(id),
  received_by uuid not null references auth.users(id),
  received_at timestamptz not null default now(),
  note text,
  unique (id,warehouse_id)
);
create table public.ci_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null,
  invoice_line_id uuid not null,
  warehouse_id smallint not null,
  lot_id uuid not null,
  location_id uuid not null,
  quantity numeric(18,3) not null check (quantity > 0),
  created_at timestamptz not null default now(),
  foreign key (receipt_id,warehouse_id) references public.ci_receipts(id,warehouse_id),
  foreign key (invoice_line_id,warehouse_id) references public.ci_invoice_lines(id,warehouse_id),
  foreign key (lot_id,warehouse_id) references public.ci_stock_lots(id,warehouse_id),
  foreign key (location_id,warehouse_id) references public.ci_locations(id,warehouse_id)
);
create table public.ci_stock_transactions (
  id uuid primary key default gen_random_uuid(),
  warehouse_id smallint not null references public.ci_warehouses(id),
  kind text not null check (kind in ('receive','issue','transfer','adjustment','reversal','expired_disposal')),
  idempotency_key text not null check (length(btrim(idempotency_key)) > 0),
  request_hash text not null,
  actor_id uuid not null references auth.users(id),
  reason text,
  purpose text check (purpose in ('Routine','QC','Calibration','Verification/Validation','Repeat/Troubleshooting','Waste','Other')),
  source_transaction_id uuid unique references public.ci_stock_transactions(id),
  receipt_id uuid,
  created_at timestamptz not null default now(),
  unique (warehouse_id,kind,idempotency_key),
  unique (id,warehouse_id),
  foreign key (receipt_id,warehouse_id) references public.ci_receipts(id,warehouse_id)
);
create table public.ci_stock_movement_lines (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null,
  warehouse_id smallint not null,
  lot_id uuid not null,
  location_id uuid not null,
  quantity_delta numeric(18,3) not null check (quantity_delta <> 0),
  created_at timestamptz not null default now(),
  foreign key (transaction_id,warehouse_id) references public.ci_stock_transactions(id,warehouse_id),
  foreign key (lot_id,warehouse_id) references public.ci_stock_lots(id,warehouse_id),
  foreign key (location_id,warehouse_id) references public.ci_locations(id,warehouse_id)
);
create index ci_movement_balance_idx on public.ci_stock_movement_lines(lot_id,location_id);
create table public.ci_stock_counts (
  id uuid primary key default gen_random_uuid(),
  warehouse_id smallint not null references public.ci_warehouses(id),
  status text not null default 'draft' check (status in ('draft','approved','stale','cancelled')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  note text,
  unique (id,warehouse_id)
);
create table public.ci_stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null,
  warehouse_id smallint not null,
  lot_id uuid not null,
  location_id uuid not null,
  snapshot_quantity numeric(18,3) not null check (snapshot_quantity >= 0),
  snapshot_movement_count bigint not null check (snapshot_movement_count >= 0),
  physical_quantity numeric(18,3) check (physical_quantity >= 0),
  unique (count_id,lot_id,location_id),
  foreign key (count_id,warehouse_id) references public.ci_stock_counts(id,warehouse_id),
  foreign key (lot_id,warehouse_id) references public.ci_stock_lots(id,warehouse_id),
  foreign key (location_id,warehouse_id) references public.ci_locations(id,warehouse_id)
);
create table public.ci_audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,
  warehouse_id smallint references public.ci_warehouses(id),
  action text not null,
  entity_table text not null,
  entity_id text not null,
  old_value jsonb,
  new_value jsonb,
  reason text,
  created_at timestamptz not null default now()
);

-- Security helpers never accept an actor supplied by the browser.
create function ci_private.require_role(p_warehouse_id smallint, p_roles text[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null or not exists (
    select 1 from public.ci_user_profiles p join public.ci_user_access a on a.user_id=p.user_id
    where p.user_id=v_actor and p.active and a.active and a.warehouse_id=p_warehouse_id and a.role=any(p_roles)
  ) then raise exception 'CI_ACCESS_DENIED' using errcode='42501'; end if;
  return v_actor;
end $$;
create function ci_private.can_read(p_warehouse_id smallint)
returns boolean language sql stable security definer set search_path = '' as $$
 select auth.uid() is not null and exists (
   select 1 from public.ci_user_profiles p join public.ci_user_access a on a.user_id=p.user_id
   where p.user_id=auth.uid() and p.active and a.active and a.warehouse_id=p_warehouse_id
 )
$$;
create function ci_private.can_admin_any()
returns boolean language sql stable security definer set search_path = '' as $$
 select auth.uid() is not null and exists (
   select 1 from public.ci_user_profiles p join public.ci_user_access a on a.user_id=p.user_id
   where p.user_id=auth.uid() and p.active and a.active and a.role='admin'
 )
$$;
create function ci_private.has_role(p_warehouse_id smallint, p_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
 select auth.uid() is not null and exists (
   select 1 from public.ci_user_profiles p join public.ci_user_access a on a.user_id=p.user_id
   where p.user_id=auth.uid() and p.active and a.active and a.warehouse_id=p_warehouse_id and a.role=any(p_roles)
 )
$$;

create function ci_private.guard_product() returns trigger language plpgsql set search_path = '' as $$
declare v_code text;
begin
  if tg_op='UPDATE' and (new.product_code <> old.product_code or new.warehouse_id <> old.warehouse_id or new.source_name <> old.source_name or new.import_batch_id is distinct from old.import_batch_id or new.source_sheet is distinct from old.source_sheet or new.source_row is distinct from old.source_row or new.raw_source is distinct from old.raw_source) then
    raise exception 'CI_PRODUCT_IDENTITY_IMMUTABLE';
  end if;
  select code into v_code from public.ci_warehouses where id=new.warehouse_id;
  if new.product_code !~ ('^'||v_code||'-[0-9]{4,}$') then raise exception 'CI_PRODUCT_CODE_WAREHOUSE_MISMATCH'; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger ci_product_guard before insert or update on public.ci_products for each row execute function ci_private.guard_product();
create function ci_private.guard_relation() returns trigger language plpgsql set search_path = '' as $$
declare v_type text;v_source_type text;
begin
  select product_type into v_type from public.ci_products where id=new.target_product_id and warehouse_id=new.warehouse_id;
  select product_type into v_source_type from public.ci_products where id=new.source_product_id and warehouse_id=new.warehouse_id;
  if new.relation_type like 'uses_%' and v_source_type is distinct from 'reagent' then
    raise exception 'CI_RELATION_SOURCE_TYPE_INVALID'; end if;
  if new.relation_type='uses_calibrator' and v_type is distinct from 'calibrator'
    or new.relation_type='uses_control' and v_type is distinct from 'control'
    or new.relation_type='uses_consumable' and v_type is distinct from 'consumable'
  then raise exception 'CI_RELATION_TARGET_TYPE_INVALID'; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger ci_relation_guard before insert or update on public.ci_product_relations for each row execute function ci_private.guard_relation();
create function ci_private.guard_product_type_relation() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.product_type is distinct from old.product_type and exists (
    select 1 from public.ci_product_relations r where
      (r.target_product_id=new.id and
        ((r.relation_type='uses_calibrator' and new.product_type<>'calibrator') or
         (r.relation_type='uses_control' and new.product_type<>'control') or
         (r.relation_type='uses_consumable' and new.product_type<>'consumable')))
      or (r.source_product_id=new.id and r.relation_type like 'uses_%' and new.product_type<>'reagent')
  ) then raise exception 'CI_PRODUCT_TYPE_HAS_RELATIONS'; end if;
  return new;
end $$;
create trigger ci_product_type_relation_guard before update of product_type on public.ci_products for each row execute function ci_private.guard_product_type_relation();
create function ci_private.guard_immutable() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'CI_CONFIRMED_HISTORY_IMMUTABLE'; end $$;
create trigger ci_movement_immutable before update or delete on public.ci_stock_movement_lines for each row execute function ci_private.guard_immutable();
create trigger ci_transaction_immutable before update or delete on public.ci_stock_transactions for each row execute function ci_private.guard_immutable();
create trigger ci_receipt_immutable before update or delete on public.ci_receipts for each row execute function ci_private.guard_immutable();
create trigger ci_receipt_line_immutable before update or delete on public.ci_receipt_lines for each row execute function ci_private.guard_immutable();
create trigger ci_audit_immutable before update or delete on public.ci_audit_logs for each row execute function ci_private.guard_immutable();
create function ci_private.guard_lot() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='DELETE' and exists(select 1 from public.ci_stock_movement_lines where lot_id=old.id) then
    raise exception 'CI_LOT_HAS_HISTORY'; end if;
  if tg_op='UPDATE' and exists(select 1 from public.ci_stock_movement_lines where lot_id=old.id)
    and (new.product_id<>old.product_id or new.warehouse_id<>old.warehouse_id or new.lot_number<>old.lot_number or new.expiry_date<>old.expiry_date) then
    raise exception 'CI_LOT_IDENTITY_IMMUTABLE'; end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
create trigger ci_lot_guard before update or delete on public.ci_stock_lots for each row execute function ci_private.guard_lot();
create function ci_private.check_movement_balance() returns trigger language plpgsql set search_path = '' as $$
declare v_balance numeric;
begin
  perform 1 from public.ci_stock_lots where id=new.lot_id and warehouse_id=new.warehouse_id for update;
  select coalesce(sum(quantity_delta),0) into v_balance from public.ci_stock_movement_lines
    where lot_id=new.lot_id and location_id=new.location_id;
  if v_balance + new.quantity_delta < 0 then raise exception 'CI_NEGATIVE_STOCK'; end if;
  return new;
end $$;
create trigger ci_movement_balance before insert on public.ci_stock_movement_lines for each row execute function ci_private.check_movement_balance();

create function ci_private.audit_change() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_id text; v_warehouse smallint;
begin
  if tg_op='DELETE' then v_id:=coalesce(to_jsonb(old)->>'id',to_jsonb(old)->>'user_id');
  else v_id:=coalesce(to_jsonb(new)->>'id',to_jsonb(new)->>'user_id'); end if;
  if tg_op='DELETE' then v_warehouse := (to_jsonb(old)->>'warehouse_id')::smallint;
  else v_warehouse := (to_jsonb(new)->>'warehouse_id')::smallint; end if;
  insert into public.ci_audit_logs(actor_id,warehouse_id,action,entity_table,entity_id,old_value,new_value)
  values (auth.uid(),v_warehouse,tg_op,tg_table_name,v_id,
    case when tg_op='INSERT' then null else to_jsonb(old) end,
    case when tg_op='DELETE' then null else to_jsonb(new) end);
  return case when tg_op='DELETE' then old else new end;
end $$;
create trigger ci_products_audit after insert or update or delete on public.ci_products for each row execute function ci_private.audit_change();
create trigger ci_identifiers_audit after insert or update or delete on public.ci_product_identifiers for each row execute function ci_private.audit_change();
create trigger ci_relations_audit after insert or update or delete on public.ci_product_relations for each row execute function ci_private.audit_change();
create trigger ci_platform_map_audit after insert or update or delete on public.ci_product_platforms for each row execute function ci_private.audit_change();
create trigger ci_access_audit after insert or update or delete on public.ci_user_access for each row execute function ci_private.audit_change();
create trigger ci_profiles_audit after insert or update or delete on public.ci_user_profiles for each row execute function ci_private.audit_change();
create trigger ci_import_reviews_audit after insert or update or delete on public.ci_import_review_items for each row execute function ci_private.audit_change();

-- All client writes go through explicit security-definer RPCs in the next migration.
do $$ declare t text; begin
  foreach t in array array[
    'ci_warehouses','ci_product_code_counters','ci_user_profiles','ci_user_access',
    'ci_import_batches','ci_import_rows','ci_import_review_items','ci_products',
    'ci_product_identifiers','ci_product_relations','ci_platforms','ci_product_platforms',
    'ci_vendors','ci_locations','ci_stock_lots','ci_invoices','ci_invoice_lines',
    'ci_receipts','ci_receipt_lines','ci_stock_transactions','ci_stock_movement_lines',
    'ci_stock_counts','ci_stock_count_lines','ci_audit_logs'
  ] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
  end loop;
end $$;
-- Only scoped reads are exposed to authenticated users.
create policy ci_wh_read on public.ci_warehouses for select to authenticated using (ci_private.can_read(id));
create policy ci_user_profiles_read on public.ci_user_profiles for select to authenticated using (user_id=auth.uid() or ci_private.can_admin_any());
create policy ci_user_access_read on public.ci_user_access for select to authenticated using (user_id=auth.uid() or ci_private.can_admin_any());
create policy ci_products_read on public.ci_products for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_identifiers_read on public.ci_product_identifiers for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_relations_read on public.ci_product_relations for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_platforms_read on public.ci_platforms for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_product_platforms_read on public.ci_product_platforms for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_locations_read on public.ci_locations for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_lots_read on public.ci_stock_lots for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_invoice_lines_read on public.ci_invoice_lines for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_invoices_read on public.ci_invoices for select to authenticated using (
  exists (select 1 from public.ci_invoice_lines l where l.invoice_id=ci_invoices.id and ci_private.can_read(l.warehouse_id))
);
create policy ci_receipts_read on public.ci_receipts for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_receipt_lines_read on public.ci_receipt_lines for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_transactions_read on public.ci_stock_transactions for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_movement_read on public.ci_stock_movement_lines for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_counts_read on public.ci_stock_counts for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_count_lines_read on public.ci_stock_count_lines for select to authenticated using (ci_private.can_read(warehouse_id));
create policy ci_audit_read on public.ci_audit_logs for select to authenticated using (warehouse_id is not null and ci_private.has_role(warehouse_id,array['admin','supervisor']));
create policy ci_vendor_read on public.ci_vendors for select to authenticated using (exists (select 1 from public.ci_user_access a join public.ci_user_profiles p on p.user_id=a.user_id where a.user_id=auth.uid() and a.active and p.active));
create policy ci_import_batch_read on public.ci_import_batches for select to authenticated using (ci_private.has_role(1::smallint,array['admin']) and ci_private.has_role(2::smallint,array['admin']));
create policy ci_import_rows_read on public.ci_import_rows for select to authenticated using (ci_private.has_role(1::smallint,array['admin']) and ci_private.has_role(2::smallint,array['admin']));
create policy ci_import_reviews_read on public.ci_import_review_items for select to authenticated using (ci_private.has_role(1::smallint,array['admin']) and ci_private.has_role(2::smallint,array['admin']));
-- Counters are intentionally never client-readable.

create view public.ci_stock_balances with (security_invoker=true) as
select l.warehouse_id,l.product_id,l.id as lot_id,l.lot_number,l.expiry_date,
       m.location_id,coalesce(sum(m.quantity_delta),0)::numeric(18,3) as balance
from public.ci_stock_lots l join public.ci_stock_movement_lines m on m.lot_id=l.id
group by l.warehouse_id,l.product_id,l.id,l.lot_number,l.expiry_date,m.location_id;
create view public.ci_fefo_candidates with (security_invoker=true) as
select * from public.ci_stock_balances where balance > 0 and expiry_date >= current_date;
create view public.ci_invoice_line_progress with (security_invoker=true) as
select il.id as invoice_line_id,il.invoice_id,il.warehouse_id,il.product_id,
       il.ordered_quantity,coalesce(sum(rl.quantity),0)::numeric(18,3) as received_quantity,
       (il.ordered_quantity-coalesce(sum(rl.quantity),0))::numeric(18,3) as remaining_quantity
from public.ci_invoice_lines il left join public.ci_receipt_lines rl on rl.invoice_line_id=il.id
group by il.id;
grant select on public.ci_stock_balances,public.ci_fefo_candidates,public.ci_invoice_line_progress to authenticated;

revoke all on all functions in schema ci_private from public, anon, authenticated;
grant usage on schema ci_private to authenticated;
grant execute on function ci_private.can_read(smallint),ci_private.can_admin_any(),ci_private.has_role(smallint,text[]) to authenticated;
revoke all on all sequences in schema public from anon,authenticated;
