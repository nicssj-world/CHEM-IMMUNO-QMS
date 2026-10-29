'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { updateTalkAction } from '@/app/actions/morning-talk';
import { ACTION_STATUSES, actionStatusLabels, type ActionRow } from '@/lib/morning-talk';
import { formatDate, formatDateTime } from '@/lib/format';
import { UrgencyBadge } from './urgency-badge';

export type ActionView = Pick<ActionRow, 'id' | 'talk_id' | 'title' | 'due_date' | 'status' | 'note' | 'completed_at' | 'updated_at'> & {
  owner_name: string; completed_by_name: string | null; canUpdate: boolean; talk_title?: string; talk_cancelled?: boolean;
};

function Row({ action, talkId, today, showTalk }: { action: ActionView; talkId: string; today: string; showTalk: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string>(action.status);
  const [note, setNote] = useState(action.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = status !== action.status || note !== (action.note ?? '');
  const save = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateTalkAction(action.id, status, note, action.updated_at, talkId);
      if (!result.ok) { setError(result.message); return; }
      setSaved(true);
      router.refresh();
    });
  };
  return <li className="rounded-lg border border-line p-3 grid gap-2">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="grid gap-0.5 min-w-0">
        <p className="font-semibold">{action.title}</p>
        {showTalk && action.talk_title && <p className="text-sm"><Link href={`/morning-talk/${talkId}`}>จาก: {action.talk_title}</Link>{action.talk_cancelled && <span className="muted"> · Morning Talk นี้ถูกยกเลิกแล้ว งานยังต้องปิดให้เรียบร้อย</span>}</p>}
        <p className="muted text-sm">ผู้รับผิดชอบ {action.owner_name} · กำหนดส่ง {action.due_date ? formatDate(action.due_date) : 'ไม่ระบุ'}</p>
      </div>
      <div className="flex flex-wrap gap-1.5"><UrgencyBadge action={action} today={today} />{action.status === 'cancelled' && <span className="badge" style={{ background: '#eef3f5', color: '#455e6d' }}>ยกเลิก</span>}</div>
    </div>
    {action.completed_at && <p className="muted text-xs">เสร็จเมื่อ {formatDateTime(action.completed_at)}{action.completed_by_name ? ` · ${action.completed_by_name}` : ''}</p>}
    {action.note && !action.canUpdate && <p className="text-sm">หมายเหตุ: {action.note}</p>}
    {action.canUpdate && <div className="grid gap-2 sm:grid-cols-[200px_1fr_auto] items-end">
      <label className="field">สถานะ<select className="input" value={status} onChange={event => setStatus(event.target.value)}>{ACTION_STATUSES.map(item => <option key={item} value={item}>{actionStatusLabels[item]}</option>)}</select></label>
      <label className="field">หมายเหตุ<input className="input" value={note} maxLength={1000} onChange={event => setNote(event.target.value)} placeholder="ความคืบหน้าหรือเหตุผล" /></label>
      <button type="button" className="button secondary" onClick={save} disabled={!dirty || pending} aria-busy={pending}>{pending ? 'กำลังบันทึก…' : 'บันทึก'}</button>
    </div>}
    {saved && !dirty && <p className="muted text-xs" role="status">บันทึกแล้ว</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </li>;
}

/** Owners update their own status and note; managers of the talk's scope update any. The database enforces both rules again. */
export function ActionList({ talkId, actions, today, showTalk = false, empty = 'ไม่มีงานที่มอบหมาย' }: { talkId?: string; actions: ActionView[]; today: string; showTalk?: boolean; empty?: string }) {
  if (actions.length === 0) return <p className="muted text-sm">{empty}</p>;
  return <ul className="grid gap-2">{actions.map(action => <Row key={action.id} action={action} talkId={talkId ?? action.talk_id} today={today} showTalk={showTalk} />)}</ul>;
}
