import { z } from 'zod';

// Morning Talk helpers shared by the pages, the forms, the actions and the tests. Pure: no database or framework imports, so the
// rules that matter (overdue, ordering, limits, copy-from-previous) can be tested without a browser or Postgres.

export const TALK_SCOPES = ['ALL', 'CHE', 'IMM'] as const;
export type TalkScope = (typeof TALK_SCOPES)[number];
export const scopeLabels: Record<TalkScope, string> = { ALL: 'ทั้งสองคลัง', CHE: 'Clinical Chemistry', IMM: 'Immunology' };
export function scopeLabel(scope: string | null | undefined) { return scopeLabels[scope as TalkScope] ?? scope ?? '—'; }
export function isTalkScope(value: unknown): value is TalkScope { return typeof value === 'string' && (TALK_SCOPES as readonly string[]).includes(value); }

export const ACTION_STATUSES = ['todo', 'in_progress', 'done', 'cancelled'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];
export const actionStatusLabels: Record<ActionStatus, string> = { todo: 'รอดำเนินการ', in_progress: 'กำลังดำเนินการ', done: 'เสร็จแล้ว', cancelled: 'ยกเลิก' };
export function actionStatusLabel(status: string | null | undefined) { return actionStatusLabels[status as ActionStatus] ?? status ?? '—'; }
export function isOpenStatus(status: string) { return status === 'todo' || status === 'in_progress'; }

export const LIMITS = { title: 200, agenda: 5000, attendees: 100, checklist: 30, checklistTitle: 240, actions: 50, actionTitle: 240, note: 1000, reason: 500 } as const;
/** An open action due within this many days (today included) is shown as "due soon". */
export const DUE_SOON_DAYS = 2;

export type TalkRow = {
  id: string; scope: TalkScope; warehouse_id: number | null; talk_date: string; title: string; agenda: string | null; status: 'active' | 'cancelled';
  cancelled_at: string | null; cancelled_by: string | null; cancel_reason: string | null; created_by: string; created_at: string; updated_at: string;
};
export type AttendeeRow = { talk_id: string; user_id: string; assigned_at: string; acknowledged_at: string | null };
export type ChecklistRow = { id: string; talk_id: string; sort_order: number; title: string; completed_at: string | null; completed_by: string | null };
export type ActionRow = {
  id: string; talk_id: string; title: string; owner_id: string; due_date: string | null; status: ActionStatus; note: string | null;
  completed_at: string | null; completed_by: string | null; updated_at: string; created_at: string;
};
export type ScopeMember = { user_id: string; display_name: string; position_title: string | null; active: boolean; attendee_eligible: boolean; owner_eligible: boolean };

// --- dates (Asia/Bangkok calendar dates travel as YYYY-MM-DD strings) --------------------------------------------------------
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
export function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !dateOnly.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function daysBetween(from: string, to: string) { return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000); }

/** Overdue = still open and due strictly before today's Bangkok date. Due today is NOT overdue. */
export function isOverdue(action: Pick<ActionRow, 'status' | 'due_date'>, today: string) {
  return isOpenStatus(action.status) && action.due_date != null && action.due_date < today;
}
export function isDueSoon(action: Pick<ActionRow, 'status' | 'due_date'>, today: string) {
  if (!isOpenStatus(action.status) || action.due_date == null || action.due_date < today) return false;
  return daysBetween(today, action.due_date) <= DUE_SOON_DAYS;
}
export type ActionUrgency = 'overdue' | 'due-soon' | 'scheduled' | 'no-date' | 'closed';
export function actionUrgency(action: Pick<ActionRow, 'status' | 'due_date'>, today: string): ActionUrgency {
  if (!isOpenStatus(action.status)) return 'closed';
  if (action.due_date == null) return 'no-date';
  if (isOverdue(action, today)) return 'overdue';
  return isDueSoon(action, today) ? 'due-soon' : 'scheduled';
}
const urgencyRank: Record<ActionUrgency, number> = { overdue: 0, 'due-soon': 1, scheduled: 2, 'no-date': 3, closed: 4 };
/** Open-actions order: overdue (oldest due first), due soon, later dates, no due date. Ties keep the earlier due date, then title. */
export function sortOpenActions<T extends Pick<ActionRow, 'status' | 'due_date' | 'title'>>(actions: readonly T[], today: string): T[] {
  return [...actions].sort((a, b) => {
    const byUrgency = urgencyRank[actionUrgency(a, today)] - urgencyRank[actionUrgency(b, today)];
    if (byUrgency) return byUrgency;
    if (a.due_date !== b.due_date) return a.due_date == null ? 1 : b.due_date == null ? -1 : a.due_date.localeCompare(b.due_date);
    return a.title.localeCompare(b.title, 'th');
  });
}

/** `YYYY-MM` → the first day of the month and of the next one, for a half-open range filter. */
export function monthBounds(month: string): { from: string; to: string } | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const [year, number] = month.split('-').map(Number);
  const next = number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
  return { from: `${month}-01`, to: `${next}-01` };
}

// --- scope and permission hints (the database re-checks everything) --------------------------------------------------------
/** Only scopes the actor may manage are offered; the RPC still refuses the rest. */
export function creatableScopes(manageable: readonly string[]): TalkScope[] { return TALK_SCOPES.filter(scope => manageable.includes(scope)); }
export function canManageTalk(manageable: readonly string[], scope: string) { return manageable.includes(scope); }

