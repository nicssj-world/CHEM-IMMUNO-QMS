'use server';

import { revalidatePath } from 'next/cache';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';
import { isLocationQrToken } from '@/lib/location-qr';

export type EnvironmentActionResult = { ok: true; reading: { id: string; overall_status: string; excursion_id: string | null; temperature_status: string; humidity_status: string } } | { ok: false; message: string };
type SavedReading = Extract<EnvironmentActionResult, { ok: true }>['reading'];
const clean = (value: string | null | undefined) => value?.trim() || null;

export async function resolveEnvironmentToken(token: string): Promise<{ ok: true; path: string } | { ok: false; message: string; path?: string }> {
  const access = await requireAccess();
  if (!isLocationQrToken(token)) return { ok: false, message: 'QR นี้ไม่ใช่ QR ตำแหน่งจัดเก็บ' };
  const client = await createClient();
  if (!client) return { ok: false, message: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล' };
  const { data: location } = await client.from('ci_locations').select('id,warehouse_id,active').eq('qr_token', token).maybeSingle();
  const warehouse = location && access.warehouses.find(item => Number(item.id) === location.warehouse_id);
  if (!location || !warehouse) return { ok: false, message: 'ไม่พบตำแหน่งนี้ หรือคุณไม่มีสิทธิ์เข้าถึง' };
  const { data: monitorId, error } = await client.rpc('ci_environment_monitor_location_id', { p_location_id: location.id });
  if (error) return { ok: false, message: logUserMessage('resolveEnvironmentToken', error) };
  if (!monitorId) return { ok: false, message: 'ตำแหน่งนี้ไม่มีการเฝ้าระวังอุณหภูมิ/ความชื้น', path: `/locations/${location.id}` };
  const [monitor, config] = await Promise.all([
    client.from('ci_locations').select('active').eq('id', monitorId).maybeSingle(),
    client.from('ci_location_env_configs').select('monitoring_state').eq('location_id', monitorId).order('effective_from', { ascending: false }).limit(1),
  ]);
  if (!location.active || !monitor.data?.active || config.data?.[0]?.monitoring_state !== 'active' || warehouse.role === 'viewer')
    return { ok: false, message: 'ตำแหน่งนี้ยังไม่พร้อมบันทึกค่า', path: `/locations/${location.id}` };
  return { ok: true, path: `/environment/check/${monitorId}?source=qr${monitorId !== location.id ? `&from=${location.id}` : ''}` };
}

export async function recordEnvironmentReading(input: {
  locationId: string; temperature: string; humidity: string; source: 'manual' | 'qr';
  observedAt?: string; note?: string; reason?: string; clientRequestId: string;
}): Promise<EnvironmentActionResult> {
  await requireAccess();
  const client = await createClient();
  if (!client) return { ok: false, message: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล' };
  const { data, error } = await client.rpc('ci_record_environment_reading', { p: {
    location_id: input.locationId, temperature_c: clean(input.temperature), humidity_rh: clean(input.humidity),
    source: input.source, observed_at: clean(input.observedAt), note: clean(input.note), reason: clean(input.reason),
    client_request_id: input.clientRequestId,
  } });
  if (error || !data) return { ok: false, message: logUserMessage('recordEnvironmentReading', error, 'บันทึกค่าไม่สำเร็จ กรุณาลองอีกครั้ง') };
  revalidatePath('/environment'); revalidatePath('/environment/history'); revalidatePath('/environment/excursions');
  revalidatePath(`/locations/${input.locationId}`); revalidatePath('/attention'); revalidatePath('/');
  return { ok: true, reading: data as SavedReading };
}

export async function correctEnvironmentReading(input: {
  readingId: string; entryKind: 'correction' | 'void'; temperature?: string; humidity?: string;
  reason: string; note?: string; clientRequestId: string;
}): Promise<EnvironmentActionResult> {
  await requireAccess();
  const client = await createClient();
  if (!client) return { ok: false, message: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล' };
  const { data, error } = await client.rpc('ci_correct_environment_reading', { p: {
    reading_id: input.readingId, entry_kind: input.entryKind, temperature_c: clean(input.temperature),
    humidity_rh: clean(input.humidity), reason: clean(input.reason), note: clean(input.note),
    client_request_id: input.clientRequestId,
  } });
  if (error || !data) return { ok: false, message: logUserMessage('correctEnvironmentReading', error, 'แก้ไขข้อมูลไม่สำเร็จ') };
  revalidatePath('/environment'); revalidatePath('/environment/history'); revalidatePath('/environment/excursions');
  revalidatePath('/attention'); revalidatePath('/');
  return { ok: true, reading: data as SavedReading };
}

// One-step completion: the same authorized actor records both the corrective action and the resolution and the
// excursion becomes resolved immediately. There is no separate Admin/Supervisor approval or closure stage — see
// ci_private.ci_complete_environment_excursion. `action` may be empty when completing a legacy 'acknowledged'
// excursion (its historical immediate_action is preserved server-side and this value is ignored for that row).
export async function completeEnvironmentExcursion(id: string, action: string, note: string, referred: boolean): Promise<{ ok: boolean; message: string }> {
  await requireAccess();
  const client = await createClient();
  if (!client) return { ok: false, message: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล' };
  const { error } = await client.rpc('ci_complete_environment_excursion', {
    p_id: id, p_immediate_action: action.trim(), p_resolution_note: note.trim(), p_equipment_referred: referred,
  });
  if (error) return { ok: false, message: logUserMessage('completeEnvironmentExcursion', error) };
  revalidatePath('/environment/excursions'); revalidatePath(`/environment/excursions/${id}`); revalidatePath('/attention');
  return { ok: true, message: 'บันทึกการแก้ไขแล้ว' };
}
