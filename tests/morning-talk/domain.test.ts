import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { bangkokToday } from '../../src/lib/inventory-insights';
import { userMessage } from '../../src/lib/messages';
import {
  ACTION_STATUSES, LIMITS, acknowledgement, actionStatusLabel, actionUrgency, canManageTalk, canWorkInScope, checklistProgress, copyFromPrevious, creatableScopes, isDateOnly, isDueSoon,
  isOverdue, monthBounds, parseSavePayload, scopeLabel, searchTerm, sortOpenActions, unacknowledgedFor, type ActionStatus,
} from '../../src/lib/morning-talk';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const action = (title: string, due_date: string | null, status: ActionStatus = 'todo') => ({ title, due_date, status });

test('overdue means open and strictly before today: due today is not overdue, done and cancelled never are', () => {
  const today = '2026-09-27';
  assert.equal(isOverdue(action('a', '2026-09-26'), today), true);
  assert.equal(isOverdue(action('a', '2026-09-27'), today), false);
  assert.equal(isOverdue(action('a', '2026-09-28'), today), false);
  assert.equal(isOverdue(action('a', null), today), false);
  assert.equal(isOverdue(action('a', '2026-09-01', 'in_progress'), today), true);
  assert.equal(isOverdue(action('a', '2026-09-01', 'done'), today), false);
  assert.equal(isOverdue(action('a', '2026-09-01', 'cancelled'), today), false);
});

test('overdue uses the Bangkok calendar date: UTC 16:59 is still today, UTC 17:00 is already tomorrow', () => {
  const due = '2026-09-27';
  const beforeMidnight = bangkokToday(new Date('2026-09-27T16:59:59Z'));
  const afterMidnight = bangkokToday(new Date('2026-09-27T17:00:00Z'));
  assert.equal(beforeMidnight, '2026-09-27');
  assert.equal(afterMidnight, '2026-09-28');
  assert.equal(isOverdue(action('a', due), beforeMidnight), false);
  assert.equal(isOverdue(action('a', due), afterMidnight), true);
});

test('urgency: due today and the next two days are "due soon"; later dates are scheduled; no date is its own group', () => {
  const today = '2026-09-27';
  assert.equal(actionUrgency(action('a', '2026-09-26'), today), 'overdue');
  assert.equal(actionUrgency(action('a', '2026-09-27'), today), 'due-soon');
  assert.equal(actionUrgency(action('a', '2026-09-29'), today), 'due-soon');
  assert.equal(actionUrgency(action('a', '2026-09-30'), today), 'scheduled');
  assert.equal(actionUrgency(action('a', null), today), 'no-date');
  assert.equal(actionUrgency(action('a', '2026-09-01', 'done'), today), 'closed');
  assert.equal(isDueSoon(action('a', '2026-09-26'), today), false, 'overdue is not "due soon"');
});

test('open actions sort overdue (oldest first) → due soon → later dates → no due date', () => {
  const today = '2026-09-27';
  const sorted = sortOpenActions([
    action('no date', null), action('later', '2026-10-15'), action('overdue new', '2026-09-26'), action('soon', '2026-09-28'), action('overdue old', '2026-09-01'), action('today', '2026-09-27'), action('later b', '2026-10-01'),
  ], today).map(item => item.title);
  assert.deepEqual(sorted, ['overdue old', 'overdue new', 'today', 'soon', 'later b', 'later', 'no date']);
});

test('the input list is never mutated by sorting', () => {
  const input = [action('b', '2026-10-01'), action('a', '2026-09-01')];
  sortOpenActions(input, '2026-09-27');
  assert.deepEqual(input.map(item => item.title), ['b', 'a']);
});

test('labels: every scope and status has a Thai label; unknown values fall back to the raw value', () => {
  assert.equal(scopeLabel('ALL'), 'ทั้งสองคลัง');
  assert.equal(scopeLabel('CHE'), 'Clinical Chemistry');
  assert.equal(scopeLabel('IMM'), 'Immunology');
  assert.equal(scopeLabel('XXX'), 'XXX');
  assert.deepEqual(ACTION_STATUSES.map(actionStatusLabel), ['รอดำเนินการ', 'กำลังดำเนินการ', 'เสร็จแล้ว', 'ยกเลิก']);
  assert.equal(actionStatusLabel(null), '—');
});

