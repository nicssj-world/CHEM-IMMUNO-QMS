'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';
import { safeReturnPath } from '@/lib/return-path';
import { assessmentError, parseAssessment, toAssessmentPayload } from '@/lib/receipt-assessment';

function value(form: FormData, key: string) { return String(form.get(key) ?? '').trim(); }
/** Rebuilds the page URL from hidden form fields, so a redirect lands on the same warehouse (and product) the user was working in. */
function pageOf(base: string, form: FormData, keys: string[] = ['warehouse']) {
  const query = new URLSearchParams();
  for (const key of keys) { const v = value(form, key); if (v) query.set(key, v); }
  return query.size ? `${base}?${query}` : base;
}
function fail(path: string, message: string): never { redirect(`${path}${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(logUserMessage(path, message))}`); }
/** `summary` says what was saved; `at` makes every success a new URL so client drafts know to reset. */
function success(path: string, summary = '1'): never { revalidatePath(path.split('?')[0]); redirect(`${path}${path.includes('?') ? '&' : '?'}saved=${encodeURIComponent(summary)}&at=${Date.now().toString(36)}`); }
async function clientOrFail(path: string) { await requireAccess(); const client = await createClient(); if (!client) fail(path,'ยังไม่ได้ตั้งค่า Supabase'); return client; }

/** Master-data forms live on their own pages but can be opened from receiving; `return_to` brings the user back there. */
function returnTo(form: FormData, fallback: string) { return safeReturnPath(value(form,'return_to')) ?? fallback; }

export async function createLocation(form: FormData) {
  const page = pageOf('/locations', form);
  const back = returnTo(form, page);
  const client = await clientOrFail(page);
  const warehouseId = Number(value(form,'warehouse_id'));
  const code = value(form,'code');
  const name = value(form,'name');
  if (!code || !name || ![1,2].includes(warehouseId)) fail(page,'กรุณาระบุรหัสและชื่อตำแหน่ง');
  const { error } = await client.rpc('ci_create_location',{ p_warehouse_id: warehouseId, p_code: code, p_name: name });
  if (error) fail(page,error.message);
  revalidatePath('/receive');
  success(back,`เพิ่มตำแหน่ง ${code}`);
}

export type StartInvoiceResult = { ok: true; invoiceId: string; existing: boolean } | { ok: false; message: string };

/** Creates the invoice from scanned/selected lines and returns its id; an existing vendor + number reopens that invoice. */
export async function startInvoice(input: { vendorId: string; invoiceNumber: string; invoiceDate: string; poNumber: string; lines: { productId: string; quantity: number }[] }): Promise<StartInvoiceResult> {
  await requireAccess();
  const client = await createClient();
  if (!client) return { ok: false, message: 'ยังไม่ได้ตั้งค่า Supabase' };
  const totals = new Map<string, number>();
  for (const line of input.lines) if (line.productId && Number.isFinite(line.quantity) && line.quantity > 0) totals.set(line.productId, Math.round(((totals.get(line.productId) ?? 0) + line.quantity) * 1000) / 1000);
  if (!totals.size) return { ok: false, message: 'กรุณาเพิ่มสินค้าอย่างน้อยหนึ่งรายการ' };
  const invoiceNumber = input.invoiceNumber.trim();
  if (!input.vendorId || !invoiceNumber || !input.invoiceDate) return { ok: false, message: 'กรุณากรอกผู้ขาย เลขที่ Invoice และวันที่' };
  const { data: existing } = await client.from('ci_invoices').select('id').eq('vendor_id', input.vendorId).eq('invoice_number', invoiceNumber).limit(1).maybeSingle();
  if (existing) return { ok: true, invoiceId: existing.id, existing: true };
  const payload = { vendor_id: input.vendorId, invoice_number: invoiceNumber, invoice_date: input.invoiceDate, po_number: input.poNumber.trim() || null, lines: [...totals].map(([product_id, quantity]) => ({ product_id, quantity: String(quantity) })) };
  const { data, error } = await client.rpc('ci_create_invoice', { p_data: payload });
  if (error || !data) return { ok: false, message: logUserMessage('startInvoice', error, 'สร้าง Invoice ไม่สำเร็จ') };
  revalidatePath('/receive');
  return { ok: true, invoiceId: data as string, existing: false };
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
  // Same rules as the form and the database (see lib/receipt-assessment.ts); checked here so a bad post never reaches the RPC.
  const assessment = parseAssessment(value(form,'assessment'));
  if (!assessment) fail(path,'กรุณาบันทึกผลตรวจรับก่อนยืนยัน');
  const assessmentProblem = assessmentError(assessment);
  if (assessmentProblem) fail(path,assessmentProblem);
  const { error } = await client.rpc('ci_confirm_receipt_assessed',{ p_invoice_id: invoiceId, p_lines: lines, p_idempotency_key: value(form,'idempotency_key'), p_assessment: toAssessmentPayload(assessment) });
  if (error) fail(path,error.message);
  success(path,`รับเข้า ${lines.length} แพ็กเกจ`);
}

