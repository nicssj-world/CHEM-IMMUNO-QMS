import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { bangkokToday } from '@/lib/inventory-insights';
import { logUserMessage } from '@/lib/messages';
import { canManageTalk, canWorkInScope, isOverdue, isTalkScope, scopeLabel, sortOpenActions, TALK_SCOPES } from '@/lib/morning-talk';
import { loadActionsWithTalk, loadManageableScopes, loadNames } from '@/lib/morning-talk-data';
import { ActionList, type ActionView } from '@/components/morning-talk/action-list';

type Params = { mine?: string; overdue?: string; scope?: string };

function chipHref(params: Params, change: Partial<Record<keyof Params, string | null>>) {
  const next: Record<string, string> = {};
  for (const key of ['mine', 'overdue', 'scope'] as const) { const value = key in change ? change[key] : params[key]; if (value) next[key] = value; }
  const text = new URLSearchParams(next).toString();
  return `/morning-talk/actions${text ? `?${text}` : ''}`;
}

// Every open action I can read: overdue first, then due soon, then later dates, then no due date. Each row links to its talk.
export default async function MorningTalkActionsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const client = await createClient();
  if (!client) return <main className="grid gap-4"><h1 className="page-title">งานค้างจาก Morning Talk</h1><p className="error" role="alert">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p></main>;
  const today = bangkokToday();
  const mine = params.mine === '1';
  const overdueOnly = params.overdue === '1';
  const scope = isTalkScope(params.scope) ? params.scope : '';
  const [result, manageable] = await Promise.all([
    loadActionsWithTalk(client, query => {
      let q = query.in('status', ['todo', 'in_progress']);
      if (mine) q = q.eq('owner_id', access.userId);
      if (overdueOnly) q = q.lt('due_date', today);
      // Scope is filtered in the database (actions carry their talk's warehouse; ALL has none), so the row cap never hides matches.
      if (scope === 'ALL') q = q.is('warehouse_id', null);
      else if (scope) q = q.eq('warehouse_id', Number(access.warehouses.find(item => item.code === scope)?.id ?? -1));
      return q;
    }),
    loadManageableScopes(client),
  ]);
  if (result.error) return <main className="grid gap-4"><h1 className="page-title">งานค้างจาก Morning Talk</h1><p className="error" role="alert">อ่านข้อมูลไม่สำเร็จ: {logUserMessage('morning-talk-actions', result.error)}</p></main>;
  const filtered = result.data;
  const sorted = sortOpenActions(filtered, today);
  const names = await loadNames(client, sorted.flatMap(action => [action.owner_id, ...(action.completed_by ? [action.completed_by] : [])]));
  const views: ActionView[] = sorted.map(action => {
    const talkScope = action.talk?.scope ?? 'ALL';
    return { ...action, owner_name: names.get(action.owner_id) ?? 'ไม่ทราบชื่อ', completed_by_name: null, talk_title: action.talk?.title ?? 'Morning Talk', talk_cancelled: action.talk?.status === 'cancelled',
      canUpdate: (canManageTalk(manageable, talkScope) || (action.owner_id === access.userId && canWorkInScope(access.warehouses, talkScope))) };
  });
  const overdueCount = filtered.filter(action => isOverdue(action, today)).length;
  const chip = (label: string, href: string, on: boolean) => <Link key={label} href={href} aria-current={on ? 'true' : undefined} className={`button ${on ? '' : 'secondary'}`}>{label}</Link>;
  return <main className="grid gap-5 max-w-[980px]">
    <div><p className="eyebrow mb-2">Morning Talk</p><h1 className="page-title">งานค้างจาก Morning Talk</h1><p className="muted mt-2 text-sm">งานที่ยังไม่เสร็จในขอบเขตที่คุณมีสิทธิ์ดู · เกินกำหนด {overdueCount} · ทั้งหมด {filtered.length}</p></div>
    <nav aria-label="ตัวกรองงานค้าง" className="flex flex-wrap gap-2">
      {chip('ทั้งหมด', '/morning-talk/actions', !mine && !overdueOnly && !scope)}
      {chip('ของฉัน', chipHref(params, { mine: mine ? null : '1' }), mine)}
      {chip('เกินกำหนด', chipHref(params, { overdue: overdueOnly ? null : '1' }), overdueOnly)}
      {TALK_SCOPES.map(item => chip(item === 'ALL' ? 'ทั้งสองคลัง' : scopeLabel(item), chipHref(params, { scope: scope === item ? null : item }), scope === item))}
    </nav>
    <ActionList actions={views} today={today} showTalk empty="ไม่มีงานค้างตามเงื่อนไขนี้" />
    {result.data.length >= 500 && <p className="muted text-sm">แสดง 500 รายการแรก · ใช้ตัวกรองเพื่อจำกัดรายการ</p>}
  </main>;
}
