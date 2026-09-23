-- Apply explicit owner review decisions as a forward-only import version.
-- Raw workbook snapshots remain unchanged; approved values and decisions are
-- recorded separately so a reviewer can explain each difference.

insert into public.ci_platforms(warehouse_id,platform_key,display_name,is_group)
values (1,'c513','c513',false)
on conflict (warehouse_id,platform_key) do nothing;

alter table public.ci_import_review_items
  add column review_id text,
  add column source_product_ref text,
  add column raw_source_value jsonb,
  add column resolution_type text,
  add constraint ci_import_review_id_format
    check (review_id is null or review_id ~ '^(REL|PM)-[0-9]{2}$'),
  add constraint ci_import_review_resolution_type
    check (resolution_type is null or resolution_type in (
      'source-confirmed','owner-confirmed-candidate','owner-manual-relationship',
      'owner-unassigned','owner-data-correction','owner-type-override','owner-platform-override'
    ));
create unique index ci_import_review_id_unique
  on public.ci_import_review_items(batch_id,review_id) where review_id is not null;

alter table public.ci_product_relations
  add column source_kind text not null default 'manual'
    check (source_kind in ('manual','source-confirmed','owner-approved')),
  add column source_review_id text
    check (source_review_id is null or source_review_id ~ '^(REL|PM)-[0-9]{2}$');
alter table public.ci_product_platforms
  add column source_kind text not null default 'manual'
    check (source_kind in ('manual','source-confirmed','owner-approved')),
  add column source_review_id text
    check (source_review_id is null or source_review_id ~ '^(REL|PM)-[0-9]{2}$');

create table public.ci_import_review_resolutions (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.ci_import_batches(id),
  review_item_id uuid not null references public.ci_import_review_items(id),
  warehouse_id smallint not null references public.ci_warehouses(id),
  review_id text not null check (review_id ~ '^(REL|PM)-[0-9]{2}$'),
  source_sha256 text not null check (source_sha256 ~ '^[A-F0-9]{64}$'),
  source_sheet text not null,
  source_row integer not null check (source_row > 0),
  source_product_ref text not null check (source_product_ref ~ '^[0-9]+$'),
  source_field text not null,
  raw_source_value jsonb not null check (jsonb_typeof(raw_source_value) in ('string','number','null')),
  approved_decision jsonb not null check (jsonb_typeof(approved_decision)='object'),
  target_refs text[] not null default '{}',
  platform_keys text[] not null default '{}',
  resolution_type text not null check (resolution_type in (
    'source-confirmed','owner-confirmed-candidate','owner-manual-relationship',
    'owner-unassigned','owner-data-correction','owner-type-override','owner-platform-override'
  )),
  approval_source text not null,
  resolution_note text not null,
  recorded_by uuid not null references auth.users(id),
  recorded_at timestamptz not null default now(),
  unique (batch_id,review_id),
  unique (review_item_id)
);
create index ci_import_review_resolutions_product_idx
  on public.ci_import_review_resolutions(batch_id,source_product_ref);

create function ci_private.reject_import_resolution_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'CI_IMPORT_RESOLUTION_IMMUTABLE';
end $$;

