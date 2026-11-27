'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, Minus, Plus, RotateCcw, Save, Send, Trash2, X } from 'lucide-react';
import { PoProductSearch } from './po-product-search';
import { ConfirmDialog } from './confirm-dialog';
import { deletePurchaseOrderDraft, savePurchaseOrder, savePurchaseOrderTemplate } from '@/app/actions/purchase-orders';
import { addProducts, belowRop, parseOrderQuantity, refreshLines, ropText, stepOrderQuantity, validateLines, type PoLine, type PoMetric, type PoProduct } from '@/lib/purchase-orders';
import type { TemplateSummary } from '@/lib/purchase-order-data';
import { unitLabel } from '@/lib/units';

const fmt = (n: number) => n.toLocaleString('th-TH', { maximumFractionDigits: 3 });

export function PoEditor({ orderId, products, metrics, templates, initialTemplateId, initialLines, metricsAtText, canManageTemplate, currentUserId }: {
  orderId: string | null; products: PoProduct[]; metrics: Record<string, PoMetric>; templates: TemplateSummary[];
  initialTemplateId: string | null; initialLines: { productId: string; quantity: string }[]; metricsAtText: string;
  canManageTemplate: boolean; currentUserId: string;
}) {
  const router = useRouter();
  const metricMap = useMemo(() => new Map(Object.entries(metrics)), [metrics]);
  const productMap = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  const clientKey = useRef(crypto.randomUUID());
  const [id, setId] = useState(orderId);
  const [templateId, setTemplateId] = useState(initialTemplateId);
  // Saved quantities are the user's own: they are never replaced by a later ROP.
  const [lines, setLines] = useState<PoLine[]>(() => initialLines.length && orderId
    ? initialLines.map(line => ({ productId: line.productId, quantity: line.quantity, edited: true }))
    : refreshLines(initialLines.map(line => ({ productId: line.productId, quantity: line.quantity, edited: false })), metricMap));
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<'' | 'draft' | 'confirm' | 'template' | 'delete'>('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateMode, setTemplateMode] = useState<'new' | 'update'>('new');
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dialogError, setDialogError] = useState('');

  const chosen = useMemo(() => new Set(lines.map(line => line.productId)), [lines]);
  const problems = useMemo(() => validateLines(lines), [lines]);
  const ordered = lines.filter(line => { const p = parseOrderQuantity(line.quantity); return p.ok && p.value > 0; }).length;
  const selectedTemplate = templates.find(t => t.id === templateId) ?? null;
  const ownsTemplate = Boolean(selectedTemplate && (selectedTemplate.created_by === currentUserId || canManageTemplate));

  const change = (next: PoLine[]) => { setLines(next); setDirty(true); setMessage(null); };
  const setQuantity = (productId: string, quantity: string) => change(lines.map(line => line.productId === productId ? { ...line, quantity, edited: true } : line));
  const move = (index: number, delta: -1 | 1) => { const next = [...lines]; const [item] = next.splice(index, 1); next.splice(index + delta, 0, item); change(next); };

  function applyTemplate(nextId: string | null, mode: 'replace' | 'merge') {
    const template = templates.find(t => t.id === nextId);
    setTemplateId(nextId);
    if (!template) { setDirty(true); return; }
    const ids = template.productIds.filter(pid => productMap.has(pid));
    change(mode === 'replace' ? addProducts([], ids, metricMap) : addProducts(lines, ids, metricMap));
  }

  async function save(confirm: boolean) {
    if (pending) return;
    if (problems.size) { setMessage({ kind: 'error', text: 'ยอดสั่งซื้อบางรายการยังไม่ถูกต้อง · ตรวจรายการที่มีกรอบสีแดง' }); setConfirmOpen(false); return; }
    setPending(confirm ? 'confirm' : 'draft'); setDialogError('');
    try {
      const result = await savePurchaseOrder({ id, clientKey: clientKey.current, templateId, confirm, lines: lines.map(line => ({ productId: line.productId, quantity: line.quantity })) });
      if (!result.ok) { if (confirm) setDialogError(result.message); else setMessage({ kind: 'error', text: result.message }); return; }
      setDirty(false);
      if (confirm) { router.push(`/purchase-orders/${result.id}?created=1`); return; }
      setMessage({ kind: 'ok', text: 'บันทึกฉบับร่างแล้ว · กลับมาแก้ไขต่อได้' });
      if (!id) { setId(result.id); router.replace(`/purchase-orders/${result.id}`); }
    } catch {
      const text = 'เชื่อมต่อไม่สำเร็จ · กดอีกครั้งได้ ระบบจะไม่สร้างใบสั่งซื้อซ้ำ';
      if (confirm) setDialogError(text); else setMessage({ kind: 'error', text });
    } finally { setPending(''); }
  }

  async function saveTemplate() {
    if (pending) return;
    setPending('template'); setDialogError('');
    try {
      const update = templateMode === 'update' && selectedTemplate;
      const result = await savePurchaseOrderTemplate({ id: update ? selectedTemplate.id : null, name: update ? selectedTemplate.name : templateName, productIds: lines.map(line => line.productId) });
      if (!result.ok) { setDialogError(result.message); return; }
      setTemplateOpen(false); setTemplateId(result.id);
      setMessage({ kind: 'ok', text: update ? `แก้ไข Template “${selectedTemplate.name}” แล้ว` : `บันทึก Template “${templateName.trim()}” แล้ว` });
      router.refresh();
    } catch { setDialogError('เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่'); }
    finally { setPending(''); }
  }

  async function removeDraft() {
    if (!id || pending) return;
    setPending('delete'); setDialogError('');
    try {
      const result = await deletePurchaseOrderDraft(id);
      if (!result.ok) { setDialogError(result.message); return; }
      router.replace('/purchase-orders?deleted=1');
    } catch { setDialogError('เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่'); }
    finally { setPending(''); }
  }

  const stepper = (line: PoLine, product: PoProduct | undefined) => {
    const invalid = problems.get(line.productId);
    return <div className="flex items-center justify-center gap-1">
      <button type="button" className="grid place-items-center w-11 h-11 rounded-lg border border-[#d9c37a] bg-white" aria-label={`ลดยอดสั่งซื้อ ${product?.product_code ?? ''}`} onClick={() => setQuantity(line.productId, stepOrderQuantity(line.quantity, -1))}><Minus size={18} aria-hidden /></button>
      <input className={'input !min-h-11 !w-20 text-center tabular-nums !text-base font-bold !px-1 ' + (invalid ? '!border-[#c0394b]' : '')} inputMode="numeric" pattern="[0-9]*" autoComplete="off"
        value={line.quantity} aria-label={`ยอดสั่งซื้อ ${product?.product_code ?? ''}`} aria-invalid={Boolean(invalid) || undefined}
        onChange={event => setQuantity(line.productId, event.target.value)} onFocus={event => event.currentTarget.select()} />
      <button type="button" className="grid place-items-center w-11 h-11 rounded-lg border border-[#d9c37a] bg-white" aria-label={`เพิ่มยอดสั่งซื้อ ${product?.product_code ?? ''}`} onClick={() => setQuantity(line.productId, stepOrderQuantity(line.quantity, 1))}><Plus size={18} aria-hidden /></button>
    </div>;
  };

  return <div className="grid gap-4 pb-28 md:pb-6">
    <section className="surface p-4 sm:p-5 grid gap-4">
      <div className="grid sm:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
        <label className="field">Template
          <select className="input" value={templateId ?? ''} onChange={event => {
            const next = event.target.value || null;
            if (next && lines.length) { setSwitchTo(next); return; }
            applyTemplate(next, 'replace');
          }}>
            <option value="">ไม่ใช้ Template</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name} ({t.productIds.length} รายการ)</option>)}
          </select>
        </label>
        <div className="text-sm muted flex items-center gap-2">
          <span>ข้อมูลยอดเบิก ยอดคงเหลือ และ ROP ล่าสุดเมื่อ {metricsAtText}</span>
          <button type="button" className="button secondary min-h-11 px-3" onClick={() => router.refresh()} aria-label="โหลดตัวเลขล่าสุด"><RotateCcw size={16} aria-hidden /></button>
        </div>
      </div>
      <PoProductSearch products={products} chosen={chosen} onAdd={pid => change(addProducts(lines, [pid], metricMap))} />
    </section>

    {message && <p className={message.kind === 'ok' ? 'notice' : 'error'} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</p>}

    <section className="surface p-0 sm:p-0 overflow-hidden" aria-label="รายการสั่งซื้อ">
      <div className="px-4 py-2 border-b border-line flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>รายการน้ำยา <strong className="tabular-nums">{lines.length}</strong> · มียอดสั่ง <strong className="tabular-nums">{ordered}</strong>{dirty && <span className="text-amber-800"> · ยังไม่ได้บันทึก</span>}</span>
        <button type="button" className="button secondary min-h-11 text-sm px-3" disabled={!lines.length || Boolean(pending)} onClick={() => { setDialogError(''); setTemplateName(''); setTemplateMode(ownsTemplate ? 'update' : 'new'); setTemplateOpen(true); }}><Save size={16} aria-hidden /> บันทึก Template</button>
      </div>
      {lines.length === 0 ? <p className="muted text-sm p-5 text-center">ยังไม่มีรายการ · เลือก Template หรือค้นหาน้ำยาเพื่อเพิ่ม</p> : <>
        <div className="hidden md:block">
          <table className="data-table po-table">
            <thead><tr><th scope="col">รายการน้ำยา</th><th scope="col" className="text-right">ยอดเบิก 30 วัน</th><th scope="col" className="text-right">ยอดคงเหลือ</th>
              <th scope="col" className="text-right">จำนวนขั้นต่ำ (ROP)</th><th scope="col" className="text-center po-order-cell">ยอดสั่งซื้อ</th><th scope="col" className="text-center">จัดการ</th></tr></thead>
            <tbody>{lines.map((line, index) => {
              const product = productMap.get(line.productId); const metric = metricMap.get(line.productId);
              const low = metric ? belowRop(metric.stock_balance, metric.rop) : false;
              return <tr key={line.productId}>
                <td><span className="muted text-xs tabular-nums block">{product?.product_code ?? '—'}</span><span className="break-words">{product?.display_name ?? 'ไม่พบน้ำยา'}</span>
                  <span className="muted text-xs block">{product?.packing_size_raw ? `${product.packing_size_raw} · ` : ''}หน่วย {unitLabel(product?.base_stock_unit)}</span>
                  {product && !product.active && <span className="text-xs text-[#a83442] block">ปิดใช้งานแล้ว · นำออกก่อนยืนยัน</span>}</td>
                <td style={{ verticalAlign: 'middle' }} className="text-right tabular-nums">{metric ? fmt(metric.issued_30d) : '—'}</td>
                <td style={{ verticalAlign: 'middle' }} className={'text-right tabular-nums ' + (low ? 'text-[#a8323e] font-semibold' : '')}>{metric ? fmt(metric.stock_balance) : '—'}</td>
                <td style={{ verticalAlign: 'middle' }} className={'text-right tabular-nums ' + (metric?.rop == null ? 'muted' : '')}>{ropText(metric?.rop)}</td>
                <td className="po-order-cell">{stepper(line, product)}{problems.get(line.productId) && <span className="block text-xs text-[#a8323e] text-center mt-1">{problems.get(line.productId)}</span>}</td>
                <td><div className="flex justify-center gap-1">
                  <button type="button" className="grid place-items-center w-11 h-11 rounded-lg hover:bg-surface-2 disabled:opacity-30" disabled={index === 0} aria-label="เลื่อนขึ้น" onClick={() => move(index, -1)}><ChevronUp size={18} aria-hidden /></button>
                  <button type="button" className="grid place-items-center w-11 h-11 rounded-lg hover:bg-surface-2 disabled:opacity-30" disabled={index === lines.length - 1} aria-label="เลื่อนลง" onClick={() => move(index, 1)}><ChevronDown size={18} aria-hidden /></button>
                  <button type="button" className="grid place-items-center w-11 h-11 rounded-lg text-[#a83442] hover:bg-rose-50" aria-label={`นำ ${product?.product_code ?? ''} ออก`} onClick={() => change(lines.filter(x => x.productId !== line.productId))}><X size={18} aria-hidden /></button>
                </div></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        <ul className="md:hidden grid divide-y divide-[var(--line)]">
          {lines.map((line, index) => {
            const product = productMap.get(line.productId); const metric = metricMap.get(line.productId);
            const low = metric ? belowRop(metric.stock_balance, metric.rop) : false;
            return <li key={line.productId} className="p-4 grid gap-3">
              <div>
                <p className="muted text-xs tabular-nums">{product?.product_code ?? '—'}</p>
                <p className="font-semibold leading-snug break-words">{product?.display_name ?? 'ไม่พบน้ำยา'}</p>
                <p className="muted text-xs">{product?.packing_size_raw ? `${product.packing_size_raw} · ` : ''}หน่วย {unitLabel(product?.base_stock_unit)}</p>
                {product && !product.active && <p className="text-xs text-[#a83442]">ปิดใช้งานแล้ว · นำออกก่อนยืนยัน</p>}
              </div>
              <dl className="grid grid-cols-3 gap-2 text-center">
                <div><dt className="text-xs muted">ยอดเบิก 30 วัน</dt><dd className="tabular-nums font-semibold">{metric ? fmt(metric.issued_30d) : '—'}</dd></div>
                <div><dt className="text-xs muted">คงเหลือ</dt><dd className={'tabular-nums font-semibold ' + (low ? 'text-[#a8323e]' : '')}>{metric ? fmt(metric.stock_balance) : '—'}</dd></div>
                <div><dt className="text-xs muted">ROP</dt><dd className={'tabular-nums font-semibold ' + (metric?.rop == null ? 'muted !font-normal text-sm' : '')}>{ropText(metric?.rop)}</dd></div>
              </dl>
              <div className="rounded-xl po-order-cell p-3 grid gap-1">
                <p className="text-sm font-semibold text-center">ยอดสั่งซื้อ</p>
                {stepper(line, product)}
                {problems.get(line.productId) && <p className="text-xs text-[#a8323e] text-center">{problems.get(line.productId)}</p>}
              </div>
              <div className="flex justify-between items-center">
                <div className="flex gap-1">
                  <button type="button" className="grid place-items-center w-11 h-11 rounded-lg border border-line disabled:opacity-30" disabled={index === 0} aria-label="เลื่อนขึ้น" onClick={() => move(index, -1)}><ChevronUp size={18} aria-hidden /></button>
                  <button type="button" className="grid place-items-center w-11 h-11 rounded-lg border border-line disabled:opacity-30" disabled={index === lines.length - 1} aria-label="เลื่อนลง" onClick={() => move(index, 1)}><ChevronDown size={18} aria-hidden /></button>
                </div>
                <button type="button" className="min-h-11 px-3 text-sm text-[#a83442]" onClick={() => change(lines.filter(x => x.productId !== line.productId))}>นำรายการออก</button>
              </div>
            </li>;
          })}
        </ul>
      </>}
    </section>

    <div className="sticky-action md:static -mx-4 px-4 sm:mx-0 sm:px-0">
      <div className="surface p-2 sm:p-3 grid grid-cols-2 sm:flex sm:justify-end gap-2">
        <button type="button" className="button secondary min-h-12" disabled={Boolean(pending)} aria-busy={pending === 'draft'} onClick={() => void save(false)}>
          {pending === 'draft' ? <><span className="spinner" aria-hidden /><span role="status">กำลังบันทึก…</span></> : 'บันทึกฉบับร่าง'}</button>
        <button type="button" className="button min-h-12" disabled={!ordered || Boolean(pending)} onClick={() => { setDialogError(''); if (problems.size) { void save(true); return; } setConfirmOpen(true); }}><Send size={17} aria-hidden /> ยืนยันสั่งซื้อ</button>
      </div>
    </div>
    {id && <button type="button" className="text-sm text-[#a83442] w-fit min-h-11 inline-flex items-center gap-1" onClick={() => { setDialogError(''); setDeleteOpen(true); }}><Trash2 size={15} aria-hidden /> ลบฉบับร่างนี้</button>}

    <ConfirmDialog open={confirmOpen} title="ยืนยันสั่งซื้อ?" confirmLabel="ยืนยันสั่งซื้อ" pendingLabel="กำลังสร้างใบสั่งซื้อ…" pending={pending === 'confirm'} error={dialogError}
      onClose={() => setConfirmOpen(false)} onConfirm={() => void save(true)}>
      <p>สั่งซื้อ <strong>{ordered}</strong> รายการ ตามยอดที่กรอกไว้ ระบบจะรันเลขที่ใบสั่งซื้อและบันทึกยอดเบิก 30 วัน ยอดคงเหลือ และ ROP ณ เวลานี้</p>
      {lines.length > ordered && <p className="notice !py-2">รายการที่ยอดสั่งซื้อเป็น 0 ({lines.length - ordered} รายการ) จะเก็บไว้ในใบสั่งซื้อ แต่ไม่แสดงในเอกสารที่พิมพ์</p>}
      <p className="muted">ใบสั่งซื้อไม่เปลี่ยนยอดคงคลัง · ยอดเพิ่มเมื่อรับน้ำยาเข้าตามปกติ</p>
    </ConfirmDialog>

    <ConfirmDialog open={templateOpen} title="บันทึกรายการเป็น Template" confirmLabel="บันทึก Template" pendingLabel="กำลังบันทึก…" pending={pending === 'template'} error={dialogError}
      onClose={() => setTemplateOpen(false)} onConfirm={() => void saveTemplate()}>
      {ownsTemplate && selectedTemplate && <div className="grid gap-2">
        <label className="flex items-center gap-2 min-h-11"><input type="radio" className="w-4 h-4" checked={templateMode === 'update'} onChange={() => setTemplateMode('update')} /> แก้ไข Template “{selectedTemplate.name}” ให้ตรงกับรายการนี้</label>
        <label className="flex items-center gap-2 min-h-11"><input type="radio" className="w-4 h-4" checked={templateMode === 'new'} onChange={() => setTemplateMode('new')} /> บันทึกเป็น Template ใหม่</label>
      </div>}
      {templateMode === 'new' && <label className="field">ชื่อ Template<input className="input" value={templateName} maxLength={120} onChange={event => setTemplateName(event.target.value)} placeholder="เช่น น้ำยาที่สั่งซื้อประจำเดือน" autoFocus /></label>}
      <p className="muted">Template เก็บเฉพาะรายชื่อน้ำยาและลำดับ ({lines.length} รายการ) · ตัวเลขจะดึงใหม่ทุกครั้งที่ใช้</p>
    </ConfirmDialog>

    <ConfirmDialog open={switchTo !== null} title="เปลี่ยน Template?" confirmLabel="แทนที่รายการ" cancelLabel="เพิ่มเฉพาะรายการใหม่"
      onClose={() => { if (switchTo) applyTemplate(switchTo, 'merge'); setSwitchTo(null); }} onConfirm={() => { applyTemplate(switchTo, 'replace'); setSwitchTo(null); }}>
      <p>แทนที่รายการ: ใช้รายการจาก Template ใหม่ทั้งหมด (ยอดที่แก้ไว้จะหายไป)</p>
      <p>เพิ่มเฉพาะรายการใหม่: เก็บรายการและยอดเดิมไว้ แล้วเพิ่มน้ำยาที่ยังไม่มี</p>
    </ConfirmDialog>

    <ConfirmDialog open={deleteOpen} danger title="ลบฉบับร่างนี้?" confirmLabel="ลบฉบับร่าง" pendingLabel="กำลังลบ…" pending={pending === 'delete'} error={dialogError}
      onClose={() => setDeleteOpen(false)} onConfirm={() => void removeDraft()}>
      <p className="muted">ฉบับร่างยังไม่ได้สั่งซื้อและไม่มีผลกับยอดคงคลัง</p>
    </ConfirmDialog>
  </div>;
}
