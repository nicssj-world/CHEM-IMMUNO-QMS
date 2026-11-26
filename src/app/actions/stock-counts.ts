'use server';

import { revalidatePath } from 'next/cache';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';
import { parseCountQuantity, type CountScopeType } from '@/lib/stock-count';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Fail = { ok: false; message: string; code?: string };

async function connect() {
  await requireAccess();
  return createClient();
}
function codeOf(error: { message?: string } | null | undefined) { return error?.message?.match(/CI_[A-Z0-9_]+/)?.[0]; }

export type CreateRoundInput = {
  clientKey: string; note: string; scopeType: CountScopeType; allowParallel: boolean;
  warehouseId?: number; locationIds?: string[]; productIds?: string[];
};
/** One request per click; the client key makes double clicks and network retries return the same round. */
export async function createCountRound(input: CreateRoundInput): Promise<{ ok: true; id: string } | Fail> {
  if (!uuid.test(input.clientKey)) return { ok: false, message: 'ฟอร์มหมดอายุ · โหลดหน้าใหม่แล้วลองอีกครั้ง' };
  if ((input.note ?? '').length > 1000) return { ok: false, message: 'หมายเหตุยาวเกิน 1,000 ตัวอักษร' };
  const scope: Record<string, unknown> = {};
  if (input.scopeType === 'group') {
    if (![1, 2].includes(Number(input.warehouseId))) return { ok: false, message: 'เลือกกลุ่ม CHEM หรือ IMMUNO' };
    scope.warehouse_id = Number(input.warehouseId);
  } else if (input.scopeType === 'locations') {
    const ids = (input.locationIds ?? []).filter(id => uuid.test(id));
    if (!ids.length) return { ok: false, message: 'เลือกตำแหน่งจัดเก็บอย่างน้อย 1 ตำแหน่ง' };
    scope.location_ids = ids;
  } else if (input.scopeType === 'products') {
    const ids = (input.productIds ?? []).filter(id => uuid.test(id));
    if (!ids.length) return { ok: false, message: 'เลือกน้ำยาอย่างน้อย 1 รายการ' };
    scope.product_ids = ids;
  } else if (input.scopeType !== 'all') return { ok: false, message: 'เลือกขอบเขตการตรวจนับ' };
  const client = await connect();
  if (!client) return { ok: false, message: 'เชื่อมต่อระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' };
  const { data, error } = await client.rpc('ci_create_stock_count_round', { p_data: {
    client_key: input.clientKey, note: input.note.trim(), scope_type: input.scopeType, scope, allow_parallel: input.allowParallel,
  } });
  if (error || typeof data !== 'string') return { ok: false, code: codeOf(error), message: logUserMessage('count-create', error, 'สร้างรอบตรวจนับไม่สำเร็จ กรุณาลองใหม่') };
  revalidatePath('/counts');
  return { ok: true, id: data };
}

/** Confirms that the count belongs to the round the page shows, so edited ids from a browser go nowhere. */
async function countInRound(client: NonNullable<Awaited<ReturnType<typeof createClient>>>, roundId: string, countId: string) {
  if (roundId === countId) return true;
  const { data, error } = await client.from('ci_unified_stock_counts').select('che_count_id,imm_count_id').eq('id', roundId).maybeSingle();
  return !error && Boolean(data) && (data!.che_count_id === countId || data!.imm_count_id === countId);
}

export type LineState = { ok: true; counted: boolean; physical: number | null } | Fail;
export async function setCountLineState(roundId: string, countId: string, lineId: string, counted: boolean, quantity: string | null): Promise<LineState> {
  if (![roundId, countId, lineId].every(id => uuid.test(id))) return { ok: false, message: 'รายการไม่ถูกต้อง · โหลดหน้าใหม่แล้วลองอีกครั้ง' };
  let physical: number | null = null;
  if (counted) {
    const parsed = parseCountQuantity(quantity ?? '');
    if (!parsed.ok) return { ok: false, message: parsed.message };
    physical = parsed.value;
  }
  const client = await connect();
  if (!client) return { ok: false, message: 'เชื่อมต่อระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' };
  if (!(await countInRound(client, roundId, countId))) return { ok: false, message: 'ไม่พบรอบตรวจนับนี้หรือไม่มีสิทธิ์' };
  const { data, error } = await client.rpc('ci_set_stock_count_line_state', { p_count_id: countId, p_line_id: lineId, p_counted: counted, p_physical_quantity: physical });
  if (error || !data) return { ok: false, code: codeOf(error), message: logUserMessage('count-line', error, 'บันทึกไม่สำเร็จ · ตรวจการเชื่อมต่อแล้วลองอีกครั้ง') };
  const result = data as { counted: boolean; physical_quantity: number | string | null };
  return { ok: true, counted: result.counted, physical: result.physical_quantity === null ? null : Number(result.physical_quantity) };
}

export type FinalizeResult =
  | { ok: true; status: 'approved'; adjusted: number; partial: boolean; already: boolean }
  | { ok: true; status: 'recount'; recount: number }
  | Fail;
export async function finalizeCountRound(roundId: string): Promise<FinalizeResult> {
  if (!uuid.test(roundId)) return { ok: false, message: 'รอบตรวจนับไม่ถูกต้อง' };
  const client = await connect();
  if (!client) return { ok: false, message: 'เชื่อมต่อระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' };
  const { data, error } = await client.rpc('ci_finalize_stock_count_round', { p_round_id: roundId });
  if (error || !data) return { ok: false, code: codeOf(error), message: logUserMessage('count-finalize', error, 'จบรอบไม่สำเร็จ · ยังไม่มีการปรับยอด กรุณาลองใหม่') };
  for (const path of ['/counts', `/counts/${roundId}`, '/stock', '/movements', '/']) revalidatePath(path);
  const result = data as { status: string; adjusted_lines?: number; partial?: boolean; already?: boolean; recount_lines?: number };
  if (result.status === 'recount') return { ok: true, status: 'recount', recount: Number(result.recount_lines ?? 0) };
  return { ok: true, status: 'approved', adjusted: Number(result.adjusted_lines ?? 0), partial: Boolean(result.partial), already: Boolean(result.already) };
}

export async function deleteCountRounds(roundIds: string[]): Promise<{ ok: true; deleted: number } | Fail> {
  const ids = [...new Set(roundIds)];
  if (!ids.length || ids.length > 100 || !ids.every(id => uuid.test(id))) return { ok: false, message: 'เลือกรอบที่ต้องการลบ (สูงสุด 100 รอบ)' };
  const client = await connect();
  if (!client) return { ok: false, message: 'เชื่อมต่อระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' };
  const { data, error } = await client.rpc('ci_delete_stock_count_rounds', { p_round_ids: ids });
  if (error || typeof data !== 'number') return { ok: false, code: codeOf(error), message: logUserMessage('count-delete', error, 'ลบรอบไม่สำเร็จ · ไม่มีรอบใดถูกลบ กรุณาลองใหม่') };
  revalidatePath('/counts');
  return { ok: true, deleted: data };
}
