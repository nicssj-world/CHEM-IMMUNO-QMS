import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { PrintButton } from '@/components/print-button';
import { bangkokToday } from '@/lib/inventory-insights';
import { formatDate, formatDateTime, formatMonth } from '@/lib/format';
import { logUserMessage } from '@/lib/messages';
import { acknowledgement, actionStatusLabel, checklistProgress, isOverdue, isTalkScope, monthBounds, scopeLabel, TALK_SCOPES, type TalkRow } from '@/lib/morning-talk';
import { TALK_COLUMNS, attachChildren, loadActionsWithTalk, loadNames, userIdsOf } from '@/lib/morning-talk-data';

// Printable monthly record of Morning Talk: who was told, who acknowledged, what was checked and what was assigned. Bangkok months.
export default async function MorningTalkReportPage({ searchParams }: { searchParams: Promise<{ month?: string; scope?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const client = await createClient();
  if (!client) return <p className="error">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p>;
  const today = bangkokToday();
  const month = params.month ?? today.slice(0, 7);
  const bounds = monthBounds(month);
  if (!bounds) return <p className="error" role="alert">เดือนรายงานไม่ถูกต้อง</p>;
  const scope = isTalkScope(params.scope) ? params.scope : '';
  let talkQuery = client.from('ci_morning_talks').select(TALK_COLUMNS).gte('talk_date', bounds.from).lt('talk_date', bounds.to).order('talk_date').order('created_at').limit(400);
  if (scope) talkQuery = talkQuery.eq('scope', scope);
  const [talkResult, actionResult] = await Promise.all([
    talkQuery,
    // Actions created in the month (Bangkok), whichever talk date they belong to.
    loadActionsWithTalk(client, query => query.gte('created_at', `${bounds.from}T00:00:00+07:00`).lt('created_at', `${bounds.to}T00:00:00+07:00`).order('created_at')),
  ]);
  if (talkResult.error) return <p className="error" role="alert">อ่านรายงานไม่สำเร็จ: {logUserMessage('morning-talk-report', talkResult.error)}</p>;
  if (actionResult.error) return <p className="error" role="alert">อ่านรายงานไม่สำเร็จ: {logUserMessage('morning-talk-report', actionResult.error)}</p>;
  if ((talkResult.data ?? []).length >= 400) return <p className="error" role="alert">ข้อมูลรายงานเกินขอบเขตการแสดงผล · เลือกขอบเขตเดียวหรือเดือนอื่น</p>;
  const detail = await attachChildren(client, (talkResult.data ?? []) as TalkRow[]);
  if (detail.error) return <p className="error" role="alert">อ่านรายงานไม่สำเร็จ: {logUserMessage('morning-talk-report', detail.error)}</p>;
  const talks = detail.data;
  const actions = actionResult.data.filter(action => !scope || action.talk?.scope === scope);
  const names = await loadNames(client, [...userIdsOf(talks), ...actions.flatMap(action => [action.owner_id, ...(action.completed_by ? [action.completed_by] : [])])]);
  const name = (id: string | null) => (id ? names.get(id) ?? 'ไม่ทราบชื่อ' : '—');
  const active = talks.filter(talk => talk.status === 'active');
  const ackTotal = active.reduce((sum, talk) => { const ack = acknowledgement(talk.attendees); return { done: sum.done + ack.done, total: sum.total + ack.total }; }, { done: 0, total: 0 });
  const overdue = actions.filter(action => isOverdue(action, today)).length;
  return <main className="grid gap-6 report-page">
    <div className="print-hide"><Link href="/morning-talk">← Morning Talk วันนี้</Link></div>
    <header className="flex flex-wrap justify-between items-end gap-4"><div><p className="eyebrow">Morning Talk</p><h1 className="page-title">รายงาน Morning Talk ประจำเดือน</h1><p className="muted">{formatMonth(month)} · {scope ? `${scopeLabel(scope)} (${scope})` : 'ทุกขอบเขตที่มีสิทธิ์ดู'} · เวลา Asia/Bangkok</p><p className="print-only text-xs">พิมพ์โดย {access.displayName} · {formatDateTime(new Date())}</p></div><PrintButton /></header>
    <form method="get" className="surface p-4 flex flex-wrap gap-3 items-end print-hide">
      <label className="field">เดือนรายงาน<input className="input" type="month" name="month" defaultValue={month} required /></label>
      <label className="field">ขอบเขต<select className="input" name="scope" defaultValue={scope}><option value="">ทั้งหมด</option>{TALK_SCOPES.map(item => <option key={item} value={item}>{item === 'ALL' ? 'ทั้งสองคลัง (ALL)' : `${scopeLabel(item)} (${item})`}</option>)}</select></label>
      <button className="button">แสดงรายงาน</button>
    </form>
    <section className="surface p-5 min-w-0"><h2 className="font-bold text-lg mb-3">สรุป</h2><div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
      <p>ครั้งที่จัด<br /><strong className="text-2xl tabular-nums">{active.length}</strong></p><p>ยกเลิก<br /><strong className="text-2xl tabular-nums">{talks.length - active.length}</strong></p>
      <p>รับทราบ<br /><strong className="text-2xl tabular-nums">{ackTotal.done}/{ackTotal.total}</strong></p><p>งานที่มอบหมายในเดือน<br /><strong className="text-2xl tabular-nums">{actions.length}</strong>{overdue > 0 && <span className="muted"> · เกินกำหนด {overdue}</span>}</p>
    </div></section>
    <section className="surface p-5 min-w-0"><h2 className="font-bold text-lg mb-3">การประชุม ({talks.length})</h2>
      <div className="table-wrap"><table className="data-table report-table"><thead><tr><th>วันที่</th><th>หัวข้อ</th><th>ขอบเขต</th><th>ผู้สร้าง</th><th>รับทราบ</th><th>ยังไม่รับทราบ</th><th>รายการตรวจสอบ</th></tr></thead>
        <tbody>{talks.map(talk => { const ack = acknowledgement(talk.attendees); const progress = checklistProgress(talk.checklist); const missing = talk.attendees.filter(item => !item.acknowledged_at).map(item => name(item.user_id));
          return <tr key={talk.id}><td className="whitespace-nowrap">{formatDate(talk.talk_date)}</td><td><Link href={`/morning-talk/${talk.id}`}>{talk.title}</Link>{talk.status === 'cancelled' && <span className="block muted text-xs">ยกเลิก: {talk.cancel_reason}</span>}</td><td>{talk.scope}</td><td>{name(talk.created_by)}</td>
            <td className="tabular-nums">{talk.status === 'cancelled' ? '—' : `${ack.done}/${ack.total}`}</td><td>{talk.status === 'cancelled' ? '—' : missing.length ? missing.join(', ') : '—'}</td><td className="tabular-nums">{progress.done}/{progress.total}</td></tr>; })}
          {talks.length === 0 && <tr><td colSpan={7} className="muted">ไม่มี Morning Talk ในเดือนนี้</td></tr>}</tbody></table></div>
    </section>
    <section className="surface p-5 min-w-0"><h2 className="font-bold text-lg mb-3">งานที่มอบหมายในเดือนนี้ ({actions.length})</h2>
      <div className="table-wrap"><table className="data-table report-table"><thead><tr><th>งาน</th><th>จาก</th><th>ผู้รับผิดชอบ</th><th>กำหนดส่ง</th><th>สถานะ</th><th>เสร็จเมื่อ</th></tr></thead>
        <tbody>{actions.map(action => <tr key={action.id}><td>{action.title}</td><td>{action.talk?.title ?? '—'}</td><td>{name(action.owner_id)}</td><td className="whitespace-nowrap">{action.due_date ? formatDate(action.due_date) : '—'}</td>
          <td>{actionStatusLabel(action.status)}{isOverdue(action, today) ? ' · เกินกำหนด' : ''}</td><td>{action.completed_at ? `${formatDateTime(action.completed_at)} · ${name(action.completed_by)}` : '—'}</td></tr>)}
          {actions.length === 0 && <tr><td colSpan={6} className="muted">ไม่มีงานที่มอบหมายในเดือนนี้</td></tr>}</tbody></table></div>
    </section>
    <p className="muted text-xs">การรับทราบคือการยืนยันว่าผู้เข้าร่วมได้รับทราบ ไม่ใช่การลงนาม · งานเกินกำหนดคิดจากวันที่ในเวลา Asia/Bangkok · พิมพ์จากเบราว์เซอร์เป็น A4 PDF ได้</p>
  </main>;
}
