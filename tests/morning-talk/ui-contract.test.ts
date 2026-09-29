import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadUnacknowledged } from '../../src/lib/morning-talk-data';

const root = process.cwd();

test('Attention unacknowledged includes only my active talks from the seven Bangkok dates ending today', async () => {
  const today = '2026-09-27';
  const cases = [
    { id: 'today', talk_date: today, status: 'active', acknowledged_at: null },
    { id: 'lookback', talk_date: '2026-09-21', status: 'active', acknowledged_at: null },
    { id: 'older', talk_date: '2026-09-20', status: 'active', acknowledged_at: null },
    { id: 'future', talk_date: '2026-09-28', status: 'active', acknowledged_at: null },
    { id: 'acknowledged', talk_date: today, status: 'active', acknowledged_at: '2026-09-27T01:00:00Z' },
    { id: 'cancelled', talk_date: today, status: 'cancelled', acknowledged_at: null },
  ];
  let rows = cases.map(item => ({ user_id: 'mine', acknowledged_at: item.acknowledged_at, ci_morning_talks: { ...item, title: item.id, scope: 'CHE', created_at: '' } }));
  const query = {
    select() { return this; },
    eq(column: string, value: string) { rows = rows.filter(row => column === 'user_id' ? row.user_id === value : column === 'ci_morning_talks.status' ? row.ci_morning_talks.status === value : false); return this; },
    is(column: string, value: null) { rows = rows.filter(row => column === 'acknowledged_at' && row.acknowledged_at === value); return this; },
    in(column: string, values: string[]) { rows = rows.filter(row => column === 'ci_morning_talks.scope' && values.includes(row.ci_morning_talks.scope)); return this; },
    gte(column: string, value: string) { rows = rows.filter(row => column === 'ci_morning_talks.talk_date' && row.ci_morning_talks.talk_date >= value); return this; },
    lte(column: string, value: string) { rows = rows.filter(row => column === 'ci_morning_talks.talk_date' && row.ci_morning_talks.talk_date <= value); return this; },
    async limit(count: number) { return { data: rows.slice(0, count), error: null }; },
  };
  const client = { from(table: string) { assert.equal(table, 'ci_morning_talk_attendees'); return query; } } as unknown as Parameters<typeof loadUnacknowledged>[0];
  const result = await loadUnacknowledged(client, 'mine', 'CHE', today);
  assert.equal(result.error, null);
  assert.deepEqual(result.data?.map(row => row.id), ['today', 'lookback']);
});
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
function files(dir: string): string[] {
  return readdirSync(path.join(root, dir)).flatMap(name => {
    const relative = `${dir}/${name}`;
    return statSync(path.join(root, relative)).isDirectory() ? files(relative) : [relative];
  });
}
const talkSources = [...files('src/components/morning-talk'), ...files('src/app/(app)/morning-talk'), 'src/app/actions/morning-talk.ts', 'src/app/(app)/reports/morning-talk/page.tsx', 'src/lib/morning-talk.ts', 'src/lib/morning-talk-data.ts'];

test('all seven Morning Talk routes exist', () => {
  for (const route of ['morning-talk/page.tsx', 'morning-talk/history/page.tsx', 'morning-talk/actions/page.tsx', 'morning-talk/new/page.tsx', 'morning-talk/[id]/page.tsx', 'morning-talk/[id]/edit/page.tsx', 'reports/morning-talk/page.tsx']) {
    assert.ok(existsSync(path.join(root, 'src/app/(app)', route)), route);
  }
});

test('no service-role or admin client is used anywhere in Morning Talk code', () => {
  for (const file of talkSources) assert.doesNotMatch(read(file), /service_role|SERVICE_ROLE|supabase\/admin|createAdminClient/i, file);
});

