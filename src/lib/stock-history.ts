import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export type MovementTransaction = {
  id: string;
  warehouse_id: number;
  kind: string;
  created_at: string;
  purpose: string | null;
  reason: string | null;
  actor_id: string;
  source_transaction_id?: string | null;
};

export type MovementDetailLine = {
  lotId: string;
  locationId: string;
  productId: string | null;
  productCode: string;
  productName: string;
  ref: string | null;
  unit: string;
  lotNumber: string;
  expiryDate: string | null;
  location: string;
  delta: number;
  currentLotLocationBalance: number | null;
};

export type MovementDetail = MovementTransaction & {
  actorName: string | null;
  lines: MovementDetailLine[];
};

type SourceLine = { transaction_id: string; lot_id: string; location_id: string; quantity_delta: number };
type Lot = { id: string; product_id: string; lot_number: string; expiry_date: string };
type Product = { id: string; product_code: string; display_name: string; base_stock_unit: string };
type Location = { id: string; code: string };
type Balance = { lot_id: string; location_id: string; balance: number };
type Actor = { transaction_id: string; actor_name: string | null };

function failed(message: string): never { throw new Error('ข้อมูลประวัติไม่ครบ: ' + message); }

/** Read only: transaction IDs MUST come from an RLS-scoped ci_stock_transactions query.
 * No names or inventory balances are ever calculated from client-provided IDs.
 */
export async function loadMovementDetails(
  client: SupabaseClient,
  transactions: MovementTransaction[],
  access: AccessContext,
): Promise<MovementDetail[]> {
  if (!transactions.length) return [];
  if (transactions.length > 200) failed('จำนวนรายการเกินขอบเขตการตรวจสอบ');
  const ids = [...new Set(transactions.map(tx => tx.id))];
  const movements = await client.from('ci_stock_movement_lines')
    .select('transaction_id,lot_id,location_id,quantity_delta', { count: 'exact' })
    .in('transaction_id', ids).limit(2000);
  if (movements.error || (movements.count ?? 0) > (movements.data?.length ?? 0)) failed('อ่าน movement lines ไม่ครบ');
  const lines = (movements.data ?? []) as SourceLine[];
  const lotIds = [...new Set(lines.map(line => line.lot_id))];
  const locationIds = [...new Set(lines.map(line => line.location_id))];

  const [lotsResult, locationsResult, balancesResult] = await Promise.all([
    lotIds.length ? client.from('ci_stock_lots').select('id,product_id,lot_number,expiry_date').in('id', lotIds).limit(2000) : Promise.resolve({ data: [] as Lot[], error: null }),
    locationIds.length ? client.from('ci_locations').select('id,code').in('id', locationIds).limit(2000) : Promise.resolve({ data: [] as Location[], error: null }),
    lotIds.length ? client.from('ci_stock_balances').select('lot_id,location_id,balance', { count: 'exact' }).in('lot_id', lotIds).limit(2000) : Promise.resolve({ data: [] as Balance[], error: null, count: 0 }),
  ]);
  if (lotsResult.error || locationsResult.error || balancesResult.error ||
      (balancesResult.count ?? 0) > (balancesResult.data?.length ?? 0)) failed('อ่าน LOT และยอดคงเหลือไม่ครบ');
  const lots = (lotsResult.data ?? []) as Lot[];
  const productIds = [...new Set(lots.map(lot => lot.product_id))];
  const [productResult, refsResult] = await Promise.all([
    productIds.length ? client.from('ci_products').select('id,product_code,display_name,base_stock_unit').in('id', productIds).limit(2000) : Promise.resolve({ data: [] as Product[], error: null }),
    productIds.length ? client.from('ci_product_identifiers').select('product_id,value').eq('kind','REF_CURRENT').in('product_id', productIds).limit(2000) : Promise.resolve({ data: [] as {product_id:string;value:string}[], error: null }),
  ]);
  if (productResult.error || refsResult.error) failed('อ่านชื่อน้ำยาและ REF ไม่สำเร็จ');
  const lotMap = new Map(lots.map(lot => [lot.id, lot]));
  const productMap = new Map(((productResult.data ?? []) as Product[]).map(product => [product.id, product]));
  const refMap = new Map((refsResult.data ?? []).map(ref => [ref.product_id, ref.value]));
  const locationMap = new Map(((locationsResult.data ?? []) as Location[]).map(location => [location.id, location.code]));
  const balances = new Map(((balancesResult.data ?? []) as Balance[]).map(row => [row.lot_id + ':' + row.location_id, Number(row.balance)]));
  const byTransaction = new Map<string, MovementDetailLine[]>();
  for (const line of lines) {
    const lot = lotMap.get(line.lot_id);
    const product = lot && productMap.get(lot.product_id);
    const current = balances.get(line.lot_id + ':' + line.location_id);
    const details: MovementDetailLine = {
      lotId: line.lot_id, locationId: line.location_id, productId: lot?.product_id ?? null,
      productCode: product?.product_code ?? 'ไม่พบรหัสน้ำยา',
      productName: product?.display_name ?? 'ไม่พบชื่อน้ำยา',
      ref: lot ? refMap.get(lot.product_id) ?? null : null,
      unit: product?.base_stock_unit ?? '',
      lotNumber: lot?.lot_number ?? '—', expiryDate: lot?.expiry_date ?? null,
      location: locationMap.get(line.location_id) ?? '—',
      delta: Number(line.quantity_delta), currentLotLocationBalance: current ?? 0,
    };
    const existing = byTransaction.get(line.transaction_id) ?? [];
    existing.push(details);
    byTransaction.set(line.transaction_id, existing);
  }

  const actorNames = new Map<string, string>();
  // The RPC returns only names of transaction actors in warehouses readable by the current user.
  const visibleActors = await client.rpc('ci_visible_transaction_actors', { p_transaction_ids: ids });
  if (!visibleActors.error) {
    for (const row of (visibleActors.data ?? []) as Actor[]) {
      if (row.actor_name) actorNames.set(row.transaction_id, row.actor_name);
    }
  } else {
    // Deploy compatibility while the additive migration is being applied.
    // Restrict the privileged lookup to actors from the already RLS-filtered transactions.
    const admin = createAdminClient();
    const actorIds = [...new Set(transactions.map(tx => tx.actor_id))];
    if (admin && actorIds.length) {
      const result = await admin.from('ci_user_profiles').select('user_id,display_name').in('user_id', actorIds).limit(200);
      if (!result.error) {
        const profiles = new Map((result.data ?? []).map(row => [row.user_id, row.display_name]));
        for (const tx of transactions) {
          const name = profiles.get(tx.actor_id);
          if (name) actorNames.set(tx.id, name);
        }
      }
    }
  }
  for (const tx of transactions) if (!actorNames.has(tx.id) && tx.actor_id === access.userId) actorNames.set(tx.id, access.displayName);

  return transactions.map(tx => ({
    ...tx,
    actorName: actorNames.get(tx.id) ?? null,
    lines: byTransaction.get(tx.id) ?? [],
  }));
}
