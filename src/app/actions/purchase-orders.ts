'use server';

import { revalidatePath } from 'next/cache';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';
import { parseOrderQuantity } from '@/lib/purchase-orders';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Fail = { ok: false; message: string };
const offline: Fail = { ok: false, message: 'เชื่อมต่อระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' };
async function connect() { await requireAccess(); return createClient(); }
function refresh(id?: string) {
  for (const path of ['/purchase-orders', '/purchase-orders/history', '/purchase-orders/templates']) revalidatePath(path);
  if (id) revalidatePath(`/purchase-orders/${id}`);
}

export type SaveOrderInput = { id?: string | null; clientKey: string; templateId?: string | null; confirm: boolean; lines: { productId: string; quantity: string }[] };
export type SaveOrderResult = { ok: true; id: string; status: string; poNumber: string | null; already: boolean } | Fail;

/** Draft save and confirmation share one transaction in the database; the quantities sent are stored exactly. */
export async function savePurchaseOrder(input: SaveOrderInput): Promise<SaveOrderResult> {
  if (input.id && !uuid.test(input.id)) return { ok: false, message: 'ใบสั่งซื้อไม่ถูกต้อง' };
  if (!uuid.test(input.clientKey)) return { ok: false, message: 'ฟอร์มหมดอายุ · โหลดหน้าใหม่แล้วลองอีกครั้ง' };
  if (input.lines.length > 500) return { ok: false, message: 'ใบสั่งซื้อมีรายการได้สูงสุด 500 รายการ' };
  const lines: { product_id: string; order_quantity: number }[] = [];
  for (const line of input.lines) {
    if (!uuid.test(line.productId)) return { ok: false, message: 'รายการน้ำยาไม่ถูกต้อง · โหลดหน้าใหม่' };
    const parsed = parseOrderQuantity(line.quantity);
    if (!parsed.ok) return { ok: false, message: `${parsed.message} · ตรวจรายการที่มีกรอบสีแดง` };
    lines.push({ product_id: line.productId, order_quantity: parsed.value });
  }
  const client = await connect();
  if (!client) return offline;
  const { data, error } = await client.rpc('ci_save_purchase_order', { p_data: {
    id: input.id ?? null, client_key: input.clientKey, template_id: input.templateId && uuid.test(input.templateId) ? input.templateId : null,
    confirm: input.confirm, lines,
  } });
  if (error || !data) return { ok: false, message: logUserMessage('po-save', error, input.confirm ? 'ยืนยันสั่งซื้อไม่สำเร็จ · ยังไม่ได้สร้างใบสั่งซื้อ กรุณาลองใหม่' : 'บันทึกฉบับร่างไม่สำเร็จ กรุณาลองใหม่') };
  const result = data as { id: string; status: string; po_number: string | null; already: boolean };
  refresh(result.id);
  return { ok: true, id: result.id, status: result.status, poNumber: result.po_number, already: result.already };
}

export async function deletePurchaseOrderDraft(id: string): Promise<{ ok: true } | Fail> {
  if (!uuid.test(id)) return { ok: false, message: 'ใบสั่งซื้อไม่ถูกต้อง' };
  const client = await connect(); if (!client) return offline;
  const { error } = await client.rpc('ci_delete_purchase_order_draft', { p_id: id });
  if (error) return { ok: false, message: logUserMessage('po-delete', error, 'ลบฉบับร่างไม่สำเร็จ กรุณาลองใหม่') };
  refresh(); return { ok: true };
}

export async function cancelPurchaseOrder(id: string): Promise<{ ok: true } | Fail> {
  if (!uuid.test(id)) return { ok: false, message: 'ใบสั่งซื้อไม่ถูกต้อง' };
  const client = await connect(); if (!client) return offline;
  const { error } = await client.rpc('ci_cancel_purchase_order', { p_id: id });
  if (error) return { ok: false, message: logUserMessage('po-cancel', error, 'ยกเลิกใบสั่งซื้อไม่สำเร็จ กรุณาลองใหม่') };
  refresh(id); return { ok: true };
}

export async function savePurchaseOrderTemplate(input: { id?: string | null; name: string; productIds: string[]; expectedUpdatedAt?: string | null }): Promise<{ ok: true; id: string } | Fail> {
  const name = input.name.trim();
  if (!name || name.length > 120) return { ok: false, message: 'ตั้งชื่อ Template 1–120 ตัวอักษร' };
  if (input.id && !uuid.test(input.id)) return { ok: false, message: 'Template ไม่ถูกต้อง' };
  if (input.productIds.length > 500 || !input.productIds.every(id => uuid.test(id))) return { ok: false, message: 'รายการน้ำยาไม่ถูกต้อง · โหลดหน้าใหม่' };
  if (new Set(input.productIds).size !== input.productIds.length) return { ok: false, message: 'มีน้ำยาซ้ำในรายการ · นำรายการที่ซ้ำออก' };
  const client = await connect(); if (!client) return offline;
  const payload: Record<string, unknown> = { id: input.id ?? null, name, product_ids: input.productIds };
  if (input.expectedUpdatedAt) payload.expected_updated_at = input.expectedUpdatedAt;
  const { data, error } = await client.rpc('ci_save_purchase_order_template', { p_data: payload });
  if (error || typeof data !== 'string') return { ok: false, message: logUserMessage('po-template-save', error, 'บันทึก Template ไม่สำเร็จ กรุณาลองใหม่') };
  refresh(); revalidatePath(`/purchase-orders/templates/${data}`);
  return { ok: true, id: data };
}

export async function deletePurchaseOrderTemplate(id: string): Promise<{ ok: true } | Fail> {
  if (!uuid.test(id)) return { ok: false, message: 'Template ไม่ถูกต้อง' };
  const client = await connect(); if (!client) return offline;
  const { error } = await client.rpc('ci_delete_purchase_order_template', { p_id: id });
  if (error) return { ok: false, message: logUserMessage('po-template-delete', error, 'ลบ Template ไม่สำเร็จ กรุณาลองใหม่') };
  refresh(); return { ok: true };
}
