import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/auth';
import { canMutateRole } from '@/lib/auth-identity';
import { readAll, readByIds } from '@/lib/stock-count-data';
import type { PoMetric, PoProduct } from '@/lib/purchase-orders';

type DbError = { message: string };
const PRODUCT_COLUMNS = 'id,product_code,display_name,packing_size_raw,base_stock_unit,warehouse_id,active';

export function orderWarehouseIds(access: AccessContext) {
  return access.warehouses.filter(w => canMutateRole(w.role)).map(w => Number(w.id));
}

/** Active products of the groups this user may order for, plus any already-referenced ones. */
export async function loadCatalog(client: SupabaseClient, access: AccessContext, extraIds: readonly string[] = []) {
  const ids = orderWarehouseIds(access);
  const active = ids.length ? await readAll<PoProduct>((from, to) => client.from('ci_products').select(PRODUCT_COLUMNS, { count: 'exact' })
    .in('warehouse_id', ids).eq('active', true).order('product_code').range(from, to)) : { data: [] as PoProduct[], error: null };
  if (active.error) return { data: null, error: active.error };
  const known = new Set(active.data.map(p => p.id));
  const missing = extraIds.filter(id => !known.has(id));
  const extra = missing.length ? await readByIds<PoProduct>(missing, chunk => client.from('ci_products').select(PRODUCT_COLUMNS).in('id', chunk)) : { data: [] as PoProduct[], error: null };
  if (extra.error) return { data: null, error: extra.error };
  return { data: [...active.data, ...extra.data], error: null };
}

type MetricRow = { product_id: string; warehouse_id: number; issued_30d: number | string; stock_balance: number | string; rop: number | string | null; stock_requirement: string; usage_start: string; usage_end: string };

/** Current 30-day issues, on-hand stock and ROP, computed by the database in batches (never one call per product). */
export async function loadMetrics(client: SupabaseClient, productIds: readonly string[]): Promise<{ data: { metrics: Record<string, PoMetric>; usageStart: string | null; usageEnd: string | null } | null; error: DbError | null }> {
  const unique = [...new Set(productIds)];
  const metrics: Record<string, PoMetric> = {};
  let usageStart: string | null = null, usageEnd: string | null = null;
  for (let index = 0; index < unique.length; index += 300) {
    const { data, error } = await client.rpc('ci_purchase_order_metrics', { p_product_ids: unique.slice(index, index + 300) });
    if (error) return { data: null, error };
    for (const row of (data ?? []) as MetricRow[]) {
      metrics[row.product_id] = { product_id: row.product_id, warehouse_id: Number(row.warehouse_id), issued_30d: Number(row.issued_30d),
        stock_balance: Number(row.stock_balance), rop: row.rop === null ? null : Number(row.rop), stock_requirement: row.stock_requirement };
      usageStart ??= row.usage_start; usageEnd ??= row.usage_end;
    }
  }
  return { data: { metrics, usageStart, usageEnd }, error: null };
}

export type TemplateSummary = { id: string; name: string; created_by: string; updated_at: string; productIds: string[] };
export async function loadTemplates(client: SupabaseClient): Promise<{ data: TemplateSummary[] | null; error: DbError | null }> {
  const [headers, lines] = await Promise.all([
    client.from('ci_purchase_order_templates').select('id,name,created_by,updated_at').order('name').limit(500),
    readAll<{ template_id: string; product_id: string; display_order: number }>((from, to) => client.from('ci_purchase_order_template_lines')
      .select('template_id,product_id,display_order', { count: 'exact' }).order('template_id').order('display_order').range(from, to)),
  ]);
  if (headers.error) return { data: null, error: headers.error };
  if (lines.error) return { data: null, error: lines.error };
  const byTemplate = new Map<string, string[]>();
  for (const line of lines.data) byTemplate.set(line.template_id, [...(byTemplate.get(line.template_id) ?? []), line.product_id]);
  return { data: (headers.data ?? []).map(h => ({ ...h, productIds: byTemplate.get(h.id) ?? [] })) as TemplateSummary[], error: null };
}

export type OrderHeader = { id: string; po_number: string | null; status: string; template_id: string | null; template_name_snapshot: string | null;
  created_by: string; created_by_name: string; created_at: string; updated_at: string; confirmed_at: string | null; usage_period_start: string | null; usage_period_end: string | null };
export type OrderLine = { id: string; product_id: string; warehouse_id: number; display_order: number; order_quantity: number | string;
  product_code_snapshot: string | null; product_name_snapshot: string | null; packing_snapshot: string | null; unit_snapshot: string | null;
  issued_30d_snapshot: number | string | null; stock_balance_snapshot: number | string | null; rop_snapshot: number | string | null };
export const ORDER_COLUMNS = 'id,po_number,status,template_id,template_name_snapshot,created_by,created_by_name,created_at,updated_at,confirmed_at,usage_period_start,usage_period_end';

export async function loadOrder(client: SupabaseClient, id: string): Promise<{ data: { header: OrderHeader; lines: OrderLine[] } | null; error: DbError | null }> {
  const header = await client.from('ci_purchase_orders').select(ORDER_COLUMNS).eq('id', id).maybeSingle();
  if (header.error) return { data: null, error: header.error };
  if (!header.data) return { data: null, error: null };
  const lines = await client.from('ci_purchase_order_lines')
    .select('id,product_id,warehouse_id,display_order,order_quantity,product_code_snapshot,product_name_snapshot,packing_snapshot,unit_snapshot,issued_30d_snapshot,stock_balance_snapshot,rop_snapshot')
    .eq('purchase_order_id', id).order('display_order').limit(1000);
  if (lines.error) return { data: null, error: lines.error };
  return { data: { header: header.data as OrderHeader, lines: (lines.data ?? []) as OrderLine[] }, error: null };
}
