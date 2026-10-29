'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import type { IssueCartLine } from '@/lib/issue-cart';
import type { IssueCandidate, IssueProduct } from './issue-group-workbench';

export type IssueWarehouse = { id: number; code: string };

type CatalogRow = { product: IssueProduct; candidate: IssueCandidate | null };
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

/** Prepare-only stock table. LOT/location identity and FEFO remain authoritative. */
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
  const [expanded, setExpanded] = useState<number[]>(() => warehouses.length ? [warehouses[0].id] : []);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  const selected = new Map(lines.map(line => [keyOf(line.lot_id, line.location_id), line]));
  const prepared = useMemo(() => {
    const byProduct = new Map<string, IssueCandidate[]>();
    for (const candidate of candidates) {
      const existing = byProduct.get(candidate.product_id) ?? [];
      existing.push(candidate);
      byProduct.set(candidate.product_id, existing);
    }
    for (const options of byProduct.values()) {
      options.sort((a, b) =>
        a.expiry_date.localeCompare(b.expiry_date) ||
        a.lot_number.localeCompare(b.lot_number) ||
        a.lot_id.localeCompare(b.lot_id) ||
        a.location_code.localeCompare(b.location_code));
    }
    const byWarehouse = new Map<number, CatalogRow[]>();
    for (const product of [...products].sort((a, b) => a.product_code.localeCompare(b.product_code))) {
      const rows = byWarehouse.get(product.warehouse_id) ?? [];
      const options = byProduct.get(product.id) ?? [];
      if (options.length === 0) rows.push({ product, candidate: null });
      else for (const candidate of options) rows.push({ product, candidate });
      byWarehouse.set(product.warehouse_id, rows);
    }
    const firstFefo = new Map<string, string>();
    for (const [productId, options] of byProduct) {
      const first = options.find(x => x.selectable !== false && x.balance > 0 && x.expiry_date >= today);
      if (first) firstFefo.set(productId, first.lot_id);
    }
    return { byWarehouse, firstFefo };
  }, [products, candidates, today]);

  function isFefo(candidate: IssueCandidate) {
    return prepared.firstFefo.get(candidate.product_id) === candidate.lot_id;
  }
  function updateLine(candidate: IssueCandidate, change: Partial<IssueCartLine>) {
    const key = keyOf(candidate.lot_id, candidate.location_id);
    onChange(lines.map(line => keyOf(line.lot_id, line.location_id) === key ? { ...line, ...change } : line));
  }
  function toggle(product: IssueProduct, candidate: IssueCandidate, checked: boolean) {
    const key = keyOf(candidate.lot_id, candidate.location_id);
    if (!checked) {
      onChange(lines.filter(line => keyOf(line.lot_id, line.location_id) !== key));
      return;
    }
    if (candidate.selectable === false || candidate.balance <= 0 || candidate.expiry_date < today || lines.length >= 100) return;
    if (selected.has(key)) return;
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
  const groupCounts = warehouses.map(warehouse => {
    const rows = (prepared.byWarehouse.get(warehouse.id) ?? []).filter(row =>
      !needle || [row.product.product_code, row.product.display_name, row.candidate?.lot_number ?? '', row.candidate?.location_code ?? '']
        .some(value => value.toLocaleLowerCase().includes(needle)));
    return { warehouse, rows, selectedCount: rows.filter(row => row.candidate && selected.has(keyOf(row.candidate.lot_id, row.candidate.location_id))).length };
  });

  return <div className="grid gap-3">
    <div className="grid gap-1">
      <label htmlFor="issue-prepare-query" className="font-semibold text-sm">รายการน้ำยาในคลัง</label>
      <div className="relative">
        <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden />
        <input id="issue-prepare-query" type="search" className="input w-full pl-10"
          placeholder="แสดงทั้งหมด หรือค้นหาชื่อสินค้า / รหัส / LOT"
          value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      <p className="muted text-xs">ติ๊กเลือก LOT และตำแหน่ง แล้วกรอกจำนวนที่ต้องการเบิก (เริ่มที่ 1) · ข้อมูล EXP และคงเหลือแสดงแยกตาม LOT</p>
    </div>
    {groupCounts.map(({ warehouse, rows, selectedCount }) => {
      const open = Boolean(needle) || expanded.includes(warehouse.id);
      const title = warehouseTitle(warehouse.code);
      return <section key={warehouse.id} className="border border-line rounded-xl overflow-hidden">
        <button type="button" className="w-full flex items-center justify-between gap-2 px-4 py-3 bg-surface-2 text-left"
          aria-expanded={open} aria-controls={'issue-warehouse-' + warehouse.id}
          onClick={() => setExpanded(current => current.includes(warehouse.id)
            ? current.filter(id => id !== warehouse.id) : [...current, warehouse.id])}>
          <span className="flex items-center gap-2 font-bold">
            {open ? <ChevronDown size={18} aria-hidden /> : <ChevronRight size={18} aria-hidden />}
            {title}
          </span>
          <span className="muted text-sm">{rows.length} แถว · เลือก {selectedCount}</span>
        </button>
        {open && <div id={'issue-warehouse-' + warehouse.id} className="overflow-x-auto">
          <table className="w-full min-w-[780px] text-sm border-collapse">
            <thead className="bg-slate-50 text-left">
              <tr className="border-b border-line">
                <th scope="col" className="p-3 w-12">เลือก</th>
                <th scope="col" className="p-3">สินค้า</th>
                <th scope="col" className="p-3">LOT</th>
                <th scope="col" className="p-3 whitespace-nowrap">EXP</th>
                <th scope="col" className="p-3">ตำแหน่ง</th>
                <th scope="col" className="p-3 text-right whitespace-nowrap">คงเหลือ</th>
                <th scope="col" className="p-3 w-28">จำนวนเบิก</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ product, candidate }) => {
                const key = candidate ? keyOf(candidate.lot_id, candidate.location_id) : product.id + ':empty';
                const item = candidate ? selected.get(key) : undefined;
                const expired = Boolean(candidate && candidate.expiry_date < today);
                const selectable = Boolean(candidate && candidate.selectable !== false && !expired && candidate.balance > 0);
                const isOldest = candidate ? isFefo(candidate) : false;
                return <tr key={key} className={'border-b border-line last:border-none align-top ' + (item ? 'bg-teal-50/60' : expired ? 'bg-rose-50/40' : '')}>
                  <td className="p-3">
                    <input type="checkbox" aria-label={'เลือก ' + product.product_code + ' LOT ' + (candidate?.lot_number ?? 'ไม่มี')}
                      checked={Boolean(item)} disabled={!selectable && !item}
                      className="w-5 h-5 accent-teal-700 cursor-pointer"
                      onChange={event => candidate && toggle(product, candidate, event.target.checked)} />
                  </td>
                  <td className="p-3 min-w-48">
                    <strong className="block">{product.product_code}</strong>
                    <span>{product.display_name}</span>
                  </td>
                  <td className="p-3 whitespace-nowrap">
                    {candidate ? <><span className="font-medium">{candidate.lot_number}</span>
                      {isOldest && <span className="ml-1 text-xs font-bold text-emerald-700">FEFO</span>}
                    </> : <span className="muted">ไม่มี LOT คงเหลือ</span>}
                  </td>
                  <td className="p-3 whitespace-nowrap">
                    {candidate ? <><span>{formatDate(candidate.expiry_date)}</span>
                      {expired && <span className="block text-rose-700 text-xs font-bold">หมดอายุ</span>}
                      {!expired && !selectable && <span className="block text-amber-700 text-xs">ไม่พร้อมเบิก</span>}
                    </> : '—'}
                  </td>
                  <td className="p-3 whitespace-nowrap">{candidate?.location_code ?? '—'}</td>
                  <td className="p-3 text-right tabular-nums font-semibold">{formatQuantity(Number(candidate?.balance ?? 0))}</td>
                  <td className="p-3">
                    <input type="number" inputMode="numeric" step="1" min="1"
                      max={candidate?.balance} className="input w-24 text-right tabular-nums"
                      aria-label={'จำนวนเบิก ' + product.product_code + ' LOT ' + (candidate?.lot_number ?? '')}
                      disabled={!item} value={item?.quantity ?? ''}
                      onChange={event => candidate && updateLine(candidate, { quantity: Number(event.target.value) })} />
                    {item && (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > Number(candidate?.balance)) &&
                      <span className="block text-rose-700 text-xs mt-1">จำนวนไม่ถูกต้อง</span>}
                    {item && !isOldest && candidate && <div className="mt-2">
                      <label htmlFor={'reason-' + candidate.lot_id + '-' + candidate.location_id} className="text-xs text-amber-800 font-semibold">
                        เหตุผลไม่ใช้ FEFO *
                      </label>
                      <input id={'reason-' + candidate.lot_id + '-' + candidate.location_id}
                        type="text" maxLength={500} required
                        className="input w-40 text-xs mt-1" placeholder="ระบุเหตุผล"
                        value={item.override_reason}
                        onChange={event => updateLine(candidate, { override_reason: event.target.value })}/>
                    </div>}
                  </td>
                </tr>;
              })}
              {!rows.length && <tr><td colSpan={7} className="p-5 text-center muted">ไม่มีรายการในคลังนี้ที่ตรงกับคำค้นหา</td></tr>}
            </tbody>
          </table>
        </div>}
      </section>;
    })}
    {lines.length >= 100 && <p role="alert" className="text-sm text-amber-800">เลือกได้สูงสุด 100 แถวต่อ Checklist กรุณาสร้างรายการนี้ก่อน</p>}
    <p className="muted text-xs">LOT หมดอายุหรือไม่พร้อมเบิกจะแสดงเพื่ออ้างอิง แต่ไม่สามารถเลือกได้ · ยอด Stock จะตรวจอีกครั้งเมื่อปิด Checklist</p>
  </div>;
}
