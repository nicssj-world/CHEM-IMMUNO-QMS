'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';
import { safeReturnPath } from '@/lib/return-path';
import { cleanVendorInput, vendorInputError } from '@/lib/vendors';
import { ISSUE_FILE_MAX_BYTES, ISSUE_FILE_TYPES, VENDOR_ISSUE_BUCKET } from '@/lib/vendor-issues';
import { assessmentError, parseAssessment, toAssessmentPayload } from '@/lib/receipt-assessment';

export type VendorActionResult = { ok: true; id: string } | { ok: false; message: string };

async function client() {
  await requireAccess();
  const supabase = await createClient();
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล');
  return supabase;
}

export async function createVendorRecord(raw: unknown): Promise<VendorActionResult> {
  const input = cleanVendorInput(raw);
  const problem = vendorInputError(input);
  if (problem) return { ok: false, message: problem };
  const supabase = await client();
  const { data, error } = await supabase.rpc('ci_create_vendor', { p_data: input });
  if (error || !data) return { ok: false, message: logUserMessage('createVendor', error, 'เพิ่มผู้ขายไม่สำเร็จ กรุณาลองใหม่') };
  revalidatePath('/vendors');
  revalidatePath('/receive');
  return { ok: true, id: data as string };
}

/** `expectedUpdatedAt` goes back exactly as the page read it: the database compares it for equality to catch concurrent edits. */
export async function updateVendorRecord(id: string, raw: unknown, expectedUpdatedAt: string): Promise<VendorActionResult> {
  const input = cleanVendorInput(raw);
  const problem = vendorInputError(input);
  if (problem) return { ok: false, message: problem };
  const supabase = await client();
  const { error } = await supabase.rpc('ci_update_vendor', { p_id: id, p_data: input, p_expected_updated_at: expectedUpdatedAt });
  if (error) return { ok: false, message: logUserMessage('updateVendor', error, 'บันทึกข้อมูลผู้ขายไม่สำเร็จ กรุณาลองใหม่') };
  revalidatePath('/vendors');
  revalidatePath(`/vendors/${id}`);
  return { ok: true, id };
}

export async function setVendorActive(id: string, active: boolean, note: string): Promise<VendorActionResult> {
  if (!active && !note.trim()) return { ok: false, message: 'กรุณาระบุเหตุผลที่ปิดการใช้งาน' };
  const supabase = await client();
  const { error } = await supabase.rpc('ci_set_vendor_active', { p_id: id, p_active: active, p_note: note.trim() || null });
  if (error) return { ok: false, message: logUserMessage('setVendorActive', error, 'เปลี่ยนสถานะผู้ขายไม่สำเร็จ กรุณาลองใหม่') };
  revalidatePath('/vendors');
  revalidatePath(`/vendors/${id}`);
  return { ok: true, id };
}

export async function closeInvoiceShort(form: FormData) {
  const invoiceId = String(form.get('invoice_id') ?? '');
  const back = safeReturnPath(`/receive?invoice=${encodeURIComponent(invoiceId)}`) ?? '/receive';
  const reason = String(form.get('reason') ?? '').trim();
  const fail = (message: string): never => redirect(`${back}&error=${encodeURIComponent(message)}`);
  if (!reason) fail('กรุณาระบุเหตุผลที่ปิด Invoice แบบรับไม่ครบ');
  const supabase = await client();
  const { error } = await supabase.rpc('ci_close_invoice_short', { p_invoice_id: invoiceId, p_reason: reason });
  if (error) fail(logUserMessage('closeInvoiceShort', error));
  revalidatePath('/receive');
  redirect(`${back}&saved=${encodeURIComponent('ปิด Invoice แบบรับไม่ครบแล้ว')}&at=${Date.now().toString(36)}`);
}

// ---- Vendor issues (LABCBH VendorIssuePanel actions) ----------------------------------------------------------

export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; message: string };
const done = <T,>(data: T): ActionResult<T> => ({ ok: true, data });
const problem = (message: string): ActionResult<never> => ({ ok: false, message });

