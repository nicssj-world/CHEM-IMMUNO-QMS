'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { previewApprovedWorkbook, WorkbookValidationError } from '@/lib/import/approved-workbook';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function requireImportAdmin() {
  const access = await requireAccess();
  if (!['CHE', 'IMM'].every((code) => access.warehouses.some((w) => w.code === code && w.role === 'admin'))) {
    redirect('/import?error=permission');
  }
  const client = await createClient();
  if (!client) redirect('/import?error=configuration');
  return client;
}

/** Staging stores evidence only. No Product Master record is activated here. */
export async function stageApprovedWorkbook(formData: FormData): Promise<void> {
  const client = await requireImportAdmin();
  const file = formData.get('workbook');
  if (!(file instanceof File) || file.size < 1 || file.size > 1_000_000) {
    redirect('/import?error=file');
  }
  let preview;
  try {
    preview = await previewApprovedWorkbook(Buffer.from(await file.arrayBuffer()), file.name);
  } catch (error) {
    if (error instanceof WorkbookValidationError) redirect('/import?error=source');
    throw error;
  }
  const { data, error } = await client.rpc('ci_stage_import_batch', { p_payload: preview.payload });
  if (error || typeof data !== 'string' || !uuidPattern.test(data)) redirect('/import?error=stage');
  revalidatePath('/import');
  redirect(`/import?batch=${data}&staged=1`);
}

export async function applyApprovedImport(formData: FormData): Promise<void> {
  const client = await requireImportAdmin();
  const batchId = String(formData.get('batchId') ?? '');
  if (!uuidPattern.test(batchId)) redirect('/import?error=batch');
  // The RPC checks hash, source totals, resolutions, authorization and product
  // uniqueness again in a single transaction. The UI cannot waive those gates.
  const { error } = await client.rpc('ci_apply_import_batch', { p_batch_id: batchId });
  if (error) redirect(`/import?batch=${batchId}&error=apply`);
  revalidatePath('/import');
  revalidatePath('/products');
  redirect(`/import?batch=${batchId}&applied=1`);
}

export async function resolveImportReview(formData: FormData): Promise<void> {
  const client = await requireImportAdmin();
  const itemId = String(formData.get('itemId') ?? '');
  const mode = String(formData.get('mode') ?? '');
  const note = String(formData.get('note') ?? '').trim();
  if (!uuidPattern.test(itemId) || note.length < 3 || note.length > 2000) redirect('/import?error=review-input');
  const { data: item, error: itemError } = await client.from('ci_import_review_items')
    .select('id,batch_id,kind,status,source_sheet,source_row').eq('id', itemId).single();
  if (itemError || !item || item.status !== 'open') redirect('/import?error=review-state');
  const batchId = String(item.batch_id);
  const { data: batch, error: batchError } = await client.from('ci_import_batches')
    .select('status,payload').eq('id', batchId).single();
  if (batchError || !batch || batch.status !== 'staged') redirect(`/import?batch=${batchId}&error=review-state`);
  const payload = batch.payload as { products?: Array<{
    source_sheet: string; source_row: number; warehouse_code: string;
    product_type: string; ref_current: string;
  }> };
  const source = payload.products?.find((product) =>
    product.source_sheet === item.source_sheet && product.source_row === item.source_row);
  if (!source) redirect(`/import?batch=${batchId}&error=review-state`);

  let resolution: 'approved_mapping' | 'accepted_unlinked' | 'accepted_source';
  let resolutionData: Record<string, unknown> = {};
  if (item.kind === 'used_with' && mode === 'unlinked') {
    resolution = 'accepted_unlinked';
  } else if (item.kind === 'used_with' && mode === 'product') {
    if (!['calibrator', 'control', 'consumable'].includes(source.product_type)) {
      redirect(`/import?batch=${batchId}&error=review-input`);
    }
    const refs = String(formData.get('targetRefs') ?? '').split(',').map((ref) => ref.trim()).filter(Boolean);
    if (!refs.length || refs.length > 50 || new Set(refs).size !== refs.length ||
      refs.some((ref) => !payload.products?.some((product) =>
        product.ref_current === ref && product.product_type === 'reagent' &&
        product.warehouse_code === source.warehouse_code))) {
      redirect(`/import?batch=${batchId}&error=review-input`);
    }
    resolution = 'approved_mapping';
    resolutionData = { target_ref_currents: refs, relation_type: `uses_${source.product_type}` };
  } else if (item.kind === 'used_with' && mode === 'platform') {
    const platformKey = String(formData.get('platformKey') ?? '');
    if (!['c503_c703_ise', 'ise_neo', 'c703', 'e801'].includes(platformKey) ||
      (source.warehouse_code === 'CHE' && platformKey === 'e801') ||
      (source.warehouse_code === 'IMM' && platformKey !== 'e801')) {
      redirect(`/import?batch=${batchId}&error=review-input`);
    }
    resolution = 'approved_mapping';
    resolutionData = { platform_key: platformKey };
  } else if (item.kind !== 'used_with' && mode === 'source') {
    resolution = 'accepted_source';
  } else {
    redirect(`/import?batch=${batchId}&error=review-input`);
  }
  const { error } = await client.rpc('ci_resolve_import_review', {
    p_item_id: itemId, p_resolution: resolution, p_note: note, p_resolution_data: resolutionData,
  });
  if (error) redirect(`/import?batch=${batchId}&error=review`);
  revalidatePath('/import');
  redirect(`/import?batch=${batchId}&reviewed=1`);
}
