-- Separate append/update flow for later Product workbooks. The original
-- ci_import_batches and the 162-row initial-import provenance remain intact.

create table public.ci_incremental_product_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_filename text not null check (length(btrim(source_filename)) between 1 and 255),
  source_sha256 text not null check (source_sha256 ~ '^[0-9A-F]{64}$'),
  status text not null default 'preview' check (status in ('preview','applied')),
  row_count integer not null check (row_count between 1 and 500),
  staged_by uuid not null references auth.users(id),
  staged_at timestamptz not null default now(),
  applied_by uuid references auth.users(id),
  applied_at timestamptz,
  check ((status = 'preview' and applied_by is null and applied_at is null)
      or (status = 'applied' and applied_by is not null and applied_at is not null))
);

create table public.ci_incremental_product_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.ci_incremental_product_import_batches(id),
  warehouse_id smallint not null references public.ci_warehouses(id),
  source_sheet text not null,
  source_row integer not null check (source_row > 0),
  disposition text not null check (disposition in ('New','Existing','Update','Conflict','Duplicate in file')),
  product_id uuid,
  match_method text,
  match_snapshot jsonb,
  candidate jsonb not null,
  changes jsonb not null default '[]'::jsonb check (jsonb_typeof(changes) = 'array'),
  relation_product_ids uuid[],
  platform_keys text[],
  details text,
  unique (batch_id, source_sheet, source_row)
);

create table public.ci_incremental_product_import_audit (
  id bigint generated always as identity primary key,
  import_batch_id uuid not null references public.ci_incremental_product_import_batches(id),
  product_id uuid not null,
  warehouse_id smallint not null references public.ci_warehouses(id),
  field text not null,
  old_value jsonb,
  new_value jsonb,
  action text not null check (action in ('PRODUCT_UPDATED','PRODUCT_IDENTIFIER_REPLACED')),
  source_filename text not null,
  source_row integer not null check (source_row > 0),
  actor_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.ci_incremental_product_import_batches enable row level security;
alter table public.ci_incremental_product_import_rows enable row level security;
alter table public.ci_incremental_product_import_audit enable row level security;
revoke all on public.ci_incremental_product_import_batches,
  public.ci_incremental_product_import_rows,
  public.ci_incremental_product_import_audit from anon, authenticated;
grant select on public.ci_incremental_product_import_batches,
  public.ci_incremental_product_import_rows,
  public.ci_incremental_product_import_audit to authenticated;

create policy ci_incremental_import_batch_read on public.ci_incremental_product_import_batches
  for select to authenticated using (
    ci_private.has_role(1::smallint, array['admin'])
    and ci_private.has_role(2::smallint, array['admin'])
  );
create policy ci_incremental_import_rows_read on public.ci_incremental_product_import_rows
  for select to authenticated using (exists (
    select 1 from public.ci_incremental_product_import_batches b
    where b.id = batch_id
      and ci_private.has_role(1::smallint, array['admin'])
      and ci_private.has_role(2::smallint, array['admin'])
  ));
create policy ci_incremental_import_audit_read on public.ci_incremental_product_import_audit
  for select to authenticated using (
    ci_private.has_role(warehouse_id, array['admin','supervisor'])
  );
create trigger ci_incremental_import_audit_immutable
  before update or delete on public.ci_incremental_product_import_audit
  for each row execute function ci_private.guard_immutable();

create function ci_private.incremental_product_snapshot(p_product_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id,
    'warehouse_id', p.warehouse_id,
    'product_code', p.product_code,
    'product_type', p.product_type,
    'source_name', p.source_name,
    'display_name', p.display_name,
    'packing_size_raw', p.packing_size_raw,
    'identifiers', coalesce((
      select jsonb_agg(jsonb_build_object('kind', i.kind, 'value', i.value, 'approved', i.approved) order by i.kind, i.value)
      from public.ci_product_identifiers i where i.product_id = p.id
    ), '[]'::jsonb),
    'relations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'source_product_id', r.source_product_id,
        'target_product_id', r.target_product_id,
        'relation_type', r.relation_type
      ) order by r.source_product_id, r.target_product_id, r.relation_type)
      from public.ci_product_relations r
      where r.source_product_id = p.id or r.target_product_id = p.id
    ), '[]'::jsonb),
    'platforms', coalesce((
      select jsonb_agg(jsonb_build_object('platform_id', pp.platform_id, 'platform_key', pl.platform_key) order by pl.platform_key)
      from public.ci_product_platforms pp
      join public.ci_platforms pl on pl.id = pp.platform_id
      where pp.product_id = p.id
    ), '[]'::jsonb)
  )
  from public.ci_products p where p.id = p_product_id