export async function openVendorIssue(input: { vendorId: string; warehouseId: number; issueType: string; description: string; invoiceId: string | null }): Promise<ActionResult> {
  if (!input.description.trim()) return problem('กรุณาระบุรายละเอียดปัญหา');
  const supabase = await client();
  const { error } = await supabase.rpc('ci_open_vendor_issue', { p_vendor_id: input.vendorId, p_warehouse_id: input.warehouseId, p_issue_type: input.issueType, p_description: input.description, p_invoice_id: input.invoiceId });
  if (error) return problem(logUserMessage('openVendorIssue', error, 'บันทึกปัญหาผู้ขายไม่สำเร็จ'));
  revalidatePath('/vendors'); revalidatePath('/receive');
  return done(null);
}

export async function resolveVendorIssueAction(id: string, action: string, note: string): Promise<ActionResult> {
  if (!note.trim()) return problem('กรุณาระบุรายละเอียดการแก้ไข');
  const supabase = await client();
  const { error } = await supabase.rpc('ci_resolve_vendor_issue', { p_id: id, p_action: action, p_note: note });
  if (error) return problem(logUserMessage('resolveVendorIssue', error, 'บันทึกการแก้ไขปัญหาไม่สำเร็จ'));
  revalidatePath('/vendors'); revalidatePath('/receive');
  return done(null);
}

export async function cancelVendorIssueAction(id: string, reason: string, note: string): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc('ci_cancel_vendor_issue', { p_id: id, p_reason: reason, p_note: note.trim() || null });
  if (error) return problem(logUserMessage('cancelVendorIssue', error, 'ยกเลิกปัญหาไม่สำเร็จ'));
  revalidatePath('/vendors'); revalidatePath('/receive');
  return done(null);
}

/** Registers the file row and returns a one-time signed upload token; the browser then uploads straight to private storage. */
export async function prepareIssueAttachment(issueId: string, file: { name: string; type: string; size: number }): Promise<ActionResult<{ attachmentId: string; path: string; token: string }>> {
  if (!(ISSUE_FILE_TYPES as readonly string[]).includes(file.type)) return problem('รองรับเฉพาะ PDF, JPG, PNG และ WebP');
  if (file.size < 1 || file.size > ISSUE_FILE_MAX_BYTES) return problem('ไฟล์หลักฐานต้องมีขนาดไม่เกิน 10 MB');
  const supabase = await client();
  const { data, error } = await supabase.rpc('ci_register_vendor_issue_attachment', { p_issue_id: issueId, p_file_name: file.name.slice(0, 255), p_mime: file.type, p_size: file.size });
  if (error || !data) return problem(logUserMessage('prepareIssueAttachment', error, 'เตรียมอัปโหลดหลักฐานไม่สำเร็จ'));
  const ticket = data as { attachment_id: string; object_key: string };
  const { data: upload, error: uploadError } = await supabase.storage.from(VENDOR_ISSUE_BUCKET).createSignedUploadUrl(ticket.object_key);
  if (uploadError || !upload) {
    await supabase.rpc('ci_remove_vendor_issue_attachment', { p_id: ticket.attachment_id });
    return problem(logUserMessage('prepareIssueAttachment', uploadError, 'ขอสิทธิ์อัปโหลดหลักฐานไม่สำเร็จ'));
  }
  return done({ attachmentId: ticket.attachment_id, path: ticket.object_key, token: upload.token });
}

/** Called when the browser upload failed after the row was registered, so no dangling evidence row is left. */
export async function removeIssueAttachment(attachmentId: string): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc('ci_remove_vendor_issue_attachment', { p_id: attachmentId });
  if (error) return problem(logUserMessage('removeIssueAttachment', error));
  revalidatePath('/vendors');
  return done(null);
}

export async function finishIssueAttachment(): Promise<ActionResult> {
  revalidatePath('/vendors'); revalidatePath('/receive');
  return done(null);
}

// ---- Receipt assessment revision -----------------------------------------------------------------------------

export async function reviseReceiptAssessment(assessmentId: string, raw: string): Promise<ActionResult> {
  const assessment = parseAssessment(raw);
  if (!assessment) return problem('ข้อมูลผลตรวจรับไม่ถูกต้อง');
  const invalid = assessmentError(assessment);
  if (invalid) return problem(invalid);
  const supabase = await client();
  const { error } = await supabase.rpc('ci_update_receipt_assessment', { p_assessment_id: assessmentId, p_data: toAssessmentPayload(assessment) });
  if (error) return problem(logUserMessage('reviseReceiptAssessment', error, 'แก้ไขผลตรวจรับไม่สำเร็จ'));
  revalidatePath('/vendors'); revalidatePath('/receive');
  return done(null);
}
