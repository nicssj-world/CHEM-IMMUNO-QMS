'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { SearchInput } from './search-input';
import type { IssueCartLine } from '@/lib/issue-cart';
import type { IssueCandidate, IssueProduct } from './issue-group-workbench';

export type IssueWarehouse = { id: number; code: string };

type LotGroup = {
  id: string;
  number: string;
  expiry: string;
  locations: IssueCandidate[];
  balance: number;
};
type ProductGroup = { product: IssueProduct; lots: LotGroup[]; balance: number };
const keyOf = (lotId: string, locationId: string) => lotId + ':' + locationId;
const formatDate = (value: string) => {
  const [year, month, day] = value.split('-');
  return year && month && day ? day + '/' + month + '/' + year : '—';
};
const formatQuantity = (value: number) => value.toLocaleString('th-TH');

function warehouseTitle(code: string) {
  if (code === 'CHE') return 'CHEM';
  if (code === 'IMM') return 'IMMUNO';
  return code;
}

/** One product heading, one LOT heading, and one selectable row per physical location.
 * Selecting a row never mutates inventory; group creation and closing are separate RPCs.
 */
export function IssuePrepareCatalog({
  warehouses, products, candidates, lines, onChange,
}: {
  warehouses: IssueWarehouse[];
  products: IssueProduct[];
  candidates: IssueCandidate[];
  lines: IssueCartLine[];
  onChange: (next: IssueCartLine[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [expandedWarehouses, setExpandedWarehouses] = useState<number[]>(() =>
    warehouses.length ? [warehouses[0].id] : []);
  // Every product starts open so a new user can select LOTs without extra clicks.
  const [collapsedProducts, setCollapsedProducts] = useState<string[]>([]);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  const selected = new Map(lines.map(line => [keyOf(line.lot_id, line.location_id), line]));

  const prepared = useMemo(() => {
    const byProduct = new Map<string, IssueCandidate[]>();
    for (const candidate of candidates) {
      const list = byProduct.get(candidate.product_id) ?? [];
      list.push(candidate);
      byProduct.set(candidate.product_id, list);
    }
    const byWarehouse = new Map<number, ProductGroup[]>();
    const firstFefo = new Map<string, string>();
    for (const product of [...products].sort((a, b) =>
      a.product_code.localeCompare(b.product_code) || a.id.localeCompare(b.id))) {
      const options = byProduct.get(product.id) ?? [];
      const lotMap = new Map<string, LotGroup>();
      for (const option of options) {
        const entry = lotMap.get(option.lot_id) ?? {
          id: option.lot_id, number: option.lot_number, expiry: option.expiry_date,
          locations: [], balance: 0,
        };
        entry.locations.push(option);
        entry.balance += Number(option.balance);
        lotMap.set(option.lot_id, entry);
      }
      const lots = [...lotMap.values()].sort((a, b) =>
        a.expiry.localeCompare(b.expiry) || a.number.localeCompare(b.number) ||
        a.id.localeCompare(b.id));
      for (const lot of lots) {
        lot.locations.sort((a, b) =>
          a.location_code.localeCompare(b.location_code) ||
          a.location_id.localeCompare(b.location_id));
      }
      const earliest = lots.find(lot =>
        lot.locations.some(position =>
          position.selectable !== false && position.balance > 0 && position.expiry_date >= today));
      if (earliest) firstFefo.set(product.id, earliest.id);
      const group = byWarehouse.get(product.warehouse_id) ?? [];
      group.push({
        product,
        lots,
        balance: lots.reduce((sum, lot) => sum + lot.balance, 0),
      });
      byWarehouse.set(product.warehouse_id, group);
    }
    return { byWarehouse, firstFefo };
  }, [products, candidates, today]);

  function isFefo(productId: string, lotId: string) {
    return prepared.firstFefo.get(productId) === lotId;
  }
  function updateLine(candidate: IssueCandidate, change: Partial<IssueCartLine>) {
    const key = keyOf(candidate.lot_id, candidate.location_id);
    onChange(lines.map(line =>
      keyOf(line.lot_id, line.location_id) === key ? { ...line, ...change } : line));
  }
  function toggle(product: IssueProduct, candidate: IssueCandidate, checked: boolean) {
    const key = keyOf(candidate.lot_id, candidate.location_id);
    if (!checked) {
      onChange(lines.filter(line => keyOf(line.lot_id, line.location_id) !== key));
      return;
    }
    if (candidate.selectable === false || candidate.balance <= 0 ||
        candidate.expiry_date < today || lines.length >= 100 || selected.has(key)) return;
    onChange([...lines, {
      product_id: product.id,
      product_code: product.product_code,
      product_name: product.display_name,
      warehouse_id: product.warehouse_id,
      lot_id: candidate.lot_id,
      lot_number: candidate.lot_number,
      location_id: candidate.location_id,
      location_code: candidate.location_code,
      expiry_date: candidate.expiry_date,
      balance: Number(candidate.balance),
      quantity: 1,
      override_reason: '',
    }]);
  }
  const needle = query.trim().toLocaleLowerCase();
  const warehousesWithProducts = warehouses.map(warehouse => {
    const groups = (prepared.byWarehouse.get(warehouse.id) ?? []).flatMap(group => {
      const matchesProduct = [group.product.product_code, group.product.display_name]
        .some(value => value.toLocaleLowerCase().includes(needle));
      const lots = !needle || matchesProduct ? group.lots : group.lots.flatMap(lot => {
        const matchesLot = lot.number.toLocaleLowerCase().includes(needle);
        if (matchesLot) return [lot];
        const positions = lot.locations.filter(candidate =>
          candidate.location_code.toLocaleLowerCase().includes(needle));
        return positions.length ? [{ ...lot, locations: positions }] : [];
      });
      return !needle || matchesProduct || lots.length ? [{ ...group, lots }] : [];
    });
    const countSelected = groups.reduce((sum, group) =>
      sum + group.lots.reduce((lotSum, lot) =>
        lotSum + lot.locations.filter(position =>
          selected.has(keyOf(position.lot_id, position.location_id))).length, 0), 0);
    return { warehouse, groups, countSelected };
  });

  return <div className="grid gap-3">
    <div className="grid gap-1.5">
      <SearchInput label="รายการน้ำยาในคลัง" placeholder="ค้นหาชื่อน้ำยา รหัสสินค้า LOT หรือตำแหน่ง"
        value={query} onChange={value => {
          setQuery(value);
          if (value.trim()) {
            setExpandedWarehouses(warehouses.map(w => w.id));
            setCollapsedProducts([]);
          }
        }} />
      <p className="muted text-sm">เลือก LOT ที่ต้องการแล้วกรอกจำนวน ระบบจะแยกตำแหน่งหยิบให้อัตโนมัติ</p>
    </div>

    {warehousesWithProducts.map(({ warehouse, groups, countSelected }) => {
      const open = expandedWarehouses.includes(warehouse.id);
      return <section key={warehouse.id} className="rounded-xl border border-line overflow-hidden">
        <button type="button" className="w-full min-h-12 flex items-center justify-between gap-3 px-4 py-3 bg-surface-2 text-left focus-visible:outline-2 focus-visible:outline-teal-700"
          aria-expanded={open} aria-controls={'issue-warehouse-' + warehouse.id}
          onClick={() => setExpandedWarehouses(current => open
            ? current.filter(id => id !== warehouse.id) : [...current, warehouse.id])}>
          <span className="flex items-center gap-2 font-bold">
            {open ? <ChevronDown size={18} aria-hidden /> : <ChevronRight size={18} aria-hidden />}
            {warehouseTitle(warehouse.code)}
          </span>
          <span className="muted text-sm text-right">{groups.length} น้ำยา · เลือก {countSelected} รายการ</span>
        </button>
        {open && <div id={'issue-warehouse-' + warehouse.id} className="divide-y divide-line">
          {groups.map((group, productIndex) => {
            const product = group.product;
            const empty = group.lots.length === 0;
            const collapsed = collapsedProducts.includes(product.id);
            const countSelectedLocations = group.lots.reduce((sum, lot) =>
              sum + lot.locations.filter(position =>
                selected.has(keyOf(position.lot_id, position.location_id))).length, 0);
            const selectedQty = group.lots.reduce((sum, lot) => sum +
              lot.locations.reduce((total, position) =>
                total + (selected.get(keyOf(position.lot_id, position.location_id))?.quantity || 0), 0), 0);
            // Soft alternating headers distinguish reagents; status colors retain their meaning.
            const headerTone = empty
              ? 'bg-slate-50/70 border-l-slate-200 text-slate-500'
              : countSelectedLocations > 0
                ? 'bg-teal-50 border-l-teal-500 hover:bg-teal-100/70'
                : productIndex % 2 === 0
                  ? 'bg-slate-50 border-l-slate-300 hover:bg-slate-100'
                  : 'bg-sky-50/80 border-l-sky-400 hover:bg-sky-100/80';
            return <div key={product.id}>
              <button type="button" disabled={empty}
                className={'w-full min-h-14 border-l-4 flex items-start justify-between gap-3 px-3 sm:px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-teal-700 ' + headerTone}
                aria-expanded={empty ? undefined : !collapsed}
                aria-controls={empty ? undefined : 'issue-product-' + product.id}
                onClick={() => setCollapsedProducts(previous => collapsed
                  ? previous.filter(id => id !== product.id) : [...previous, product.id])}>
                <span className="flex items-start gap-2 min-w-0">
                  <span className="pt-0.5 shrink-0 text-slate-500">
                    {!empty && (collapsed ? <ChevronRight size={18} aria-hidden /> : <ChevronDown size={18} aria-hidden />)}
                  </span>
                  <span className="min-w-0">
                    <strong className={'block text-sm ' + (empty ? 'text-slate-500' : 'text-slate-900')}>{product.product_code}</strong>
                    <span className="block text-sm leading-5 break-words">{product.display_name}</span>
                    <span className="block text-xs mt-1 text-slate-600">
                      {empty ? 'ไม่มี LOT คงเหลือ' : group.lots.length + ' LOT · คงเหลือรวม ' + formatQuantity(group.balance)}
                    </span>
                  </span>
                </span>
                {countSelectedLocations > 0 && <span className="shrink-0 text-right text-xs font-semibold text-teal-800 rounded-lg border border-teal-200 bg-teal-50 px-2 py-1">
                  เลือก {countSelectedLocations} · {formatQuantity(selectedQty)} ชิ้น
                </span>}
              </button>
              {!empty && !collapsed && <div id={'issue-product-' + product.id} className="pb-2 sm:pl-8">
                {group.lots.map(lot => {
                  const expired = lot.expiry < today;
                  const recommended = isFefo(product.id, lot.id);
                  return <div key={lot.id} className="border-t border-line/80 bg-slate-50/60 px-3 sm:px-4 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-2">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <strong className="text-sm text-slate-900">LOT {lot.number}</strong>
                        {recommended && <span className="rounded bg-emerald-100 text-emerald-800 text-xs font-bold px-1.5 py-0.5">FEFO</span>}
                        {expired && <span className="rounded bg-rose-100 text-rose-800 text-xs font-bold px-1.5 py-0.5">หมดอายุ</span>}
                        <span className={'text-xs ' + (expired ? 'text-rose-700 font-semibold' : 'muted')}>EXP {formatDate(lot.expiry)}</span>
                      </div>
                      <span className="text-xs muted">คงเหลือ LOT นี้ <strong className="text-slate-900">{formatQuantity(lot.balance)}</strong></span>
                    </div>
                    <div className="grid gap-2">
                      {lot.locations.map(position => {
                        const item = selected.get(keyOf(position.lot_id, position.location_id));
                        const selectable = position.selectable !== false && position.balance > 0 && !expired;
                        const invalidQty = Boolean(item && (!Number.isSafeInteger(item.quantity) ||
                          item.quantity < 1 || item.quantity > Number(position.balance)));
                        const needsReason = Boolean(item && !recommended);
                        const baseId = 'issue-' + position.lot_id + '-' + position.location_id;
                        return <div key={position.location_id} className={'rounded-lg border px-2.5 py-2.5 sm:px-3 ' +
                          (item ? 'bg-white border-teal-300' : 'bg-white border-line')}>
                          <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] sm:grid-cols-[1.5rem_minmax(0,1fr)_5.5rem_8rem] items-center gap-x-3 gap-y-2.5">
                            <input type="checkbox" id={baseId} className="w-5 h-5 accent-teal-700"
                              aria-label={'เลือก ' + product.product_code + ' LOT ' + lot.number + ' ตำแหน่ง ' + position.location_code}
                              checked={Boolean(item)} disabled={!selectable && !item}
                              onChange={event => toggle(product, position, event.target.checked)} />
                            <label htmlFor={baseId} className="min-w-0 text-sm cursor-pointer">
                              <span className="inline-flex max-w-full items-center rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-600 break-all">
                                <span className="sr-only">ตำแหน่งจัดเก็บ </span>{position.location_code}
                              </span>
                              <span className="block text-xs muted mt-1 sm:hidden">คงเหลือ {formatQuantity(Number(position.balance))}</span>
                            </label>
                            <div className="hidden sm:block text-right text-sm tabular-nums">
                              <span className="block muted text-xs">คงเหลือ</span>
                              <strong>{formatQuantity(Number(position.balance))}</strong>
                            </div>
                            <div className="col-start-3 row-start-1 sm:col-start-4 min-w-0">
                              <label htmlFor={baseId + '-quantity'} className="block text-xs text-slate-600 mb-1">จำนวนเบิก</label>
                              <input id={baseId + '-quantity'} type="number" inputMode="numeric"
                                step="1" min="1" max={position.balance}
                                aria-invalid={invalidQty || undefined}
                                className="input w-24 sm:w-full min-h-11 text-base text-right tabular-nums"
                                disabled={!item} value={item?.quantity ?? ''}
                                onChange={event => updateLine(position, { quantity: Number(event.target.value) })} />
                            </div>
                          </div>
                          {invalidQty && <p role="alert" className="text-xs text-rose-700 mt-1">กรุณากรอกจำนวน 1–{formatQuantity(Number(position.balance))}</p>}
                          {needsReason && <div className="mt-2">
                            <label htmlFor={baseId + '-reason'} className="block text-xs font-semibold text-amber-800 mb-1">เหตุผลที่ไม่ใช้ LOT ตาม FEFO *</label>
                            <input id={baseId + '-reason'} type="text" required maxLength={500}
                              value={item?.override_reason ?? ''}
                              onChange={event => updateLine(position, { override_reason: event.target.value })}
                              placeholder="ระบุเหตุผล" className="input w-full min-h-11 text-base" />
                          </div>}
                          {!selectable && !item && <p className="text-xs text-rose-700 mt-1">{expired ? 'LOT หมดอายุ ไม่สามารถเบิกได้' : 'LOT นี้ไม่พร้อมเบิก'}</p>}
                        </div>;
                      })}
                    </div>
                  </div>;
                })}
              </div>}
            </div>;
          })}
          {!groups.length && <p className="p-5 text-center muted text-sm">ไม่พบน้ำยาที่ตรงกับคำค้นหาในคลังนี้</p>}
        </div>}
      </section>;
    })}
    {lines.length >= 100 && <p role="alert" className="text-sm text-amber-800">เลือกได้สูงสุด 100 รายการต่อ Checklist กรุณาสร้างรายการนี้ก่อน</p>}
    <p className="muted text-xs">น้ำยาหนึ่งรายการอาจมีหลาย LOT · เลือกจำนวนแยกตามตำแหน่ง · LOT หมดอายุแสดงเพื่ออ้างอิงแต่เลือกไม่ได้</p>
  </div>;
}
