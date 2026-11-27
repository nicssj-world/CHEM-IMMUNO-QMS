'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { SearchInput } from './search-input';
import { normalize, poStatusLabels } from '@/lib/purchase-orders';

export type HistoryRow = { id: string; poNumber: string | null; status: string; dateText: string; templateName: string | null; itemCount: number; createdByName: string; acknowledgedByName: string | null; acknowledgedDateText: string | null };
const filters = [{ key: 'all', label: 'ทั้งหมด' }, { key: 'ordered', label: 'สั่งซื้อแล้ว' }, { key: 'draft', label: 'ฉบับร่าง' }, { key: 'cancelled', label: 'ยกเลิก' }, { key: 'awaiting_confirmation', label: 'รอยืนยัน' }, { key: 'seller_confirmed', label: 'ยืนยันแล้ว' }];

function SellerStatus({ row }: { row: HistoryRow }) {
  if (row.acknowledgedDateText) return <div className="grid gap-1"><span className="badge w-fit !bg-emerald-50 !text-emerald-800">ยืนยันแล้ว</span><span className="text-sm">{row.acknowledgedByName}</span><span className="muted text-xs">{row.acknowledgedDateText}</span></div>;
  if (row.status === 'ordered') return <span className="badge !bg-amber-50 !text-amber-800">รอยืนยัน</span>;
  return <span className="muted">—</span>;
}

export function PoHistoryList({ rows }: { rows: HistoryRow[] }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const visible = useMemo(() => {
    const needle = normalize(query);
    return rows.filter(row => (status === 'all' || row.status === status || (row.status === 'ordered' && ((status === 'awaiting_confirmation' && !row.acknowledgedDateText) || (status === 'seller_confirmed' && !!row.acknowledgedDateText))))
      && (!needle || normalize(`${row.poNumber ?? ''} ${row.templateName ?? ''} ${row.createdByName}`).includes(needle)));
  }, [rows, query, status]);
  return <section className="surface p-4 sm:p-5 grid gap-3">
    <div className="grid sm:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
      <SearchInput label="ค้นหาใบสั่งซื้อ" placeholder="เลขที่ Template หรือผู้สร้าง" value={query} onChange={setQuery} />
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1 rounded-xl bg-slate-100 p-1" role="group" aria-label="กรองตามสถานะ">
        {filters.map(item => <button key={item.key} type="button" aria-pressed={status === item.key} onClick={() => setStatus(item.key)}
          className={'min-h-11 rounded-lg text-sm px-2 ' + (status === item.key ? 'bg-white shadow-sm font-semibold' : 'text-slate-600')}>{item.label}</button>)}
      </div>
    </div>
    <div className="hidden md:block table-wrap">
      <table className="data-table">
        <thead><tr><th scope="col">เลขที่ใบสั่งซื้อ</th><th scope="col">วันที่สั่งซื้อ</th><th scope="col">Template</th><th scope="col" className="text-right">จำนวนรายการ</th><th scope="col">ผู้สร้าง</th><th scope="col">สถานะ</th><th scope="col">การยืนยันของผู้แทนขาย</th><th scope="col"><span className="sr-only">จัดการ</span></th></tr></thead>
        <tbody>{visible.map(row => <tr key={row.id}>
          <td className="tabular-nums font-semibold">{row.poNumber ?? '—'}</td><td>{row.dateText}</td><td>{row.templateName ?? '—'}</td>
          <td className="text-right tabular-nums">{row.itemCount}</td><td>{row.createdByName}</td>
          <td><span className={'badge ' + (row.status === 'cancelled' ? '!bg-rose-50 !text-[#a83442]' : row.status === 'draft' ? '!bg-slate-100 !text-slate-700' : '')}>{poStatusLabels[row.status] ?? row.status}</span></td>
          <td><SellerStatus row={row}/></td>
          <td className="text-right whitespace-nowrap"><Link href={`/purchase-orders/${row.id}`} className="button secondary min-h-11">{row.status === 'draft' ? 'แก้ไข' : 'เปิดดู / พิมพ์ PDF'}</Link></td>
        </tr>)}</tbody>
      </table>
    </div>
    <ul className="md:hidden grid gap-2">{visible.map(row => <li key={row.id}>
      <Link href={`/purchase-orders/${row.id}`} className="rounded-xl border border-line p-3 grid gap-1 no-underline text-[var(--ink)]">
        <span className="flex justify-between gap-2"><strong className="tabular-nums">{row.poNumber ?? 'ฉบับร่าง'}</strong><span className="badge h-fit">{poStatusLabels[row.status] ?? row.status}</span></span>
        <span className="text-sm">{row.dateText} · {row.itemCount} รายการ</span>
        <span className="muted text-sm">{row.templateName ?? 'ไม่ใช้ Template'} · {row.createdByName}</span>
        {(row.status === 'ordered' || row.acknowledgedDateText) && <SellerStatus row={row}/>}
      </Link></li>)}</ul>
    {!visible.length && <p className="muted text-sm text-center p-4">{rows.length ? 'ไม่พบใบสั่งซื้อที่ค้นหา' : 'ยังไม่มีใบสั่งซื้อ'}</p>}
  </section>;
}
