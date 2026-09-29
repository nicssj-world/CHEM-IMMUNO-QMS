import type { createClient } from '@/lib/supabase/server';
import { addDays } from '@/lib/inventory-insights';
import type { ActionRow, AttendeeRow, ChecklistRow, ScopeMember, TalkRow } from '@/lib/morning-talk';

// Server-side reads for the Morning Talk pages. Everything goes through the user's own session, so row-level security decides what
// is visible; nothing here uses the service role. Names come from a scoped RPC because ci_user_profiles stays closed to staff.

type Client = NonNullable<Awaited<ReturnType<typeof createClient>>>;
type QueryError = { message?: string | null; code?: string | null };
export type Loaded<T> = { data: T; error: null } | { data: null; error: QueryError };

export const TALK_COLUMNS = 'id,scope,warehouse_id,talk_date,title,agenda,status,cancelled_at,cancelled_by,cancel_reason,created_by,created_at,updated_at';
export const ACTION_COLUMNS = 'id,talk_id,title,owner_id,due_date,status,note,completed_at,completed_by,updated_at,created_at';
const ATTENDEE_COLUMNS = 'talk_id,user_id,assigned_at,acknowledged_at';
const CHECKLIST_COLUMNS = 'id,talk_id,sort_order,title,completed_at,completed_by';

export type TalkDetail = TalkRow & { attendees: AttendeeRow[]; checklist: ChecklistRow[]; actions: ActionRow[] };

/** Attendees, checklist and actions for a set of talks, attached to each talk (the detail of a page is small: today, one talk, or 20 rows). */
export async function attachChildren(client: Client, talks: TalkRow[]): Promise<Loaded<TalkDetail[]>> {
  if (talks.length === 0) return { data: [], error: null };
  const ids = talks.map(talk => talk.id);
  const [attendees, checklist, actions] = await Promise.all([
    client.from('ci_morning_talk_attendees').select(ATTENDEE_COLUMNS).in('talk_id', ids).order('assigned_at').limit(5000),
    client.from('ci_morning_talk_checklist_items').select(CHECKLIST_COLUMNS).in('talk_id', ids).order('sort_order').limit(5000),
    client.from('ci_morning_talk_actions').select(ACTION_COLUMNS).in('talk_id', ids).order('created_at').limit(5000),
  ]);
  const error = attendees.error ?? checklist.error ?? actions.error;
  if (error) return { data: null, error };
  const group = <T extends { talk_id: string }>(rows: T[] | null) => { const map = new Map<string, T[]>(); for (const row of rows ?? []) map.set(row.talk_id, [...(map.get(row.talk_id) ?? []), row]); return map; };
  const a = group(attendees.data as AttendeeRow[] | null), c = group(checklist.data as ChecklistRow[] | null), x = group(actions.data as ActionRow[] | null);
  return { data: talks.map(talk => ({ ...talk, attendees: a.get(talk.id) ?? [], checklist: c.get(talk.id) ?? [], actions: x.get(talk.id) ?? [] })), error: null };
}

/** Display names for everybody who appears in the loaded data. Unknown ids simply have no entry (shown as "ไม่ทราบชื่อ"). */
export async function loadNames(client: Client, userIds: Iterable<string>): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)].filter(Boolean);
  const names = new Map<string, string>();
  for (let start = 0; start < unique.length; start += 400) {
    const { data, error } = await client.rpc('ci_morning_talk_names', { p_user_ids: unique.slice(start, start + 400) });
    if (error) { console.error('[morning-talk-names]', error.message); continue; }
    for (const row of (data ?? []) as { user_id: string; display_name: string }[]) names.set(row.user_id, row.display_name);
  }
  return names;
}
export function userIdsOf(talks: readonly TalkDetail[]) {
  const ids: string[] = [];
  for (const talk of talks) {
    ids.push(talk.created_by);
    if (talk.cancelled_by) ids.push(talk.cancelled_by);
    for (const item of talk.attendees) ids.push(item.user_id);
    for (const item of talk.checklist) if (item.completed_by) ids.push(item.completed_by);
    for (const item of talk.actions) { ids.push(item.owner_id); if (item.completed_by) ids.push(item.completed_by); }
  }
  return ids;
}

export async function loadManageableScopes(client: Client): Promise<string[]> {
  const { data, error } = await client.rpc('ci_manageable_scopes');
  if (error) { console.error('[manageable-scopes]', error.message); return []; }
  return (data ?? []) as string[];
}

