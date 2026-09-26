'use client';

import { useState } from 'react';
import { transferStock, adjustStock, disposeExpired } from '@/app/actions/inventory';
import { ConfirmForm } from './confirm-form';
import { SubmitButton } from './submit-button';

export type StockOption = { lot_id: string; lot_number: string; expiry_date: string; location_id: string; location_code: string; product_code: string; product_name: string; balance: number };
export type LocationOption = { id: string; code: string; name: string; parent_code?: string | null };
type Kind = 'transfer' | 'adjust' | 'dispose';

const submitLabel = { transfer: 'ยืนยันย้ายตำแหน่ง', adjust: 'ยืนยันปรับยอด', dispose: 'ยืนยันกำจัดของหมดอายุ' };

export function StockOperationForm({ kind, options, locations, submissionKey, warehouseCode, productId = '' }: { kind: Kind; options: StockOption[]; locations: LocationOption[]; submissionKey: string; warehouseCode: string; productId?: string }) {
  // Nothing is preselected when there is a choice: acting on the wrong LOT is easy on a phone picker and hard to undo.
  const [index,setIndex] = useState(options.length === 1 ? 0 : -1);
  const [direction,setDirection] = useState<1 | -1>(-1);
  const [amount,setAmount] = useState('');
  const selected = index >= 0 ? options[index] : undefined;
  const action = kind === 'transfer' ? transferStock : kind === 'adjust' ? adjustStock : disposeExpired;
  const delta = direction * (Number(amount) || 0);
  const what = selected ? `${selected.product_code} LOT ${selected.lot_number} @ ${selected.location_code}` : '';
  const showProduct = kind === 'dispose';

  const fields = <>
    <input type="hidden" name="lot_id" value={selected?.lot_id ?? ''}/><input type="hidden" name="idempotency_key" value={submissionKey}/>
    <input type="hidden" name={kind === 'transfer' ? 'from_location_id' : 'location_id'} value={selected?.location_id ?? ''}/>
    <input type="hidden" name="warehouse" value={warehouseCode}/><input type="hidden" name="product" value={productId}/><input type="hidden" name="summary" value={what}/>
    <label className="field">{showProduct ? 'สินค้า · LOT · ตำแหน่ง' : 'LOT · ตำแหน่ง'}<select className="input" value={index} required onChange={e => setIndex(Number(e.target.value))}>
      {options.length > 1 && <option value={-1} disabled>เลือก LOT</option>}
      {options.map((item,i) => <option key={`${item.lot_id}:${item.location_id}`} value={i}>{showProduct ? `${item.product_code} · ` : ''}LOT {item.lot_number} · หมดอายุ {item.expiry_date} · {item.location_code} · คงเหลือ {Number(item.balance)}</option>)}
    </select></label>
    {selected && <p className="notice text-sm">{showProduct && <><strong>{selected.product_code}</strong> · {selected.product_name} · </>}คงเหลือ {Number(selected.balance)} · หมดอายุ {selected.expiry_date} · ตำแหน่ง {selected.location_code}</p>}
    {kind === 'transfer' && <label className="field">ปลายทาง<select className="input" name="to_location_id" required defaultValue=""><option value="">เลือกตำแหน่งปลายทาง</option>{locations.filter(l => l.id !== selected?.location_id).map(l => <option key={l.id} value={l.id}>{l.parent_code ? `${l.parent_code} › ` : ''}{l.code} · {l.name}</option>)}</select></label>}
    {kind === 'adjust' ? <fieldset className="grid gap-2"><legend className="field mb-2">ทิศทางและจำนวนที่ปรับ</legend>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="ทิศทางการปรับ">{([[1,'เพิ่มยอด (+)'],[-1,'ลดยอด (−)']] as const).map(([value,text]) => <label key={value} className={`button secondary cursor-pointer ${direction === value ? '!border-[var(--blue)] !bg-[#e8f1f8]' : ''}`}><input type="radio" className="sr-only" name="direction" checked={direction === value} onChange={() => setDirection(value)}/>{text}</label>)}</div>
      <input className="input" aria-label="จำนวนที่ปรับ" type="number" inputMode="decimal" min="0.001" step="0.001" value={amount} onChange={e => setAmount(e.target.value)} required/>
      <input type="hidden" name="quantity_delta" value={delta || ''}/>
      {selected && amount && <p className="muted text-sm">ยอดหลังปรับ {Math.round((Number(selected.balance) + delta) * 1000) / 1000}</p>}
    </fieldset>
      : <label className="field">จำนวน<input className="input" name="quantity" type="number" inputMode="decimal" step="0.001" min="0.001" max={Number(selected?.balance ?? 0) || undefined} required/></label>}
    {kind !== 'transfer' && <label className="field">เหตุผล<textarea className="input min-h-24" name="reason" required placeholder={kind === 'dispose' ? 'หลักฐานและวิธีการกำจัด' : 'เหตุผลการปรับยอด'}/></label>}
    <SubmitButton label={submitLabel[kind]} pendingLabel="กำลังบันทึก…" disabled={!selected}/>
  </>;

  const className = 'surface p-5 sm:p-7 grid gap-5';
  if (kind === 'transfer') return <form action={action} className={className}>{fields}</form>;
  return <ConfirmForm action={action} className={className} message={data => kind === 'adjust'
    ? `ยืนยันปรับยอด ${what}\nจำนวน ${delta > 0 ? '+' : ''}${delta} · ยอดหลังปรับ ${Math.round((Number(selected?.balance ?? 0) + delta) * 1000) / 1000}\n\nบันทึกแล้วแก้ไขไม่ได้ ต้องใช้การยกเลิกรายการ`
    : `ยืนยันกำจัด ${what}\nจำนวน ${data.get('quantity')}\n\nบันทึกแล้วแก้ไขไม่ได้ ต้องใช้การยกเลิกรายการ`}>{fields}</ConfirmForm>;
}