create or replace function public.ci_apply_import_batch(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_batch public.ci_import_batches%rowtype;
  v_product jsonb;
  v_edge jsonb;
  v_resolution record;
  v_wh smallint;v_id uuid;v_source uuid;v_target uuid;v_platform uuid;v_material uuid;
  v_source_wh smallint;v_target_wh smallint;v_source_type text;v_target_type text;
  v_target_ref text;v_platform_key text;v_active_relations integer;v_active_platforms integer;
  v_source_text text;
begin
  perform ci_private.require_import_admin();
  select * into v_batch from public.ci_import_batches where id=p_batch_id for update;
  if not found or v_batch.status<>'staged' then raise exception 'CI_IMPORT_NOT_STAGED'; end if;
  if exists(select 1 from public.ci_import_batches where status='applied' and source_sha256=v_batch.source_sha256)
    then raise exception 'CI_IMPORT_ALREADY_APPLIED'; end if;
  if exists(select 1 from public.ci_import_review_items where batch_id=p_batch_id and critical and status='open')
    then raise exception 'CI_IMPORT_CRITICAL_REVIEW_OPEN'; end if;
  if (select count(*) from public.ci_import_rows where batch_id=p_batch_id)<>162
    or (select count(*) from public.ci_import_review_items where batch_id=p_batch_id and kind='used_with')<>12
    or (select count(*) from public.ci_import_review_resolutions where batch_id=p_batch_id)<>20 then
    raise exception 'CI_IMPORT_STAGING_CORRUPT'; end if;

  -- Product order is source sheet order; database counters allocate immutable codes.
  for v_product in select value from jsonb_array_elements(v_batch.payload->'products') loop
    select id into v_wh from public.ci_warehouses where code=v_product->>'warehouse_code';
    v_id:=ci_private.new_product(v_wh,v_product->>'product_type',v_product->>'source_name',
      v_product->>'packing_size_raw',p_batch_id,v_product->>'source_sheet',
      (v_product->>'source_row')::integer,coalesce(v_product->'raw_source','{}'::jsonb));
    insert into public.ci_product_identifiers(product_id,warehouse_id,kind,value,source)
      values(v_id,v_wh,'REF_CURRENT',v_product->>'ref_current','approved_workbook'),
            (v_id,v_wh,'MANUFACTURER_BARCODE',v_product->>'manufacturer_barcode','approved_workbook');
    if nullif(v_product->>'legacy_ref','') is not null then
      insert into public.ci_product_identifiers(product_id,warehouse_id,kind,value,source)
        values(v_id,v_wh,'REF_LEGACY',v_product->>'legacy_ref','approved_workbook');
    end if;
  end loop;

  for v_edge in select value from jsonb_array_elements(v_batch.payload->'product_relations') loop
    select p.id,p.warehouse_id into v_source,v_wh from public.ci_products p
      join public.ci_product_identifiers i on i.product_id=p.id
      where p.import_batch_id=p_batch_id and i.kind='REF_CURRENT' and i.value=v_edge->>'source_ref_current';
    select p.id,p.warehouse_id into v_target,v_target_wh from public.ci_products p
      join public.ci_product_identifiers i on i.product_id=p.id
      where p.import_batch_id=p_batch_id and i.kind='REF_CURRENT' and i.value=v_edge->>'target_ref_current';
    if v_source is null or v_target is null or v_wh is distinct from v_target_wh then raise exception 'CI_IMPORT_RELATION_REF_NOT_FOUND'; end if;
    insert into public.ci_product_relations(warehouse_id,source_product_id,target_product_id,relation_type,source_text,source_kind)
      values(v_wh,v_source,v_target,v_edge->>'relation_type',v_edge->>'source_text','source-confirmed');
  end loop;

  for v_resolution in select * from public.ci_import_review_resolutions
    where batch_id=p_batch_id and resolution_type in ('owner-confirmed-candidate','owner-manual-relationship')
    order by review_id loop
    if v_resolution.approved_decision->>'kind'<>'product_relationship' then raise exception 'CI_IMPORT_RELATION_DECISION_INVALID'; end if;
    v_target_ref:=v_resolution.approved_decision->>'source_ref_current';
    select p.id,p.warehouse_id,p.product_type into v_source,v_source_wh,v_source_type
      from public.ci_products p join public.ci_product_identifiers i on i.product_id=p.id
      where p.import_batch_id=p_batch_id and i.kind='REF_CURRENT' and i.value=v_target_ref;
    v_target_ref:=v_resolution.approved_decision->>'target_ref_current';
    select p.id,p.warehouse_id,p.product_type into v_target,v_target_wh,v_target_type
      from public.ci_products p join public.ci_product_identifiers i on i.product_id=p.id
      where p.import_batch_id=p_batch_id and i.kind='REF_CURRENT' and i.value=v_target_ref;
    if v_source is null or v_target is null or v_source_wh is distinct from v_target_wh
      or v_source_type<>'reagent' or v_target_type='reagent'
      or v_resolution.approved_decision->>'relation_type' is distinct from 'uses_'||v_target_type then
      raise exception 'CI_IMPORT_RELATION_TARGET_INVALID';
    end if;
    v_source_text:=case when jsonb_typeof(v_resolution.raw_source_value)='string'
      then v_resolution.raw_source_value #>> '{}' else null end;
    insert into public.ci_product_relations(
      warehouse_id,source_product_id,target_product_id,relation_type,source_text,note,source_kind,source_review_id
    ) values(v_source_wh,v_source,v_target,v_resolution.approved_decision->>'relation_type',v_source_text,
      v_resolution.resolution_note,'owner-approved',v_resolution.review_id);
  end loop;

  for v_edge in select value from jsonb_array_elements(v_batch.payload->'platform_relations') loop
    if exists(select 1 from public.ci_import_review_resolutions r where r.batch_id=p_batch_id
      and r.resolution_type='owner-platform-override' and r.source_product_ref=v_edge->>'product_ref_current') then
      continue;
    end if;
    select p.id,p.warehouse_id into v_material,v_wh from public.ci_products p
      join public.ci_product_identifiers i on i.product_id=p.id
      where p.import_batch_id=p_batch_id and i.kind='REF_CURRENT' and i.value=v_edge->>'product_ref_current';
    select id into v_platform from public.ci_platforms where warehouse_id=v_wh and platform_key=v_edge->>'platform_key';
    if v_material is null or v_platform is null then raise exception 'CI_IMPORT_PLATFORM_NOT_FOUND'; end if;
    insert into public.ci_product_platforms(product_id,platform_id,warehouse_id,source_text,source_sheet,source_row,source_kind)
      values(v_material,v_platform,v_wh,v_edge->>'source_text',v_edge->>'source_sheet',(v_edge->>'source_row')::integer,'source-confirmed');
  end loop;

  for v_resolution in select * from public.ci_import_review_resolutions
    where batch_id=p_batch_id and resolution_type='owner-platform-override' order by review_id loop
    select p.id,p.warehouse_id into v_material,v_wh from public.ci_products p
      join public.ci_product_identifiers i on i.product_id=p.id
      where p.import_batch_id=p_batch_id and i.kind='REF_CURRENT' and i.value=v_resolution.source_product_ref;
    if v_material is null then raise exception 'CI_IMPORT_PLATFORM_PRODUCT_NOT_FOUND'; end if;
    v_source_text:=case when jsonb_typeof(v_resolution.raw_source_value)='string'
      then v_resolution.raw_source_value #>> '{}' else null end;
    for v_platform_key in select unnest(v_resolution.platform_keys) loop
      select id into v_platform from public.ci_platforms where warehouse_id=v_wh and platform_key=v_platform_key;
      if v_platform is null then raise exception 'CI_IMPORT_PLATFORM_NOT_FOUND'; end if;
      insert into public.ci_product_platforms(
        product_id,platform_id,warehouse_id,source_text,source_sheet,source_row,source_kind,source_review_id
      ) values(v_material,v_platform,v_wh,v_source_text,v_resolution.source_sheet,v_resolution.source_row,'owner-approved',v_resolution.review_id);
    end loop;
  end loop;

  select count(*) into v_active_relations from public.ci_product_relations r
    join public.ci_products p on p.id=r.source_product_id where p.import_batch_id=p_batch_id;
  select count(*) into v_active_platforms from public.ci_product_platforms pp
    join public.ci_products p on p.id=pp.product_id where p.import_batch_id=p_batch_id;
  if v_active_relations<>100 or v_active_platforms<>28 then raise exception 'CI_IMPORT_ACTIVE_RELATION_TOTAL_MISMATCH'; end if;

  update public.ci_import_batches set status='applied',applied_by=auth.uid(),applied_at=now() where id=p_batch_id;
  perform ci_private.audit(1::smallint,'APPLY','ci_import_batches',p_batch_id::text);
  perform ci_private.audit(2::smallint,'APPLY','ci_import_batches',p_batch_id::text);
  return jsonb_build_object('batch_id',p_batch_id,'products',162,
    'source_product_relations',90,'owner_approved_product_relations',10,'active_product_relations',v_active_relations,
    'source_platform_rows',27,'owner_platform_override_products',1,'active_product_platform_mappings',v_active_platforms,
    'review_items',(select count(*) from public.ci_import_review_items where batch_id=p_batch_id),
    'critical_unresolved_reviews',(select count(*) from public.ci_import_review_items where batch_id=p_batch_id and critical and status='open'));
end $$;

create or replace function public.ci_save_product_relation(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_wh smallint;v_source uuid;v_id uuid;
begin
  v_source := (p_data->>'source_product_id')::uuid;
  select warehouse_id into v_wh from public.ci_products where id=v_source;
  perform ci_private.require_role(v_wh,array['admin','supervisor']);
  if p_data ? 'id' then
    v_id := (p_data->>'id')::uuid;
    update public.ci_product_relations set target_product_id=(p_data->>'target_product_id')::uuid,
      relation_type=p_data->>'relation_type',note=p_data->>'note',source_kind='manual',source_review_id=null
      where id=v_id and source_product_id=v_source;
    if not found then raise exception 'CI_RELATION_NOT_FOUND'; end if;
  else
    insert into public.ci_product_relations(warehouse_id,source_product_id,target_product_id,relation_type,note,source_text)
      values(v_wh,v_source,(p_data->>'target_product_id')::uuid,p_data->>'relation_type',p_data->>'note',p_data->>'source_text') returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function public.ci_save_product_platform(p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_wh smallint;v_id uuid;v_product uuid;
begin
  v_product := (p_data->>'product_id')::uuid;
  select warehouse_id into v_wh from public.ci_products where id=v_product;
  perform ci_private.require_role(v_wh,array['admin','supervisor']);
  if p_data ? 'id' then
    v_id := (p_data->>'id')::uuid;
    update public.ci_product_platforms set platform_id=(p_data->>'platform_id')::uuid,source_text=p_data->>'source_text',
      source_kind='manual',source_review_id=null
    where id=v_id and product_id=v_product;
    if not found then raise exception 'CI_PLATFORM_MAP_NOT_FOUND'; end if;
  else
    insert into public.ci_product_platforms(product_id,platform_id,warehouse_id,source_text)
      values(v_product,(p_data->>'platform_id')::uuid,v_wh,p_data->>'source_text') returning id into v_id;
  end if;
  return v_id;
end $$;

revoke all on function public.ci_stage_import_batch(jsonb),public.ci_apply_import_batch(uuid) from public,anon,authenticated;
grant execute on function public.ci_stage_import_batch(jsonb),public.ci_apply_import_batch(uuid) to authenticated;
create trigger ci_import_review_resolutions_immutable
before update or delete on public.ci_import_review_resolutions
for each row execute function ci_private.reject_import_resolution_mutation();

alter table public.ci_import_review_resolutions enable row level security;
revoke all on public.ci_import_review_resolutions from public,anon,authenticated;
grant select on public.ci_import_review_resolutions to authenticated;
create policy ci_import_review_resolutions_read
  on public.ci_import_review_resolutions for select to authenticated
  using (ci_private.can_read(warehouse_id));
revoke all on function ci_private.reject_import_resolution_mutation() from public,anon,authenticated;

create or replace function public.ci_stage_import_batch(p_payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid;
  v_batch uuid;
  v_wh smallint;
  v_product jsonb;
  v_review jsonb;
  v_entry jsonb;
  v_decision jsonb;
  v_review_item_id uuid;
  v_source_value jsonb;
  v_review_status text;
  v_total integer; v_che integer; v_imm integer;
  v_src_reagent integer; v_src_calibrator integer; v_src_control integer; v_src_consumable integer;
  v_active_reagent integer; v_active_calibrator integer; v_active_control integer; v_active_consumable integer;
  v_legacy integer; v_refs integer; v_barcodes integer;
  v_product_edges integer; v_platform_rows integer; v_used_reviews integer;
  v_reviews integer; v_resolutions integer;
  v_source_confirmed integer; v_candidate integer; v_manual integer; v_unassigned integer;
  v_data_correction integer; v_type_override integer; v_platform_override integer;
begin
  v_actor:=ci_private.require_import_admin();
  if p_payload->>'source_filename'<>'NEW Summary_72 items + FOC_Chonburi_revised 2026_20092026.xlsx'
     or upper(p_payload->>'source_sha256')<>'5DC4FEA985E8A262177E96F317BB56D1A0E0F5DDFE660EB2E75005DE355B788C'
     or p_payload->'resolution_manifest'->>'source_sha256'<>'5DC4FEA985E8A262177E96F317BB56D1A0E0F5DDFE660EB2E75005DE355B788C' then
    raise exception 'CI_IMPORT_SOURCE_MISMATCH';
  end if;
  -- Pin the complete parser and resolution output, not only the workbook hash.
  if md5(p_payload::text)<>'1ae84724264bc1e621aac722083732f2' then
    raise exception 'CI_IMPORT_PAYLOAD_FINGERPRINT_MISMATCH';
  end if;
  if jsonb_typeof(p_payload->'products')<>'array'
    or jsonb_typeof(p_payload->'product_relations')<>'array'
    or jsonb_typeof(p_payload->'platform_relations')<>'array'
    or jsonb_typeof(p_payload->'review_items')<>'array'
    or jsonb_typeof(p_payload->'resolution_manifest'->'entries')<>'array'
    or (p_payload->'resolution_manifest'->>'format_version')::integer<>1 then
    raise exception 'CI_IMPORT_PAYLOAD_INVALID';
  end if;

  select count(*),count(*) filter(where x.value->>'warehouse_code'='CHE'),count(*) filter(where x.value->>'warehouse_code'='IMM'),
    count(*) filter(where x.value->>'source_product_type'='reagent'),count(*) filter(where x.value->>'source_product_type'='calibrator'),
    count(*) filter(where x.value->>'source_product_type'='control'),count(*) filter(where x.value->>'source_product_type'='consumable'),
    count(*) filter(where x.value->>'product_type'='reagent'),count(*) filter(where x.value->>'product_type'='calibrator'),
    count(*) filter(where x.value->>'product_type'='control'),count(*) filter(where x.value->>'product_type'='consumable'),
    count(*) filter(where nullif(x.value->>'legacy_ref','') is not null),
    count(distinct x.value->>'ref_current'),count(distinct x.value->>'manufacturer_barcode')
    into v_total,v_che,v_imm,v_src_reagent,v_src_calibrator,v_src_control,v_src_consumable,
      v_active_reagent,v_active_calibrator,v_active_control,v_active_consumable,v_legacy,v_refs,v_barcodes
    from jsonb_array_elements(p_payload->'products') x;
  select jsonb_array_length(p_payload->'product_relations'),jsonb_array_length(p_payload->'platform_relations'),
    (select count(*) from jsonb_array_elements(p_payload->'review_items') x where x.value->>'kind'='used_with'),
    jsonb_array_length(p_payload->'review_items'),jsonb_array_length(p_payload->'resolution_manifest'->'entries')
    into v_product_edges,v_platform_rows,v_used_reviews,v_reviews,v_resolutions;
  if (v_total,v_che,v_imm,v_src_reagent,v_src_calibrator,v_src_control,v_src_consumable,
      v_active_reagent,v_active_calibrator,v_active_control,v_active_consumable,v_legacy,v_refs,v_barcodes,
      v_product_edges,v_platform_rows,v_used_reviews,v_reviews,v_resolutions)
    is distinct from (162,90,72,72,32,23,35,72,34,23,33,29,162,162,90,27,12,20,20) then
    raise exception 'CI_IMPORT_BASELINE_MISMATCH';
  end if;
  if exists(select 1 from jsonb_array_elements(p_payload->'products') x
    where nullif(btrim(x.value->>'source_name'),'') is null
       or nullif(btrim(x.value->>'ref_current'),'') is null
       or nullif(btrim(x.value->>'manufacturer_barcode'),'') is null
       or x.value->>'product_type' not in ('reagent','calibrator','control','consumable')
       or x.value->>'source_product_type' not in ('reagent','calibrator','control','consumable')
       or x.value->>'warehouse_code' not in ('CHE','IMM')
       or (x.value->>'source_row')::integer<=0)
    then raise exception 'CI_IMPORT_PRODUCT_FIELD_INVALID'; end if;

  select count(*) filter(where x.value->>'resolution_type'='source-confirmed'),
    count(*) filter(where x.value->>'resolution_type'='owner-confirmed-candidate'),
    count(*) filter(where x.value->>'resolution_type'='owner-manual-relationship'),
    count(*) filter(where x.value->>'resolution_type'='owner-unassigned'),
    count(*) filter(where x.value->>'resolution_type'='owner-data-correction'),
    count(*) filter(where x.value->>'resolution_type'='owner-type-override'),
    count(*) filter(where x.value->>'resolution_type'='owner-platform-override')
    into v_source_confirmed,v_candidate,v_manual,v_unassigned,v_data_correction,v_type_override,v_platform_override
    from jsonb_array_elements(p_payload->'resolution_manifest'->'entries') x;
  if (v_source_confirmed,v_candidate,v_manual,v_unassigned,v_data_correction,v_type_override,v_platform_override)
    is distinct from (1,9,1,2,4,2,1) then
    raise exception 'CI_IMPORT_RESOLUTION_MANIFEST_MISMATCH';
  end if;

  insert into public.ci_import_batches(source_filename,source_sha256,payload,staged_by)
    values(p_payload->>'source_filename',upper(p_payload->>'source_sha256'),p_payload,v_actor) returning id into v_batch;
  for v_product in select value from jsonb_array_elements(p_payload->'products') loop
    select id into v_wh from public.ci_warehouses where code=v_product->>'warehouse_code';
    if v_wh is null then raise exception 'CI_IMPORT_PRODUCT_WAREHOUSE_REQUIRED'; end if;
    insert into public.ci_import_rows(batch_id,warehouse_id,source_sheet,source_row,raw_source,normalized)
      values(v_batch,v_wh,v_product->>'source_sheet',(v_product->>'source_row')::integer,
        coalesce(v_product->'raw_source','{}'::jsonb),v_product);
  end loop;

  for v_review in select value from jsonb_array_elements(p_payload->'review_items') loop
    select id into v_wh from public.ci_warehouses where code=v_review->>'warehouse_code';
    if v_wh is null then raise exception 'CI_IMPORT_REVIEW_WAREHOUSE_REQUIRED'; end if;
    select value into v_entry from jsonb_array_elements(p_payload->'resolution_manifest'->'entries')
      where value->>'review_id'=v_review->>'review_id';
    if v_entry is null or v_entry->>'source_sheet' is distinct from v_review->>'source_sheet'
      or (v_entry->>'source_row')::integer is distinct from (v_review->>'source_row')::integer
      or v_entry->>'source_product_ref' is distinct from v_review->>'source_product_ref'
      or v_entry->'raw_source_value' is distinct from v_review->'raw_source_value' then
      raise exception 'CI_IMPORT_REVIEW_MANIFEST_MISMATCH';
    end if;
    select coalesce(normalized->'raw_source'->(v_entry->>'source_field'),'null'::jsonb)
      into v_source_value from public.ci_import_rows
      where batch_id=v_batch and source_sheet=v_review->>'source_sheet' and source_row=(v_review->>'source_row')::integer;
    if v_source_value is distinct from v_entry->'raw_source_value' then
      raise exception 'CI_IMPORT_RAW_SOURCE_MISMATCH';
    end if;
    v_decision:=v_entry->'approved_decision';
    if v_decision->>'kind' in ('product_relationship','product_platform_override') then
      v_review_status:='approved_mapping';
    elsif v_decision->>'kind'='unassigned' then
      v_review_status:='accepted_unlinked';
    else
      v_review_status:='accepted_source';
    end if;
    insert into public.ci_import_review_items(
      batch_id,warehouse_id,source_sheet,source_row,kind,source_text,details,critical,status,
      resolution_note,resolution_data,resolved_by,resolved_at,review_id,source_product_ref,raw_source_value,resolution_type
    ) values (
      v_batch,v_wh,v_review->>'source_sheet',(v_review->>'source_row')::integer,v_review->>'kind',
      coalesce(v_review->>'source_text',''),coalesce(v_review->>'details','Review evidence retained'),
      coalesce((v_review->>'critical')::boolean,true),v_review_status,v_entry->>'resolution_note',
      jsonb_build_object('review_id',v_entry->>'review_id','approved_decision',v_decision,
        'target_refs',v_entry->'target_refs','platform_keys',v_entry->'platform_keys',
        'approval_source',v_entry->>'approval_source'),v_actor,now(),v_entry->>'review_id',
      v_entry->>'source_product_ref',coalesce(v_entry->'raw_source_value','null'::jsonb),v_entry->>'resolution_type'
    ) returning id into v_review_item_id;
    insert into public.ci_import_review_resolutions(
      batch_id,review_item_id,warehouse_id,review_id,source_sha256,source_sheet,source_row,
      source_product_ref,source_field,raw_source_value,approved_decision,target_refs,platform_keys,
      resolution_type,approval_source,resolution_note,recorded_by
    ) values (
      v_batch,v_review_item_id,v_wh,v_entry->>'review_id',upper(v_entry->>'source_sha256'),v_entry->>'source_sheet',
      (v_entry->>'source_row')::integer,v_entry->>'source_product_ref',v_entry->>'source_field',
      coalesce(v_entry->'raw_source_value','null'::jsonb),v_decision,
      array(select jsonb_array_elements_text(v_entry->'target_refs')),
      array(select jsonb_array_elements_text(v_entry->'platform_keys')),
      v_entry->>'resolution_type',v_entry->>'approval_source',v_entry->>'resolution_note',v_actor
    );
    insert into public.ci_audit_logs(actor_id,warehouse_id,action,entity_table,entity_id,old_value,new_value,reason)
      values(v_actor,v_wh,'OWNER_APPROVED_RESOLUTION','ci_import_review_resolutions',v_entry->>'review_id',
        jsonb_build_object('raw_source_value',v_entry->'raw_source_value','source_field',v_entry->>'source_field'),
        v_decision,v_entry->>'approval_source');
  end loop;
  if (select count(*) from public.ci_import_review_items where batch_id=v_batch)<>v_reviews
    or (select count(*) from public.ci_import_review_resolutions where batch_id=v_batch)<>v_resolutions
    or exists(select 1 from public.ci_import_review_items where batch_id=v_batch and critical and status='open') then
    raise exception 'CI_IMPORT_RESOLUTION_APPLY_INCOMPLETE';
  end if;
  perform ci_private.audit(1::smallint,'STAGE','ci_import_batches',v_batch::text);
  perform ci_private.audit(2::smallint,'STAGE','ci_import_batches',v_batch::text);
  return v_batch;
end $$;
