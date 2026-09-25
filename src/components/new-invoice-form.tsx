'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, Minus, Plus } from 'lucide-react';
import { BarcodeScanner, type ScanFeedback } from './barcode-scanner';
import { SubmitButton } from './submit-button';
import { resolveProductScan } from '@/app/actions/scanner';
import { startInvoice } from '@/app/actions/inventory';
import { saveReceiveDraft } from '@/lib/receive-draft';
import { userMessage } from '@/lib/messages';

type Product = { id: string; warehouse_id: number; product_code: string; display_name: string };
type Vendor = { id: string; name: string };
type Line = { key: string; productId: string; quantity: string; lot: string; expiry: string; raw?: string; scanned: boolean; open: boolean };

const FORM_ID = 'new-invoice';
const warehouseTag = (id: number) => (id === 1 ? 'CHE' : 'IMM');
const round = (value: number) => Math.round(value * 1000) / 1000;
const incomplete = (line: Pick<Line, 'productId' | 'lot' | 'expiry'>) => !line.productId || !line.lot || !line.expiry;

export function NewInvoiceForm({ vendors, products }: { vendors: Vendor[]; products: Product[] }) {
  const router = useRouter();
  const [lines, setLines] = useState<Line[]>([]);
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);
  const [flash, setFlash] = useState<{ key: string; n: number } | null>(null);
  const [error, setError] = useState('');
  // An existing vendor + invoice number reopens that invoice; its lines are not changed, so the user decides before leaving.
  const [existing, setExisting] = useState<{ id: string; lines: Line[] } | null>(null);
  const [pending, startTransition] = useTransition();
  const productById = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const feedbackId = useRef(0);
  // The camera callback keeps the onScan it started with, so read current lines through a ref.
  const linesRef = useRef(lines);
  useEffect(() => { linesRef.current = lines; }, [lines]);

  // Briefly tint the row a scan just added or counted, so the eye finds it without reading.
  useEffect(() => {
    if (!flash || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    rows.current.get(flash.key)?.animate([{ backgroundColor: '#cdeee4' }, { backgroundColor: '#f4f8f8' }], { duration: 1400, easing: 'ease-out' });
  }, [flash]);

  const patch = (key: string, change: Partial<Line>) => setLines(prev => prev.map(l => (l.key === key ? { ...l, ...change } : l)));
  const say = (tone: ScanFeedback['tone'], title: string, detail?: string) => setFeedback({ id: ++feedbackId.current, tone, title, detail });

  async function onScan(raw: string, symbology: string) {
    setError('');
    try {
      const result = await resolveProductScan(raw, symbology);
      const trusted = result.parsed.warnings.length === 0;
      const lot = trusted ? result.parsed.lot ?? '' : '';
      const expiry = trusted ? result.parsed.expiry ?? '' : '';
      const productId = result.product?.id ?? '';
      // Same product + LOT + expiry is the same batch: count another pack instead of adding a row, and lift that row to the top.
      const current = linesRef.current;
      const same = productId && lot ? current.find(l => l.productId === productId && l.lot === lot && l.expiry === expiry) : undefined;
      const key = same?.key ?? crypto.randomUUID();
      const quantity = same ? String(round(Number(same.quantity) + 1)) : '1';
      setLines(prev => {
        const existing = prev.find(l => l.key === key);
        if (existing) return [...prev.filter(l => l.key !== key), { ...existing, quantity }];
        return [...prev, { key, productId, quantity, lot, expiry, raw, scanned: true, open: incomplete({ productId, lot, expiry }) }];
      });
      setFlash({ key, n: feedbackId.current });
      const code = result.product?.code;
      if (!result.product) say('error', result.message ?? 'ไม่พบสินค้าที่ตรงกับ Barcode', 'เพิ่มเป็นรายการว่างไว้ด้านล่างแล้ว');
      else if (!trusted) say('warn', `${code} · Barcode มีคำเตือน`, 'กรอก LOT และวันหมดอายุเอง');
      else if (same) say('ok', `${code} · รวม ×${quantity}`, `LOT ${lot} · นับเพิ่มอีก 1`);
      else if (!lot || !expiry) say('warn', `${code} · ${result.product.name}`, 'Barcode ไม่มี LOT หรือวันหมดอายุ · กรอกเองได้');
      else say('ok', `${code} · ${result.product.name}`, `LOT ${lot} · หมดอายุ ${expiry}`);
    } catch (cause) { say('error', userMessage(cause instanceof Error ? cause.message : null, 'อ่าน Barcode ไม่สำเร็จ')); }
  }

  function addManual() {
    const key = crypto.randomUUID();
    setLines(prev => [...prev, { key, productId: '', quantity: '1', lot: '', expiry: '', scanned: false, open: true }]);
    setFlash({ key, n: Date.now() });
  }

  function openInvoice(invoiceId: string, usable: Line[]) {
    saveReceiveDraft(invoiceId, usable.filter(l => l.lot.trim() && l.expiry).map(l => ({ productId: l.productId, quantity: l.quantity, lot: l.lot.trim(), expiry: l.expiry, raw: l.raw })));
    router.push(`/receive?invoice=${invoiceId}`);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    setExisting(null);
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    const usable = lines.filter(l => l.productId && Number(l.quantity) > 0);
    if (!usable.length) { setError('กรุณาสแกนหรือเพิ่มสินค้าอย่างน้อยหนึ่งรายการ'); return; }
    if (usable.length !== lines.length) {
      setLines(prev => prev.map(l => (l.productId && Number(l.quantity) > 0 ? l : { ...l, open: true })));
      setError('มีรายการที่ยังไม่ได้เลือกสินค้าหรือจำนวน');
      return;
    }
    startTransition(async () => {
      const result = await startInvoice({
        vendorId: String(form.get('vendor_id') ?? ''), invoiceNumber: String(form.get('invoice_number') ?? ''),
        invoiceDate: String(form.get('invoice_date') ?? ''), poNumber: String(form.get('po_number') ?? ''),
        lines: usable.map(l => ({ productId: l.productId, quantity: Number(l.quantity) })),
      });
      if (!result.ok) { setError(result.message); return; }
      if (result.existing) { setExisting({ id: result.invoiceId, lines: usable }); return; }
      openInvoice(result.invoiceId, usable);
    });
  }

  const total = round(lines.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0));
  const needsCheck = lines.filter(incomplete).length;
  const summary = <p className="text-sm font-semibold" aria-live="off">{lines.length ? <>รวมจำนวน {total} · {lines.length} รายการ{needsCheck > 0 && <span className="text-amber-800"> · ต้องตรวจ {needsCheck}</span>}</> : <span className="muted font-normal">ยังไม่มีรายการ</span>}</p>;

  // BarcodeScanner owns a <form>, so this form cannot wrap it: controls attach through the form attribute instead.
  return <div className="grid gap-5">
    <form id={FORM_ID} onSubmit={submit} />
    <div className="grid sm:grid-cols-2 gap-4">
      <label className="field">ผู้ขาย<select form={FORM_ID} className="input" name="vendor_id" required defaultValue=""><option value="">เลือกผู้ขาย</option>{vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      <label className="field">เลขที่ Invoice<input form={FORM_ID} className="input" name="invoice_number" autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" required /></label>
      <label className="field">วันที่ Invoice<input form={FORM_ID} className="input" name="invoice_date" type="date" required /></label>
      <label className="field">เลขที่ PO (ถ้ามี)<input form={FORM_ID} className="input" name="po_number" autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" /></label>
    </div>
    <div className="grid gap-3">
      <div><h3 className="font-bold">รายการสินค้า</h3><p className="muted text-sm mt-1">สแกน Datamatrix ของสินค้าแต่ละชิ้น ระบบจะเพิ่มรายการและกรอก LOT / วันหมดอายุให้ · กล้องเปิดค้างสแกนต่อเนื่องได้ · สแกน LOT เดิมซ้ำจะเพิ่มจำนวน (ถือ Barcode ค้างไว้นับครั้งเดียว ต้องเอาออกจากกรอบก่อนสแกนชิ้นใหม่)</p></div>
      <BarcodeScanner onScan={onScan} continuous dock feedback={feedback} summary={summary} />
      <div className="grid gap-2">
        {[...lines].reverse().map(line => {
          const product = productById.get(line.productId);
          const label = product?.product_code ?? 'รายการที่ยังไม่เลือกสินค้า';
          const quantity = Number(line.quantity) || 0;
          return <div key={line.key} ref={el => { if (el) rows.current.set(line.key, el); else rows.current.delete(line.key); }} className={`rounded-xl border bg-surface-2 ${incomplete(line) ? 'border-amber-400' : 'border-transparent'}`}>
            <div className="flex items-center gap-2 p-2 pl-3">
              <button type="button" className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left cursor-pointer" onClick={() => patch(line.key, { open: !line.open })} aria-expanded={line.open} aria-label={`${line.open ? 'ย่อ' : 'แก้ไข'} ${label}`}>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2"><strong className="truncate text-sm">{label}</strong>{product && <span className="badge shrink-0">{warehouseTag(product.warehouse_id)}</span>}</span>
                  {product && <span className="block truncate text-xs muted">{product.display_name}</span>}
                  <span className="block text-xs">LOT {line.lot || <span className="text-amber-800">ยังไม่ระบุ</span>} · หมดอายุ {line.expiry || <span className="text-amber-800">ยังไม่ระบุ</span>}</span>
                </span>
                <ChevronDown size={18} aria-hidden className={`shrink-0 muted transition-transform ${line.open ? 'rotate-180' : ''}`} />
              </button>
              <div className="flex shrink-0 items-center rounded-lg border border-field-line bg-white">
                <button type="button" className="grid size-11 place-items-center disabled:opacity-35 cursor-pointer" disabled={quantity <= 1} onClick={() => patch(line.key, { quantity: String(round(quantity - 1)) })} aria-label={`ลดจำนวน ${label}`}><Minus size={16} aria-hidden /></button>
                <span className="min-w-8 text-center font-bold tabular-nums" aria-label={`จำนวน ${line.quantity}`}>{line.quantity}</span>
                <button type="button" className="grid size-11 place-items-center cursor-pointer" onClick={() => patch(line.key, { quantity: String(round(quantity + 1)) })} aria-label={`เพิ่มจำนวน ${label}`}><Plus size={16} aria-hidden /></button>
              </div>
            </div>
            {line.open && <div className="grid gap-3 border-t border-line p-3">
              <div className="grid sm:grid-cols-[1fr_120px] gap-3">
                <label className="field">สินค้า<select form={FORM_ID} className="input" value={line.productId} onChange={e => patch(line.key, { productId: e.target.value })} required><option value="">เลือกสินค้า</option>{products.map(p => <option key={p.id} value={p.id}>[{warehouseTag(p.warehouse_id)}] {p.product_code} · {p.display_name}</option>)}</select></label>
                <label className="field">จำนวน<input form={FORM_ID} className="input" type="number" inputMode="decimal" min="0.001" step="0.001" value={line.quantity} onChange={e => patch(line.key, { quantity: e.target.value })} required /></label>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="field">LOT<input form={FORM_ID} className="input" autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" value={line.lot} onChange={e => patch(line.key, { lot: e.target.value })} /></label>
                <label className="field">วันหมดอายุ<input form={FORM_ID} className="input" type="date" value={line.expiry} onChange={e => patch(line.key, { expiry: e.target.value })} /></label>
              </div>
              {line.scanned && (!line.lot || !line.expiry) && <p className="text-xs muted">ไม่พบ LOT หรือวันหมดอายุใน Barcode · กรอกเอง หรือปล่อยว่างแล้วบันทึกตอนรับเข้า</p>}
              {line.raw && <p className="muted text-xs break-all">Scan: {line.raw}</p>}
              <div className="flex flex-wrap gap-2"><button type="button" className="button secondary" onClick={() => patch(line.key, { open: false })}>เสร็จ</button><button type="button" className="button secondary text-[#a83442]" onClick={() => setLines(prev => prev.filter(l => l.key !== line.key))}>ลบรายการนี้</button></div>
            </div>}
          </div>;
        })}
      </div>
      {!lines.length && <p className="muted text-sm rounded-xl border border-dashed border-field-line p-4">ยังไม่มีรายการ · สแกน Datamatrix หรือเพิ่มสินค้าด้วยตนเอง</p>}
      <div><button type="button" className="button secondary" onClick={addManual}>+ เพิ่มสินค้าด้วยตนเอง</button></div>
    </div>
    <div className="sticky-action grid gap-2">
      {error && <p className="error" role="alert">{error}</p>}
      {existing && <div className="notice grid gap-3" role="alert"><p><strong>เลขที่ Invoice นี้ของผู้ขายรายนี้มีอยู่แล้ว</strong> · ระบบไม่ได้เพิ่มรายการใหม่เข้า Invoice เดิม ถ้าเปิด Invoice เดิม จะใช้ได้เฉพาะแพ็กเกจที่สแกนซึ่งมีสินค้าตรงกับรายการใน Invoice นั้น</p><div className="flex flex-wrap gap-2"><button type="button" className="button" onClick={() => openInvoice(existing.id, existing.lines)}>เปิด Invoice เดิม</button><button type="button" className="button secondary" onClick={() => setExisting(null)}>แก้เลขที่ Invoice</button></div></div>}
      <SubmitButton label={`สร้าง Invoice และเริ่มรับ${lines.length ? ` (${lines.length} รายการ)` : ''}`} pendingLabel="กำลังสร้าง Invoice…" pending={pending} form={FORM_ID} />
    </div>
  </div>;
}
