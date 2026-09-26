'use server';

import { parseBarcode, type ParsedBarcode } from '@/lib/barcode';
import { requireAccess, canMutate } from '@/lib/auth';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';
import { locationQrScan, looksLikeLocationQr } from '@/lib/location-qr';

export type ScanResolution = { parsed: ParsedBarcode; locationQr?: { path: string | null }; productId?: string; productCode?: string; invoiceLineId?: string; message?: string; scanId?: string; otherWarehouse?: boolean };

/** Approved identifier matches for a scan as product id -> warehouse id. */
async function matchApprovedIdentifiers(client: SupabaseClient, parsed: ParsedBarcode, raw: string) {
  const candidates: { kind: string; value: string }[] = [];
  if (parsed.gtin) candidates.push({ kind: 'GTIN', value: parsed.gtin }, { kind: 'MANUFACTURER_BARCODE', value: parsed.gtin });
  if (parsed.primary) candidates.push({ kind: 'HIBC_PRIMARY', value: parsed.primary });
  if (parsed.additionalProductId) candidates.push({ kind: 'GS1_AI240', value: parsed.additionalProductId });
  candidates.push({ kind: 'MANUFACTURER_BARCODE', value: raw.trim() });
  const matches = await Promise.all(candidates.map(async ({ kind, value }) => {
    const { data, error } = await client.from('ci_product_identifiers').select('product_id,warehouse_id').eq('kind',kind).eq('value',value).eq('approved',true).limit(2);
    if (error) throw new Error(logUserMessage('scanner', error));
    return data ?? [];
  }));
  const ids = new Map<string, number>();
  for (const item of matches.flat()) ids.set(item.product_id, Number(item.warehouse_id));
  return ids;
}

export async function resolveScan(raw: string, symbology: string, warehouseId: number, invoiceId?: string): Promise<ScanResolution> {
  const access = await requireAccess();
  const selected = access.warehouses.find(w => Number(w.id) === warehouseId);
  if (!selected || !canMutate(selected.role)) throw new Error('CI_ACCESS_DENIED');
  const locationQr = locationQrScan(raw, symbology);
  if (locationQr) return locationQr;
  const client = await createClient();
  if (!client) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล');
  const parsed = parseBarcode(raw, symbology);
  const ids = await matchApprovedIdentifiers(client, parsed, raw);
  const result: ScanResolution = { parsed };
  if (ids.size === 1) {
    const [productId, matchedWarehouseId] = [...ids][0];
    if (matchedWarehouseId !== warehouseId) { result.otherWarehouse = true; result.message = 'Barcode นี้เป็นสินค้าของอีกคลัง · สลับคลังก่อนทำรายการ'; }
    else {
      const { data: product } = await client.from('ci_products').select('product_code').eq('id',productId).maybeSingle();
      result.productId = productId;
      result.productCode = product?.product_code;
      if (invoiceId) {
        const { data: line } = await client.from('ci_invoice_lines').select('id').eq('invoice_id',invoiceId).eq('product_id',productId).limit(1).maybeSingle();
        if (line) result.invoiceLineId = line.id;
        else result.message = 'สินค้าจาก Barcode นี้ไม่อยู่ใน Invoice นี้';
      }
    }
  } else result.message = ids.size ? 'Barcode ตรงกับหลายสินค้า · ต้องให้หัวหน้างานตรวจสอบ' : 'ไม่พบสินค้าที่ตรงกับ Barcode';
  const { data: scanId, error: scanError } = await client.rpc('ci_record_scan', { p_data: {
    warehouse_id: warehouseId, invoice_id: invoiceId ?? null, invoice_line_id: result.invoiceLineId ?? null,
    raw_payload: raw, symbology, parsed_fields: parsed, parse_warnings: parsed.warnings,
  } });
  if (scanError) throw new Error(logUserMessage('scanner', scanError));
  result.scanId = scanId;
  return result;
}

export async function proposeScanMapping(productId: string, kind: string, value: string, raw: string) {
  await requireAccess();
  // Server-side backstop for the scanner guard: a Location QR must never be proposed as a product barcode, whatever the client sent.
  if (looksLikeLocationQr(raw) || looksLikeLocationQr(value)) throw new Error('CI_LOCATION_QR_NOT_A_BARCODE');
  const client = await createClient();
  if (!client) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล');
  const { data, error } = await client.rpc('ci_propose_identifier_mapping', { p_product_id: productId, p_kind: kind, p_value: value, p_raw: raw });
  if (error) throw new Error(logUserMessage('scanner', error));
  return data as string;
}

