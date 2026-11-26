'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowLeft, Check, ClipboardCheck, Minus, Pencil, Plus, Trash2 } from 'lucide-react';
import { SearchInput } from './search-input';
import { ConfirmDialog } from './confirm-dialog';
import { deleteCountRounds, finalizeCountRound, setCountLineState } from '@/app/actions/stock-counts';
import { formatQuantity, groupByLocation, inTab, matchesCountQuery, parseCountQuantity, roundStateLabels, stepQuantity, summarize, variance, varianceText, type ChecklistLine, type CountTab, type RoundState } from '@/lib/stock-count';
import { unitLabel } from '@/lib/units';

export type ChecklistRound = {
  id: string; createdAtText: string; note: string | null; scopeLabel: string; state: RoundState;
  editable: boolean; canEdit: boolean; canFinalize: boolean; canDelete: boolean; deletable: boolean;
};

const tabs: { key: CountTab; label: string }[] = [
  { key: 'pending', label: 'ยังไม่ได้ตรวจ' }, { key: 'counted', label: 'ตรวจแล้ว' }, { key: 'all', label: 'ทั้งหมด' },
];
const fmt = (n: number) => n.toLocaleString('th-TH', { maximumFractionDigits: 3 });
const dateText = (value: string | null) => { if (!value) return ''; const [y, m, d] = value.split('-'); return `${d}/${m}/${y}`; };

