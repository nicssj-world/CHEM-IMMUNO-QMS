import { normalizeSupplierCode, type SupplierBillRow, type SupplierProductMatch } from '@/lib/supplier-bill-import';

/** Supplier-specific aliases never replace the master REF_CURRENT/barcode. */
export function supplierIdentifier(kind: 'rdth' | 'material', code: string): string {
  const normalized = normalizeSupplierCode(code);
  if (!normalized || normalized.length > 100 || !/^[A-Z0-9]+$/.test(normalized))
    throw new Error('รหัสผู้ขายไม่ถูกต้อง');
  return (kind === 'rdth' ? 'SUPPLIER_RDTH:' : 'SUPPLIER_MATERIAL:') + normalized;
}
export type ApprovedIdentifier = {
  product_id: string; kind: string; value: string; approved: boolean;
};
export type UnmatchedSupplierProduct = {
  key: string;
  excelRows: number[];
  rdthCode: string;
  materialNo: string;
  description: string;
  reason: 'missing' | 'conflict';
};

export function resolveSupplierProducts(
  rows: readonly SupplierBillRow[],
  identifiers: readonly ApprovedIdentifier[],
  products: ReadonlyMap<string, SupplierProductMatch>,
): { matched: Map<number, SupplierProductMatch>; issues: UnmatchedSupplierProduct[] } {
  const refs = new Map<string, Set<string>>();
  const materials = new Map<string, Set<string>>();
  function record(target: Map<string, Set<string>>, key: string, id: string) {
    const normalized = normalizeSupplierCode(key);
    if (!normalized) return;
    if (!target.has(normalized)) target.set(normalized, new Set());
    target.get(normalized)!.add(id);
  }
  for (const item of identifiers) {
    if (!item.approved || !products.has(item.product_id)) continue;
    if (item.kind === 'REF_CURRENT' || item.kind === 'REF_LEGACY')
      record(refs, item.value, item.product_id);
    else if (item.kind === 'MANUFACTURER_BARCODE')
      record(materials, item.value, item.product_id);
    else if (item.kind === 'OTHER' && item.value.startsWith('SUPPLIER_RDTH:'))
      record(refs, item.value.slice('SUPPLIER_RDTH:'.length), item.product_id);
    else if (item.kind === 'OTHER' && item.value.startsWith('SUPPLIER_MATERIAL:'))
      record(materials, item.value.slice('SUPPLIER_MATERIAL:'.length), item.product_id);
  }
  const matched = new Map<number, SupplierProductMatch>();
  const issues = new Map<string, UnmatchedSupplierProduct>();
  for (const row of rows) {
    const refIds = refs.get(normalizeSupplierCode(row.rdthCode)) ?? new Set<string>();
    const materialIds = materials.get(normalizeSupplierCode(row.materialNo)) ?? new Set<string>();
    const ref = [...refIds][0];
    const material = [...materialIds][0];
    const conflict = refIds.size > 1 || materialIds.size > 1 || (ref && material && ref !== material);
    const id = !conflict ? (ref || material) : undefined;
    const product = id ? products.get(id) : undefined;
    if (product) {
      matched.set(row.excelRow, product);
      continue;
    }
    const key = normalizeSupplierCode(row.rdthCode) + '|' + normalizeSupplierCode(row.materialNo);
    const existing = issues.get(key);
    if (existing) {
      existing.excelRows.push(row.excelRow);
      if (conflict) existing.reason = 'conflict';
    } else {
      issues.set(key, { key, excelRows: [row.excelRow],
        rdthCode: row.rdthCode, materialNo: row.materialNo,
        description: row.description, reason: conflict ? 'conflict' : 'missing' });
    }
  }
  return { matched, issues: [...issues.values()] };
}
