'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ClipboardPlus } from 'lucide-react';
import { SearchInput } from './search-input';
import { ConfirmDialog } from './confirm-dialog';
import { createCountRound } from '@/app/actions/stock-counts';
import { normalizeSearch, scopeLineCount, type CountScopeType, type ScopeBalance } from '@/lib/stock-count';

export type CreateLocation = { id: string; code: string; name: string; parent_location_id: string | null };
export type CreateProduct = { id: string; product_code: string; display_name: string; warehouse_id: number };
export type OpenRound = { id: string; createdAtText: string; scopeLabel: string; counted: number; total: number };

const scopes: { key: CountScopeType; label: string; hint: string }[] = [
  { key: 'all', label: 'น้ำยาทั้งหมด', hint: 'ทุกตำแหน่งและทุกกลุ่มที่คุณตรวจนับได้' },
  { key: 'locations', label: 'เฉพาะตำแหน่งจัดเก็บ', hint: 'เช่น ตู้เย็นหนึ่งตู้ (รวมชั้นในตู้)' },
  { key: 'group', label: 'เฉพาะกลุ่ม', hint: 'CHEM หรือ IMMUNO' },
  { key: 'products', label: 'เลือกน้ำยาเอง', hint: 'เลือกได้หลายรายการ' },
];

