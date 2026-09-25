import { createClient } from '@/lib/supabase/server';
import type { LocationOption, StockOption } from '@/components/stock-operation-form';
import type { PickerProduct } from '@/components/product-picker';

/**
 * LOT × location rows for one product (or, with `expiredBefore`, every expired row) plus the product list for the picker.
 * Loading per product keeps the list complete: a warehouse-wide dropdown had to cap rows and silently dropped the newest LOTs.
 */
export async function getStockOptions(warehouseId: string, { includeZero = false, productId, expiredBefore }: { includeZero?: boolean; productId?: string; expiredBefore?: string } = {}): Promise<{ options: StockOption[]; locations: LocationOption[]; products: PickerProduct[]; error: string | null }> {
  const client = await createClient();
  if (!client) return { options: [], locations: [], products: [], error: 'ยังไม่ได้ตั้งค่า Supabase' };
  const loadRows = Boolean(productId || expiredBefore);
  let balances = client.from('ci_stock_balances').select('lot_id,lot_number,expiry_date,location_id,product_id,balance').eq('warehouse_id',warehouseId);
  balances = includeZero ? balances.gte('balance',0) : balances.gt('balance',0);
  if (productId) balances = balances.eq('product_id',productId);
  if (expiredBefore) balances = balances.lt('expiry_date',expiredBefore);
  const [balanceResult, productResult, locationResult] = await Promise.all([
    loadRows ? balances.order('expiry_date').order('lot_number').limit(1000) : Promise.resolve({ data: [], error: null }),
    client.from('ci_products').select('id,product_code,display_name').eq('warehouse_id',warehouseId).eq('active',true).order('product_code').limit(1000),
    client.from('ci_locations').select('id,code,name').eq('warehouse_id',warehouseId).eq('active',true).order('code'),
  ]);
  const error = balanceResult.error?.message ?? productResult.error?.message ?? locationResult.error?.message ?? null;
  const products = (productResult.data ?? []) as PickerProduct[];
  const productMap = new Map(products.map(p => [p.id,p]));
  const locations = (locationResult.data ?? []) as LocationOption[];
  const locationMap = new Map(locations.map(l => [l.id,l]));
  const options = ((balanceResult.data ?? []) as { lot_id: string; lot_number: string; expiry_date: string; location_id: string; product_id: string; balance: number }[]).map(b => ({ lot_id: b.lot_id, lot_number: b.lot_number, expiry_date: b.expiry_date, location_id: b.location_id, location_code: locationMap.get(b.location_id)?.code ?? '—', product_code: productMap.get(b.product_id)?.product_code ?? '—', product_name: productMap.get(b.product_id)?.display_name ?? '', balance: Number(b.balance) }));
  return { options, locations, products, error };
}
