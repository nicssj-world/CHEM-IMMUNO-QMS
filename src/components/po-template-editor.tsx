'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, FilePlus2, Trash2, X } from 'lucide-react';
import { PoProductSearch } from './po-product-search';
import { ConfirmDialog } from './confirm-dialog';
import { deletePurchaseOrderTemplate, savePurchaseOrderTemplate } from '@/app/actions/purchase-orders';
import type { PoProduct } from '@/lib/purchase-orders';
import { unitLabel } from '@/lib/units';

/** A template is only a named, ordered list of reagents; numbers are always read fresh when it is used. */
export function PoTemplateEditor({ templateId, initialName, initialProductIds, updatedAt, products, canManage }: {
  templateId: string | null; initialName: string; initialProductIds: string[]; updatedAt: string | null; products: PoProduct[]; canManage: boolean;
}) {
  const router = useRouter();
  const productMap = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  const [name, setName] = useState(initialName);
  const [ids, setIds] = useState(initialProductIds);
  const [pending, setPending] = useState<'' | 'save' | 'delete'>('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const chosen = useMemo(() => new Set(ids), [ids]);
  const editable = canManage || templateId === null;
  const move = (index: number, delta: -1 | 1) => { const next = [...ids]; const [item] = next.splice(index, 1); next.splice(index + delta, 0, item); setIds(next); };

  async function save() {
    if (pending) return;
    setPending('save'); setMessage(null);
    try {
      const result = await savePurchaseOrderTemplate({ id: templateId, name, productIds: ids, expectedUpdatedAt: updatedAt });
      if (!result.ok) { setMessage({ kind: 'error', text: result.message }); return; }
      setMessage({ kind: 'ok', text: 'บันทึก Template แล้ว' });
      if (!templateId) router.replace(`/purchase-orders/templates/${result.id}?saved=1`); else router.refresh();
    } catch { setMessage({ kind: 'error', text: 'เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่' }); }
    finally { setPending(''); }
  }
  async function remove() {
    if (!templateId || pending) return;
    setPending('delete'); setDeleteError('');
    try {
      const result = await deletePurchaseOrderTemplate(templateId);
      if (!result.ok) { setDeleteError(result.message); return; }
      router.replace('/purchase-orders/templates?deleted=1');
    } catch { setDeleteError('เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่'); }
    finally { setPending(''); }
  }

  return <section className="surface p-4 sm:p-5 grid gap-4">
    <label className="field">ชื่อ Template<input className="input" value={name} maxLength={120} disabled={!editable} onChange={event => setName(event.target.value)} placeholder="เช่น น้ำยา Clinical Chemistry" /></label>
    {editable && <PoProductSearch products={products} chosen={chosen} onAdd={id => setIds(old => old.includes(id) ? old : [...old, id])} />}
    <div className="grid gap-1">
      <p className="text-sm font-semibold">รายการน้ำยา ({ids.length})</p>
      <ul className="grid divide-y divide-[var(--line)] rounded-xl border border-line">
        {ids.map((id, index) => { const product = productMap.get(id); return <li key={id} className="flex items-center gap-2 px-3 py-2 min-h-12">
          <span className="w-6 text-right tabular-nums muted text-sm shrink-0">{index + 1}</span>
          <span className="min-w-0 flex-1 text-sm"><span className="muted tabular-nums">{product?.product_code ?? '—'}</span> · {product?.display_name ?? 'ไม่พบน้ำยา'}
            <span className="block text-xs muted">{product?.packing_size_raw ? `${product.packing_size_raw} · ` : ''}หน่วย {unitLabel(product?.base_stock_unit)}{product && !product.active ? ' · ปิดใช้งานแล้ว' : ''}</span></span>
          {editable && <span className="flex shrink-0">
            <button type="button" className="grid place-items-center w-11 h-11 rounded-lg hover:bg-surface-2 disabled:opacity-30" disabled={index === 0} aria-label="เลื่อนขึ้น" onClick={() => move(index, -1)}><ChevronUp size={18} aria-hidden /></button>
            <button type="button" className="grid place-items-center w-11 h-11 rounded-lg hover:bg-surface-2 disabled:opacity-30" disabled={index === ids.length - 1} aria-label="เลื่อนลง" onClick={() => move(index, 1)}><ChevronDown size={18} aria-hidden /></button>
            <button type="button" className="grid place-items-center w-11 h-11 rounded-lg text-[#a83442] hover:bg-rose-50" aria-label={`นำ ${product?.product_code ?? ''} ออก`} onClick={() => setIds(old => old.filter(x => x !== id))}><X size={18} aria-hidden /></button>
          </span>}
        </li>; })}
        {!ids.length && <li className="muted text-sm p-4 text-center">ยังไม่มีน้ำยา · ค้นหาแล้วกด “เพิ่ม”</li>}
      </ul>
    </div>
    {message && <p className={message.kind === 'ok' ? 'notice' : 'error'} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</p>}
    {!editable && <p className="notice">ผู้สร้าง หัวหน้างาน หรือผู้ดูแลระบบเป็นผู้แก้ไข Template นี้ · ใช้ Template นี้สร้างใบสั่งซื้อได้</p>}
    <div className="flex flex-wrap gap-2 justify-between">
      <div className="flex flex-wrap gap-2">
        {editable && <button type="button" className="button min-h-12" disabled={Boolean(pending) || !name.trim()} aria-busy={pending === 'save'} onClick={() => void save()}>
          {pending === 'save' ? <><span className="spinner" aria-hidden /><span role="status">กำลังบันทึก…</span></> : 'บันทึก Template'}</button>}
        {templateId && <Link href={`/purchase-orders?template=${templateId}`} className="button secondary min-h-12"><FilePlus2 size={17} aria-hidden /> ใช้สร้างใบสั่งซื้อ</Link>}
      </div>
      {templateId && canManage && <button type="button" className="button secondary min-h-12 text-[#a83442]" onClick={() => { setDeleteError(''); setDeleteOpen(true); }}><Trash2 size={16} aria-hidden /> ลบ Template</button>}
    </div>
    <ConfirmDialog open={deleteOpen} danger title={`ลบ Template “${initialName}”?`} confirmLabel="ลบ Template" pendingLabel="กำลังลบ…" pending={pending === 'delete'} error={deleteError}
      onClose={() => setDeleteOpen(false)} onConfirm={() => void remove()}>
      <p className="muted">ใบสั่งซื้อที่สร้างไปแล้วยังเก็บชื่อ Template เดิมไว้</p>
    </ConfirmDialog>
  </section>;
}