export async function loadScopeMembers(client: Client, warehouseId: number | null): Promise<Loaded<ScopeMember[]>> {
  const { data, error } = await client.rpc('ci_list_scope_members', { p_warehouse_id: warehouseId });
  return error ? { data: null, error } : { data: (data ?? []) as ScopeMember[], error: null };
}

/** The latest active (not cancelled) talk of a scope, used by "คัดลอกหัวข้อจากครั้งก่อน": agenda and checklist titles only. */
export async function loadPreviousTalk(client: Client, scope: string): Promise<{ agenda: string | null; checklist: { title: string }[] } | null> {
  const { data } = await client.from('ci_morning_talks').select('id,agenda').eq('scope', scope).eq('status', 'active').order('talk_date', { ascending: false }).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  const items = await client.from('ci_morning_talk_checklist_items').select('title').eq('talk_id', data.id as string).order('sort_order').limit(60);
  return { agenda: (data.agenda as string | null) ?? null, checklist: (items.data ?? []) as { title: string }[] };
}

export type TalkRef = { title: string; scope: string; talk_date: string; status: string };
export type ActionWithTalk = ActionRow & { talk: TalkRef | null };
/** Actions with the talk they came from, using the embedded relationship so the list needs one query. */
export async function loadActionsWithTalk(client: Client, build: (query: ReturnType<typeof baseActionQuery>) => ReturnType<typeof baseActionQuery>, limit = 500): Promise<Loaded<ActionWithTalk[]>> {
  const { data, error } = await build(baseActionQuery(client)).limit(limit);
  if (error) return { data: null, error };
  const rows = (data ?? []) as unknown as (ActionRow & { ci_morning_talks: TalkRef | TalkRef[] | null })[];
  return { data: rows.map(({ ci_morning_talks, ...row }) => ({ ...row, talk: Array.isArray(ci_morning_talks) ? ci_morning_talks[0] ?? null : ci_morning_talks })), error: null };
}
function baseActionQuery(client: Client) {
  return client.from('ci_morning_talk_actions').select(`${ACTION_COLUMNS},ci_morning_talks(title,scope,talk_date,status)`);
}

/** Attention: my unacknowledged active talks from the last seven days (today included) that apply to the selected warehouse. */
export async function loadUnacknowledged(client: Client, userId: string, warehouseCode: string, today: string) {
  const { data, error } = await client.from('ci_morning_talk_attendees')
    .select('talk_id,ci_morning_talks!inner(id,title,scope,talk_date,status,created_at)')
    .eq('user_id', userId).is('acknowledged_at', null)
    .eq('ci_morning_talks.status', 'active').in('ci_morning_talks.scope', ['ALL', warehouseCode]).gte('ci_morning_talks.talk_date', addDays(today, -6)).lte('ci_morning_talks.talk_date', today)
    .limit(200);
  if (error) return { data: null, error } as const;
  const rows = (data ?? []) as unknown as { talk_id: string; ci_morning_talks: { id: string; title: string; scope: string; talk_date: string; created_at: string } | { id: string; title: string; scope: string; talk_date: string; created_at: string }[] }[];
  return { data: rows.map(row => (Array.isArray(row.ci_morning_talks) ? row.ci_morning_talks[0] : row.ci_morning_talks)).filter(Boolean), error: null } as const;
}

/** Today's talks for the dashboard line: how many apply to this warehouse, how many name me as an attendee, and how many of those I have acknowledged. */
export async function loadTodaySummary(client: Client, userId: string, warehouseCode: string, today: string) {
  const talks = await client.from('ci_morning_talks').select('id').eq('status', 'active').eq('talk_date', today).in('scope', ['ALL', warehouseCode]).limit(50);
  if (talks.error) return null;
  const ids = (talks.data ?? []).map(row => row.id as string);
  if (ids.length === 0) return { talks: 0, mine: 0, acknowledged: 0 };
  const mine = await client.from('ci_morning_talk_attendees').select('acknowledged_at').eq('user_id', userId).in('talk_id', ids);
  if (mine.error) return null;
  const rows = (mine.data ?? []) as { acknowledged_at: string | null }[];
  return { talks: ids.length, mine: rows.length, acknowledged: rows.filter(row => row.acknowledged_at).length };
}
