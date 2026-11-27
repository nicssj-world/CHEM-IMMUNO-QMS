'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setChecklistItem } from '@/app/actions/morning-talk';
import { formatDateTime } from '@/lib/format';

export type ChecklistView = { id: string; title: string; completed_at: string | null; completed_by_name: string | null };

/** Large tap targets. Managers and assigned staff may tick; everyone else sees the state read-only. The database enforces the same rule. */
export function ChecklistPanel({ talkId, items, canTick }: { talkId: string; items: ChecklistView[]; canTick: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (items.length === 0) return <p className="muted text-sm">ไม่มีรายการตรวจสอบ</p>;
  const toggle = (item: ChecklistView) => {
    setError(null);
    setBusy(item.id);
    startTransition(async () => {
      const result = await setChecklistItem(item.id, !item.completed_at, talkId);
      setBusy(null);
      if (!result.ok) { setError(result.message); return; }
      router.refresh();
    });
  };
  return <div className="grid gap-2">
    <ul className="grid gap-1.5">{items.map(item => <li key={item.id}>
      <label className={`flex items-start gap-3 rounded-lg border border-line p-3 min-h-11 ${canTick ? 'cursor-pointer' : ''}`}>
        <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={Boolean(item.completed_at)} disabled={!canTick || (pending && busy === item.id)} onChange={() => toggle(item)} />
        <span className="grid gap-0.5"><span className={item.completed_at ? 'line-through muted' : ''}>{item.title}</span>
          {item.completed_at && <span className="muted text-xs">เสร็จเมื่อ {formatDateTime(item.completed_at)}{item.completed_by_name ? ` · ${item.completed_by_name}` : ''}</span>}</span>
      </label>
    </li>)}</ul>
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
