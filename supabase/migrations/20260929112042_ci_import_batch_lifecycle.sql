-- Keep one active, unapplied workspace per import flow and allow its owner Admins
-- to discard only staging evidence before any Product Master changes are made.

create unique index ci_import_batches_one_staged_idx
  on public.ci_import_batches (status)
  where status = 'staged';

create unique index ci_incremental_import_batches_one_preview_idx
  on public.ci_incremental_product_import_batches (status)
  where status = 'preview';

-- Owner-approved resolution rows are immutable evidence after Apply. The only
-- exception is a checked cancellation RPC deleting evidence for its locked,
-- still-staged parent batch.
create or replace function ci_private.reject_import_resolution_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE'
     and pg_catalog.current_setting('ci.import_cancel_batch_id', true) = old.batch_id::text
     and exists (
       select 1 from public.ci_import_batches b
       where b.id = old.batch_id and b.status = 'staged' and b.applied_at is null
     ) then
    return old;
  end if;
  raise exception 'CI_IMPORT_RESOLUTION_IMMUTABLE';
end $$;

create function ci_private.ci_cancel_import_batch(p_batch_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_batch public.ci_import_batches%rowtype;
begin
  perform ci_private.require_import_admin();
  select * into v_batch
  from public.ci_import_batches
  where id = p_batch_id
  for update;
  if not found or v_batch.status <> 'staged' or v_batch.applied_at is not null then
    raise exception 'CI_IMPORT_NOT_CANCELLABLE';
  end if;

  perform ci_private.audit(1::smallint, 'CANCEL', 'ci_import_batches', p_batch_id::text);
  perform ci_private.audit(2::smallint, 'CANCEL', 'ci_import_batches', p_batch_id::text);

  perform pg_catalog.set_config('ci.import_cancel_batch_id', p_batch_id::text, true);
  delete from public.ci_import_review_resolutions where batch_id = p_batch_id;
  perform pg_catalog.set_config('ci.import_cancel_batch_id', '', true);
  delete from public.ci_import_batches where id = p_batch_id;
end $$;
revoke all on function ci_private.ci_cancel_import_batch(uuid) from public, anon, authenticated;
select ci_private.publish_rpc('ci_private.ci_cancel_import_batch(uuid)'::pg_catalog.regprocedure);

create function ci_private.ci_cancel_incremental_product_import(p_batch_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_batch public.ci_incremental_product_import_batches%rowtype;
begin
  perform ci_private.require_import_admin();
  select * into v_batch
  from public.ci_incremental_product_import_batches
  where id = p_batch_id
  for update;
  if not found or v_batch.status <> 'preview' or v_batch.applied_at is not null then
    raise exception 'CI_INCREMENTAL_IMPORT_NOT_CANCELLABLE';
  end if;
  if exists (
    select 1 from public.ci_incremental_product_import_audit a
    where a.import_batch_id = p_batch_id
  ) then
    raise exception 'CI_INCREMENTAL_IMPORT_AUDIT_PRESENT';
  end if;

  perform ci_private.audit(1::smallint, 'CANCEL', 'ci_incremental_product_import_batches', p_batch_id::text);
  perform ci_private.audit(2::smallint, 'CANCEL', 'ci_incremental_product_import_batches', p_batch_id::text);
  delete from public.ci_incremental_product_import_rows where batch_id = p_batch_id;
  delete from public.ci_incremental_product_import_batches where id = p_batch_id;
end $$;
revoke all on function ci_private.ci_cancel_incremental_product_import(uuid) from public, anon, authenticated;
select ci_private.publish_rpc('ci_private.ci_cancel_incremental_product_import(uuid)'::pg_catalog.regprocedure);