export function CountChecklist({ round, initialLines, initialNotice = '' }: { round: ChecklistRound; initialLines: ChecklistLine[]; initialNotice?: string }) {
  const router = useRouter();
  // Local state is the source of truth while counting. The page remounts this component (key)
  // only when the round itself changes state, so a re-sent older server payload never rolls back saves.
  const [lines, setLines] = useState(initialLines);
  const writable = round.editable && round.canEdit;
  const [tab, setTab] = useState<CountTab>(writable ? 'pending' : 'all');
  const [query, setQuery] = useState('');
  // Typed numbers live only until they are saved; they survive refreshes of the list itself.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const busy = useRef(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<{ id: string; text: string } | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState('');
  const [notice] = useState(initialNotice);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const stats = useMemo(() => summarize(lines), [lines]);
  const counts = { pending: stats.pending, counted: stats.counted, all: stats.total };
  const visible = useMemo(() => lines.filter(line => inTab(line, tab) && matchesCountQuery(line, query)), [lines, tab, query]);
  const groups = useMemo(() => groupByLocation(visible), [visible]);
  const varianceLines = useMemo(() => lines.filter(line => line.counted && (variance(line.physical, line.snapshot) ?? 0) !== 0), [lines]);

  const draftOf = (line: ChecklistLine) => drafts[line.id] ?? formatQuantity(line.physical ?? line.snapshot);
  const setDraft = (id: string, value: string) => { setDrafts(old => ({ ...old, [id]: value })); setErrors(old => ({ ...old, [id]: '' })); };

  async function save(line: ChecklistLine, counted: boolean) {
    if (!writable || busy.current.has(line.id)) return; // one request per line at a time
    const raw = draftOf(line);
    if (counted) {
      const parsed = parseCountQuantity(raw);
      if (!parsed.ok) { setErrors(old => ({ ...old, [line.id]: parsed.message })); return; }
    }
    busy.current.add(line.id);
    setPending(old => ({ ...old, [line.id]: true }));
    setErrors(old => ({ ...old, [line.id]: '' }));
    try {
      const result = await setCountLineState(round.id, line.countId, line.id, counted, counted ? raw : null);
      if (!result.ok) { setErrors(old => ({ ...old, [line.id]: result.message })); return; }
      setLines(old => old.map(item => item.id === line.id ? { ...item, counted: result.counted, physical: result.physical, needsRecount: result.counted ? false : item.needsRecount } : item));
      if (result.counted) {
        setDrafts(old => { const next = { ...old }; delete next[line.id]; return next; });
        setToast({ id: line.id, text: `ตรวจแล้ว: ${line.productCode} · LOT ${line.lotNumber} · ${fmt(result.physical ?? 0)} ${unitLabel(line.unit)}` });
      } else {
        setDrafts(old => ({ ...old, [line.id]: formatQuantity(line.physical ?? line.snapshot) }));
        setToast(null);
      }
    } catch {
      setErrors(old => ({ ...old, [line.id]: 'บันทึกไม่สำเร็จ · ตรวจการเชื่อมต่อแล้วกดอีกครั้ง ตัวเลขที่กรอกยังอยู่' }));
    } finally {
      busy.current.delete(line.id);
      setPending(old => ({ ...old, [line.id]: false }));
    }
  }

  async function finish() {
    if (finishing) return;
    setFinishing(true); setFinishError('');
    try {
      const result = await finalizeCountRound(round.id);
      if (!result.ok) { setFinishError(result.message); return; }
      setSummaryOpen(false);
      // The URL carries the outcome, and the fresh page brings the new snapshot / state.
      const query = result.status === 'recount' ? `result=recount&n=${result.recount}`
        : `result=${result.already ? 'already' : 'approved'}&n=${result.adjusted}${result.partial ? '&partial=1' : ''}`;
      router.replace(`/counts/${round.id}?${query}`);
    } catch {
      setFinishError('เชื่อมต่อไม่สำเร็จ · ยังไม่ทราบผล กรุณาโหลดหน้าใหม่เพื่อตรวจสถานะก่อนกดอีกครั้ง');
    } finally { setFinishing(false); }
  }

  async function removeRound() {
    if (deleting) return;
    setDeleting(true); setDeleteError('');
    try {
      const result = await deleteCountRounds([round.id]);
      if (!result.ok) { setDeleteError(result.message); return; }
      router.replace('/counts?deleted=1');
    } catch { setDeleteError('เชื่อมต่อไม่สำเร็จ · กรุณาลองใหม่'); }
    finally { setDeleting(false); }
  }

  return <main className="grid gap-4 max-w-[860px] pb-28 md:pb-8">
    <header className="grid gap-3">
      <Link href="/counts" className="text-sm inline-flex items-center gap-1 min-h-11 w-fit"><ArrowLeft size={16} aria-hidden /> รอบตรวจนับ</Link>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">ตรวจนับคลังน้ำยา</h1>
          <p className="muted text-sm">{round.createdAtText} · {round.scopeLabel}{round.note ? ` · ${round.note}` : ''}</p>
        </div>
        <span className={'badge h-fit ' + (round.state === 'recheck' ? '!bg-amber-100 !text-amber-900' : round.state === 'counting' ? '' : '!bg-slate-100 !text-slate-700')}>{roundStateLabels[round.state]}</span>
      </div>
      <div className="surface px-4 py-3 grid gap-2" aria-label="ความคืบหน้า">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span>ตรวจแล้ว <strong className="tabular-nums text-base">{fmt(stats.counted)}</strong> / <span className="tabular-nums">{fmt(stats.total)}</span> · ยังไม่ได้ตรวจ <strong className="tabular-nums">{fmt(stats.pending)}</strong></span>
          <span className="tabular-nums font-semibold">{stats.percent}%</span>
        </div>
        <div className="h-2 rounded-full bg-slate-200 overflow-hidden" role="progressbar" aria-label="สัดส่วนที่ตรวจแล้ว" aria-valuemin={0} aria-valuemax={stats.total} aria-valuenow={stats.counted}>
          <div className="h-full bg-emerald-600 transition-[width] duration-300" style={{ width: `${stats.total ? (100 * stats.counted) / stats.total : 0}%` }} />
        </div>
      </div>
    </header>

    {notice && <p className="notice" role="status">{notice}</p>}
    {stats.recount > 0 && writable && <p className="notice !bg-amber-50 !border-amber-200 !text-amber-900 flex gap-2" role="status"><AlertTriangle size={18} className="shrink-0 mt-0.5" aria-hidden />มี {fmt(stats.recount)} รายการที่ยอดในระบบเปลี่ยนระหว่างตรวจนับ · ตรวจรายการที่มีป้าย “ตรวจใหม่” อีกครั้ง</p>}
    {!writable && round.editable && <p className="notice">บัญชีนี้ดูรายการได้อย่างเดียว</p>}

    <div className="sticky top-0 z-10 -mx-4 px-4 sm:mx-0 sm:px-0 py-2 bg-[var(--bg)] grid gap-2">
      <SearchInput label="ค้นหาน้ำยา" labelHidden placeholder="ค้นหา ชื่อ รหัส LOT หรือตำแหน่ง" value={query} onChange={setQuery} />
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1" role="tablist" aria-label="มุมมองรายการ">
        {tabs.map(item => <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} onClick={() => setTab(item.key)}
          className={'min-h-12 rounded-lg px-1 py-1 grid content-center leading-tight transition-colors ' + (tab === item.key ? 'bg-white shadow-sm text-[var(--ink)]' : 'text-slate-600')}>
          <span className="text-[13px] sm:text-sm">{item.label}</span>
          <span className="tabular-nums font-semibold text-sm">{fmt(counts[item.key])}</span>
        </button>)}
      </div>
    </div>

    <section className="grid gap-5" aria-label="รายการน้ำยา">
      {groups.map(group => <div key={group.code} className="grid gap-2">
        <h2 className="text-sm font-semibold text-slate-700 flex items-baseline gap-2 px-1 min-w-0">
          <span className="shrink-0 whitespace-nowrap">ตำแหน่ง {group.code}</span>{group.name && <span className="muted font-normal truncate min-w-0">{group.name}</span>}
          <span className="muted font-normal ml-auto shrink-0 whitespace-nowrap tabular-nums">{group.lines.length} รายการ</span>
        </h2>
        {group.lines.map(line => {
          const raw = draftOf(line);
          const parsed = parseCountQuantity(raw);
          const diff = line.counted ? variance(line.physical, line.snapshot) : parsed.ok ? variance(parsed.value, line.snapshot) : null;
          const working = Boolean(pending[line.id]);
          const unit = unitLabel(line.unit);
          return <article key={line.id} className={'rounded-2xl border p-3 sm:p-4 grid gap-3 ' + (line.counted ? 'bg-emerald-50/70 border-emerald-200' : 'bg-white border-line')}>
            <div className="flex gap-3 items-start">
              {line.counted && <span className="shrink-0 grid place-items-center w-7 h-7 rounded-full bg-emerald-600 text-white" aria-hidden><Check size={16} strokeWidth={3} /></span>}
              <div className="min-w-0 flex-1">
                <p className="text-xs muted tabular-nums">{line.productCode}</p>
                <p className={'font-semibold leading-snug break-words ' + (line.counted ? 'line-through decoration-slate-400 text-slate-600' : '')}>{line.productName}</p>
                <p className="text-sm text-slate-700 mt-0.5">LOT {line.lotNumber}{line.expiryDate ? <span className="muted"> · EXP {dateText(line.expiryDate)}</span> : null}</p>
                {line.needsRecount && !line.counted && <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-900 px-2 py-0.5 text-xs"><AlertTriangle size={13} aria-hidden /> ยอดในระบบเปลี่ยน · ตรวจใหม่</p>}
              </div>
              {line.counted && <span className="sr-only">ตรวจแล้ว</span>}
            </div>

            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
              <div>
                <p className="text-xs muted">ยอดคงเหลือในคลัง</p>
                <p className="text-xl tabular-nums font-semibold">{fmt(line.snapshot)} <span className="text-xs font-normal muted">{unit}</span></p>
              </div>
              {line.counted || !writable ? <div className="text-right">
                <p className="text-xs muted">ยอดตรวจนับจริง</p>
                <p className="text-xl tabular-nums font-semibold">{line.physical === null ? '—' : fmt(line.physical)} <span className="text-xs font-normal muted">{unit}</span></p>
              </div> : <div className="grid gap-1 justify-items-end">
                <label className="text-xs muted" htmlFor={`qty-${line.id}`}>ยอดตรวจนับจริง</label>
                <div className="flex items-center gap-1">
                  <button type="button" className="grid place-items-center w-11 h-11 rounded-lg border border-line bg-white active:bg-slate-100" aria-label={`ลดจำนวน ${line.productCode}`}
                    disabled={working} onClick={() => setDraft(line.id, stepQuantity(raw, -1, line.snapshot))}><Minus size={18} aria-hidden /></button>
                  <input id={`qty-${line.id}`} className="input !min-h-11 !w-20 text-center tabular-nums !text-base !px-1" inputMode="decimal" autoComplete="off" enterKeyHint="done"
                    value={raw} disabled={working} aria-invalid={!parsed.ok || undefined}
                    onChange={event => setDraft(line.id, event.target.value)}
                    onFocus={event => event.currentTarget.select()}
                    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void save(line, true); } }} />
                  <button type="button" className="grid place-items-center w-11 h-11 rounded-lg border border-line bg-white active:bg-slate-100" aria-label={`เพิ่มจำนวน ${line.productCode}`}
                    disabled={working} onClick={() => setDraft(line.id, stepQuantity(raw, 1, line.snapshot))}><Plus size={18} aria-hidden /></button>
                </div>
              </div>}
            </div>

            <div className="flex items-center justify-between gap-3">
              <p className={'text-sm ' + (diff === null ? 'muted' : diff === 0 ? 'text-emerald-800' : 'text-amber-800 font-semibold')} aria-live="polite">
                {diff === null ? (parsed.ok ? '' : 'กรอกจำนวนให้ถูกต้อง') : varianceText(diff)}
              </p>
              {writable && (line.counted
                ? <button type="button" className="button secondary min-h-11 px-4" disabled={working} aria-busy={working} onClick={() => void save(line, false)}>
                    {working ? <><span className="spinner" aria-hidden /><span role="status">กำลังบันทึก…</span></> : <><Pencil size={16} aria-hidden /> แก้ไข</>}
                  </button>
                : <button type="button" className="button min-h-12 px-5 min-w-[9rem]" disabled={working} aria-busy={working} onClick={() => void save(line, true)}>
                    {working ? <><span className="spinner" aria-hidden /><span role="status">กำลังบันทึก…</span></> : <><Check size={18} aria-hidden /> ตรวจแล้ว</>}
                  </button>)}
            </div>
            {errors[line.id] && <p className="error text-sm !py-2" role="alert">{errors[line.id]}</p>}
          </article>;
        })}
      </div>)}
      {!groups.length && <div className="surface p-6 text-center muted">
        {query ? 'ไม่พบรายการที่ค้นหา · ลองคำค้นอื่น หรือกด X เพื่อล้างคำค้น'
          : tab === 'pending' ? (stats.total ? 'ตรวจครบทุกรายการแล้ว' : 'รอบนี้ไม่มีรายการ')
          : tab === 'counted' ? 'ยังไม่มีรายการที่ตรวจแล้ว' : 'รอบนี้ไม่มีรายการ'}
      </div>}
    </section>

    {round.canDelete && round.deletable && <section className="mt-6 pt-5 border-t border-line grid gap-2">
      <p className="muted text-sm">ลบรอบนี้ได้เพราะยังไม่ได้ปรับยอดคลัง · การลบไม่เปลี่ยนยอดคงเหลือ</p>
      <button type="button" className="button secondary w-fit text-[#a83442] border-[#e3b8bf]" onClick={() => { setDeleteError(''); setDeleteOpen(true); }}><Trash2 size={16} aria-hidden /> ลบรอบนี้</button>
    </section>}

    {writable && <div className="sticky-action md:static -mx-4 px-4 sm:mx-0 sm:px-0">
      <div className="surface p-3 flex items-center justify-between gap-3">
        {toast ? <div className="min-w-0 flex items-center gap-2" role="status">
          <Check size={18} className="shrink-0 text-emerald-700" aria-hidden />
          <span className="text-sm min-w-0 line-clamp-2">{toast.text}</span>
          <button type="button" className="shrink-0 text-sm underline underline-offset-2 min-h-11 px-2 text-[var(--blue)]"
            onClick={() => { const line = lines.find(item => item.id === toast.id); setToast(null); if (line) void save(line, false); }}>แก้ไข</button>
        </div> : <p className="text-sm muted min-w-0">บันทึกอัตโนมัติ · กลับมาตรวจต่อได้</p>}
        <button type="button" className="button shrink-0 min-h-12" onClick={() => { setFinishError(''); setSummaryOpen(true); }}><ClipboardCheck size={18} aria-hidden /> สรุปผล</button>
      </div>
    </div>}


    <ConfirmDialog open={summaryOpen} title="สรุปผลตรวจนับ" onClose={() => setSummaryOpen(false)} pending={finishing} error={finishError}
      confirmLabel={round.canFinalize ? 'จบรอบและปรับยอดที่ตรวจแล้ว' : 'ปิด'} pendingLabel="กำลังตรวจสอบและปรับยอด…"
      cancelLabel="บันทึกและตรวจต่อภายหลัง"
      onConfirm={() => { if (!round.canFinalize) { setSummaryOpen(false); return; } if (stats.counted === 0) { setFinishError('ยังไม่มีรายการที่ตรวจแล้ว · ตรวจอย่างน้อย 1 รายการก่อนจบรอบ'); return; } void finish(); }}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        {([['รายการทั้งหมด', stats.total], ['ตรวจแล้ว', stats.counted], ['ยังไม่ได้ตรวจ', stats.pending], ['ยอดตรงกับระบบ', stats.match],
          ['ยอดเกิน', stats.over], ['ยอดขาด', stats.short], ['รายการที่จะปรับยอด', stats.adjust]] as const).map(([label, value]) =>
          <div key={label} className="flex justify-between gap-2 border-b border-line py-1"><dt className="muted">{label}</dt><dd className="tabular-nums font-semibold">{fmt(value)}</dd></div>)}
      </dl>
      {stats.pending > 0 && stats.counted > 0 && <p className="notice !py-2">ระบบจะปรับยอดเฉพาะรายการที่ตรวจแล้ว ส่วนรายการที่ยังไม่ได้ตรวจจะคงยอดเดิม</p>}
      {varianceLines.length > 0 && <div className="grid gap-1 max-h-56 overflow-y-auto">
        <p className="font-semibold">รายการที่มีส่วนต่าง</p>
        {varianceLines.map(line => <p key={line.id} className="flex justify-between gap-3 border-b border-line py-1">
          <span className="min-w-0">{line.productCode} · LOT {line.lotNumber}<span className="muted block text-xs">ตำแหน่ง {line.locationCode} · ในระบบ {fmt(line.snapshot)} → นับได้ {fmt(line.physical ?? 0)}</span></span>
          <span className="tabular-nums font-semibold shrink-0">{varianceText(variance(line.physical, line.snapshot))}</span></p>)}
      </div>}
      {!round.canFinalize && <p className="muted">ผลตรวจบันทึกไว้แล้ว · หัวหน้างานหรือผู้ดูแลระบบเป็นผู้จบรอบและปรับยอด</p>}
    </ConfirmDialog>

    <ConfirmDialog open={deleteOpen} title="ลบรอบตรวจนับนี้?" danger confirmLabel="ลบรอบ" pendingLabel="กำลังลบ…"
      pending={deleting} error={deleteError} onClose={() => setDeleteOpen(false)} onConfirm={() => void removeRound()}>
      <p>{round.createdAtText} · {round.scopeLabel}</p>
      <p className="muted">ผลตรวจที่บันทึกในรอบนี้จะถูกลบ · ยอดคงเหลือในคลังไม่เปลี่ยน</p>
    </ConfirmDialog>
  </main>;
}
