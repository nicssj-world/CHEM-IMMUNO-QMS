/** Shared, viewport-independent receiving logic. Product/LOT/location remain separate stock keys. */
export type ReceiptPackage = {
  id: string; invoiceLineId: string; quantity: string; lot: string;
  expiry: string; locationId: string; raw?: string;
};
export type ReceiptLimit = { invoice_line_id: string; remaining_quantity: number };
export type AppendResult = { ok: true; packages: ReceiptPackage[]; merged: boolean; quantity: number }
  | { ok: false; reason: 'invalid' | 'capacity' | 'lot-expiry-conflict' };

const sameLot = (a: ReceiptPackage, b: ReceiptPackage) =>
  a.invoiceLineId === b.invoiceLineId && a.lot.trim() === b.lot.trim();

export function appendReceiptPackage(
  existing: readonly ReceiptPackage[], next: ReceiptPackage, limits: readonly ReceiptLimit[],
): AppendResult {
  const n = Number(next.quantity);
  if (!next.invoiceLineId || !next.lot.trim() || !next.expiry || !next.locationId || !Number.isSafeInteger(n) || n <= 0) {
    return { ok: false, reason: 'invalid' };
  }
  const limit = limits.find(line => line.invoice_line_id === next.invoiceLineId);
  if (!limit) return { ok: false, reason: 'invalid' };
  if (existing.some(item => sameLot(item, next) && item.expiry !== next.expiry)) {
    return { ok: false, reason: 'lot-expiry-conflict' };
  }
  const used = existing.filter(item => item.invoiceLineId === next.invoiceLineId).reduce((sum,item) => sum + Number(item.quantity),0);
  if (used + n > Number(limit.remaining_quantity)) return { ok: false, reason: 'capacity' };
  const same = existing.find(item => sameLot(item,next) && item.expiry === next.expiry && item.locationId === next.locationId);
  return {
    ok: true,
    packages: same
      ? existing.map(item => item.id === same.id ? { ...item, quantity: String(Number(item.quantity)+n) } : item)
      : [...existing, { ...next, lot: next.lot.trim() }],
    merged: Boolean(same),
    quantity: n,
  };
}

/** Detailed draft errors keyed by package id. Never changes stock or confirmation rules. */
export function receiptPackageIssues(packages: readonly ReceiptPackage[], limits: readonly ReceiptLimit[]): { id: string; message: string }[] {
  const issues: { id: string; message: string }[] = [];
  const used = new Map<string, number>();
  const expiryByLot = new Map<string, string>();
  for (const item of packages) {
    const qty = Number(item.quantity);
    let message = '';
    const limit = limits.find(line => line.invoice_line_id === item.invoiceLineId);
    if (!item.invoiceLineId || !limit) message = 'น้ำยาไม่ตรงกับ Invoice';
    else if (!item.lot.trim()) message = 'ยังไม่ระบุ LOT';
    else if (!item.expiry) message = 'ยังไม่ระบุวันหมดอายุ';
    else if (!item.locationId) message = 'ยังไม่เลือกตำแหน่งจัดเก็บ';
    else if (!Number.isSafeInteger(qty) || qty <= 0) message = 'จำนวนต้องเป็นจำนวนเต็มมากกว่า 0';
    if (limit && Number.isSafeInteger(qty) && qty > 0) {
      const next = (used.get(item.invoiceLineId) ?? 0) + qty;
      used.set(item.invoiceLineId, next);
      if (!message && next > Number(limit.remaining_quantity)) message = 'จำนวนรวมของน้ำยานี้เกินยอดค้างรับ';
    }
    if (item.invoiceLineId && item.lot.trim()) {
      const key = JSON.stringify([item.invoiceLineId, item.lot.trim()]);
      if (!message && expiryByLot.has(key) && expiryByLot.get(key) !== item.expiry) message = 'LOT เดียวกันมีวันหมดอายุไม่ตรงกัน';
      if (!expiryByLot.has(key)) expiryByLot.set(key, item.expiry);
    }
    if (message) issues.push({ id: item.id, message });
  }
  return issues;
}

export function validateReceiptPackages(packages: readonly ReceiptPackage[], limits: readonly ReceiptLimit[]): string | null {
  if (!packages.length) return 'กรุณาเพิ่มรายการรับเข้าอย่างน้อยหนึ่งรายการ';
  const used = new Map<string, number>();
  const lotExpiry = new Map<string, string>();
  for (const item of packages) {
    const n = Number(item.quantity);
    if (!item.invoiceLineId || !item.lot.trim() || !item.expiry || !item.locationId || !Number.isSafeInteger(n) || n < 1) {
      return 'กรุณาตรวจ LOT วันหมดอายุ จำนวน และตำแหน่งของทุกรายการ';
    }
    const limit = limits.find(line => line.invoice_line_id === item.invoiceLineId);
    if (!limit) return 'รายการรับเข้าไม่ตรงกับ Invoice นี้';
    const key = JSON.stringify([item.invoiceLineId,item.lot.trim()]);
    if (lotExpiry.has(key) && lotExpiry.get(key) !== item.expiry) return 'LOT เดียวกันมีวันหมดอายุไม่ตรงกัน';
    lotExpiry.set(key,item.expiry);
    used.set(item.invoiceLineId, (used.get(item.invoiceLineId) ?? 0) + n);
    if ((used.get(item.invoiceLineId) ?? 0) > Number(limit.remaining_quantity)) return 'จำนวนรับเข้าเกินยอดค้างรับใน Invoice';
  }
  return null;
}
