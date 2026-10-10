import Link from 'next/link';
import { Ban, Pencil } from 'lucide-react';
import { formatDate, formatDateTime } from '@/lib/format';
import { acknowledgement, canManageTalk, canWorkInScope, checklistProgress, scopeLabel, sortOpenActions } from '@/lib/morning-talk';
import type { TalkDetail } from '@/lib/morning-talk-data';
import { AckButton } from './ack-button';
import { ActionList, type ActionView } from './action-list';
import { ChecklistPanel } from './checklist-panel';

export type TalkViewer = { userId: string; warehouses: readonly { code: string; role: string }[]; manageable: readonly string[] };

export function ScopeBadge({ scope }: { scope: string }) { return <span className="badge">{scope === 'ALL' ? 'ทั้งสองคลัง' : scope}</span>; }

/** Everything about one talk: who has acknowledged, the checklist and the assigned actions. Server-rendered; only the controls are client components. */
export function TalkCard({ talk, names, viewer, today, href, showAck = false, heading = 'h2' }: {
  talk: TalkDetail; names: ReadonlyMap<string, string>; viewer: TalkViewer; today: string; href?: string; showAck?: boolean; heading?: 'h1' | 'h2';
}) {
  const name = (id: string | null) => (id ? names.get(id) ?? 'ไม่ทราบชื่อ' : null);
  const cancelled = talk.status === 'cancelled';
  const manage = canManageTalk(viewer.manageable, talk.scope);
  const works = canWorkInScope(viewer.warehouses, talk.scope);
  const mine = talk.attendees.find(item => item.user_id === viewer.userId);
  const ack = acknowledgement(talk.attendees);
  const progress = checklistProgress(talk.checklist);
  const Heading = heading;
  const actions: ActionView[] = sortOpenActions(talk.actions, today).map(action => ({
    ...action, owner_name: name(action.owner_id) ?? 'ไม่ทราบชื่อ', completed_by_name: name(action.completed_by),
    // Actions outlive a cancelled talk (they stay open until done or cancelled), so the talk's status does not gate them.
    canUpdate: manage || (action.owner_id === viewer.userId && works),
  }));
  return <article className="surface p-5 grid gap-4" aria-labelledby={`talk-${talk.id}`}>
    <header className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2"><ScopeBadge scope={talk.scope} />{cancelled && <span className="badge" style={{ background: '#fff1f2', color: '#8c2534' }}><Ban size={13} aria-hidden className="mr-1" />ยกเลิกแล้ว</span>}<span className="muted text-sm">{formatDate(talk.talk_date)} · {scopeLabel(talk.scope)}</span></div>
      <Heading id={`talk-${talk.id}`} className={heading === 'h1' ? 'page-title' : 'text-lg font-bold'}>{href ? <Link href={href} className="no-underline text-[var(--ink)]">{talk.title}</Link> : talk.title}</Heading>
      <p className="muted text-xs">สร้างโดย {name(talk.created_by) ?? 'ไม่ทราบชื่อ'} · {formatDateTime(talk.created_at)}</p>
      {cancelled && <p className="error">ยกเลิกเมื่อ {formatDateTime(talk.cancelled_at)} โดย {name(talk.cancelled_by) ?? 'ไม่ทราบชื่อ'} · เหตุผล: {talk.cancel_reason}</p>}
    </header>
    {talk.agenda && <p className="whitespace-pre-line">{talk.agenda}</p>}

    {showAck && mine && !cancelled && <AckButton talkId={talk.id} acknowledgedAt={mine.acknowledged_at} sticky={!mine.acknowledged_at} />}

    <div className="grid gap-2">
      <details className="rounded-lg border border-line">
        <summary className="flex items-center justify-between gap-3 p-3 min-h-11 cursor-pointer font-semibold"><span>ผู้เข้าร่วม · รับทราบ {ack.done}/{ack.total}</span>{ack.complete && <span className="badge">ครบทุกคน</span>}</summary>
        <ul className="grid gap-1 px-3 pb-3 text-sm">{talk.attendees.map(item => <li key={item.user_id} className="flex flex-wrap justify-between gap-2"><span>{name(item.user_id) ?? 'ไม่ทราบชื่อ'}</span><span className={item.acknowledged_at ? '' : 'muted'}>{item.acknowledged_at ? `รับทราบ ${formatDateTime(item.acknowledged_at)}` : 'ยังไม่รับทราบ'}</span></li>)}{talk.attendees.length === 0 && <li className="muted">ยังไม่ได้ระบุผู้เข้าร่วม</li>}</ul>
      </details>
    </div>

    <div className="grid gap-2"><h3 className="font-bold">รายการตรวจสอบ <span className="muted font-normal text-sm">{progress.done}/{progress.total}</span></h3>
      <ChecklistPanel talkId={talk.id} canTick={!cancelled && (manage || (Boolean(mine) && works))} items={talk.checklist.map(item => ({ id: item.id, title: item.title, completed_at: item.completed_at, completed_by_name: name(item.completed_by) }))} />
    </div>

    <div className="grid gap-2"><h3 className="font-bold">งานที่มอบหมาย</h3><ActionList talkId={talk.id} actions={actions} today={today} /></div>

    {manage && !cancelled && <div className="flex flex-wrap gap-2 print-hide"><Link className="button secondary" href={`/morning-talk/${talk.id}/edit`}><Pencil size={16} aria-hidden />แก้ไข</Link></div>}
  </article>;
}
