'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, ListChecks, Trash2, X } from 'lucide-react';
import { ConfirmDialog } from './confirm-dialog';
import { deleteCountRounds } from '@/app/actions/stock-counts';
import { roundStateLabels, type RoundState } from '@/lib/stock-count';

export type RoundListItem = {
  id: string; createdAtText: string; note: string | null; scopeLabel: string; state: RoundState;
  counted: number; total: number; removable: boolean;
};

const badge = (state: RoundState) => 'badge h-fit shrink-0 ' + (state === 'recheck' ? '!bg-amber-100 !text-amber-900' : state === 'counting' ? '' : '!bg-slate-100 !text-slate-700');

export function CountRoundList({ title, items, emptyText }: { title: string; items: RoundListItem[]; emptyText: string }) {
  const router = useRouter();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const removable = items.filter(item => item.removable);
  const toggle = (id: string) => setSelected(old => old.includes(id) ? old.filter(x => x !== id) : [...old, id]);

  async function confirmDelete() {
    if (!target || pending) return;
    setPending(true); setError('');
    try {
      const result = await deleteCountRounds(target);
      if (!result.ok) { setError(result.message); return; }
      setDone(`ลบแล้ว ${result.deleted} รอบ · ยอดคงเหลือในคลังไม่เปลี่ยน`);
      setTarget(null); setSelected([]); setSelecting(false);
      router.refresh();
    } catch { setError('เชื่อมต่อไม่สำเร็จ · ไม่มีรอบใดถูกลบ กรุณาลองใหม่'); }
    finally { setPending(false); }
  }

  const targetItems = items.filter(item => target?.includes(item.id));
  return <section className="surface p-4 sm:p-6 grid gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-bold text-lg">{title}</h2>
      {removable.length > 0 && (selecting
        ? <div className="flex gap-2">
            <button type="button" className="button danger min-h-11" disabled={!selected.length} onClick={() => { setError(''); setTarget(selected); }}><Trash2 size={16} aria-hidden /> ลบรอบที่เลือก ({selected.length})</button>
            <button type="button" className="button secondary min-h-11" onClick={() => { setSelecting(false); setSelected([]); }}><X size={16} aria-hidden /> เลิกเลือก</button>
          </div>
        : <button type="button" className="button secondary min-h-11" onClick={() => setSelecting(true)}><ListChecks size={16} aria-hidden /> เลือกหลายรอบ</button>)}
    </div>
    {done && <p className="notice" role="status">{done}</p>}
    <ul className="grid gap-2">
      {items.map(item => <li key={item.id} className="flex items-stretch gap-2">
        {selecting && <label className={'grid place-items-center w-11 shrink-0 rounded-xl border border-line ' + (item.removable ? 'cursor-pointer' : 'opacity-40')}>
          <input type="checkbox" className="w-5 h-5" disabled={!item.removable} checked={selected.includes(item.id)} onChange={() => toggle(item.id)}
            aria-label={`เลือกรอบ ${item.createdAtText}`} />
        </label>}
        <Link href={`/counts/${item.id}`} className="flex-1 min-w-0 rounded-xl border border-line p-3 sm:p-4 no-underline text-[var(--ink)] hover:bg-surface-2 flex items-center gap-3">
          <span className="min-w-0 flex-1 grid gap-0.5">
            <span className="font-semibold">{item.createdAtText}</span>
            <span className="muted text-sm truncate">{item.scopeLabel}{item.note ? ` · ${item.note}` : ''}</span>
            <span className="text-sm tabular-nums">ตรวจแล้ว {item.counted.toLocaleString('th-TH')} / {item.total.toLocaleString('th-TH')} รายการ</span>
          </span>
          <span className={badge(item.state)}>{roundStateLabels[item.state]}</span>
          <ChevronRight size={18} className="shrink-0 muted" aria-hidden />
        </Link>
        {!selecting && item.removable && <button type="button" className="grid place-items-center w-11 shrink-0 rounded-xl border border-line text-[#a83442] hover:bg-rose-50"
          aria-label={`ลบรอบ ${item.createdAtText}`} onClick={() => { setError(''); setDone(''); setTarget([item.id]); }}><Trash2 size={18} aria-hidden /></button>}
      </li>)}
    </ul>
    {!items.length && <p className="muted text-sm">{emptyText}</p>}
    <ConfirmDialog open={target !== null} danger title={targetItems.length > 1 ? `ลบ ${targetItems.length} รอบที่เลือก?` : 'ลบรอบตรวจนับนี้?'}
      confirmLabel="ลบรอบ" pendingLabel="กำลังลบ…" pending={pending} error={error} onClose={() => setTarget(null)} onConfirm={() => void confirmDelete()}>
      <ul className="grid gap-1 max-h-48 overflow-y-auto">{targetItems.map(item => <li key={item.id}>{item.createdAtText} · {item.scopeLabel}</li>)}</ul>
      <p className="muted">ลบได้เฉพาะรอบที่ยังไม่ได้ปรับยอดคลัง · ยอดคงเหลือไม่เปลี่ยน</p>
    </ConfirmDialog>
  </section>;
}
