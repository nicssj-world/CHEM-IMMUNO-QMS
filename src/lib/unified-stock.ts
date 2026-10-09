import { createClient } from '@/lib/supabase/server';

type Client = NonNullable<Awaited<ReturnType<typeof createClient>>>;
export type UnifiedStockRow = { product_id: string; product_code: string; display_name: string; lot_id: string; lot_number: string; expiry_date: string; location_id: string; location_code: string; balance: number };
export type UnifiedProductRow = { id: string; product_code: string; display_name: string; product_type: string; packing_size_raw: string | null; active: boolean; usable_stock: number; rop: number | null; stock_status: string };
type DbError = { message: string };

/** Read both independent signed ledgers, merge by product code, then paginate globally.
 * Queries run with the user's RLS context and never rewrite historical warehouse_id.
 * Fetches bounded 100-row RPC pages to avoid silently truncating the second group.
 */
async function collect<T>(warehouseIds: readonly number[], fetcher: (warehouseId: number, offset: number) => PromiseLike<{ data: T[] | null; error: DbError | null }>) {
  const all: T[] = [];
  for (const warehouseId of warehouseIds) {
    for (let offset = 0; offset < 10000; offset += 100) {
      const response = await fetcher(warehouseId, offset);
      if (response.error) return { data: [] as T[], error: response.error };
      all.push(...(response.data ?? []));
      if ((response.data ?? []).length < 100) break;
      if (offset === 9900) return { data: [] as T[], error: { message: 'จำนวนข้อมูลเกินขีดจำกัดที่ระบบกำหนด' } };
    }
  }
  return { data: all, error: null as DbError | null };
}

export async function searchUnifiedStock(client: Client, warehouseIds: readonly number[], query: string, page: number, pageSize = 50) {
  const result = await collect<UnifiedStockRow>(warehouseIds, (id, offset) => client.rpc('ci_search_stock', {
    p_warehouse_id: id, p_query: query, p_limit: 100, p_offset: offset,
  }));
  result.data.sort((a, b) => a.product_code.localeCompare(b.product_code) || a.expiry_date.localeCompare(b.expiry_date) || a.lot_number.localeCompare(b.lot_number) || a.location_code.localeCompare(b.location_code));
  return { data: result.data.slice((page - 1) * pageSize, page * pageSize), error: result.error };
}

export async function searchUnifiedProducts(client: Client, warehouseIds: readonly number[], args: { query: string; type: string | null; platform: string | null; stock: string | null; expiry: string | null }, page: number, pageSize = 50) {
  const result = await collect<UnifiedProductRow>(warehouseIds, (id, offset) => client.rpc('ci_search_inventory', {
    p_warehouse_id: id, p_query: args.query, p_type: args.type,
    p_platform_id: args.platform, p_stock_status: args.stock, p_expiry: args.expiry,
    p_limit: 100, p_offset: offset,
  }));
  result.data.sort((a,b) => a.product_code.localeCompare(b.product_code));
  return { data: result.data.slice((page - 1) * pageSize, page * pageSize), error: result.error };
}
