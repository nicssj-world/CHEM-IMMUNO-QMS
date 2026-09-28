'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { editReceipt } from '@/app/actions/inventory';
import { IntegerQuantityInput } from '@/components/integer-quantity-input';
import { ReceiptAssessmentFields } from '@/components/receipt-assessment-fields';
import { assessmentError, DEFAULT_ASSESSMENT, fromAssessmentRow, type AssessmentInput, type AssessmentRow } from '@/lib/receipt-assessment';

type ProductOption = { id: string; product_code: string; display_name: string };
type InvoiceLineOption = { invoice_line_id: string; warehouse_id: number; product_id: string; ordered_quantity: number; received_quantity: number; remaining_quantity: number };
type LocationOption = { id: string; warehouse_id: number; code: string; name: string; parent_code?: string | null };
type ReceiptLine = { id: string; invoice_line_id: string; quantity: number; lot_number: string; expiry_date: string; location_id: string };
type DraftLine = ReceiptLine & { key: string };

function draftLines(lines: ReceiptLine[]): DraftLine[] {
  return lines.map((line, index) => ({ ...line, key: line.id || `line-${index}` }));
}

export function ReceiptEditForm({ receiptId, warehouseId, eventNumber, invoice, lines, receiptLines, products, locations, assessmentRow }: {
  receiptId: string;
  warehouseId: number;
  eventNumber: string | null;
  invoice: { invoice_number: string; invoice_date: string; po_number: string | null };
  lines: InvoiceLineOption[];
  receiptLines: ReceiptLine[];
  products: ProductOption[];
  locations: LocationOption[];
  assessmentRow: AssessmentRow | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftLine[]>(draftLines(receiptLines));
  const [invoiceDraft, setInvoiceDraft] = useState({ invoice_number: invoice.invoice_number, invoice_date: invoice.invoice_date, po_number: invoice.po_number ?? '' });
  const [assessment, setAssessment] = useState<AssessmentInput>(assessmentRow ? fromAssessmentRow(assessmentRow) : DEFAULT_ASSESSMENT);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const productById = new Map(products.map(product => [product.id, product]));
  const lineById = new Map(lines.map(line => [line.invoice_line_id, line]));

  function reset() {
    setDraft(draftLines(receiptLines));
    setInvoiceDraft({ invoice_number: invoice.invoice_number, invoice_date: invoice.invoice_date, po_number: invoice.po_number ?? '' });
    setAssessment(assessmentRow ? fromAssessmentRow(assessmentRow) : DEFAULT_ASSESSMENT);
    setError(null);
    setSaved(false);
  }

  function save() {
    if (!draft.length) { setError('กรุณาเก็บรายการน้ำยาไว้อย่างน้อยหนึ่งรายการ'); return; }
    if (draft.some(line => !Number.isSafeInteger(Number(line.quantity)) || Number(line.quantity) <= 0 || !line.invoice_line_id || !line.lot_number.trim() || !line.expiry_date || !line.location_id)) {
      setError('กรุณาตรวจ Product, LOT, วันหมดอายุ, จำนวนเต็ม และตำแหน่งของทุกรายการ'); return;
    }
    const invalidAssessment = assessmentError(assessment);
    if (invalidAssessment) { setError(invalidAssessment); return; }
    setError(null);
    startTransition(async () => {
      const result = await editReceipt(receiptId, {
        invoice: invoiceDraft,
        lines: draft.map(line => ({
          receipt_line_id: line.id || undefined,
          invoice_line_id: line.invoice_line_id,
          quantity: Number(line.quantity),
          lot_number: line.lot_number,
          expiry_date: line.expiry_date,
          location_id: line.location_id,
        })),
        assessment,
      });
      if (!result.ok) { setError(result.message); return; }
      setSaved(true);
      setEditing(false);
      router.refresh();
    });
  }

  return <section className="rounded-xl border border-line p-4 grid gap-3" aria-label={`แก้ไขใบรับเข้า ${eventNumber ?? ''}`}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><strong>ใบรับเข้า {eventNumber ?? '—'}</strong><p className="muted text-sm mt-1">Admin และ Supervisor แก้ไขรายการนี้ได้ · ระบบปรับ Stock และยอดค้างรับให้ทันที</p></div>
      {!editing && <button type="button" className="button secondary" onClick={() => { reset(); setEditing(true); }}>แก้ไขใบรับเข้า</button>}
    </div>
    {saved && <p className="notice" role="status">บันทึกการแก้ไขใบรับเข้าแล้ว · Stock, LOT และ Invoice อัปเดตแล้ว</p>}
    {editing && <div className="grid gap-5">
      <section className="grid gap-3" aria-labelledby={`receipt-edit-lines-${receiptId}`}>
        <div><h3 id={`receipt-edit-lines-${receiptId}`} className="font-bold">รายการน้ำยา</h3><p className="muted text-sm">ลดจำนวนได้เมื่อยอดคงเหลือพอ หากมีการเบิกหรือย้ายออกไปแล้วจนยอดใหม่ติดลบ ระบบจะไม่บันทึก</p></div>
        {draft.map((line, index) => {
          const chosen = lineById.get(line.invoice_line_id);
          const product = productById.get(chosen?.product_id ?? '');
          return <article key={line.key} className="rounded-xl border border-line p-4 grid gap-3">
            <div className="flex items-center justify-between gap-2"><strong>รายการ {index + 1}</strong><button type="button" className="button secondary min-h-10" disabled={draft.length <= 1 || pending} onClick={() => setDraft(current => current.filter(item => item.key !== line.key))}>นำรายการออก</button></div>
            <label className="field">น้ำยาใน Invoice<select className="input" value={line.invoice_line_id} onChange={event => setDraft(current => current.map(item => item.key === line.key ? { ...item, invoice_line_id: event.target.value } : item))} required>
              <option value="">เลือกน้ำยา</option>
              {lines.filter(option => option.warehouse_id === warehouseId).map(option => {
                const item = productById.get(option.product_id);
                return <option key={option.invoice_line_id} value={option.invoice_line_id}>{item ? `${item.product_code} · ${item.display_name}` : option.product_id} · สั่ง {option.ordered_quantity} · ค้าง {option.remaining_quantity}</option>;
              })}
            </select></label>
            {product && <p className="muted text-xs">รหัส {product.product_code} · เปลี่ยนรายการได้เฉพาะน้ำยาที่อยู่ใน Invoice และคลังเดิม</p>}
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="field">จำนวน<IntegerQuantityInput className="input" min="1" value={line.quantity} onChange={event => setDraft(current => current.map(item => item.key === line.key ? { ...item, quantity: Number(event.target.value) } : item))} required /></label>
              <label className="field">ตำแหน่ง<select className="input" value={line.location_id} onChange={event => setDraft(current => current.map(item => item.key === line.key ? { ...item, location_id: event.target.value } : item))} required>
                <option value="">เลือกตำแหน่ง</option>{locations.filter(item => item.warehouse_id === warehouseId).map(item => <option key={item.id} value={item.id}>{item.parent_code ? `${item.parent_code} › ` : ''}{item.code} · {item.name}</option>)}
              </select></label>
              <label className="field">LOT<input className="input" autoCapitalize="characters" autoCorrect="off" value={line.lot_number} onChange={event => setDraft(current => current.map(item => item.key === line.key ? { ...item, lot_number: event.target.value } : item))} required /></label>
              <label className="field">วันหมดอายุตามกล่อง<input className="input" type="date" value={line.expiry_date} onChange={event => setDraft(current => current.map(item => item.key === line.key ? { ...item, expiry_date: event.target.value } : item))} required /></label>
            </div>
          </article>;
        })}
        <button type="button" className="button secondary justify-self-start" disabled={pending} onClick={() => setDraft(current => [...current, { id: '', key: `new-${crypto.randomUUID()}`, invoice_line_id: '', quantity: 1, lot_number: '', expiry_date: '', location_id: '' }])}>+ เพิ่มรายการน้ำยา</button>
      </section>

      <section className="grid gap-3" aria-labelledby={`receipt-edit-invoice-${receiptId}`}>
        <div><h3 id={`receipt-edit-invoice-${receiptId}`} className="font-bold">ข้อมูล Invoice</h3><p className="muted text-sm">Invoice อาจใช้ร่วมกันหลายคลัง หากแก้ข้อมูลนี้ต้องเป็น Admin หรือ Supervisor ในทุกคลังที่อยู่ใน Invoice</p></div>
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="field">เลขที่ Invoice<input className="input" value={invoiceDraft.invoice_number} onChange={event => setInvoiceDraft(current => ({ ...current, invoice_number: event.target.value }))} required /></label>
          <label className="field">วันที่ Invoice<input className="input" type="date" value={invoiceDraft.invoice_date} onChange={event => setInvoiceDraft(current => ({ ...current, invoice_date: event.target.value }))} required /></label>
          <label className="field">เลขที่ PO<input className="input" value={invoiceDraft.po_number} onChange={event => setInvoiceDraft(current => ({ ...current, po_number: event.target.value }))} /></label>
        </div>
      </section>

      <section className="grid gap-3" aria-labelledby={`receipt-edit-assessment-${receiptId}`}>
        <div><h3 id={`receipt-edit-assessment-${receiptId}`} className="font-bold">ข้อมูลการตรวจรับ</h3><p className="muted text-sm">ระบบบันทึกประวัติการแก้ผลตรวจรับตามข้อมูลเดิมของใบนี้</p></div>
        <ReceiptAssessmentFields value={assessment} onChange={setAssessment} />
      </section>

      {error && <p className="error" role="alert">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="button secondary" disabled={pending} onClick={() => { reset(); setEditing(false); }}>ยกเลิก</button>
        <button type="button" className="button" disabled={pending} aria-busy={pending} onClick={save}>{pending ? 'กำลังบันทึก…' : 'บันทึกการแก้ไขใบรับเข้า'}</button>
      </div>
    </div>}
  </section>;
}