$$;
revoke all on function ci_private.incremental_product_snapshot(uuid) from public, anon, authenticated;

create function ci_private.ci_stage_incremental_product_import(p_payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_batch uuid;
  v_rows jsonb := p_payload->'rows';
  v_row jsonb;
  v_candidate jsonb;
  v_warehouse smallint;
  v_product_id uuid;
  v_disposition text;
  v_snapshot jsonb;
  v_count integer := 0;
begin
  perform ci_private.require_role(1::smallint, array['admin']);
  perform ci_private.require_role(2::smallint, array['admin']);
  if jsonb_typeof(p_payload) <> 'object'
     or jsonb_typeof(v_rows) <> 'array'
     or jsonb_array_length(v_rows) < 1
     or jsonb_array_length(v_rows) > 500
     or nullif(btrim(p_payload->>'source_filename'), '') is null
     or length(p_payload->>'source_filename') > 255
     or p_payload->>'source_sha256' !~ '^[0-9A-F]{64}$' then
    raise exception 'CI_INCREMENTAL_IMPORT_PAYLOAD_INVALID';
  end if;

  for v_row in select value from jsonb_array_elements(v_rows) loop
    v_candidate := v_row->'candidate';
    if jsonb_typeof(v_candidate) <> 'object'
       or v_candidate ? 'product_code'
       or v_candidate->>'warehouse_code' not in ('CHE','IMM')
       or v_candidate->>'source_sheet' not in ('Reagent list','FOC item_chem c503 c703 ISE','FOC item_Imm e801')
       or coalesce((v_candidate->>'source_row')::integer, 0) <= 0
       or nullif(btrim(v_candidate->>'source_name'), '') is null
       or v_candidate->>'ref_current' !~ '^\d+$'
       or v_candidate->>'manufacturer_barcode' !~ '^\d+$'
       or (v_candidate->>'product_type' is not null and v_candidate->>'product_type' not in ('reagent','calibrator','control','consumable'))
       or v_row->>'classification' not in ('New','Existing','Update','Conflict','Duplicate in file')
       or jsonb_typeof(v_row->'changes') <> 'array' then
      raise exception 'CI_INCREMENTAL_IMPORT_ROW_INVALID';
    end if;
  end loop;

  insert into public.ci_incremental_product_import_batches(source_filename,source_sha256,row_count,staged_by)
  values (p_payload->>'source_filename',p_payload->>'source_sha256',jsonb_array_length(v_rows),v_actor)
  returning id into v_batch;

  for v_row in select value from jsonb_array_elements(v_rows) loop
    v_candidate := v_row->'candidate';
    v_warehouse := case v_candidate->>'warehouse_code' when 'CHE' then 1::smallint else 2::smallint end;
    perform ci_private.require_role(v_warehouse, array['admin']);
    v_product_id := nullif(v_row->>'product_id','')::uuid;
    v_snapshot := null;
    if v_product_id is not null then
      select ci_private.incremental_product_snapshot(v_product_id) into v_snapshot;
      if v_snapshot is null or (v_snapshot->>'warehouse_id')::smallint <> v_warehouse then
        raise exception 'CI_INCREMENTAL_IMPORT_PRODUCT_INVALID';
      end if;
    end if;
    v_disposition := v_row->>'classification';
    insert into public.ci_incremental_product_import_rows(
      batch_id,warehouse_id,source_sheet,source_row,disposition,product_id,match_method,
      match_snapshot,candidate,changes,relation_product_ids,platform_keys,details
    ) values (
      v_batch,v_warehouse,v_candidate->>'source_sheet',(v_candidate->>'source_row')::integer,
      v_disposition,v_product_id,nullif(v_row->>'match_method',''),v_snapshot,v_candidate,
      v_row->'changes',
      case when jsonb_typeof(v_row->'relation_product_ids')='array'
        then array(select value::text::uuid from jsonb_array_elements_text(v_row->'relation_product_ids')) else null end,
      case when jsonb_typeof(v_row->'platform_keys')='array'
        then array(select value from jsonb_array_elements_text(v_row->'platform_keys')) else null end,
      nullif(v_row->>'message','')
    );
    v_count := v_count + 1;
  end loop;

  -- Duplicate protection is repeated in the database so a hand-built request
  -- cannot stage two rows as independently safe Products.
  update public.ci_incremental_product_import_rows r
  set disposition = 'Duplicate in file', product_id = null, match_snapshot = null,
      details = 'Repeated REF or Manufacturer Barcode appears in multiple changed rows'
  where r.batch_id = v_batch and exists (
    select 1 from public.ci_incremental_product_import_rows other
    where other.batch_id = r.batch_id and other.id <> r.id
      and (
        other.candidate->>'ref_current' in (r.candidate->>'ref_current',r.candidate->>'manufacturer_barcode')
        or other.candidate->>'manufacturer_barcode' in (r.candidate->>'ref_current',r.candidate->>'manufacturer_barcode')
      )
  );
  update public.ci_incremental_product_import_batches set row_count = v_count where id = v_batch;
  return v_batch;
end $$;
revoke all on function ci_private.ci_stage_incremental_product_import(jsonb) from public, anon, authenticated;

create function ci_private.audit_incremental_product_change(
  p_batch_id uuid,p_product_id uuid,p_warehouse_id smallint,p_field text,
  p_old_value jsonb,p_new_value jsonb,p_action text,p_source_row integer
) returns void language plpgsql security definer set search_path = '' as $$
declare v_filename text;
begin
  select source_filename into v_filename from public.ci_incremental_product_import_batches where id=p_batch_id;
  insert into public.ci_incremental_product_import_audit(
    import_batch_id,product_id,warehouse_id,field,old_value,new_value,action,
    source_filename,source_row,actor_id
  ) values (
    p_batch_id,p_product_id,p_warehouse_id,p_field,p_old_value,p_new_value,p_action,
    v_filename,p_source_row,auth.uid()
  );
end $$;
revoke all on function ci_private.audit_incremental_product_change(uuid,uuid,smallint,text,jsonb,jsonb,text,integer) from public, anon, authenticated;

create function ci_private.ci_apply_incremental_product_import(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_batch public.ci_incremental_product_import_batches%rowtype;
  v_row public.ci_incremental_product_import_rows%rowtype;
  v_candidate jsonb;
  v_product public.ci_products%rowtype;
  v_wh smallint;
  v_current_ref text;
  v_current_barcode text;
  v_new_ref text;
  v_new_barcode text;
  v_ref_id uuid;
  v_barcode_id uuid;
  v_new_id uuid;
  v_product_data jsonb;
  v_current_platforms jsonb;
  v_new_platforms jsonb;
  v_current_relations jsonb;
  v_new_relations jsonb;
  v_platform_key text;
  v_platform_id uuid;
  v_relation_id uuid;
  v_relation_type text;
  v_new_count integer := 0;
  v_update_count integer := 0;
  v_existing_count integer := 0;
  v_conflict_count integer := 0;
  v_duplicate_count integer := 0;
begin
  perform ci_private.require_role(1::smallint, array['admin']);
  perform ci_private.require_role(2::smallint, array['admin']);
  select * into v_batch from public.ci_incremental_product_import_batches where id=p_batch_id for update;
  if not found or v_batch.status <> 'preview' then raise exception 'CI_INCREMENTAL_IMPORT_STATE_INVALID'; end if;

  -- Lock matched rows and recheck their full identifier, relationship, and
  -- platform snapshot before any change. A stale preview fails atomically.
  for v_row in
    select * from public.ci_incremental_product_import_rows
    where batch_id=p_batch_id and disposition in ('Existing','Update') order by product_id for update
  loop
    perform 1 from public.ci_products where id=v_row.product_id and warehouse_id=v_row.warehouse_id for update;
    if not found or ci_private.incremental_product_snapshot(v_row.product_id) is distinct from v_row.match_snapshot then
      raise exception 'CI_INCREMENTAL_PREVIEW_STALE';
    end if;
    v_candidate := v_row.candidate;
    select value into v_current_ref from public.ci_product_identifiers
      where product_id=v_row.product_id and kind='REF_CURRENT';
    select value,id into v_current_barcode,v_barcode_id from public.ci_product_identifiers
      where product_id=v_row.product_id and kind='MANUFACTURER_BARCODE' and approved;
    if not (v_current_ref=v_candidate->>'ref_current' or v_current_barcode=v_candidate->>'manufacturer_barcode'
      or (nullif(v_candidate->>'replaces_ref','') is not null and (
        v_current_ref=v_candidate->>'replaces_ref' or exists (
          select 1 from public.ci_product_identifiers legacy
          where legacy.product_id=v_row.product_id and legacy.kind='REF_LEGACY'
            and legacy.value=v_candidate->>'replaces_ref'
        )
      ))) then
      raise exception 'CI_INCREMENTAL_MATCH_EVIDENCE_STALE';
    end if;
    if exists (
      select 1 from public.ci_product_identifiers i
      where i.value in (v_candidate->>'ref_current',v_candidate->>'manufacturer_barcode')
        and i.product_id <> v_row.product_id
    ) then raise exception 'CI_INCREMENTAL_IDENTIFIER_COLLISION'; end if;
    if exists (
      select 1 from public.ci_product_identifiers i
      where i.product_id=v_row.product_id and i.kind='REF_LEGACY' and i.value=v_candidate->>'ref_current'
        and v_current_ref is distinct from v_candidate->>'ref_current'
    ) then raise exception 'CI_INCREMENTAL_STALE_LEGACY_REF'; end if;
    if v_row.disposition='Existing' and jsonb_array_length(v_row.changes)<>0 then
      raise exception 'CI_INCREMENTAL_CLASSIFICATION_STALE';
    end if;
    if v_row.disposition='Update' and jsonb_array_length(v_row.changes)=0 then
      raise exception 'CI_INCREMENTAL_CLASSIFICATION_STALE';
    end if;
  end loop;

  for v_row in select * from public.ci_incremental_product_import_rows
    where batch_id=p_batch_id and disposition='New' order by warehouse_id,source_sheet,source_row for update
  loop
    v_candidate := v_row.candidate;
    if v_row.product_id is not null or nullif(v_candidate->>'product_type','') is null
       or exists (select 1 from public.ci_product_identifiers i where i.value in (v_candidate->>'ref_current',v_candidate->>'manufacturer_barcode'))
       or exists (select 1 from public.ci_products p where p.warehouse_id=v_row.warehouse_id
         and (lower(btrim(p.display_name))=lower(btrim(v_candidate->>'source_name'))
           or lower(btrim(p.source_name))=lower(btrim(v_candidate->>'source_name')))) then
      raise exception 'CI_INCREMENTAL_PREVIEW_STALE';
    end if;
  end loop;

  -- Generate Products first so relation rows can safely target another New row
  -- if a future workbook supplies a deterministic in-batch reference.
  for v_row in select * from public.ci_incremental_product_import_rows
    where batch_id=p_batch_id and disposition='New' order by warehouse_id,source_sheet,source_row for update
  loop
    v_candidate := v_row.candidate;
    v_new_id := ci_private.new_product(
      v_row.warehouse_id,v_candidate->>'product_type',v_candidate->>'source_name',
      nullif(v_candidate->>'packing_size_raw',''),null,v_row.source_sheet,v_row.source_row,
      coalesce(v_candidate->'raw_source','{}'::jsonb)
    );
    insert into public.ci_product_identifiers(product_id,warehouse_id,kind,value,source)
    values(v_new_id,v_row.warehouse_id,'REF_CURRENT',v_candidate->>'ref_current','incremental_import'),
          (v_new_id,v_row.warehouse_id,'MANUFACTURER_BARCODE',v_candidate->>'manufacturer_barcode','incremental_import');
    update public.ci_incremental_product_import_rows set product_id=v_new_id where id=v_row.id;
    v_new_count := v_new_count + 1;
  end loop;

  -- Apply supplied, exact Product and Platform mappings after all new Product
  -- identities exist. Blank source cells remain unassigned and create no links.
  for v_row in select * from public.ci_incremental_product_import_rows
    where batch_id=p_batch_id and disposition='New' and (relation_product_ids is not null or platform_keys is not null)
    order by warehouse_id,source_sheet,source_row for update
  loop
    v_candidate := v_row.candidate;
    if v_row.relation_product_ids is not null then
      v_relation_type := 'uses_' || (v_candidate->>'product_type');
      foreach v_relation_id in array v_row.relation_product_ids loop
        insert into public.ci_product_relations(warehouse_id,source_product_id,target_product_id,relation_type,source_text)
        values(v_row.warehouse_id,v_relation_id,v_row.product_id,v_relation_type,v_candidate->>'used_with');
      end loop;
    end if;
    if v_row.platform_keys is not null then
      foreach v_platform_key in array v_row.platform_keys loop
        select id into v_platform_id from public.ci_platforms where warehouse_id=v_row.warehouse_id and platform_key=v_platform_key;
        if v_platform_id is null then raise exception 'CI_INCREMENTAL_PLATFORM_INVALID'; end if;
        insert into public.ci_product_platforms(product_id,platform_id,warehouse_id,source_text,source_sheet,source_row)
        values(v_row.product_id,v_platform_id,v_row.warehouse_id,v_candidate->>'used_with',v_row.source_sheet,v_row.source_row);
      end loop;
    end if;
  end loop;

  for v_row in select * from public.ci_incremental_product_import_rows
    where batch_id=p_batch_id and disposition in ('Existing','Update') order by source_sheet,source_row for update
  loop
    if v_row.disposition='Existing' then
      v_existing_count := v_existing_count + 1;
      continue;
    end if;
    v_candidate := v_row.candidate;
    select * into v_product from public.ci_products where id=v_row.product_id for update;
    v_wh := v_row.warehouse_id;
    v_new_ref := v_candidate->>'ref_current';
    v_new_barcode := v_candidate->>'manufacturer_barcode';
    select id into v_ref_id from public.ci_product_identifiers where product_id=v_row.product_id and kind='REF_CURRENT' for update;
    select value into v_current_ref from public.ci_product_identifiers where id=v_ref_id;
    select value,id into v_current_barcode,v_barcode_id from public.ci_product_identifiers
      where product_id=v_row.product_id and kind='MANUFACTURER_BARCODE' and approved for update;

    -- Remove supplied relationship mappings before Product Type changes; the
    -- relation trigger validates both ends against the final types.
    if v_row.relation_product_ids is not null then
      select coalesce(jsonb_agg(jsonb_build_object('product_code',p.product_code,'display_name',p.display_name,
        'relation_type',r.relation_type) order by p.product_code,r.relation_type),'[]'::jsonb) into v_current_relations
      from public.ci_product_relations r join public.ci_products p on p.id=r.source_product_id
      where r.target_product_id=v_row.product_id and r.relation_type like 'uses_%';
      v_relation_type := 'uses_' || (v_candidate->>'product_type');
      select coalesce(jsonb_agg(jsonb_build_object('product_code',p.product_code,'display_name',p.display_name,
        'relation_type',v_relation_type) order by p.product_code,v_relation_type),'[]'::jsonb) into v_new_relations
      from unnest(v_row.relation_product_ids) as ids(id) join public.ci_products p on p.id=ids.id;
      if v_current_relations is distinct from v_new_relations
         or v_candidate->>'product_type' is distinct from v_product.product_type then
        if v_current_relations is not distinct from v_new_relations then
          v_current_relations := jsonb_build_object('relations',v_current_relations,'product_type',v_product.product_type);
          v_new_relations := jsonb_build_object('relations',v_new_relations,'product_type',v_candidate->>'product_type');
        end if;
        perform ci_private.audit_incremental_product_change(p_batch_id,v_row.product_id,v_wh,
          'Used with / Product relationship',v_current_relations,v_new_relations,'PRODUCT_UPDATED',v_row.source_row);
        delete from public.ci_product_relations where target_product_id=v_row.product_id and relation_type like 'uses_%';
      end if;
    end if;
    if v_row.platform_keys is not null then
      select coalesce(jsonb_agg(pl.platform_key order by pl.platform_key),'[]'::jsonb) into v_current_platforms
        from public.ci_product_platforms pp join public.ci_platforms pl on pl.id=pp.platform_id where pp.product_id=v_row.product_id;
      select coalesce(jsonb_agg(keys.key order by keys.key),'[]'::jsonb) into v_new_platforms
        from unnest(v_row.platform_keys) as keys(key);
      if v_current_platforms is distinct from v_new_platforms then
        perform ci_private.audit_incremental_product_change(p_batch_id,v_row.product_id,v_wh,
          'Platform mapping',v_current_platforms,v_new_platforms,'PRODUCT_UPDATED',v_row.source_row);
        delete from public.ci_product_platforms where product_id=v_row.product_id;
      end if;
    end if;

    v_product_data := '{}'::jsonb;
    if v_candidate->>'source_name' is distinct from v_product.display_name then
      v_product_data := v_product_data || jsonb_build_object('display_name',v_candidate->>'source_name');
      perform ci_private.audit_incremental_product_change(p_batch_id,v_row.product_id,v_wh,
        'Product Name',to_jsonb(v_product.display_name),to_jsonb(v_candidate->>'source_name'),'PRODUCT_UPDATED',v_row.source_row);
    end if;
    if nullif(v_candidate->>'packing_size_raw','') is not null
       and v_candidate->>'packing_size_raw' is distinct from v_product.packing_size_raw then
      v_product_data := v_product_data || jsonb_build_object('packing_size_raw',v_candidate->>'packing_size_raw');
      perform ci_private.audit_incremental_product_change(p_batch_id,v_row.product_id,v_wh,
        'Packing Size',to_jsonb(v_product.packing_size_raw),to_jsonb(v_candidate->>'packing_size_raw'),'PRODUCT_UPDATED',v_row.source_row);
    end if;
    if nullif(v_candidate->>'product_type','') is not null
       and v_candidate->>'product_type' is distinct from v_product.product_type then
      v_product_data := v_product_data || jsonb_build_object('product_type',v_candidate->>'product_type');
      perform ci_private.audit_incremental_product_change(p_batch_id,v_row.product_id,v_wh,
        'Product Type',to_jsonb(v_product.product_type),to_jsonb(v_candidate->>'product_type'),'PRODUCT_UPDATED',v_row.source_row);
    end if;
    if v_product_data <> '{}'::jsonb then perform ci_private.ci_update_product(v_row.product_id,v_product_data); end if;

    if v_new_ref is distinct from v_current_ref then
      if not (v_current_barcode=v_new_barcode or v_current_ref=nullif(v_candidate->>'replaces_ref','')
        or exists (
          select 1 from public.ci_product_identifiers legacy
          where legacy.product_id=v_row.product_id and legacy.kind='REF_LEGACY'
            and legacy.value=nullif(v_candidate->>'replaces_ref','')
        )) then
        raise exception 'CI_INCREMENTAL_REF_REPLACEMENT_UNPROVEN';
      end if;
      update public.ci_product_identifiers set value=v_new_ref,source='incremental_import' where id=v_ref_id;
      if not exists (select 1 from public.ci_product_identifiers where product_id=v_row.product_id and kind='REF_LEGACY' and value=v_current_ref) then
        insert into public.ci_product_identifiers(product_id,warehouse_id,kind,value,source)
        values(v_row.product_id,v_wh,'REF_LEGACY',v_current_ref,'incremental_import');
      end if;
      perform ci_private.audit_incremental_product_change(p_batch_id,v_row.product_id,v_wh,
        'REF_CURRENT',to_jsonb(v_current_ref),to_jsonb(v_new_ref),'PRODUCT_IDENTIFIER_REPLACED',v_row.source_row);
      perform ci_private.audit_incremental_product_change(p_batch_id,v_row.product_id,v_wh,
        'REF_LEGACY',null,to_jsonb(v_current_ref),'PRODUCT_IDENTIFIER_REPLACED',v_row.source_row);
    end if;
    if v_new_barcode is distinct from v_current_barcode then
      if v_barcode_id is null then
        insert into public.ci_product_identifiers(product_id,warehouse_id,kind,value,source)
          values(v_row.product_id,v_wh,'MANUFACTURER_BARCODE',v_new_barcode,'incremental_import');
      else
        update public.ci_product_identifiers set value=v_new_barcode,source='incremental_import' where id=v_barcode_id;
      end if;
      perform ci_private.audit_incremental_product_change(p_batch_id,v_row.product_id,v_wh,
        'Manufacturer Barcode',to_jsonb(v_current_barcode),to_jsonb(v_new_barcode),'PRODUCT_UPDATED',v_row.source_row);
    end if;

    if v_row.relation_product_ids is not null then
      v_relation_type := 'uses_' || (v_candidate->>'product_type');
      foreach v_relation_id in array v_row.relation_product_ids loop
        insert into public.ci_product_relations(warehouse_id,source_product_id,target_product_id,relation_type,source_text)
        values(v_wh,v_relation_id,v_row.product_id,v_relation_type,v_candidate->>'used_with')
        on conflict (source_product_id,target_product_id,relation_type) do nothing;
      end loop;
    end if;
    if v_row.platform_keys is not null then
      foreach v_platform_key in array v_row.platform_keys loop
        select id into v_platform_id from public.ci_platforms where warehouse_id=v_wh and platform_key=v_platform_key;
        if v_platform_id is null then raise exception 'CI_INCREMENTAL_PLATFORM_INVALID'; end if;
        insert into public.ci_product_platforms(product_id,platform_id,warehouse_id,source_text,source_sheet,source_row)
        values(v_row.product_id,v_platform_id,v_wh,v_candidate->>'used_with',v_row.source_sheet,v_row.source_row)
        on conflict (product_id,platform_id) do nothing;
      end loop;
    end if;
    v_update_count := v_update_count + 1;
  end loop;

  select count(*) filter(where disposition='Conflict'),count(*) filter(where disposition='Duplicate in file')
    into v_conflict_count,v_duplicate_count
  from public.ci_incremental_product_import_rows where batch_id=p_batch_id;
  update public.ci_incremental_product_import_batches
  set status='applied',applied_by=auth.uid(),applied_at=now() where id=p_batch_id;
  perform ci_private.audit(1::smallint,'APPLY','ci_incremental_product_import_batches',p_batch_id::text);
  return jsonb_build_object('new',v_new_count,'existing',v_existing_count,'updated',v_update_count,
    'conflict',v_conflict_count,'duplicate_in_file',v_duplicate_count);
end $$;
revoke all on function ci_private.ci_apply_incremental_product_import(uuid) from public, anon, authenticated;

select ci_private.publish_rpc('ci_private.ci_stage_incremental_product_import(jsonb)'::regprocedure);
select ci_private.publish_rpc('ci_private.ci_apply_incremental_product_import(uuid)'::regprocedure);