test('management hints follow the manageable list only: ALL appears only when the database says so', () => {
  assert.deepEqual(creatableScopes([]), []);
  assert.deepEqual(creatableScopes(['CHE']), ['CHE']);
  assert.deepEqual(creatableScopes(['IMM', 'CHE']), ['CHE', 'IMM']);
  assert.deepEqual(creatableScopes(['CHE', 'IMM', 'ALL']), ['ALL', 'CHE', 'IMM']);
  assert.equal(canManageTalk(['CHE'], 'ALL'), false, 'a single-warehouse supervisor cannot manage an ALL talk');
  assert.equal(canManageTalk(['ALL', 'CHE', 'IMM'], 'ALL'), true);
});

test('working rights: staff or above in the talk\'s warehouse (ALL: in either); viewers never', () => {
  const che = [{ code: 'CHE', role: 'staff' }];
  const viewerBoth = [{ code: 'CHE', role: 'viewer' }, { code: 'IMM', role: 'viewer' }];
  const staffImm = [{ code: 'CHE', role: 'viewer' }, { code: 'IMM', role: 'staff' }];
  assert.equal(canWorkInScope(che, 'CHE'), true);
  assert.equal(canWorkInScope(che, 'IMM'), false);
  assert.equal(canWorkInScope(che, 'ALL'), true);
  assert.equal(canWorkInScope(viewerBoth, 'ALL'), false);
  assert.equal(canWorkInScope(staffImm, 'ALL'), true);
  assert.equal(canWorkInScope(staffImm, 'CHE'), false);
});

test('acknowledgement and checklist progress counts', () => {
  assert.deepEqual(acknowledgement([]), { done: 0, total: 0, complete: false });
  assert.deepEqual(acknowledgement([{ acknowledged_at: 'x' }, { acknowledged_at: null }]), { done: 1, total: 2, complete: false });
  assert.deepEqual(acknowledgement([{ acknowledged_at: 'x' }]), { done: 1, total: 1, complete: true });
  assert.deepEqual(checklistProgress([{ completed_at: 'x' }, { completed_at: null }, { completed_at: null }]), { done: 1, total: 3 });
});

test('unacknowledged talks list newest first', () => {
  const list = unacknowledgedFor([{ talk_date: '2026-09-25' }, { talk_date: '2026-09-27', created_at: '1' }, { talk_date: '2026-09-27', created_at: '2' }]);
  assert.deepEqual(list.map(item => `${item.talk_date}/${item.created_at ?? ''}`), ['2026-09-27/2', '2026-09-27/1', '2026-09-25/']);
});

test('copy-from-previous carries the agenda skeleton and checklist titles only, with no state', () => {
  const copy = copyFromPrevious({ agenda: 'วาระ', checklist: [{ title: 'ข้อ 1', completed_at: '2026-09-26', id: 'x' } as { title: string }, { title: 'ข้อ 2' }] });
  assert.deepEqual(copy, { agenda: 'วาระ', checklist: [{ title: 'ข้อ 1' }, { title: 'ข้อ 2' }] });
  assert.deepEqual(Object.keys(copy!.checklist[0]), ['title'], 'no id and no completion leak through');
  assert.equal(copyFromPrevious(null), null);
  assert.deepEqual(copyFromPrevious({ agenda: null, checklist: [] }), { agenda: '', checklist: [] });
});

test('save payload: valid create and edit', () => {
  const create = parseSavePayload({ scope: 'CHE', title: '  Morning Talk  ', attendees: [uuid(1)], checklist: [{ title: 'a' }], actions: [{ title: 't', owner_id: uuid(2), due_date: '', note: '' }] });
  assert.ok(create.ok);
  if (create.ok) { assert.equal(create.value.title, 'Morning Talk'); assert.equal(create.value.actions[0].due_date, null); assert.equal(create.value.agenda, ''); }
  const edit = parseSavePayload({ id: uuid(9), expected_updated_at: '2026-09-27T01:00:00+00:00', title: 't', attendees: [], checklist: [], actions: [] });
  assert.ok(edit.ok);
});

