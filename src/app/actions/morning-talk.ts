'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';
import { ACTION_STATUSES, parseSavePayload } from '@/lib/morning-talk';

export type TalkActionResult = { ok: true; id?: string } | { ok: false; message: string; errors?: Record<string, string> };

// Every action here only validates the shape of the input and forwards it to a database function. The database decides who may do
// what (scope authority, candidate eligibility, self-only acknowledgement), so hiding a button or skipping these checks never grants access.
async function supabaseFor() {
  await requireAccess();
  const supabase = await createClient();
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล');
  return supabase;
}

function refresh(id?: string) {
  for (const path of ['/morning-talk', '/morning-talk/history', '/morning-talk/actions', '/reports/morning-talk', '/attention', '/']) revalidatePath(path);
  if (id) { revalidatePath(`/morning-talk/${id}`); revalidatePath(`/morning-talk/${id}/edit`); }
}

/** Create or update in one call. `expected_updated_at` goes back exactly as the page read it: the database compares it for equality. */
export async function saveMorningTalk(input: unknown): Promise<TalkActionResult> {
  const supabase = await supabaseFor();
  const parsed = parseSavePayload(input);
  if (!parsed.ok) return { ok: false, message: 'ตรวจสอบข้อมูลที่ไฮไลต์แล้วลองอีกครั้ง', errors: parsed.errors };
  const { data, error } = await supabase.rpc('ci_save_morning_talk', { p: parsed.value });
  if (error || !data) return { ok: false, message: logUserMessage('saveMorningTalk', error, 'บันทึก Morning Talk ไม่สำเร็จ กรุณาลองใหม่') };
  refresh(data as string);
  return { ok: true, id: data as string };
}

export async function acknowledgeMorningTalk(talkId: string): Promise<TalkActionResult> {
  const supabase = await supabaseFor();
  const { error } = await supabase.rpc('ci_acknowledge_morning_talk', { p_id: talkId });
  if (error) return { ok: false, message: logUserMessage('acknowledgeMorningTalk', error, 'รับทราบไม่สำเร็จ กรุณาลองใหม่') };
  refresh(talkId);
  return { ok: true, id: talkId };
}

export async function setChecklistItem(itemId: string, completed: boolean, talkId: string): Promise<TalkActionResult> {
  const supabase = await supabaseFor();
  const { error } = await supabase.rpc('ci_set_morning_talk_checklist_item', { p_item_id: itemId, p_completed: completed });
  if (error) return { ok: false, message: logUserMessage('setChecklistItem', error, 'บันทึกรายการตรวจสอบไม่สำเร็จ กรุณาลองใหม่') };
  refresh(talkId);
  return { ok: true };
}

/** `expectedUpdatedAt` is the action's own version, so two people editing the same action cannot silently overwrite each other. */
export async function updateTalkAction(actionId: string, status: string, note: string, expectedUpdatedAt: string, talkId: string): Promise<TalkActionResult> {
  if (!(ACTION_STATUSES as readonly string[]).includes(status)) return { ok: false, message: 'สถานะไม่ถูกต้อง' };
  if (note.length > 1000) return { ok: false, message: 'หมายเหตุยาวเกิน 1,000 ตัวอักษร' };
  const supabase = await supabaseFor();
  const { error } = await supabase.rpc('ci_update_morning_talk_action', { p_id: actionId, p_status: status, p_note: note, p_expected_updated_at: expectedUpdatedAt });
  if (error) return { ok: false, message: logUserMessage('updateTalkAction', error, 'บันทึกงานไม่สำเร็จ กรุณาลองใหม่') };
  refresh(talkId);
  return { ok: true };
}

/** Cancel from the talk page. Answers by redirecting back with a notice, like the other confirm-and-act forms. */
export async function cancelMorningTalk(form: FormData): Promise<void> {
  const id = String(form.get('id') ?? '');
  const reason = String(form.get('reason') ?? '').trim();
  const supabase = await supabaseFor();
  if (!reason) redirect(`/morning-talk/${id}?error=${encodeURIComponent('กรุณาระบุเหตุผลที่ยกเลิก')}`);
  const { error } = await supabase.rpc('ci_cancel_morning_talk', { p_id: id, p_reason: reason });
  if (error) redirect(`/morning-talk/${id}?error=${encodeURIComponent(logUserMessage('cancelMorningTalk', error))}`);
  refresh(id);
  redirect(`/morning-talk/${id}?saved=${encodeURIComponent('ยกเลิก Morning Talk แล้ว')}&at=${Date.now().toString(36)}`);
}
