'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';

function value(form: FormData, key: string) { return String(form.get(key) ?? '').trim(); }
function fail(path: string, message: string): never { redirect(`${path}${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(message)}`); }
function success(path: string): never { revalidatePath(path.split('?')[0]); redirect(`${path}${path.includes('?') ? '&' : '?'}saved=1`); }
async function clientOrFail(path: string) { await requireAccess(); const client = await createClient(); if (!client) fail(path,'ยังไม่ได้ตั้งค่า Supabase'); return client; }

export async function createVendor(form: FormData) {
  const client = await clientOrFail('/receive');
  const name = value(form,'name');
  if (!name) fail('/receive','กรุณาระบุชื่อผู้ขาย');
  const { error } = await client.rpc('ci_create_vendor',{ p_name: name });
  if (error) fail('/receive',error.message);
  success('/receive');
}

export async function createLocation(form: FormData) {
  const client = await clientOrFail('/receive');
  const warehouseId = Number(value(form,'warehouse_id'));
  const code = value(form,'code');
  const name = value(form,'name');
  if (!code || !name || ![1,2].includes(warehouseId)) fail('/receive','ข้อมูลตำแหน่งไม่ครบ');
  const { error } = await client.rpc('ci_create_location',{ p_warehouse_id: warehouseId, p_code: code, p_name: name });
  if (error) fail('/receive',error.message);
  success('/receive');
}

export async function createInvoice(form: FormData) {
  const client = await clientOrFail('/receive');
  const products = form.getAll('product_id').map(String);
  const quantities = form.getAll('quantity').map(String);
  const lines = products.flatMap((product_id,i) => product_id && quantities[i] && Number(quantities[i]) > 0 ? [{ product_id, quantity: quantities[i] }] : []);
  if (!lines.length) fail('/receive','กรุณาเพิ่มสินค้าอย่างน้อยหนึ่งรายการ');
  const payload = { vendor_id: value(form,'vendor_id'), invoice_number: value(form,'invoice_number'), invoice_date: value(form,'invoice_date'), po_number: value(form,'po_number') || null, lines };
  const { data: existing } = await client.from('ci_invoices').select('id').eq('vendor_id',payload.vendor_id).eq('invoice_number',payload.invoice_number).limit(1).maybeSingle();
  if (existing) redirect(`/receive?invoice=${existing.id}`);
  const { data, error } = await client.rpc('ci_create_invoice',{ p_data: payload });
  if (error || !data) fail('/receive',error?.message ?? 'สร้าง invoice ไม่สำเร็จ');
  revalidatePath('/receive');
  redirect(`/receive?invoice=${data}`);
}

export async function confirmReceipt(form: FormData) {
  const invoiceId = value(form,'invoice_id');
  const path = `/receive?invoice=${invoiceId}`;
  const client = await clientOrFail(path);
  const ids = form.getAll('invoice_line_id').map(String);
  const quantities = form.getAll('quantity').map(String);
  const lots = form.getAll('lot_number').map(String);
  const expiries = form.getAll('expiry_date').map(String);
  const locations = form.getAll('location_id').map(String);
  const lines = ids.flatMap((invoice_line_id,i) => quantities[i] && Number(quantities[i]) > 0 ? [{ invoice_line_id, quantity: quantities[i], lot_number: lots[i], expiry_date: expiries[i], location_id: locations[i] }] : []);
  if (!lines.length) fail(path,'กรุณากรอกจำนวนที่รับอย่างน้อยหนึ่งรายการ');
  if (lines.some(line => !line.lot_number || !line.expiry_date || !line.location_id)) fail(path,'รายการที่รับต้องมี LOT วันหมดอายุ และตำแหน่ง');
  const assessment = Object.fromEntries(['correct_product','correct_quantity','packaging_ok','temperature_required','temperature_ok','shelf_life_ok','documentation_complete','delivery_discrepancy'].map(key => [key, value(form,key) === '' ? null : value(form,key) === 'yes']));
  const required = ['correct_product','correct_quantity','packaging_ok','temperature_required','shelf_life_ok','documentation_complete','delivery_discrepancy'];
  if (required.some(key => value(form,key) === '')) fail(path,'กรุณาบันทึกผลตรวจรับก่อนยืนยัน');
  if (value(form,'temperature_required') === 'yes' && value(form,'temperature_ok') === '') fail(path,'กรุณาบันทึกผลอุณหภูมิ');
  const { error } = await client.rpc('ci_confirm_receipt_assessed',{ p_invoice_id: invoiceId, p_lines: lines, p_idempotency_key: value(form,'idempotency_key'), p_assessment: { ...assessment, notes: value(form,'assessment_notes') || null } });
  if (error) fail(path,error.message);
  success(path);
}