export function CountCreateForm({ balances, locations, products, groups, openRounds }: {
  balances: ScopeBalance[]; locations: CreateLocation[]; products: CreateProduct[];
  groups: { id: number; label: string }[]; openRounds: OpenRound[];
}) {
  const router = useRouter();
  // One key per form: a double click or a retried request returns the same round.
  const clientKey = useRef(crypto.randomUUID());
  const [scope, setScope] = useState<CountScopeType>('all');
  const [warehouseId, setWarehouseId] = useState(groups[0]?.id ?? 1);
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [productIds, setProductIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [askOpen, setAskOpen] = useState(false);

  const usedLocations = useMemo(() => new Set(balances.map(b => b.location_id)), [balances]);
  const locationOptions = useMemo(() => locations.filter(l => usedLocations.has(l.id) || locations.some(c => c.parent_location_id === l.id && usedLocations.has(c.id))), [locations, usedLocations]);
  const lineCount = scopeLineCount(balances, { type: scope, warehouseId, locationIds, productIds }, locations);
  const needle = normalizeSearch(search);
  const filteredLocations = locationOptions.filter(l => !needle || normalizeSearch(`${l.code} ${l.name}`).includes(needle));
  const filteredProducts = products.filter(p => !needle || needle.split(' ').every(part => normalizeSearch(`${p.product_code} ${p.display_name}`).includes(part))).slice(0, 200);
  const toggle = (list: string[], set: (value: string[]) => void, id: string) => set(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);

  async function submit(allowParallel: boolean) {
    if (pending) return;
    if (!allowParallel && openRounds.length) { setAskOpen(true); return; }
    setPending(true); setError('');
    try {
      const result = await createCountRound({ clientKey: clientKey.current, note, scopeType: scope, allowParallel, warehouseId, locationIds, productIds });
      if (!result.ok) {
        if (result.code === 'CI_COUNT_OPEN_ROUND_EXISTS') { setAskOpen(true); return; }
        setError(result.message); setAskOpen(false); return;
      }
      router.push(`/counts/${result.id}`);
    } catch { setError('เชื่อมต่อไม่สำเร็จ · กดสร้างอีกครั้งได้ ระบบจะไม่สร้างรอบซ้ำ'); }
    finally { setPending(false); }
  }

  return <section className="surface p-4 sm:p-6 grid gap-4">
    <h2 className="font-bold text-lg">เริ่มรอบตรวจนับใหม่</h2>
    <fieldset className="grid sm:grid-cols-2 gap-2">
      <legend className="text-sm font-semibold mb-2">ขอบเขตการตรวจนับ</legend>
      {scopes.map(item => <label key={item.key} className={'flex gap-3 items-start rounded-xl border p-3 min-h-12 cursor-pointer ' + (scope === item.key ? 'border-[var(--teal)] bg-[#eef8f7]' : 'border-line bg-white')}>
        <input type="radio" name="scope" className="mt-1 w-4 h-4" checked={scope === item.key} onChange={() => { setScope(item.key); setSearch(''); }} />
        <span><span className="font-semibold block">{item.label}</span><span className="muted text-xs">{item.hint}</span></span>
      </label>)}
    </fieldset>

    {scope === 'group' && <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="กลุ่มน้ำยา">
      {groups.map(group => <label key={group.id} className={'rounded-xl border p-3 min-h-12 flex items-center gap-2 cursor-pointer ' + (warehouseId === group.id ? 'border-[var(--teal)] bg-[#eef8f7]' : 'border-line')}>
        <input type="radio" name="group" className="w-4 h-4" checked={warehouseId === group.id} onChange={() => setWarehouseId(group.id)} /> {group.label}
      </label>)}
    </div>}

    {(scope === 'locations' || scope === 'products') && <div className="grid gap-2">
      <SearchInput label={scope === 'locations' ? 'ค้นหาตำแหน่ง' : 'ค้นหาน้ำยา'} placeholder={scope === 'locations' ? 'รหัสหรือชื่อตำแหน่ง' : 'ชื่อหรือรหัสน้ำยา'} value={search} onChange={setSearch} />
      <p className="text-sm muted">เลือกแล้ว {(scope === 'locations' ? locationIds : productIds).length} {scope === 'locations' ? 'ตำแหน่ง' : 'รายการ'}</p>
      <div className="grid gap-1 max-h-72 overflow-y-auto rounded-xl border border-line p-1">
        {scope === 'locations' ? filteredLocations.map(l => <label key={l.id} className="flex items-center gap-3 rounded-lg px-2 min-h-11 hover:bg-surface-2 cursor-pointer">
          <input type="checkbox" className="w-5 h-5 shrink-0" checked={locationIds.includes(l.id)} onChange={() => toggle(locationIds, setLocationIds, l.id)} />
          <span className="min-w-0"><span className="font-semibold">{l.code}</span> <span className="muted text-sm">{l.name}</span></span>
        </label>) : filteredProducts.map(p => <label key={p.id} className="flex items-center gap-3 rounded-lg px-2 min-h-11 hover:bg-surface-2 cursor-pointer">
          <input type="checkbox" className="w-5 h-5 shrink-0" checked={productIds.includes(p.id)} onChange={() => toggle(productIds, setProductIds, p.id)} />
          <span className="min-w-0 text-sm"><span className="muted tabular-nums">{p.product_code}</span> · {p.display_name}</span>
        </label>)}
        {(scope === 'locations' ? filteredLocations : filteredProducts).length === 0 && <p className="muted text-sm p-3">ไม่พบรายการที่ค้นหา</p>}
      </div>
    </div>}

    <label className="field">หมายเหตุ (ไม่บังคับ)<input className="input" value={note} maxLength={1000} onChange={event => setNote(event.target.value)} placeholder="เช่น ตรวจนับประจำเดือน" /></label>

    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
      <p className="text-sm" aria-live="polite">จะตรวจนับ <strong className="tabular-nums text-base">{lineCount.toLocaleString('th-TH')}</strong> รายการ <span className="muted">(แยกตาม LOT และตำแหน่ง)</span></p>
      <button type="button" className="button min-h-12" disabled={pending || lineCount === 0} aria-busy={pending} onClick={() => void submit(false)}>
        {pending ? <><span className="spinner" aria-hidden /><span role="status">กำลังสร้างรอบ…</span></> : <><ClipboardPlus size={18} aria-hidden /> สร้างรอบตรวจนับ</>}
      </button>
    </div>
    {lineCount === 0 && <p className="muted text-sm">ไม่มีน้ำยาคงเหลือในขอบเขตที่เลือก</p>}
    {error && <p className="error" role="alert">{error}</p>}

    <ConfirmDialog open={askOpen} title="มีรอบตรวจนับที่ยังไม่เสร็จ" confirmLabel="สร้างรอบใหม่" pendingLabel="กำลังสร้างรอบ…" cancelLabel="ยกเลิก"
      pending={pending} error={error} onClose={() => setAskOpen(false)} onConfirm={() => void submit(true)}>
      <p>เปิดรอบเดิมเพื่อตรวจต่อ หรือสร้างรอบใหม่ (เช่น ตรวจเฉพาะตำแหน่ง)</p>
      <ul className="grid gap-2">{openRounds.slice(0, 5).map(round => <li key={round.id}>
        <Link href={`/counts/${round.id}`} className="button secondary w-full justify-between min-h-12">
          <span className="text-left"><span className="block">เปิดรอบเดิม · {round.createdAtText}</span><span className="muted text-xs">{round.scopeLabel} · ตรวจแล้ว {round.counted}/{round.total}</span></span>
        </Link></li>)}</ul>
    </ConfirmDialog>
  </section>;
}
