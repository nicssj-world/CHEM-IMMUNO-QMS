/** Resolve safe per-product suggestions from receiving history, keeping warehouse RLS on the queries.
 * Only use a successful receipt; never suggest the location from a reversed receipt.
 * A tie in receipt timestamps with different locations is ambiguous and needs user selection.
 */
export type ReceiptHistory = { invoice_line_id: string; receipt_id: string; location_id: string; created_at: string };
export type ProductHistoryLine = { id: string; product_id: string };

export function mostRecentReceivedLocations(
  history: readonly ReceiptHistory[],
  invoiceLines: readonly ProductHistoryLine[],
  reversedReceiptIds: ReadonlySet<string>,
  wantedProductIds: ReadonlySet<string>,
): Record<string, string> {
  const productByLine = new Map(invoiceLines.map(line => [line.id, line.product_id]));
  const result: Record<string, string> = {};
  const seen = new Map<string, { date: string; locations: Set<string> }>();
  for (const row of [...history].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    if (reversedReceiptIds.has(row.receipt_id)) continue;
    const productId = productByLine.get(row.invoice_line_id);
    if (!productId || !wantedProductIds.has(productId)) continue;
    const existing = seen.get(productId);
    if (!existing) seen.set(productId, { date: row.created_at, locations: new Set([row.location_id]) });
    else if (existing.date === row.created_at) existing.locations.add(row.location_id);
  }
  for (const [productId, choice] of seen) if (choice.locations.size === 1) result[productId] = [...choice.locations][0];
  return result;
}
