import type { SupabaseClient } from '@supabase/supabase-js';

type EvidenceRow = { movement_line_id: string; sequence: number; transaction_id: string; product_id: string; lot_id: string; location_id: string;
  quantity: number | string; lot_location_before: number | string; lot_location_after: number | string; product_after: number | string; created_at: string };

export type IssueResultLine = {
  id: string; productId: string; productCode: string; productName: string; unit: string;
  lotNumber: string; locationCode: string; before: number; quantity: number; after: number;
};
export type IssueResultProduct = { productId: string; productCode: string; productName: string; unit: string; totalAfter: number };
export type IssueResult = { lines: IssueResultLine[]; products: IssueResultProduct[]; issuedAt: string };

/** Pure: the all-LOT total after the issue is the figure recorded on the LAST line of each product. */
export function productTotals(rows: readonly { product_id: string; sequence: number; product_after: number | string }[]) {
  const last = new Map<string, { sequence: number; value: number }>();
  for (const row of rows) {
    const seen = last.get(row.product_id);
    if (!seen || Number(row.sequence) > seen.sequence) last.set(row.product_id, { sequence: Number(row.sequence), value: Number(row.product_after) });
  }
  return new Map([...last].map(([id, item]) => [id, item.value]));
}

/**
 * Reads the balances recorded inside the issue transaction itself. It never re-issues and never
 * computes from browser state; later transactions do not change what is shown here.
 * Returns null when the transactions predate this evidence (the caller shows its older receipt).
 */
export async function loadIssueResult(client: SupabaseClient, transactionIds: readonly string[]): Promise<{ data: IssueResult | null; error: string | null }> {
  if (!transactionIds.length) return { data: null, error: null };
  const evidence = await client.from('ci_issue_balance_results')
    .select('movement_line_id,sequence,transaction_id,product_id,lot_id,location_id,quantity,lot_location_before,lot_location_after,product_after,created_at')
    .in('transaction_id', [...transactionIds]).order('sequence').limit(500);
  if (evidence.error) return { data: null, error: evidence.error.message };
  const rows = (evidence.data ?? []) as EvidenceRow[];
  if (!rows.length) return { data: null, error: null };
  const [products, lots, locations] = await Promise.all([
    client.from('ci_products').select('id,product_code,display_name,base_stock_unit').in('id', [...new Set(rows.map(r => r.product_id))]),
    client.from('ci_stock_lots').select('id,lot_number').in('id', [...new Set(rows.map(r => r.lot_id))]),
    client.from('ci_locations').select('id,code').in('id', [...new Set(rows.map(r => r.location_id))]),
  ]);
  const failed = products.error ?? lots.error ?? locations.error;
  if (failed) return { data: null, error: failed.message };
  const productMap = new Map((products.data ?? []).map(p => [p.id as string, p]));
  const lotMap = new Map((lots.data ?? []).map(l => [l.id as string, l.lot_number as string]));
  const locationMap = new Map((locations.data ?? []).map(l => [l.id as string, l.code as string]));
  const totals = productTotals(rows);
  const lines = rows.map(row => {
    const product = productMap.get(row.product_id);
    return { id: row.movement_line_id, productId: row.product_id, productCode: product?.product_code ?? '—', productName: product?.display_name ?? '—',
      unit: product?.base_stock_unit ?? '', lotNumber: lotMap.get(row.lot_id) ?? '—', locationCode: locationMap.get(row.location_id) ?? '—',
      before: Number(row.lot_location_before), quantity: Number(row.quantity), after: Number(row.lot_location_after) };
  });
  const productsOut = [...totals].map(([productId, totalAfter]) => {
    const product = productMap.get(productId);
    return { productId, productCode: product?.product_code ?? '—', productName: product?.display_name ?? '—', unit: product?.base_stock_unit ?? '', totalAfter };
  });
  return { data: { lines, products: productsOut, issuedAt: rows[0].created_at }, error: null };
}
