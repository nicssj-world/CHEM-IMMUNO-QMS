'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { classifyIncrementalImport, IncrementalWorkbookError, parseIncrementalWorkbook, type IncrementalMaster } from '@/lib/import/incremental';
import { createClient } from '@/lib/supabase/server';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const basePath = '/import/incremental';
const masterPageSize = 500;

async function requireIncrementalAdmin() {
  const access = await requireAccess();
  if (!['CHE', 'IMM'].every(code => access.warehouses.some(item => item.code === code && item.role === 'admin'))) {
    redirect(`${basePath}?error=permission`);
  }
  const client = await createClient();
  if (!client) redirect(`${basePath}?error=configuration`);
  return client;
}

async function readAllPages<T>(fetchPage: (from: number, to: number) => PromiseLike<{
  data: T[] | null;
  error: unknown;
}>): Promise<{ data: T[]; error: unknown | null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += masterPageSize) {
    const { data, error } = await fetchPage(from, from + masterPageSize - 1);
    if (error) return { data: rows, error };
    const page = data ?? [];
    rows.push(...page);
    if (page.length < masterPageSize) return { data: rows, error: null };
  }
}

async function readMaster(client: Awaited<ReturnType<typeof createClient>>): Promise<IncrementalMaster> {
  if (!client) redirect(`${basePath}?error=configuration`);
  const [products, identifiers, relations, platforms, productPlatforms] = await Promise.all([
    readAllPages((from, to) => client.from('ci_products')
      .select('id,warehouse_id,product_code,product_type,source_name,display_name,packing_size_raw,source_sheet,source_row,raw_source')
      .order('id').range(from, to)),
    readAllPages((from, to) => client.from('ci_product_identifiers')
      .select('product_id,warehouse_id,kind,value,approved').order('id').range(from, to)),
    readAllPages((from, to) => client.from('ci_product_relations')
      .select('source_product_id,target_product_id,relation_type').order('id').range(from, to)),
    readAllPages((from, to) => client.from('ci_platforms')
      .select('id,warehouse_id,platform_key,display_name').order('id').range(from, to)),
    readAllPages((from, to) => client.from('ci_product_platforms')
      .select('product_id,platform_id').order('id').range(from, to)),
  ]);
  if (products.error || identifiers.error || relations.error || platforms.error || productPlatforms.error) {
    redirect(`${basePath}?error=master`);
  }
  return {
    products: products.data as IncrementalMaster['products'],
    identifiers: identifiers.data as IncrementalMaster['identifiers'],
    relations: relations.data as IncrementalMaster['relations'],
    platforms: platforms.data as IncrementalMaster['platforms'],
    product_platforms: productPlatforms.data as IncrementalMaster['product_platforms'],
  };
}

export async function stageIncrementalWorkbook(formData: FormData): Promise<void> {
  const client = await requireIncrementalAdmin();
  const file = formData.get('workbook');
  if (!(file instanceof File) || file.size < 1 || file.size > 1_000_000) redirect(`${basePath}?error=file`);
  let workbook;
  try {
    workbook = await parseIncrementalWorkbook(Buffer.from(await file.arrayBuffer()), file.name);
  } catch (error) {
    if (error instanceof IncrementalWorkbookError) redirect(`${basePath}?error=source`);
    throw error;
  }
  const master = await readMaster(client);
  const rows = classifyIncrementalImport(workbook.rows, master);
  if (!rows.length) redirect(`${basePath}?error=no-delta`);
  const { data, error } = await client.rpc('ci_stage_incremental_product_import', {
    p_payload: { source_filename: workbook.source_filename, source_sha256: workbook.source_sha256, rows },
  });
  if (error || typeof data !== 'string' || !uuidPattern.test(data)) redirect(`${basePath}?error=stage`);
  revalidatePath(basePath);
  redirect(`${basePath}?batch=${data}&staged=1`);
}

export async function applyIncrementalImport(formData: FormData): Promise<void> {
  const client = await requireIncrementalAdmin();
  const batchId = String(formData.get('batchId') ?? '');
  if (!uuidPattern.test(batchId)) redirect(`${basePath}?error=batch`);
  const { error } = await client.rpc('ci_apply_incremental_product_import', { p_batch_id: batchId });
  if (error) redirect(`${basePath}?batch=${batchId}&error=apply`);
  revalidatePath(basePath);
  revalidatePath('/products');
  revalidatePath('/stock');
  redirect(`${basePath}?batch=${batchId}&applied=1`);
}