export function acknowledgement(attendees: readonly Pick<AttendeeRow, 'acknowledged_at'>[]) {
  const done = attendees.filter(item => item.acknowledged_at).length;
  return { done, total: attendees.length, complete: attendees.length > 0 && done === attendees.length };
}
export function checklistProgress(items: readonly Pick<ChecklistRow, 'completed_at'>[]) {
  const done = items.filter(item => item.completed_at).length;
  return { done, total: items.length };
}

/** The talk a user has not yet acknowledged, most recent first (Attention lists these for the last seven days). */
export function unacknowledgedFor<T extends { talk_date: string; created_at?: string }>(talks: readonly T[]) {
  return [...talks].sort((a, b) => b.talk_date.localeCompare(a.talk_date) || (b.created_at ?? '').localeCompare(a.created_at ?? ''));
}

/**
 * Copy-from-previous carries the agenda skeleton and the checklist TITLES only. Completion, evidence, attendees, actions and the
 * date are deliberately left behind so a new talk never inherits state from an old one.
 */
export function copyFromPrevious(previous: { agenda: string | null; checklist: readonly { title: string }[] } | null | undefined) {
  if (!previous) return null;
  return { agenda: previous.agenda ?? '', checklist: previous.checklist.map(item => ({ title: item.title })) };
}

// --- form payload ------------------------------------------------------------------------------------------------------------
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'รหัสไม่ถูกต้อง');
const optionalDate = z.string().nullish().transform(value => (value ? value : null)).refine(value => value === null || isDateOnly(value), 'วันที่ไม่ถูกต้อง');
const trimmed = (max: number, message: string) => z.string().transform(value => value.trim()).pipe(z.string().min(1, message).max(max, `ยาวเกิน ${max} ตัวอักษร`));

export const savePayloadSchema = z.object({
  id: uuid.optional(),
  expected_updated_at: z.string().min(1).optional(),
  scope: z.enum(TALK_SCOPES).optional(),
  talk_date: z.string().refine(isDateOnly, 'วันที่ไม่ถูกต้อง').optional(),
  title: trimmed(LIMITS.title, 'กรุณาระบุหัวข้อ'),
  agenda: z.string().max(LIMITS.agenda, `ยาวเกิน ${LIMITS.agenda} ตัวอักษร`).default(''),
  attendees: z.array(uuid).max(LIMITS.attendees, `ผู้เข้าร่วมได้ไม่เกิน ${LIMITS.attendees} คน`),
  checklist: z.array(z.object({ id: uuid.optional(), title: trimmed(LIMITS.checklistTitle, 'ระบุข้อความของรายการตรวจสอบ') })).max(LIMITS.checklist, `รายการตรวจสอบได้ไม่เกิน ${LIMITS.checklist} ข้อ`),
  actions: z.array(z.object({
    id: uuid.optional(),
    /** The action's own version as the form read it; required for an existing action (owners edit status/note in parallel). */
    expected_updated_at: z.string().min(1).optional(),
    /** Cancel this existing open action. Actions are never deleted, and an action the form did not show is never touched. */
    cancel: z.boolean().optional(),
    title: trimmed(LIMITS.actionTitle, 'ระบุงานที่ต้องทำ'),
    owner_id: uuid,
    due_date: optionalDate,
    note: z.string().max(LIMITS.note, `หมายเหตุยาวเกิน ${LIMITS.note} ตัวอักษร`).default(''),
  })).max(LIMITS.actions, `งานที่มอบหมายได้ไม่เกิน ${LIMITS.actions} รายการ`),
}).superRefine((value, ctx) => {
  if (!value.id && !value.scope) ctx.addIssue({ code: 'custom', path: ['scope'], message: 'เลือกขอบเขต' });
  if (value.id && !value.expected_updated_at) ctx.addIssue({ code: 'custom', path: ['expected_updated_at'], message: 'ฟอร์มหมดอายุ โหลดหน้าใหม่แล้วลองอีกครั้ง' });
  value.actions.forEach((action, index) => {
    if (action.id && !action.expected_updated_at) ctx.addIssue({ code: 'custom', path: ['actions', index, 'expected_updated_at'], message: 'ฟอร์มหมดอายุ โหลดหน้าใหม่แล้วลองอีกครั้ง' });
    if (action.cancel && !action.id) ctx.addIssue({ code: 'custom', path: ['actions', index, 'cancel'], message: 'ยกเลิกได้เฉพาะงานที่บันทึกแล้ว' });
  });
});
export type SavePayload = z.infer<typeof savePayloadSchema>;

export function parseSavePayload(input: unknown): { ok: true; value: SavePayload } | { ok: false; errors: Record<string, string> } {
  const result = savePayloadSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) { const key = issue.path.join('.') || 'form'; errors[key] ??= issue.message; }
  return { ok: false, errors };
}

/** History search text is placed inside a PostgREST `or()` filter, so characters that structure that filter are neutralised. */
export function searchTerm(input: string | undefined | null) { return (input ?? '').replace(/[%_\\,()*"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80); }

/** Working rights are "staff or above" in the talk's warehouse (for ALL: in either). UI hint only; the RPC re-checks. */
export function canWorkInScope(warehouses: readonly { code: string; role: string }[], scope: string) {
  const works = (warehouse: { code: string; role: string }) => warehouse.role !== 'viewer';
  return scope === 'ALL' ? warehouses.some(works) : warehouses.some(warehouse => warehouse.code === scope && works(warehouse));
}