test('save payload: limits and required fields are enforced before the database is called', () => {
  const base = { scope: 'ALL', title: 't', attendees: [], checklist: [], actions: [] };
  const bad = (over: Record<string, unknown>) => parseSavePayload({ ...base, ...over });
  assert.ok(!bad({ title: '   ' }).ok, 'blank title');
  assert.ok(!bad({ title: 'x'.repeat(LIMITS.title + 1) }).ok, 'title too long');
  assert.ok(bad({ title: 'x'.repeat(LIMITS.title) }).ok, 'title at the limit');
  assert.ok(!bad({ agenda: 'x'.repeat(LIMITS.agenda + 1) }).ok, 'agenda too long');
  assert.ok(!bad({ attendees: Array.from({ length: LIMITS.attendees + 1 }, (_, i) => uuid(i)) }).ok, '101 attendees');
  assert.ok(bad({ attendees: Array.from({ length: LIMITS.attendees }, (_, i) => uuid(i)) }).ok, '100 attendees');
  assert.ok(!bad({ attendees: ['nope'] }).ok, 'malformed attendee id');
  assert.ok(!bad({ checklist: Array.from({ length: LIMITS.checklist + 1 }, (_, i) => ({ title: `c${i}` })) }).ok, '31 checklist items');
  assert.ok(!bad({ checklist: [{ title: 'x'.repeat(LIMITS.checklistTitle + 1) }] }).ok, 'checklist title too long');
  assert.ok(!bad({ checklist: [{ title: ' ' }] }).ok, 'blank checklist title');
  assert.ok(!bad({ actions: Array.from({ length: LIMITS.actions + 1 }, (_, i) => ({ title: `a${i}`, owner_id: uuid(1) })) }).ok, '51 actions');
  assert.ok(!bad({ actions: [{ title: 'a', owner_id: 'nope' }] }).ok, 'malformed owner');
  assert.ok(!bad({ actions: [{ title: 'a', owner_id: uuid(1), due_date: '2026-02-30' }] }).ok, 'impossible due date');
  assert.ok(!bad({ actions: [{ title: 'a', owner_id: uuid(1), note: 'n'.repeat(LIMITS.note + 1) }] }).ok, 'note too long');
  assert.ok(!bad({ scope: 'XXX' }).ok, 'unknown scope');
  assert.ok(!parseSavePayload({ title: 't', attendees: [], checklist: [], actions: [] }).ok, 'create needs a scope');
  assert.ok(!parseSavePayload({ id: uuid(1), title: 't', attendees: [], checklist: [], actions: [] }).ok, 'edit needs the version it was read at');
  const failed = bad({ title: '' });
  if (!failed.ok) assert.ok(failed.errors.title);
});

test('dates and months', () => {
  assert.ok(isDateOnly('2026-09-27'));
  assert.ok(!isDateOnly('2026-02-30'));
  assert.ok(!isDateOnly('27/09/2026'));
  assert.deepEqual(monthBounds('2026-09'), { from: '2026-09-01', to: '2026-10-01' });
  assert.deepEqual(monthBounds('2026-12'), { from: '2026-12-01', to: '2027-01-01' });
  assert.equal(monthBounds('2026-13'), null);
  assert.equal(monthBounds('26-09'), null);
});

test('history search text cannot break out of the PostgREST or() filter', () => {
  assert.equal(searchTerm('  ตรวจ   เครื่อง '), 'ตรวจ เครื่อง');
  assert.equal(searchTerm('a,b)or(c%_*"\''), 'a b or c');
  assert.equal(searchTerm(null), '');
  assert.equal(searchTerm('x'.repeat(200)).length, 80);
});

test('every error code the Morning Talk migration can raise has a Thai message (no raw CI_ code reaches a user)', () => {
  const dir = path.join(process.cwd(), 'supabase/migrations');
  const file = readdirSync(dir).find(name => name.endsWith('_ci_morning_talk.sql'))!;
  const codes = [...new Set(readFileSync(path.join(dir, file), 'utf8').match(/CI_[A-Z0-9_]+/g) ?? [])];
  assert.ok(codes.length > 15);
  for (const code of codes) assert.doesNotMatch(userMessage(code), /รหัส CI_/, `${code} has no Thai message`);
});

test('save payload: an existing action must carry the version the form read, and only a saved action can be cancelled', () => {
  const edit = (actions: unknown[]) => parseSavePayload({ id: uuid(9), expected_updated_at: '2026-09-27T01:00:00+00:00', title: 't', attendees: [], checklist: [], actions });
  assert.ok(!edit([{ id: uuid(1), title: 'a', owner_id: uuid(2) }]).ok, 'existing action without its version');
  assert.ok(edit([{ id: uuid(1), expected_updated_at: '2026-09-27T01:00:00.123456+00:00', title: 'a', owner_id: uuid(2) }]).ok);
  assert.ok(edit([{ id: uuid(1), expected_updated_at: 'x', cancel: true, title: 'a', owner_id: uuid(2) }]).ok, 'explicit cancellation of a saved action');
  assert.ok(!edit([{ cancel: true, title: 'a', owner_id: uuid(2) }]).ok, 'a new action cannot be cancelled');
  assert.ok(edit([{ title: 'new', owner_id: uuid(2) }]).ok, 'a new action needs no version');
});