export async function issueStock(form: FormData) {
  const back = pageOf('/issue', form, ['warehouse','product','lot']);
  const client = await clientOrFail(back);
  const purpose = value(form,'purpose');
  if (!['Routine','QC','Calibration','Verification/Validation','Repeat/Troubleshooting','Waste','Other'].includes(purpose)) fail(back,'กรุณาเลือกวัตถุประสงค์การเบิก');
  const payload = { product_id: value(form,'product_id'), lot_id: value(form,'lot_id'), location_id: value(form,'location_id'), quantity: value(form,'quantity'), purpose, override_reason: value(form,'override_reason') || null, idempotency_key: value(form,'idempotency_key') };
  const { error } = await client.rpc('ci_issue_stock',{ p_data: payload });
  if (error) fail(back,error.message);
  success(pageOf('/issue', form),`${value(form,'summary')} × ${value(form,'quantity')}`);
}

export async function transferStock(form: FormData) {
  const back = pageOf('/transfer', form, ['warehouse','product']);
  const client = await clientOrFail(back);
  const payload = { lot_id: value(form,'lot_id'), from_location_id: value(form,'from_location_id'), to_location_id: value(form,'to_location_id'), quantity: value(form,'quantity'), idempotency_key: value(form,'idempotency_key') };
  const { error } = await client.rpc('ci_transfer_stock',{ p_data: payload });
  if (error) fail(back,error.message);
  success(back,`${value(form,'summary')} × ${value(form,'quantity')}`);
}

export async function adjustStock(form: FormData) {
  const back = pageOf('/adjust', form, ['warehouse','product']);
  const client = await clientOrFail(back);
  const payload = { lot_id: value(form,'lot_id'), location_id: value(form,'location_id'), quantity_delta: value(form,'quantity_delta'), reason: value(form,'reason'), idempotency_key: value(form,'idempotency_key') };
  const { error } = await client.rpc('ci_adjust_stock',{ p_data: payload });
  if (error) fail(back,error.message);
  success(back,`${value(form,'summary')} · ${Number(value(form,'quantity_delta')) > 0 ? '+' : ''}${value(form,'quantity_delta')}`);
}

export async function disposeExpired(form: FormData) {
  const back = pageOf('/dispose', form);
  const client = await clientOrFail(back);
  const payload = { lot_id: value(form,'lot_id'), location_id: value(form,'location_id'), quantity: value(form,'quantity'), reason: value(form,'reason'), idempotency_key: value(form,'idempotency_key') };
  const { error } = await client.rpc('ci_dispose_expired_stock',{ p_data: payload });
  if (error) fail(back,error.message);
  success(back,`${value(form,'summary')} × ${value(form,'quantity')}`);
}

export async function reverseTransaction(form: FormData) {
  const back = pageOf('/movements', form);
  const client = await clientOrFail(back);
  const { error } = await client.rpc('ci_reverse_transaction',{ p_source_id: value(form,'source_id'), p_reason: value(form,'reason'), p_idempotency_key: value(form,'idempotency_key') });
  if (error) fail(back,error.message);
  success(back);
}

export async function createCount(form: FormData) {
  const back = pageOf('/counts', form);
  const client = await clientOrFail(back);
  const warehouseId = Number(value(form,'warehouse_id'));
  // PostgREST caps a response at 1000 rows; a count snapshot must cover every LOT × location, so read page by page.
  const balances: { lot_id: string; location_id: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error: readError } = await client.from('ci_stock_balances').select('lot_id,location_id').eq('warehouse_id',warehouseId).gt('balance',0).order('lot_id').order('location_id').range(from,from+999);
    if (readError) fail(back,readError.message);
    balances.push(...(page ?? []));
    if (!page || page.length < 1000) break;
  }
  if (!balances.length) fail(back,'ไม่มี LOT คงเหลือสำหรับเริ่มรอบนับ');
  const { data, error } = await client.rpc('ci_create_stock_count',{ p_data: { warehouse_id: warehouseId, note: value(form,'note'), lines: balances } });
  if (error || !data) fail(back,error?.message ?? 'เริ่มรอบนับไม่สำเร็จ');
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
