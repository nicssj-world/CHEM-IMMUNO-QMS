// Pure purchase-order rules. Owner decision: the starting order quantity IS the ROP.
// Never "ROP − stock" and never "30-day issues − stock".

export type PoMetric = { product_id: string; warehouse_id: number; issued_30d: number; stock_balance: number; rop: number | null; stock_requirement: string };
export type PoProduct = { id: string; product_code: string; display_name: string; packing_size_raw: string | null; base_stock_unit: string; warehouse_id: number; active: boolean };
export type PoLine = { productId: string; quantity: string; edited: boolean };

export const poStatusLabels: Record<string, string> = { draft: 'ฉบับร่าง', ordered: 'สั่งซื้อแล้ว', cancelled: 'ยกเลิก' };

/** ROP from the system as the default; an automatic (fractional) ROP is rounded up to a whole unit. No ROP → no default. */
export function defaultOrderQuantity(rop: number | null | undefined): number | null {
  if (rop === null || rop === undefined || !Number.isFinite(rop)) return null;
  return Math.max(0, Math.ceil(rop - 1e-9));
}

export function ropText(rop: number | null | undefined) {
  if (rop === null || rop === undefined) return 'ยังไม่กำหนด';
  return Number.isInteger(rop) ? rop.toLocaleString('th-TH') : rop.toLocaleString('th-TH', { maximumFractionDigits: 2 });
}

export type OrderQuantityParse = { ok: true; value: number } | { ok: false; message: string };
/** Whole units, zero allowed; empty is "not filled in", never a silent 0. */
export function parseOrderQuantity(raw: string): OrderQuantityParse {
  const text = raw.trim().replace(/,/g, '');
  if (!text) return { ok: false, message: 'กรอกยอดสั่งซื้อ (กรอก 0 ได้)' };
  if (!/^\d+$/.test(text)) return { ok: false, message: 'ยอดสั่งซื้อต้องเป็นจำนวนเต็ม 0 ขึ้นไป' };
  const value = Number(text);
  if (value > 10_000_000) return { ok: false, message: 'ยอดสั่งซื้อมากเกินไป' };
  return { ok: true, value };
}

export function stepOrderQuantity(raw: string, delta: 1 | -1) {
  const parsed = parseOrderQuantity(raw);
  return String(Math.max(0, (parsed.ok ? parsed.value : 0) + delta));
}

/** A new line starts at the ROP; with no ROP the user fills it in. */
export function newLine(productId: string, metric: PoMetric | undefined): PoLine {
  const quantity = defaultOrderQuantity(metric?.rop ?? null);
  return { productId, quantity: quantity === null ? '' : String(quantity), edited: false };
}

/**
 * Reloading numbers (or reopening a draft) keeps every quantity the user set. Only untouched lines
 * that were still empty because there was no ROP pick up a newly set ROP.
 */
export function refreshLines(lines: readonly PoLine[], metrics: ReadonlyMap<string, PoMetric>): PoLine[] {
  return lines.map(line => {
    if (line.edited || line.quantity !== '') return line;
    const quantity = defaultOrderQuantity(metrics.get(line.productId)?.rop ?? null);
    return quantity === null ? line : { ...line, quantity: String(quantity) };
  });
}

export function addProducts(lines: readonly PoLine[], productIds: readonly string[], metrics: ReadonlyMap<string, PoMetric>) {
  const seen = new Set(lines.map(line => line.productId));
  const added = productIds.filter(id => !seen.has(id) && (seen.add(id), true)).map(id => newLine(id, metrics.get(id)));
  return [...lines, ...added];
}

export function belowRop(stock: number, rop: number | null) { return rop !== null && stock <= rop; }

export function validateLines(lines: readonly PoLine[]) {
  const problems = new Map<string, string>();
  for (const line of lines) { const parsed = parseOrderQuantity(line.quantity); if (!parsed.ok) problems.set(line.productId, parsed.message); }
  return problems;
}

/** The printed order lists lines with a quantity above 0; zero lines stay in the saved order for reference. */
export function printableLines<T extends { order_quantity: number | string }>(lines: readonly T[]) {
  return lines.filter(line => Number(line.order_quantity) > 0);
}

export function normalize(value: string) { return value.normalize('NFC').toLocaleLowerCase('th-TH').replace(/\s+/g, ' ').trim(); }
export function matchesProduct(product: Pick<PoProduct, 'product_code' | 'display_name'>, query: string) {
  const needle = normalize(query);
  if (!needle) return true;
  const hay = normalize(`${product.product_code} ${product.display_name}`);
  return needle.split(' ').every(part => hay.includes(part));
}
