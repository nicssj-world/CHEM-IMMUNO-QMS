'use server';

import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { revalidatePath } from 'next/cache';
import { requireAccess, canMutate } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { mostRecentReceivedLocations } from '@/lib/recent-receive-location';
import { createReceivingWizardDraft, saveReceivingWizardDraft } from '@/app/actions/receiving-wizard';
import { DEFAULT_ASSESSMENT } from '@/lib/receipt-assessment';
import { buildImportedWizardLines, parseSupplierBillTable,
  type SupplierProductMatch } from '@/lib/supplier-bill-import';
import { resolveSupplierProducts, type UnmatchedSupplierProduct } from '@/lib/supplier-identifier';

export type SupplierExcelImportResult =
  | { ok: true; id: string; existingDraft?: boolean }
  | { ok: false; message: string }
  | { ok: false; needsResolution: true; message: string;
      invoiceNumber: string; totalRows: number; matchedRows: number;
      items: UnmatchedSupplierProduct[] };

export async function importSupplierExcelDraft(
  vendorId: string, file: File,
): Promise<SupplierExcelImportResult> {
  if (!vendorId || !file || !file.name.toLowerCase().endsWith('.xlsx') ||
    file.size === 0 || file.size > 2 * 1024 * 1024)
    return { ok: false, message: 'กรุณาเลือกผู้ขายและไฟล์ Excel (.xlsx) ขนาดไม่เกิน 2 MB' };

  const access = await requireAccess();
  const client = await createClient();
  const warehouseIds = access.warehouses.filter(warehouse => canMutate(warehouse.role))
    .map(warehouse => Number(warehouse.id));
  if (!client || warehouseIds.length === 0)
    return { ok: false, message: 'ไม่มีสิทธิ์รับน้ำยาเข้าคลัง' };

  const { data: vendor, error: vendorError } = await client.from('ci_vendors')
    .select('id').eq('id', vendorId).eq('active', true).maybeSingle();
  if (vendorError || !vendor) return { ok: false, message: 'ไม่พบผู้ขายที่ใช้งานอยู่' };

  let table: unknown[][];
  try {
    const book = new ExcelJS.Workbook();
    // ExcelJS and Node 22 expose incompatible Buffer generic declarations; bytes are a real Node Buffer.
    await book.xlsx.load(Buffer.from(await file.arrayBuffer()) as unknown as Parameters<typeof book.xlsx.load>[0]);
    const sheet = book.getWorksheet('Bill') ?? book.worksheets[0];
    if (!sheet || sheet.rowCount > 501)
      return { ok: false, message: 'ไฟล์ต้องมี Worksheet Bill และรายการไม่เกิน 500 แถว' };
    table = [];
    for (let n = 1; n <= sheet.rowCount; n++) {
      const row = sheet.getRow(n);
      table.push(Array.from({ length: 9 }, (_, index) => {
        const cell = row.getCell(index + 1);
        const value = cell.value;
        if (value instanceof Date || typeof value === 'number' || typeof value === 'string')
          return value;
        // Formula cells with cached results are accepted only when the result is scalar.
        if (value && typeof value === 'object' && 'result' in value) {
          const result = value.result;
          return result instanceof Date || typeof result === 'number' || typeof result === 'string'
            ? result : '';
        }
        return cell.text;
      }));
    }
  } catch {
    return { ok: false, message: 'อ่านไฟล์ Excel ไม่สำเร็จ กรุณาใช้รูปแบบเดียวกับไฟล์ Bill ตัวอย่าง' };
  }
  const parsed = parseSupplierBillTable(table);
  if (!parsed.ok) return parsed;
  const bill = parsed.bill;
  const { data: alreadyReceived, error: duplicateError } = await client.from('ci_invoices')
    .select('id').eq('vendor_id', vendorId).eq('invoice_number', bill.invoiceNumber)
    .neq('status', 'cancelled').limit(1).maybeSingle();
  if (duplicateError) return { ok: false, message: 'ตรวจสอบ Invoice ซ้ำไม่สำเร็จ' };
  if (alreadyReceived) return { ok: false, message: 'Invoice นี้รับเข้าแล้ว กรุณาเปิดประวัติ Invoice เดิม (ห้าม Import ซ้ำ)' };

  // Validate every identifier against APPROVED master-data mappings. Do not create
  // products or silently guess on two different identifiers pointing to different products.
  const [productsQuery, identifiersQuery, locationsQuery] = await Promise.all([
    client.from('ci_products')
      .select('id,warehouse_id,product_code,display_name,default_location_id')
      .eq('active', true).in('warehouse_id', warehouseIds).limit(1000),
    client.from('ci_product_identifiers')
      .select('product_id,kind,value,approved').eq('approved', true)
      .in('kind', ['REF_CURRENT', 'REF_LEGACY', 'MANUFACTURER_BARCODE', 'OTHER']).limit(5000),
    client.from('ci_locations').select('id,warehouse_id')
      .eq('active', true).in('warehouse_id', warehouseIds).limit(1000),
  ]);
  if (productsQuery.error || identifiersQuery.error || locationsQuery.error ||
    !productsQuery.data || !identifiersQuery.data || !locationsQuery.data)
    return { ok: false, message: 'ตรวจสอบทะเบียนสินค้าและ Location ไม่สำเร็จ' };

  const products = new Map<string, SupplierProductMatch>(
    (productsQuery.data as SupplierProductMatch[]).map(product => [product.id, product]));
  const locationWarehouse = new Map(locationsQuery.data.map(loc => [loc.id, loc.warehouse_id]));
  const resolution = resolveSupplierProducts(bill.rows,
    identifiersQuery.data.map(item => ({ ...item, approved: Boolean(item.approved) })),
    products);
  if (resolution.issues.length) {
    return { ok: false, needsResolution: true,
      message: 'พบสินค้าที่ต้องตรวจสอบทะเบียน กรุณาจับคู่ให้ครบก่อนสร้าง Draft',
      invoiceNumber: bill.invoiceNumber, totalRows: bill.rows.length,
      matchedRows: resolution.matched.size, items: resolution.issues };
  }
  const matched = resolution.matched;

  // Reuse the same safe historical Location logic as the existing Receiving Wizard.
  // Reversed receipts and ambiguous latest locations must not be guessed.
  const recentLocations: Record<string, string> = {};
  const history = await client.from('ci_receipt_lines')
    .select('receipt_id,invoice_line_id,location_id,created_at,warehouse_id')
    .in('warehouse_id', warehouseIds).order('created_at', { ascending: false }).limit(500);
  if (!history.error && history.data?.length) {
    const lineIds = [...new Set(history.data.map(item => item.invoice_line_id))];
    const receiptIds = [...new Set(history.data.map(item => item.receipt_id))];
    const [invoiceLines, transactions] = await Promise.all([
      client.from('ci_invoice_lines').select('id,product_id').in('id', lineIds),
      client.from('ci_stock_transactions').select('id,receipt_id')
        .eq('kind', 'receive').in('receipt_id', receiptIds),
    ]);
    if (!invoiceLines.error && !transactions.error) {
      const transactionIds = (transactions.data ?? []).map(item => item.id);
      const reversed = transactionIds.length ? await client.from('ci_stock_transactions')
        .select('source_transaction_id').eq('kind', 'reversal')
        .in('source_transaction_id', transactionIds) : { data: [], error: null };
      if (!reversed.error) {
        const reversedIds = new Set((reversed.data ?? []).map(item => item.source_transaction_id));
        const reversedReceipts = new Set((transactions.data ?? [])
          .filter(item => reversedIds.has(item.id)).map(item => item.receipt_id));
        Object.assign(recentLocations, mostRecentReceivedLocations(
          history.data, invoiceLines.data ?? [], reversedReceipts,
          new Set([...matched.values()].map(product => product.id))));
      }
    }
  }
  const locationByProduct = new Map<string, string>();
  for (const product of matched.values()) {
    const suggestion = product.default_location_id || recentLocations[product.id];
    if (suggestion && locationWarehouse.get(suggestion) === product.warehouse_id)
      locationByProduct.set(product.id, suggestion);
  }

  const grouped = buildImportedWizardLines(bill.rows, matched, locationByProduct, randomUUID);
  if (!grouped.ok) return grouped;
  const header = { vendorId, invoiceNumber: bill.invoiceNumber,
    invoiceDate: bill.invoiceDate, poNumber: bill.poNumber };

  // A submitted Invoice with the same number must never be imported again.
  // This RPC also enforces ownership, active vendor, and duplicate protection.
  const created = await createReceivingWizardDraft(header);
  if (!created.ok) return created;
  if (created.existingInvoice)
    return { ok: false, message: 'Invoice นี้รับเข้าแล้ว กรุณาเปิดประวัติ Invoice เดิม (ห้าม Import ซ้ำ)' };

  const { data: draft, error: draftError } = await client.from('ci_receive_wizard_drafts')
    .select('id,lines').eq('id', created.id).maybeSingle();
  if (draftError || !draft)
    return { ok: false, message: 'สร้าง Draft แล้วแต่ไม่สามารถตรวจสอบข้อมูลเดิมได้ กรุณาเปิดหน้าร่างอีกครั้ง' };
  if (Array.isArray(draft.lines) && draft.lines.length > 0)
    return { ok: true, id: created.id, existingDraft: true };

  const saved = await saveReceivingWizardDraft(created.id, header, grouped.lines, DEFAULT_ASSESSMENT, 2);
  if (!saved.ok)
    return { ok: false, message: 'สร้าง Draft แล้วแต่บันทึกรายการไม่สำเร็จ: ' + saved.message };
  revalidatePath('/receive');
  return { ok: true, id: created.id };
}
