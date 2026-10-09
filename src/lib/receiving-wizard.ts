import type { AssessmentInput } from '@/lib/receipt-assessment';

export type WizardLot = {
  id: string; quantity: string; lot: string; expiry: string; locationId: string;
  raw?: string;
};
export type WizardLine = {
  id: string; productId: string; orderedQuantity: string; packages: WizardLot[];
};
export type WizardHeader = {
  vendorId: string; invoiceNumber: string; invoiceDate: string; poNumber: string;
};
export type WizardDraft = {
  id: string; vendor_id: string; invoice_number: string; invoice_date: string;
  po_number: string | null; lines: WizardLine[]; assessment: AssessmentInput | null;
  step: number; status: 'draft' | 'submitted'; invoice_id: string | null;
  updated_at: string;
};
export type WizardProduct = {
  id: string; warehouse_id: number; product_code: string; display_name: string;
  default_location_id: string | null;
};
export type WizardLocation = { id: string; code: string; name: string; parent_code?: string | null };

export function wizardHeaderError(header: WizardHeader): string | null {
  if (!header.vendorId || !header.invoiceNumber.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(header.invoiceDate)) {
    return 'กรุณาระบุผู้ขาย เลขที่ Invoice และวันที่ให้ครบ';
  }
  if (header.invoiceNumber.trim().length > 120 || header.poNumber.length > 200) return 'ข้อมูลส่วนหัว Invoice ยาวเกินกำหนด';
  return null;
}

export function wizardLineError(lines: readonly WizardLine[], products: readonly WizardProduct[], locations: readonly WizardLocation[]): string | null {
  if (lines.length === 0) return 'กรุณาเพิ่มน้ำยาอย่างน้อยหนึ่งรายการ';
  if (lines.length > 250) return 'จำนวนรายการน้ำยาเกินกำหนด';
  const knownProducts = new Set(products.map(p => p.id));
  const knownLocations = new Set(locations.map(p => p.id));
  const used = new Set<string>();
  let lots = 0;
  const expiryByLot = new Map<string, string>();
  for (const line of lines) {
    if (!knownProducts.has(line.productId) || used.has(line.productId)) return 'โปรดเลือกน้ำยาที่อยู่ในทะเบียนและไม่ซ้ำรายการ';
    used.add(line.productId);
    const ordered = Number(line.orderedQuantity);
    if (!Number.isSafeInteger(ordered) || ordered < 1) return 'จำนวนตาม Invoice ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป';
    let received = 0;
    for (const pkg of line.packages) {
      lots++;
      if (lots > 500) return 'จำนวน LOT มากเกินกำหนด';
      const count = Number(pkg.quantity);
      if (!Number.isSafeInteger(count) || count < 1 || !pkg.lot.trim() ||
          !/^\d{4}-\d{2}-\d{2}$/.test(pkg.expiry) || !knownLocations.has(pkg.locationId)) {
        return 'กรุณากรอก LOT วันหมดอายุ จำนวนรับจริง และตำแหน่งให้ครบ';
      }
      const key = JSON.stringify([line.productId,pkg.lot.trim().toLocaleLowerCase()]);
      if (expiryByLot.has(key) && expiryByLot.get(key) !== pkg.expiry) return 'LOT เดียวกันมีวันหมดอายุต่างกัน';
      expiryByLot.set(key,pkg.expiry);
      received += count;
    }
    if (received > ordered) return 'จำนวนรับเข้าจริงเกินจำนวนตาม Invoice';
  }
  if (!lots) return 'กรุณาระบุจำนวนรับเข้าจริงอย่างน้อยหนึ่ง LOT';
  return null;
}
export function wizardTotals(lines: readonly WizardLine[]) {
  const ordered = lines.reduce((sum,l)=>sum+(Number(l.orderedQuantity)||0),0);
  const received = lines.reduce((sum,l)=>sum+l.packages.reduce((n,p)=>n+(Number(p.quantity)||0),0),0);
  return {ordered,received,pending:Math.max(0,ordered-received),lots:lines.reduce((sum,l)=>sum+l.packages.length,0)};
}
export function remainingForLot(line: WizardLine, lotId: string) {
  return Math.max(0,Number(line.orderedQuantity) -
    line.packages.filter(p=>p.id!==lotId).reduce((n,p)=>n+(Number(p.quantity)||0),0));
}