export async function issueStock(form: FormData) {
  const client = await clientOrFail('/issue');
  const purpose = value(form,'purpose');
  if (!['Routine','QC','Calibration','Verification/Validation','Repeat/Troubleshooting','Waste','Other'].includes(purpose)) fail('/issue','Purpose ไม่ถูกต้อง');
  const payload = { product_id: value(form,'product_id'), lot_id: value(form,'lot_id'), location_id: value(form,'location_id'), quantity: value(form,'quantity'), purpose, override_reason: value(form,'override_reason') || null, idempotency_key: value(form,'idempotency_key') };
  const { error } = await client.rpc('ci_issue_stock',{ p_data: payload });
  if (error) fail('/issue',error.message);
  success('/issue');
}

export async function transferStock(form: FormData) {
  const client = await clientOrFail('/transfer');
  const payload = { lot_id: value(form,'lot_id'), from_location_id: value(form,'from_location_id'), to_location_id: value(form,'to_location_id'), quantity: value(form,'quantity'), idempotency_key: value(form,'idempotency_key') };
  const { error } = await client.rpc('ci_transfer_stock',{ p_data: payload });
  if (error) fail('/transfer',error.message);
  success('/transfer');
}

export async function adjustStock(form: FormData) {
  const client = await clientOrFail('/adjust');
  const payload = { lot_id: value(form,'lot_id'), location_id: value(form,'location_id'), quantity_delta: value(form,'quantity_delta'), reason: value(form,'reason'), idempotency_key: value(form,'idempotency_key') };
  const { error } = await client.rpc('ci_adjust_stock',{ p_data: payload });
  if (error) fail('/adjust',error.message);
  success('/adjust');
}

export async function disposeExpired(form: FormData) {
  const client = await clientOrFail('/dispose');
  const payload = { lot_id: value(form,'lot_id'), location_id: value(form,'location_id'), quantity: value(form,'quantity'), reason: value(form,'reason'), idempotency_key: value(form,'idempotency_key') };
  const { error } = await client.rpc('ci_dispose_expired_stock',{ p_data: payload });
  if (error) fail('/dispose',error.message);
  success('/dispose');
}

export async function reverseTransaction(form: FormData) {
  const client = await clientOrFail('/movements');
  const { error } = await client.rpc('ci_reverse_transaction',{ p_source_id: value(form,'source_id'), p_reason: value(form,'reason'), p_idempotency_key: value(form,'idempotency_key') });
  if (error) fail('/movements',error.message);
  success('/movements');
}

export async function createCount(form: FormData) {
  const client = await clientOrFail('/counts');
  const warehouseId = Number(value(form,'warehouse_id'));
  const { data: balances, error: readError } = await client.from('ci_stock_balances').select('lot_id,location_id,balance').eq('warehouse_id',warehouseId).gt('balance',0).limit(1000);
  if (readError) fail('/counts',readError.message);
  if (!balances?.length) fail('/counts','ไม่มี LOT คงเหลือสำหรับ snapshot');
  const { data, error } = await client.rpc('ci_create_stock_count',{ p_data: { warehouse_id: warehouseId, note: value(form,'note'), lines: balances.map(b => ({ lot_id: b.lot_id, location_id: b.location_id })) } });
  if (error || !data) fail('/counts',error?.message ?? 'สร้าง snapshot ไม่สำเร็จ');
  revalidatePath('/counts');
  redirect(`/counts/${data}`);
}

export async function setCountLine(form: FormData) {
  const countId = value(form,'count_id');
  const client = await clientOrFail(`/counts/${countId}`);
  const { error } = await client.rpc('ci_set_stock_count_line',{ p_line_id: value(form,'line_id'), p_physical_quantity: Number(value(form,'physical_quantity')) });
  if (error) fail(`/counts/${countId}`,error.message);
  success(`/counts/${countId}`);
}

export async function approveCount(form: FormData) {
  const countId = value(form,'count_id');
  const client = await clientOrFail(`/counts/${countId}`);
  const { error } = await client.rpc('ci_approve_stock_count',{ p_count_id: countId, p_reason: value(form,'reason') });
  if (error) fail(`/counts/${countId}`,error.message);
  success(`/counts/${countId}`);
}
