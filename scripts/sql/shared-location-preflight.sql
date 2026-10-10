-- Read-only Production preflight before converting CHE / IMM locations to a shared master.
-- Run on the actual CHEM-IMMUNO-QMS Supabase project and review every result.
-- This script never updates, deletes, locks, or migrates stock or location records.

select 'ci_locations' as source, count(*)::bigint as total from public.ci_locations
union all select 'ci_products_with_default_location', count(*) from public.ci_products where default_location_id is not null
union all select 'ci_receipt_lines', count(*) from public.ci_receipt_lines
union all select 'ci_stock_movement_lines', count(*) from public.ci_stock_movement_lines
union all select 'ci_stock_count_lines', count(*) from public.ci_stock_count_lines
union all select 'ci_stock_transactions', count(*) from public.ci_stock_transactions
union all select 'ci_environment_readings', count(*) from public.ci_environment_readings
union all select 'ci_location_env_configs', count(*) from public.ci_location_env_configs
union all select 'ci_environment_excursions', count(*) from public.ci_environment_excursions
order by source;

-- Existing location hierarchy, IDs, current owning warehouses and metadata.
-- Preserve IDs and parent-child relationships; never deduplicate by name alone.
select w.code as legacy_warehouse, l.id, l.code, l.name, l.location_type,
       l.parent_location_id, l.room, l.storage_condition, l.active
from public.ci_locations l
join public.ci_warehouses w on w.id = l.warehouse_id
order by w.code, l.parent_location_id nulls first, l.code, l.id;

-- Potentially overlapping physical places across CHE/IMM (review manually).
select lower(btrim(a.code)) as matching_code,
       a.id as che_location_id, a.name as che_name, a.room as che_room,
       b.id as imm_location_id, b.name as imm_name, b.room as imm_room
from public.ci_locations a
join public.ci_locations b on a.warehouse_id = 1 and b.warehouse_id = 2
 and lower(btrim(a.code)) = lower(btrim(b.code))
order by matching_code;

-- Every foreign-key dependency must be accounted for in the new schema.
select conrelid::regclass::text as source_table, conname as constraint_name,
       pg_get_constraintdef(oid) as definition
from pg_constraint
where contype = 'f' and confrelid = 'public.ci_locations'::regclass
order by source_table, constraint_name;
