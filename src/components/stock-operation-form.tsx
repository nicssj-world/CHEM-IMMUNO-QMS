'use client';

import { useState } from 'react';
import { transferStock, adjustStock, disposeExpired } from '@/app/actions/inventory';

export type StockOption = { lot_id: string; lot_number: string; expiry_date: string; location_id: string; location_code: string; product_code: string; product_name: string; balance: number };
export type LocationOption = { id: string; code: string; name: string };
type Kind = 'transfer' | 'adjust' | 'dispose';

export function StockOperationForm({ kind, options, locations, submissionKey }: { kind: Kind; options: StockOption[]; locations: LocationOption[]; submissionKey: string }) {
  const [index,setIndex] = useState(0);
  const selected = options[index];
  const action = kind === 'transfer' ? transferStock : kind === 'adjust' ? adjustStock : disposeExpired;
  return <form action={action} className="surface p-5 sm:p-7 grid gap-5"><input type="hidden" name="lot_id" value={selected?.lot_id ?? ''}/><input type="hidden" name="idempotency_key" value={submissionKey}/><input type="hidden" name={kind === 'transfer' ? 'from_location_id' : 'location_id'} value={selected?.location_id ?? ''}/>
    <label className="field">สินค้า · LOT · ตำแหน่ง<select className="input" value={index} onChange={e => setIndex(Number(e.target.value))}>{options.map((item,i) => <option key={`${item.lot_id}:${item.location_id}`} value={i}>{item.product_code} · {item.product_name} · LOT {item.lot_number} · {item.location_code} · {Number(item.balance)}</option>)}</select></label>
    {selected && <p className="notice text-sm">คงเหลือ {Number(selected.balance)} · หมดอายุ {selected.expiry_date}</p>}
    {kind === 'transfer' && <label className="field">ปลายทาง<select className="input" name="to_location_id" required defaultValue=""><option value="">เลือกตำแหน่งปลายทาง</option>{locations.filter(l => l.id !== selected?.location_id).map(l => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}</select></label>}
    <label className="field">{kind === 'adjust' ? 'จำนวนปรับ (+ เพิ่ม / − ลด)' : 'จำนวน'}<input className="input" name={kind === 'adjust' ? 'quantity_delta' : 'quantity'} type="number" step="0.001" min={kind === 'adjust' ? undefined : '0.001'} max={kind === 'adjust' ? undefined : Number(selected?.balance ?? 0)} required/></label>
    {kind !== 'transfer' && <label className="field">เหตุผล<textarea className="input min-h-24" name="reason" required placeholder={kind === 'dispose' ? 'หลักฐานและวิธีการกำจัด' : 'เหตุผลการปรับยอด'}/></label>}
    <div><button className="button" type="submit">{kind === 'transfer' ? 'ยืนยันย้ายตำแหน่ง' : kind === 'adjust' ? 'ยืนยันปรับยอด' : 'ยืนยันกำจัดของหมดอายุ'}</button></div>
  </form>;
}
