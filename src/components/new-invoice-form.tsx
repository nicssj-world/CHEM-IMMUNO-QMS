'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { BarcodeScanner } from './barcode-scanner';
import { SubmitButton } from './submit-button';
import { resolveProductScan } from '@/app/actions/scanner';
import { startInvoice } from '@/app/actions/inventory';
import { saveReceiveDraft } from '@/lib/receive-draft';

type Product = { id: string; warehouse_id: number; product_code: string; display_name: string };
type Vendor = { id: string; name: string };
type Line = { key: string; productId: string; quantity: string; lot: string; expiry: string; raw?: string; scanned: boolean };

const FORM_ID = 'new-invoice';
const warehouseTag = (id: number) => (id === 1 ? 'CHE' : 'IMM');

export function NewInvoiceForm({ vendors, products }: { vendors: Vendor[]; products: Product[] }) {
  const router = useRouter();
  const [lines, setLines] = useState<Line[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  // The camera callback keeps the onScan it started with, so read current lines through a ref.
  const linesRef = useRef(lines);
  useEffect(() => { linesRef.current = lines; }, [lines]);

  const patch = (key: string, change: Partial<Line>) => setLines(prev => prev.map(l => (l.key === key ? { ...l, ...change } : l)));

  async function onScan(raw: string, symbology: string) {
    setMessage('กำลังตรวจ Barcode…');
    setError('');
    try {
      const result = await resolveProductScan(raw, symbology);
      const trusted = result.parsed.warnings.length === 0;
      const lot = trusted ? result.parsed.lot ?? '' : '';
      const expiry = trusted ? result.parsed.expiry ?? '' : '';
      const productId = result.product?.id ?? '';
      // Same product + LOT + expiry is the same batch: count another pack instead of adding a row.
      const same = productId && lot ? linesRef.current.findIndex(l => l.productId === productId && l.lot === lot && l.expiry === expiry) : -1;
      setLines(prev => {
        const index = productId && lot ? prev.findIndex(l => l.productId === productId && l.lot === lot && l.expiry === expiry) : -1;
        if (index >= 0) return prev.map((l, i) => (i === index ? { ...l, quantity: String(Math.round((Number(l.quantity) + 1) * 1000) / 1000) } : l));
        return [...prev, { key: crypto.randomUUID(), productId, quantity: '1', lot, expiry, raw, scanned: true }];
      });
      const name = result.product ? `${result.product.code} · ${result.product.name}` : null;
      if (!result.product) setMessage(result.message ?? 'ไม่พบสินค้าที่ตรงกับ Barcode · เลือกสินค้าเอง');
      else if (!trusted) setMessage(`พบ ${name} แต่ Barcode มีคำเตือน · กรอก LOT และวันหมดอายุเอง`);
      else if (same >= 0) setMessage(`${name} · LOT ${lot} · เพิ่มจำนวนอีก 1`);
      else setMessage(`เพิ่ม ${name}${lot ? ` · LOT ${lot}` : ''} · ตรวจ LOT/วันหมดอายุ แล้วสแกนต่อได้`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'อ่าน Barcode ไม่สำเร็จ'); setMessage(''); }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    const usable = lines.filter(l => l.productId && Number(l.quantity) > 0);
    if (!usable.length) { setError('กรุณาสแกนหรือเพิ่มสินค้าอย่างน้อยหนึ่งรายการ'); return; }
    if (usable.length !== lines.length) { setError('มีรายการที่ยังไม่ได้เลือกสินค้าหรือจำนวน'); return; }
    startTransition(async () => {
      const result = await startInvoice({
        vendorId: String(form.get('vendor_id') ?? ''), invoiceNumber: String(form.get('invoice_number') ?? ''),
        invoiceDate: String(form.get('invoice_date') ?? ''), poNumber: String(form.get('po_number') ?? ''),
        lines: usable.map(l => ({ productId: l.productId, quantity: Number(l.quantity) })),
      });
      if (!result.ok) { setError(result.message); return; }
      saveReceiveDraft(result.invoiceId, usable.filter(l => l.lot.trim() && l.expiry).map(l => ({ productId: l.productId, quantity: l.quantity, lot: l.lot.trim(), expiry: l.expiry, raw: l.raw })));
      router.push(`/receive?invoice=${result.invoiceId}`);
    });
  }

  // BarcodeScanner owns a <form>, so this form cannot wrap it: controls attach through the form attribute instead.
  return <div className="grid gap-5">
    <form id={FORM_ID} onSubmit={submit} />
    <div className="grid sm:grid-cols-2 gap-4">
      <label className="field">ผู้ขาย<select form={FORM_ID} className="input" name="vendor_id" required defaultValue=""><option value="">เลือกผู้ขาย</option>{vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      <label className="field">เลขที่ Invoice<input form={FORM_ID} className="input" name="invoice_number" required /></label>
      <label className="field">วันที่ Invoice<input form={FORM_ID} className="input" name="invoice_date" type="date" required /></label>
      <label className="field">PO number (ถ้ามี)<input form={FORM_ID} className="input" name="po_number" /></label>
    </div>
    <div className="grid gap-3">
      <div><h3 className="font-bold">รายการสินค้า</h3><p className="muted text-sm mt-1">สแกน Datamatrix ของสินค้าแต่ละชิ้น ระบบจะเพิ่มรายการและกรอก LOT / วันหมดอายุให้ · กล้องเปิดค้างสแกนต่อเนื่องได้ · สแกน LOT เดิมซ้ำจะเพิ่มจำนวน (ถือ Barcode ค้างไว้นับครั้งเดียว ต้องเอาออกจากกรอบก่อนสแกนชิ้นใหม่)</p></div>
      <BarcodeScanner onScan={onScan} continuous />
      {message && <p className="notice text-sm" role="status">{message}</p>}
      {lines.map((line, i) => <div className="grid gap-3 rounded-xl bg-[#f4f8f8] p-3" key={line.key}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-bold">รายการ {i + 1}{line.scanned && <span className="badge ml-2">สแกนแล้ว</span>}</p>
          <button type="button" className="button secondary text-sm" onClick={() => setLines(prev => prev.filter(l => l.key !== line.key))} aria-label={`ลบรายการ ${i + 1}`}>ลบ</button>
        </div>
        <div className="grid sm:grid-cols-[1fr_120px] gap-3">
          <label className="field">สินค้า<select form={FORM_ID} className="input" value={line.productId} onChange={e => patch(line.key, { productId: e.target.value })} required><option value="">เลือกสินค้า</option>{products.map(p => <option key={p.id} value={p.id}>[{warehouseTag(p.warehouse_id)}] {p.product_code} · {p.display_name}</option>)}</select></label>
          <label className="field">จำนวน<input form={FORM_ID} className="input" type="number" min="0.001" step="0.001" value={line.quantity} onChange={e => patch(line.key, { quantity: e.target.value })} required /></label>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="field">LOT<input form={FORM_ID} className="input" value={line.lot} onChange={e => patch(line.key, { lot: e.target.value })} /></label>
          <label className="field">วันหมดอายุ<input form={FORM_ID} className="input" type="date" value={line.expiry} onChange={e => patch(line.key, { expiry: e.target.value })} /></label>
        </div>
        {line.scanned && (!line.lot || !line.expiry) && <p className="text-xs muted">ไม่พบ LOT หรือวันหมดอายุใน Barcode · กรอกเอง หรือปล่อยว่างแล้วบันทึกตอนรับเข้า</p>}
      </div>)}
      {!lines.length && <p className="muted text-sm rounded-xl border border-dashed border-[#bfd0d8] p-4">ยังไม่มีรายการ · สแกน Datamatrix หรือเพิ่มสินค้าด้วยตนเอง</p>}
      <div><button type="button" className="button secondary" onClick={() => setLines(prev => [...prev, { key: crypto.randomUUID(), productId: '', quantity: '1', lot: '', expiry: '', scanned: false }])}>+ เพิ่มสินค้าด้วยตนเอง</button></div>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <SubmitButton label={`สร้าง Invoice และเริ่มรับ${lines.length ? ` (${lines.length} รายการ)` : ''}`} pendingLabel="กำลังสร้าง Invoice…" pending={pending} form={FORM_ID} />
  </div>;
}
