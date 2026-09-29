'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { canSupervise, requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';
import { parseLocationForm } from '@/lib/locations';

export type LocationActionResult = { ok: true; id: string } | { ok: false; message: string; errors?: Record<string, string> };

async function supabaseFor() {
  const access = await requireAccess();
  const supabase = await createClient();
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล');
  return { access, supabase };
}

function refresh(id?: string) {
  revalidatePath('/locations');
  revalidatePath('/receive');
  if (id) revalidatePath(`/locations/${id}`);
}

/** The RPC checks the role again; this only turns an obvious mistake into a clear message before the round trip. */
function supervisorOf(access: Awaited<ReturnType<typeof requireAccess>>, warehouseId: number) {
  const warehouse = access.warehouses.find(item => Number(item.id) === warehouseId);
  return warehouse && canSupervise(warehouse.role) ? warehouse : null;
}

export async function createLocationRecord(form: FormData): Promise<LocationActionResult> {
  const { access, supabase } = await supabaseFor();
  const warehouseId = Number(form.get('warehouse_id'));
  if (!supervisorOf(access, warehouseId)) return { ok: false, message: logUserMessage('createLocation', 'CI_ACCESS_DENIED') };
  const parsed = parseLocationForm(form);
  if (!parsed.ok) return { ok: false, message: 'ตรวจสอบข้อมูลที่ไฮไลต์แล้วลองอีกครั้ง', errors: parsed.errors };
  const { data, error } = await supabase.rpc('ci_create_location_v2', { p: { warehouse_id: warehouseId, ...parsed.value } });
  if (error || !data) return { ok: false, message: logUserMessage('createLocation', error, 'เพิ่มตำแหน่งไม่สำเร็จ กรุณาลองใหม่') };
  refresh(data as string);
  return { ok: true, id: data as string };
}

/** `expectedUpdatedAt` goes back exactly as the page read it: the database compares it for equality to catch concurrent edits. */
export async function updateLocationRecord(id: string, form: FormData, expectedUpdatedAt: string): Promise<LocationActionResult> {
  const { access, supabase } = await supabaseFor();
  const warehouseId = Number(form.get('warehouse_id'));
  if (!supervisorOf(access, warehouseId)) return { ok: false, message: logUserMessage('updateLocation', 'CI_ACCESS_DENIED') };
  const parsed = parseLocationForm(form);
  if (!parsed.ok) return { ok: false, message: 'ตรวจสอบข้อมูลที่ไฮไลต์แล้วลองอีกครั้ง', errors: parsed.errors };
  const { error } = await supabase.rpc('ci_update_location', { p_id: id, p: parsed.value, p_expected_updated_at: expectedUpdatedAt });
  if (error) return { ok: false, message: logUserMessage('updateLocation', error, 'บันทึกตำแหน่งไม่สำเร็จ กรุณาลองใหม่') };
  refresh(id);
  return { ok: true, id };
}

function detailPath(id: string, query: Record<string, string>) {
  const params = new URLSearchParams(query);
  return `/locations/${id}?${params}`;
}
const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

/** Deactivate or reactivate from the detail page. Always answers by redirecting back with a notice. */
export async function setLocationActive(form: FormData): Promise<void> {
  const id = text(form, 'id');
  const active = text(form, 'active') === 'true';
  const { supabase } = await supabaseFor();
  const { error } = await supabase.rpc('ci_set_location_active', { p_id: id, p_active: active, p_reason: text(form, 'reason') });
  if (error) redirect(detailPath(id, { error: logUserMessage('setLocationActive', error) }));
  refresh(id);
  redirect(detailPath(id, { saved: active ? 'เปิดใช้งานตำแหน่งแล้ว' : 'ปิดการใช้งานตำแหน่งแล้ว', at: Date.now().toString(36) }));
}

/** Rotating invalidates every printed QR label for the location, so the reason is recorded in the audit log. */
export async function rotateLocationQr(form: FormData): Promise<void> {
  const id = text(form, 'id');
  const { supabase } = await supabaseFor();
  const { error } = await supabase.rpc('ci_rotate_location_qr_token', { p_id: id, p_reason: text(form, 'reason') });
  if (error) redirect(detailPath(id, { error: logUserMessage('rotateLocationQr', error) }));
  refresh(id);
  redirect(detailPath(id, { saved: 'เปลี่ยน QR ใหม่แล้ว · ป้ายเดิมใช้ไม่ได้อีก กรุณาพิมพ์ป้ายใหม่', at: Date.now().toString(36) }));
}