export async function decideScanMapping(id: string, approve: boolean, reason: string) {
  await requireAccess();
  const client = await createClient();
  if (!client) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล');
  const { error } = await client.rpc('ci_decide_identifier_mapping', { p_id: id, p_approve: approve, p_reason: reason });
  if (error) throw new Error(logUserMessage('scanner', error));
}

export async function checkLotExpiryConflict(productId: string, lot: string, expiry: string) {
  await requireAccess();
  const client = await createClient();
  if (!client) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล');
  const { data, error } = await client.from('ci_stock_lots').select('expiry_date').eq('product_id',productId).eq('lot_number',lot).maybeSingle();
  if (error) throw new Error(logUserMessage('scanner', error));
  return data ? data.expiry_date !== expiry : false;
}

export async function registerInvoiceAttachment(invoiceId: string, warehouseId: number, file: { type: string; size: number }) {
  await requireAccess();
  const client = await createClient();
  if (!client) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล');
  const { data, error } = await client.rpc('ci_register_invoice_attachment', { p_invoice_id: invoiceId, p_warehouse_id: warehouseId, p_type: 'invoice_photo', p_mime: file.type, p_size: file.size });
  if (error || !data?.[0]) throw new Error(logUserMessage('scanner', error, 'บันทึกภาพเอกสารไม่สำเร็จ'));
  const { data: upload, error: uploadError } = await client.storage.from('ci-invoice-evidence').createSignedUploadUrl(data[0].object_key);
  if (uploadError || !upload) throw new Error(logUserMessage('scanner', uploadError, 'ขอสิทธิ์อัปโหลดภาพไม่สำเร็จ'));
  return { ...(data[0] as { attachment_id: string; object_key: string }), token: upload.token };
}

export async function removeInvoiceAttachment(attachmentId: string) {
  await requireAccess();
  const client = await createClient();
  if (!client) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล');
  const { data: attachment, error: lookupError } = await client.from('ci_attachments').select('object_key').eq('id',attachmentId).maybeSingle();
  if (lookupError || !attachment) throw new Error(logUserMessage('scanner', lookupError, 'ไม่พบเอกสารแนบ'));
  const { error: storageError } = await client.storage.from('ci-invoice-evidence').remove([attachment.object_key]);
  if (storageError) throw new Error(logUserMessage('scanner', storageError));
  const { error } = await client.rpc('ci_delete_invoice_attachment',{p_id:attachmentId});
  if (error) throw new Error(logUserMessage('scanner', error));
}

export type ProductScan = { parsed: ParsedBarcode; locationQr?: { path: string | null }; product?: { id: string; code: string; name: string; warehouseId: number }; message?: string };

/** Resolves a scan to a product in any warehouse the user can receive into, for building an invoice before it exists. */
export async function resolveProductScan(raw: string, symbology: string): Promise<ProductScan> {
  const access = await requireAccess();
  const writable = access.warehouses.filter(w => canMutate(w.role)).map(w => Number(w.id));
  if (!writable.length) throw new Error('CI_ACCESS_DENIED');
  const locationQr = locationQrScan(raw, symbology);
  if (locationQr) return locationQr;
  const client = await createClient();
  if (!client) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล');
  const parsed = parseBarcode(raw, symbology);
  const ids = await matchApprovedIdentifiers(client, parsed, raw);
  const result: ProductScan = { parsed };
  if (ids.size === 1) {
    const [productId, warehouseId] = [...ids][0];
    if (!writable.includes(warehouseId)) result.message = 'Barcode นี้เป็นของคลังที่บัญชีนี้ไม่มีสิทธิ์รับเข้า';
    else {
      const { data: product } = await client.from('ci_products').select('id,product_code,display_name,warehouse_id').eq('id', productId).maybeSingle();
      if (product) result.product = { id: product.id, code: product.product_code, name: product.display_name, warehouseId: Number(product.warehouse_id) };
    }
  } else result.message = ids.size ? 'Barcode ตรงกับหลายสินค้า · ต้องให้หัวหน้างานตรวจสอบ' : 'ไม่พบสินค้าที่ตรงกับ Barcode · เลือกสินค้าเอง';
  const { error } = await client.rpc('ci_record_scan', { p_data: {
    warehouse_id: result.product?.warehouseId ?? writable[0], invoice_id: null, invoice_line_id: null,
    raw_payload: raw, symbology, parsed_fields: parsed, parse_warnings: parsed.warnings,
  } });
  if (error) throw new Error(logUserMessage('scanner', error));
  return result;
}