test('every write goes through a published RPC: the server actions never touch a Morning Talk table directly', () => {
  const actions = read('src/app/actions/morning-talk.ts');
  assert.doesNotMatch(actions, /\.from\(/, 'no direct table access from actions');
  for (const rpc of ['ci_save_morning_talk', 'ci_cancel_morning_talk', 'ci_acknowledge_morning_talk', 'ci_set_morning_talk_checklist_item', 'ci_update_morning_talk_action']) assert.match(actions, new RegExp(`rpc\\('${rpc}'`), rpc);
  for (const file of talkSources.filter(name => name !== 'src/app/actions/morning-talk.ts')) assert.doesNotMatch(read(file), /\.(insert|update|delete|upsert)\(/, `${file} only reads`);
});

test('acknowledgement is worded as "รับทราบ", never as a signature, and cannot name another user', () => {
  const button = read('src/components/morning-talk/ack-button.tsx');
  assert.match(button, /รับทราบ/);
  assert.doesNotMatch(button, /ลงนาม/);
  const action = read('src/app/actions/morning-talk.ts');
  assert.match(action, /acknowledgeMorningTalk\(talkId: string\)/, 'the only argument is the talk id: there is no way to pass a user');
  assert.match(read('src/app/(app)/morning-talk/page.tsx'), /ไม่ใช่การลงนาม/);
});

test('the create form offers only the scopes the database reports as manageable', () => {
  const page = read('src/app/(app)/morning-talk/new/page.tsx');
  assert.match(page, /creatableScopes\(await loadManageableScopes\(client\)\)/);
  assert.match(page, /redirect\('\/morning-talk'\)/, 'a user who cannot manage any scope is sent away');
  assert.match(read('src/app/(app)/morning-talk/page.tsx'), /creatableScopes\(manageable\)\.length > 0/, 'the create button is hidden without a manageable scope');
});

test('the pickers use the eligibility the database computed for each candidate, and the form offers copy-from-previous', () => {
  const form = read('src/components/morning-talk/talk-form.tsx');
  assert.match(form, /member\.attendee_eligible/);
  assert.match(form, /member\.owner_eligible/);
  assert.match(form, /คัดลอกหัวข้อจากครั้งก่อน/);
  assert.match(form, /ทุกคนในขอบเขต/);
  assert.match(read('src/lib/morning-talk-data.ts'), /ci_list_scope_members/);
});

test('profile privacy: names come from the scoped RPC, never from a direct ci_user_profiles read', () => {
  for (const file of talkSources) assert.doesNotMatch(read(file), /from\('ci_user_profiles'\)/, file);
  assert.match(read('src/lib/morning-talk-data.ts'), /rpc\('ci_morning_talk_names'/);
});

test('urgency is never colour alone: the badge always carries an icon and a word', () => {
  const badge = read('src/components/morning-talk/urgency-badge.tsx');
  for (const word of ['เกินกำหนด', 'ใกล้ครบกำหนด', 'ครบกำหนดวันนี้', 'เสร็จแล้ว']) assert.ok(badge.includes(word), word);
  assert.match(badge, /AlertTriangle/);
});

test('mobile: the acknowledge button is sticky on the talk page', () => {
  assert.match(read('src/components/morning-talk/ack-button.tsx'), /sticky-action/);
  assert.match(read('src/app/(app)/morning-talk/[id]/page.tsx'), /showAck/);
});

test('the report prints: it reuses the shared print styles and hides its controls', () => {
  const report = read('src/app/(app)/reports/morning-talk/page.tsx');
  assert.match(report, /report-page/);
  assert.match(report, /PrintButton/);
  assert.match(report, /print-hide/);
});

test('copy-from-previous ignores cancelled talks', () => {
  assert.match(read('src/lib/morning-talk-data.ts'), /\.eq\('scope', scope\)\.eq\('status', 'active'\)/);
});

test('the edit form sends each action\'s own version and cancels explicitly; omission never cancels', () => {
  assert.match(read('src/app/(app)/morning-talk/[id]/edit/page.tsx'), /expected_updated_at: item\.updated_at/);
  const form = read('src/components/morning-talk/talk-form.tsx');
  assert.match(form, /expected_updated_at: item\.expected_updated_at/);
  assert.match(form, /cancel: true/);
});

test('actions outlive a cancelled talk: their update controls are not gated by the talk status', () => {
  assert.doesNotMatch(read('src/components/morning-talk/talk-card.tsx'), /canUpdate: !cancelled/);
  assert.doesNotMatch(read('src/app/(app)/morning-talk/actions/page.tsx'), /canUpdate: !cancelled/);
});
