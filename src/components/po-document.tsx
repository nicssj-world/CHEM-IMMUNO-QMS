'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, Printer, XCircle } from 'lucide-react';
import { ConfirmDialog } from './confirm-dialog';
import { cancelPurchaseOrder, confirmPurchaseOrderAsSeller, type SellerConfirmation } from '@/app/actions/purchase-orders';
import type { OrderHeader, OrderLine } from '@/lib/purchase-order-data';
import { poStatusLabels, ropText } from '@/lib/purchase-orders';
import { formatDateBE, formatThaiDateTime } from '@/lib/format';
import { unitLabel } from '@/lib/units';

const fmt = (n: number | string | null) => n === null ? '—' : Number(n).toLocaleString('th-TH', { maximumFractionDigits: 3 });

/** The saved order (snapshot only). Screen shows every line; the printout leaves out zero-quantity lines. */
export function PoDocument({ header, lines, created, canCancel, canSellerConfirm }: { header: OrderHeader; lines: OrderLine[]; created: boolean; canCancel: boolean; canSellerConfirm: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [savedConfirmation, setSavedConfirmation] = useState<SellerConfirmation | null>(null);
  const confirmedAt = savedConfirmation?.acknowledged_at ?? header.acknowledged_at;
  const confirmedName = savedConfirmation?.acknowledged_by_name ?? header.acknowledged_by_name;
  async function confirmAsSeller() {
    if (!canSellerConfirm || confirming || pending || confirmedAt) return;
    setConfirming(true); setConfirmError('');
    try {
      const result = await confirmPurchaseOrderAsSeller(header.id);
      if (!result.ok) { setConfirmError(result.message); return; }
      setSavedConfirmation(result.confirmation); router.refresh();
    } catch { setConfirmError('เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่'); }
    finally { setConfirming(false); }
  }
  const printed = lines.filter(line => Number(line.order_quantity) > 0);
  const zero = lines.length - printed.length;
  const numberOf = new Map(printed.map((line, index) => [line.id, index + 1]));
  async function cancel() {
    if (pending || confirming) return;
    setPending(true); setError('');
    try {
      const result = await cancelPurchaseOrder(header.id);
      if (!result.ok) { setError(result.message); return; }
      setOpen(false); router.refresh();
    } catch { setError('เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่'); }
    finally { setPending(false); }
  }
  return <main className="grid gap-4">
    {created && <p className="notice print-hide flex items-center gap-2" role="status"><CircleCheck size={18} aria-hidden /> สร้างใบสั่งซื้อสำเร็จ · เลขที่ {header.po_number}</p>}
    <div className="print-hide flex flex-wrap items-center gap-2">
      <button type="button" className="button min-h-12" onClick={() => window.print()}><Printer size={18} aria-hidden /> พิมพ์ / บันทึก PDF</button>
      {canSellerConfirm && !confirmedAt && header.status === 'ordered' && <button type="button" className="button min-h-12 !bg-emerald-700 !text-white" disabled={confirming || pending} aria-busy={confirming} onClick={() => void confirmAsSeller()}><CircleCheck size={18} aria-hidden /> {confirming ? 'กำลังยืนยัน…' : 'ยืนยันใบสั่งซื้อ'}</button>}
      {canCancel && <button type="button" disabled={confirming || pending} className="button secondary min-h-12 text-[#a83442]" onClick={() => { setError(''); setOpen(true); }}><XCircle size={17} aria-hidden /> ยกเลิกใบสั่งซื้อ</button>}
      {zero > 0 && <p className="muted text-sm">รายการที่ยอดสั่งซื้อเป็น 0 ({zero} รายการ) แสดงบนหน้าจอเท่านั้น ไม่พิมพ์ในเอกสาร</p>}
    </div>

    {confirmError && <p className="error print-hide" role="alert">{confirmError}</p>}
    {(header.status === 'ordered' || confirmedAt) && <section className="surface print-hide p-4 grid gap-1" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">การยืนยันของผู้แทนขาย</h3><span className={'badge ' + (confirmedAt ? '!bg-emerald-50 !text-emerald-800' : '!bg-amber-50 !text-amber-800')}>{confirmedAt ? 'ยืนยันแล้ว' : 'รอยืนยัน'}</span></div>
      {confirmedAt && <p className="text-sm"><span>ผู้ยืนยัน: {confirmedName}</span><span className="block muted">{formatThaiDateTime(confirmedAt)}</span></p>}
    </section>}
    <article className="po-document surface p-5 sm:p-8 grid gap-5">
      <header className="grid sm:grid-cols-[minmax(0,1fr)_auto] gap-4 items-start border-b border-line pb-4">
        <div className="flex gap-3 items-start">
          {/* eslint-disable-next-line @next/next/no-img-element -- static branding image, also used by the approved PDF header */}
          <img src="/images/cbh-lab-logo-v3.png" alt="" width={52} height={52} className="shrink-0" />
          <div>
            <p className="font-bold">กลุ่มงานเทคนิคการแพทย์ โรงพยาบาลชลบุรี</p>
            <p>งานเคมีคลินิกและภูมิคุ้มกันวิทยา</p>
            <h2 className="text-xl font-bold mt-2">ใบสั่งซื้อน้ำยา</h2>
          </div>
        </div>
        <dl className="text-sm grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 po-meta">
          <dt className="muted">เลขที่ใบสั่งซื้อ:</dt><dd className="font-semibold tabular-nums">{header.po_number}</dd>
          <dt className="muted">วันที่สั่งซื้อ:</dt><dd>{formatDateBE(header.confirmed_at)}</dd>
          <dt className="muted">ผู้สั่งซื้อ:</dt><dd>{header.created_by_name}</dd>
          {header.template_name_snapshot && <><dt className="muted">Template:</dt><dd>{header.template_name_snapshot}</dd></>}
          <dt className="muted">สถานะ:</dt><dd className={header.status === 'cancelled' ? 'text-[#a83442] font-semibold' : ''}>{poStatusLabels[header.status] ?? header.status}</dd>
        </dl>
      </header>
      <p className="text-xs muted">ยอดเบิก 30 วัน: {formatThaiDateTime(header.usage_period_start)} ถึง {formatThaiDateTime(header.usage_period_end)} · ตัวเลขทั้งหมดเป็นข้อมูล ณ เวลายืนยันสั่งซื้อ</p>

      <div className="table-wrap">
        <table className="data-table po-print-table">
          <colgroup><col className="po-col-no" /><col /><col className="po-col-num" /><col className="po-col-num" /><col className="po-col-num" /><col className="po-col-order" /></colgroup>
          <thead><tr>
            <th scope="col" className="text-center">ลำดับ</th><th scope="col">รายการน้ำยา</th><th scope="col" className="text-right">ยอดเบิก 30 วัน</th>
            <th scope="col" className="text-right">ยอดคงเหลือ</th><th scope="col" className="text-right">จำนวนขั้นต่ำ (ROP)</th><th scope="col" className="text-right po-order-cell">ยอดสั่งซื้อ</th>
          </tr></thead>
          <tbody>{lines.map(line => {
            const zeroLine = Number(line.order_quantity) === 0;
            return <tr key={line.id} className={zeroLine ? 'print-hide text-slate-500' : ''}>
              <td className="text-center tabular-nums">{numberOf.get(line.id) ?? '—'}</td>
              <td className="po-name"><span className="tabular-nums">{line.product_code_snapshot}</span> · {line.product_name_snapshot}
                {line.packing_snapshot && <span className="block text-xs muted">ขนาดบรรจุ {line.packing_snapshot}</span>}</td>
              <td className="text-right tabular-nums">{fmt(line.issued_30d_snapshot)}</td>
              <td className="text-right tabular-nums">{fmt(line.stock_balance_snapshot)}</td>
              <td className="text-right tabular-nums">{line.rop_snapshot === null ? ropText(null) : fmt(line.rop_snapshot)}</td>
              <td className="text-right tabular-nums po-order-cell"><strong>{fmt(line.order_quantity)}</strong> <span className="text-xs">{unitLabel(line.unit_snapshot)}</span></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <p className="text-sm">รวม {printed.length} รายการ · หน่วยนับตามทะเบียนน้ำยา</p>
      <div className="po-signature grid justify-end text-sm text-center gap-1 mt-6">
        <p>ลงชื่อ ......................................................</p>
        <p>( {header.created_by_name} )</p>
        <p>ผู้สั่งซื้อ</p>
      </div>
    </article>

    <ConfirmDialog open={open} danger title={`ยกเลิกใบสั่งซื้อ ${header.po_number}?`} confirmLabel="ยกเลิกใบสั่งซื้อ" cancelLabel="ไม่ยกเลิก" pendingLabel="กำลังยกเลิก…"
      pending={pending} error={error} onClose={() => setOpen(false)} onConfirm={() => void cancel()}>
      <p>เลขที่และข้อมูลเดิมยังเก็บไว้ในประวัติ · หากต้องแก้ไข ให้สร้างใบสั่งซื้อใหม่</p>
    </ConfirmDialog>
  </main>;
}
