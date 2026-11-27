import type { WizardLine, WizardLot } from '@/lib/receiving-wizard';

export type SupplierBillRow = {
  excelRow: number;
  billNumber: string;
  billDate: string;
  customerPo: string;
  rdthCode: string;
  materialNo: string;
  description: string;
  lot: string;
  expiry: string;
  quantity: number;
};

export type SupplierBill = {
  invoiceNumber: string;
  invoiceDate: string;
  poNumber: string;
  rows: SupplierBillRow[];
};

export type SupplierProductMatch = {
  id: string;
  warehouse_id: number;
  product_code: string;
  display_name: string;
  default_location_id: string | null;
};

const HEADERS = ['Bill No.', 'Bill Date', 'Customer PO', 'RDTH Code',
  'Material No.', 'Description', 'Lot', 'Exp. Date', 'Qty'];

export function normalizeSupplierCode(value: string): string {
  // Supplier REF may omit the space present in the approved REF_CURRENT identifier.
  return value.trim().replace(/[\s-]/g, '').toUpperCase();
}

function cellText(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  return '';
}

function isoDate(value: unknown): string | null {
  const input = cellText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  const date = new Date(input + 'T00:00:00.000Z');
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input ? null : input;
}

export function parseSupplierBillTable(table: readonly (readonly unknown[])[]):
  { ok: true; bill: SupplierBill } | { ok: false; message: string } {
  if (table.length < 2 || table.length > 501)
    return { ok: false, message: 'ไฟล์ต้องมี 1–500 แถวรายการ พร้อมหัวตาราง' };
  const header = table[0].slice(0, 9).map(cellText);
  if (HEADERS.some((name, index) => header[index]?.toLowerCase() !== name.toLowerCase()))
    return { ok: false, message: 'หัวตารางต้องมี Bill No., Bill Date, Customer PO, RDTH Code, Material No., Description, Lot, Exp. Date และ Qty ตามตัวอย่าง' };

  const rows: SupplierBillRow[] = [];
  for (let n = 1; n < table.length; n++) {
    const data = table[n].slice(0, 9);
    if (data.every(v => cellText(v) === '')) continue;
    const [billNumber, , customerPo, rdthCode, materialNo, description, lot] = data.map(cellText);
    const billDate = isoDate(data[1]);
    const expiry = isoDate(data[7]);
    const quantityText = cellText(data[8]);
    const quantity = Number(quantityText);
    if (!billNumber || !billDate || !rdthCode || !materialNo || !description || !lot ||
      lot.length > 100 || !expiry || !/^\d+$/.test(quantityText) ||
      !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000) {
      return { ok: false, message: 'ข้อมูลไม่ครบหรือรูปแบบไม่ถูกต้องที่ Excel แถว ' + String(n + 1) +
        ' (Bill, วัน, REF, Material, ชื่อสินค้า, LOT, EXP และจำนวนต้องถูกต้อง)' };
    }
    rows.push({ excelRow: n + 1, billNumber, billDate, customerPo,
      rdthCode, materialNo, description, lot, expiry, quantity });
  }
  if (!rows.length) return { ok: false, message: 'ไม่พบรายการสินค้าในไฟล์' };
  const first = rows[0];
  if (rows.some(row => row.billNumber !== first.billNumber || row.billDate !== first.billDate))
    return { ok: false, message: 'ไฟล์มีมากกว่าหนึ่ง Bill No. หรือ Bill Date กรุณาแยกไฟล์' };
  const poValues = [...new Set(rows.map(row => row.customerPo.trim())
    .filter(value => value && value.toLowerCase() !== 'consignment'))];
  if (poValues.length > 1 || (poValues.length > 0 && rows.some(row =>
    row.customerPo.trim().toLowerCase() === 'consignment')))
    return { ok: false, message: 'Customer PO ในไฟล์ไม่ตรงกัน กรุณาตรวจสอบก่อน Import' };
  return { ok: true, bill: {
    invoiceNumber: first.billNumber, invoiceDate: first.billDate,
    poNumber: poValues[0] ?? '', rows,
  } };
}

export function buildImportedWizardLines(
  rows: readonly SupplierBillRow[],
  matchedProducts: ReadonlyMap<number, SupplierProductMatch>,
  locationByProduct: ReadonlyMap<string, string>,
  makeId: () => string,
): { ok: true; lines: WizardLine[] } | { ok: false; message: string } {
  const byProduct = new Map<string, WizardLine>();
  for (const row of rows) {
    const product = matchedProducts.get(row.excelRow);
    if (!product) return { ok: false, message: 'ยังจับคู่สินค้าไม่ได้ที่แถว ' + row.excelRow };
    let line = byProduct.get(product.id);
    if (!line) {
      line = { id: makeId(), productId: product.id, source: 'supplier_excel',
        orderedQuantity: '0', packages: [] };
      byProduct.set(product.id, line);
    }
    const matchingLot = line.packages.find(item =>
      item.lot.trim().toUpperCase() === row.lot.trim().toUpperCase());
    if (matchingLot && matchingLot.expiry !== row.expiry)
      return { ok: false, message: 'สินค้า ' + product.product_code + ' LOT ' + row.lot +
        ' มีวันหมดอายุไม่ตรงกันในไฟล์' };
    if (matchingLot) {
      const nextQuantity = Number(matchingLot.expectedQuantity) + row.quantity;
      if (!Number.isSafeInteger(nextQuantity) || nextQuantity > 1_000_000)
        return { ok: false, message: 'จำนวนรวม LOT เกินกำหนดที่แถว ' + row.excelRow };
      matchingLot.quantity = String(nextQuantity);
      matchingLot.expectedQuantity = String(nextQuantity);
      matchingLot.sourceRows = [...(matchingLot.sourceRows ?? []), row.excelRow];
    } else {
      const item: WizardLot = {
        id: makeId(), lot: row.lot.trim(), expiry: row.expiry,
        quantity: String(row.quantity), expectedQuantity: String(row.quantity),
        locationId: locationByProduct.get(product.id) ?? '',
        verified: false, notReceived: false, sourceRows: [row.excelRow],
      };
      line.packages.push(item);
    }
  }
  const lines = [...byProduct.values()];
  for (const line of lines) {
    line.orderedQuantity = String(line.packages.reduce((sum, pkg) =>
      sum + Number(pkg.expectedQuantity), 0));
  }
  if (lines.length > 250 || lines.reduce((sum, line) => sum + line.packages.length, 0) > 500)
    return { ok: false, message: 'จำนวนสินค้า/LOT เกินขีดจำกัดของใบรับเข้า' };
  return { ok: true, lines };
}

export function supplierChecklistError(lines: readonly WizardLine[]): string | null {
  for (const line of lines) {
    if (line.source !== 'supplier_excel') continue;
    for (const pkg of line.packages) {
      if (!pkg.verified && !pkg.notReceived)
        return 'กรุณาตรวจรับหรือระบุว่าไม่ได้รับให้ครบทุก LOT';
      if (pkg.verified && pkg.notReceived)
        return 'LOT หนึ่งรายการไม่สามารถรับและไม่รับพร้อมกันได้';
      if (pkg.verified && (!pkg.locationId ||
        !Number.isSafeInteger(Number(pkg.quantity)) || Number(pkg.quantity) < 1))
        return 'LOT ที่ตรวจรับแล้วต้องมีตำแหน่งและจำนวนรับจริง';
    }
  }
  return null;
}
