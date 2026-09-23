import { createClient } from '@/lib/supabase/server';
import type { LocationOption, StockOption } from '@/components/stock-operation-form';

export async function getStockOptions(warehouseId: string, includeZero = false): Promise<{ options: StockOption[]; locations: LocationOption[]; error: string | null }> {
  const client = await createClient();
  if (!client) return { options: [], locations: [], error: 'ยังไม่ได้ตั้งค่า Supabase' };
  const [balanceResult, productResult, locationResult] = await Promise.all([
    (includeZero
      ? client.from('ci_stock_balances').select('lot_id,lot_number,expiry_date,location_id,product_id,balance').eq('warehouse_id',warehouseId).gte('balance',0)
      : client.from('ci_stock_balances').select('lot_id,lot_number,expiry_date,location_id,product_id,balance').eq('warehouse_id',warehouseId).gt('balance',0)
    ).order('expiry_date').limit(500),
    client.from('ci_products').select('id,product_code,display_name').eq('warehouse_id',warehouseId).limit(500),
    client.from('ci_locations').select('id,code,name').eq('warehouse_id',warehouseId).eq('active',true),
  ]);
  const error = balanceResult.error?.message ?? productResult.error?.message ?? locationResult.error?.message ?? null;
  const products = new Map((productResult.data ?? []).map(p => [p.id,p]));
  const locations = (locationResult.data ?? []) as LocationOption[];
  const locationMap = new Map(locations.map(l => [l.id,l]));
  const options = (balanceResult.data ?? []).map(b => ({ lot_id: b.lot_id, lot_number: b.lot_number, expiry_date: b.expiry_date, location_id: b.location_id, location_code: locationMap.get(b.location_id)?.code ?? '—', product_code: products.get(b.product_id)?.product_code ?? '—', product_name: products.get(b.product_id)?.display_name ?? '—', balance: Number(b.balance) }));
  return { options, locations, error };
}
