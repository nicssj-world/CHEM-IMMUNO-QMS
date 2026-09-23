-- Approved source workbook import: staging, explicit review, and atomic activation.
create function ci_private.require_import_admin() returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;
begin
  v_actor:=ci_private.require_role(1::smallint,array['admin']);
  perform ci_private.require_role(2::smallint,array['admin']);
  return v_actor;
end $$;

create function public.ci_stage_import_batch(p_payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;v_batch uuid;v_product jsonb;v_review jsonb;v_wh smallint;
  v_total integer;v_che integer;v_imm integer;v_reagent integer;v_cal integer;v_control integer;v_consumable integer;
  v_legacy integer;v_refs integer;v_barcodes integer;v_product_edges integer;v_platform_edges integer;v_used_reviews integer;
begin
  v_actor:=ci_private.require_import_admin();
  if p_payload->>'source_filename'<>'NEW Summary_72 items + FOC_Chonburi_revised 2026_20092026.xlsx'
     or upper(p_payload->>'source_sha256')<>'5DC4FEA985E8A262177E96F317BB56D1A0E0F5DDFE660EB2E75005DE355B788C' then
    raise exception 'CI_IMPORT_SOURCE_MISMATCH'; end if;
  -- Exact reviewed parser output for this one-time initial source. Prevents a
  -- caller from claiming the workbook checksum while changing rows or omitting holds.
  if md5(p_payload::text)<>'bfa324897a22a374013ee6323eed0bf7' then
    raise exception 'CI_IMPORT_PAYLOAD_FINGERPRINT_MISMATCH'; end if;
  if jsonb_typeof(p_payload->'products')<>'array' or jsonb_typeof(p_payload->'product_relations')<>'array'
    or jsonb_typeof(p_payload->'platform_relations')<>'array' or jsonb_typeof(p_payload->'review_items')<>'array' then
    raise exception 'CI_IMPORT_PAYLOAD_INVALID'; end if;
  select count(*),count(*) filter(where x.value->>'warehouse_code'='CHE'),count(*) filter(where x.value->>'warehouse_code'='IMM'),
    count(*) filter(where x.value->>'product_type'='reagent'),count(*) filter(where x.value->>'product_type'='calibrator'),
    count(*) filter(where x.value->>'product_type'='control'),count(*) filter(where x.value->>'product_type'='consumable'),
    count(*) filter(where nullif(x.value->>'legacy_ref','') is not null),
    count(distinct x.value->>'ref_current'),count(distinct x.value->>'manufacturer_barcode')
    into v_total,v_che,v_imm,v_reagent,v_cal,v_control,v_consumable,v_legacy,v_refs,v_barcodes
    from jsonb_array_elements(p_payload->'products') x;
  select jsonb_array_length(p_payload->'product_relations'),jsonb_array_length(p_payload->'platform_relations'),
    (select count(*) from jsonb_array_elements(p_payload->'review_items') x where x.value->>'kind'='used_with')
    into v_product_edges,v_platform_edges,v_used_reviews;
  if (v_total,v_che,v_imm,v_reagent,v_cal,v_control,v_consumable,v_legacy,v_refs,v_barcodes,v_product_edges,v_platform_edges,v_used_reviews)
    is distinct from (162,90,72,72,32,23,35,29,162,162,90,27,12) then
    raise exception 'CI_IMPORT_BASELINE_MISMATCH'; end if;
  if exists(select 1 from jsonb_array_elements(p_payload->'products') x
    where nullif(btrim(x.value->>'source_name'),'') is null or nullif(btrim(x.value->>'ref_current'),'') is null
       or nullif(btrim(x.value->>'manufacturer_barcode'),'') is null or x.value->>'product_type' not in ('reagent','calibrator','control','consumable')
       or x.value->>'warehouse_code' not in ('CHE','IMM') or (x.value->>'source_row')::integer<=0)
  then raise exception 'CI_IMPORT_PRODUCT_FIELD_INVALID'; end if;
  insert into public.ci_import_batches(source_filename,source_sha256,payload,staged_by)
    values(p_payload->>'source_filename',upper(p_payload->>'source_sha256'),p_payload,v_actor) returning id into v_batch;
  for v_product in select value from jsonb_array_elements(p_payload->'products') loop
    select id into v_wh from public.ci_warehouses where code=v_product->>'warehouse_code';
    insert into public.ci_import_rows(batch_id,warehouse_id,source_sheet,source_row,raw_source,normalized)
      values(v_batch,v_wh,v_product->>'source_sheet',(v_product->>'source_row')::integer,
        coalesce(v_product->'raw_source','{}'::jsonb),v_product);
  end loop;
  for v_review in select value from jsonb_array_elements(p_payload->'review_items') loop
    select id into v_wh from public.ci_warehouses where code=v_review->>'warehouse_code';
    if v_wh is null then raise exception 'CI_IMPORT_REVIEW_WAREHOUSE_REQUIRED'; end if;
    insert into public.ci_import_review_items(batch_id,warehouse_id,source_sheet,source_row,kind,source_text,details,critical)
      values(v_batch,v_wh,v_review->>'source_sheet',(v_review->>'source_row')::integer,
       v_review->>'kind',v_review->>'source_text',coalesce(v_review->>'details','Review required'),
       coalesce((v_review->>'critical')::boolean,true));
  end loop;
  perform ci_private.audit(1::smallint,'STAGE','ci_import_batches',v_batch::text);
  perform ci_private.audit(2::smallint,'STAGE','ci_import_batches',v_batch::text);
  return v_batch;
end $$;

create function public.ci_resolve_import_review(p_item_id uuid,p_resolution text,p_note text,p_resolution_data jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_item public.ci_import_review_items%rowtype;v_batch public.ci_import_batches%rowtype;
  v_products jsonb;v_target text;v_targets jsonb;v_platform text;
begin
  perform ci_private.require_import_admin();
  select * into v_item from public.ci_import_review_items where id=p_item_id for update;
  if not found then raise exception 'CI_REVIEW_NOT_FOUND'; end if;
  select * into v_batch from public.ci_import_batches where id=v_item.batch_id;
  if v_batch.status<>'staged' then raise exception 'CI_IMPORT_NOT_STAGED'; end if;
  if p_resolution not in ('approved_mapping','accepted_unlinked','accepted_source') or nullif(btrim(p_note),'') is null then
    raise exception 'CI_REVIEW_RESOLUTION_INVALID'; end if;
  if v_item.kind='used_with' and p_resolution='accepted_source' then raise exception 'CI_USED_WITH_NEEDS_MAPPING_OR_UNLINKED_DECISION'; end if;
  if v_item.kind<>'used_with' and p_resolution in ('approved_mapping','accepted_unlinked') then raise exception 'CI_ANOMALY_ACCEPT_SOURCE'; end if;
  if p_resolution='approved_mapping' then
    v_targets:=p_resolution_data->'target_ref_currents';
    v_platform:=p_resolution_data->>'platform_key';
    if v_targets is not null then
      if jsonb_typeof(v_targets)<>'array' or jsonb_array_length(v_targets)=0 then raise exception 'CI_MAPPING_TARGETS_REQUIRED'; end if;
      if (select count(distinct value) from jsonb_array_elements_text(v_targets))<>jsonb_array_length(v_targets) then
        raise exception 'CI_MAPPING_TARGET_DUPLICATE'; end if;
      for v_target in select value from jsonb_array_elements_text(v_targets) loop
        if not exists(select 1 from public.ci_import_rows where batch_id=v_item.batch_id and normalized->>'ref_current'=v_target
          and warehouse_id=v_item.warehouse_id and normalized->>'product_type'='reagent') then
          raise exception 'CI_MAPPING_TARGET_NOT_EXACT_REAGENT'; end if;
      end loop;
    elsif v_platform is not null then
      if not exists(select 1 from public.ci_platforms where warehouse_id=v_item.warehouse_id and platform_key=v_platform)
        then raise exception 'CI_MAPPING_PLATFORM_INVALID'; end if;
    else raise exception 'CI_MAPPING_TARGETS_REQUIRED'; end if;
    if v_targets is not null and v_platform is not null then raise exception 'CI_MAPPING_AMBIGUOUS'; end if;
  end if;
  update public.ci_import_review_items set status=p_resolution,resolution_note=p_note,
    resolution_data=p_resolution_data,resolved_by=auth.uid(),resolved_at=now() where id=p_item_id;
  perform ci_private.audit(v_item.warehouse_id,'RESOLVE','ci_import_review_items',p_item_id::text,p_note);
end $$;

create function public.ci_apply_import_batch(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_batch public.ci_import_batches%rowtype;v_product jsonb;v_edge jsonb;v_review record;
  v_wh smallint;v_id uuid;v_source uuid;v_target uuid;v_platform uuid;v_material uuid;
  v_target_ref text;v_type text;v_existing integer;
begin
  perform ci_private.require_import_admin();
  select * into v_batch from public.ci_import_batches where id=p_batch_id for update;
  if not found or v_batch.status<>'staged' then raise exception 'CI_IMPORT_NOT_STAGED'; end if;
  if exists(select 1 from public.ci_import_batches where status='applied' and source_sha256=v_batch.source_sha256)
    then raise exception 'CI_IMPORT_ALREADY_APPLIED'; end if;
  if exists(select 1 from public.ci_import_review_items where batch_id=p_batch_id and critical and status='open')
    then raise exception 'CI_IMPORT_CRITICAL_REVIEW_OPEN'; end if;
  if (select count(*) from public.ci_import_rows where batch_id=p_batch_id)<>162
    or (select count(*) from public.ci_import_review_items where batch_id=p_batch_id and kind='used_with')<>12 then
    raise exception 'CI_IMPORT_STAGING_CORRUPT'; end if;
  -- Payload order is intentional: CHE reagents, CHE FOC, IMM reagents, IMM FOC.
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
    select p.id into v_target from public.ci_products p
      join public.ci_product_identifiers i on i.product_id=p.id
      where p.import_batch_id=p_batch_id and i.kind='REF_CURRENT' and i.value=v_edge->>'target_ref_current';
    if v_source is null or v_target is null then raise exception 'CI_IMPORT_RELATION_REF_NOT_FOUND'; end if;
    insert into public.ci_product_relations(warehouse_id,source_product_id,target_product_id,relation_type,source_text)
    values(v_wh,v_source,v_target,v_edge->>'relation_type',v_edge->>'source_text');
  end loop;
  for v_edge in select value from jsonb_array_elements(v_batch.payload->'platform_relations') loop
    select p.id,p.warehouse_id into v_material,v_wh from public.ci_products p
      join public.ci_product_identifiers i on i.product_id=p.id
      where p.import_batch_id=p_batch_id and i.kind='REF_CURRENT' and i.value=v_edge->>'product_ref_current';
    select id into v_platform from public.ci_platforms where warehouse_id=v_wh and platform_key=v_edge->>'platform_key';
    if v_material is null or v_platform is null then raise exception 'CI_IMPORT_PLATFORM_NOT_FOUND'; end if;
    insert into public.ci_product_platforms(product_id,platform_id,warehouse_id,source_text,source_sheet,source_row)
    values(v_material,v_platform,v_wh,v_edge->>'source_text',v_edge->>'source_sheet',(v_edge->>'source_row')::integer);
  end loop;
  for v_review in select r.*,ir.normalized as source_product from public.ci_import_review_items r
      join public.ci_import_rows ir on ir.batch_id=r.batch_id and ir.source_sheet=r.source_sheet and ir.source_row=r.source_row
      where r.batch_id=p_batch_id and r.kind='used_with' and r.status='approved_mapping' loop
    select p.id,p.product_type into v_material,v_type from public.ci_products p
      join public.ci_product_identifiers i on i.product_id=p.id
      where p.import_batch_id=p_batch_id and i.kind='REF_CURRENT' and i.value=(v_review.source_product)->>'ref_current';
    if v_material is null then raise exception 'CI_IMPORT_REVIEW_SOURCE_NOT_FOUND'; end if;
    if v_review.resolution_data ? 'target_ref_currents' then
      if v_type not in ('calibrator','control','consumable') then raise exception 'CI_IMPORT_REVIEW_TYPE_UNSUPPORTED'; end if;
      for v_target_ref in select value from jsonb_array_elements_text(v_review.resolution_data->'target_ref_currents') loop
        select p.id into v_source from public.ci_products p
          join public.ci_product_identifiers i on i.product_id=p.id
          where p.import_batch_id=p_batch_id and i.kind='REF_CURRENT' and i.value=v_target_ref;
        insert into public.ci_product_relations(warehouse_id,source_product_id,target_product_id,relation_type,source_text,note)
          values(v_review.warehouse_id,v_source,v_material,'uses_'||v_type,v_review.source_text,v_review.resolution_note);
      end loop;
    else
      select id into v_platform from public.ci_platforms
        where warehouse_id=v_review.warehouse_id and platform_key=v_review.resolution_data->>'platform_key';
      insert into public.ci_product_platforms(product_id,platform_id,warehouse_id,source_text,source_sheet,source_row)
        values(v_material,v_platform,v_review.warehouse_id,v_review.source_text,v_review.source_sheet,v_review.source_row);
    end if;
  end loop;
  update public.ci_import_batches set status='applied',applied_by=auth.uid(),applied_at=now() where id=p_batch_id;
  perform ci_private.audit(1::smallint,'APPLY','ci_import_batches',p_batch_id::text);
  perform ci_private.audit(2::smallint,'APPLY','ci_import_batches',p_batch_id::text);
  return jsonb_build_object('batch_id',p_batch_id,'products',162,'initial_product_relations',90,
    'initial_platform_relations',27,'review_items',(select count(*) from public.ci_import_review_items where batch_id=p_batch_id));
end $$;

revoke all on function public.ci_stage_import_batch(jsonb),
  public.ci_resolve_import_review(uuid,text,text,jsonb),public.ci_apply_import_batch(uuid) from public,anon,authenticated;
grant execute on function public.ci_stage_import_batch(jsonb),
  public.ci_resolve_import_review(uuid,text,text,jsonb),public.ci_apply_import_batch(uuid) to authenticated;
-- Import-only helpers also remain private, while RLS policy helpers retain execute.
revoke all on all functions in schema ci_private from public,anon,authenticated;
grant execute on function ci_private.can_read(smallint),ci_private.can_admin_any(),ci_private.has_role(smallint,text[]) to authenticated;
