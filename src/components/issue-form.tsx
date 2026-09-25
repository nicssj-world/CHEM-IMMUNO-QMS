'use client';

import { useState } from 'react';
import { issueStock } from '@/app/actions/inventory';
import { SubmitButton } from './submit-button';

type Candidate = { lot_id: string; lot_number: string; expiry_date: string; location_id: string; location_code: string; balance: number };

export function IssueForm({ productId, productCode, warehouseCode, candidates, submissionKey, preferredLot = '' }: { productId: string; productCode: string; warehouseCode: string; candidates: Candidate[]; submissionKey: string; preferredLot?: string }) {
  const scannedIndex = preferredLot ? candidates.findIndex(c => c.lot_number.trim().toUpperCase() === preferredLot.toUpperCase()) : -1;
  const [selected,setSelected] = useState(Math.max(0,scannedIndex));
  const item = candidates[selected];
  const firstLot = candidates[0]?.lot_id;
  const needsReason = item?.lot_id !== firstLot;
  return <form action={issueStock} className="surface p-5 sm:p-7 grid gap-5"><input type="hidden" name="product_id" value={productId}/><input type="hidden" name="lot_id" value={item?.lot_id ?? ''}/><input type="hidden" name="location_id" value={item?.location_id ?? ''}/><input type="hidden" name="idempotency_key" value={submissionKey}/>
    {/* Sent back on redirect so an error lands on the same warehouse, product and scanned LOT. */}
    <input type="hidden" name="warehouse" value={warehouseCode}/><input type="hidden" name="product" value={productId}/><input type="hidden" name="lot" value={preferredLot}/><input type="hidden" name="summary" value={`${productCode} LOT ${item?.lot_number ?? ''}`}/>
    <div className="notice text-sm"><strong>FEFO แนะนำ:</strong> LOT {candidates[0]?.lot_number} หมดอายุ {candidates[0]?.expiry_date} · ตำแหน่ง {candidates[0]?.location_code}</div>
    <label className="field">เลือก LOT และตำแหน่ง<select className="input" value={selected} onChange={e => setSelected(Number(e.target.value))}>{candidates.map((c,i) => <option key={`${c.lot_id}:${c.location_id}`} value={i}>{c.lot_number} · หมดอายุ {c.expiry_date} · {c.location_code} · คงเหลือ {Number(c.balance)}</option>)}</select></label>
    <div className="grid sm:grid-cols-2 gap-4"><label className="field">จำนวนที่เบิก<input className="input" name="quantity" type="number" inputMode="decimal" min="0.001" max={Number(item?.balance ?? 0)} step="0.001" required autoFocus={scannedIndex>=0}/></label><label className="field">วัตถุประสงค์<select className="input" name="purpose" required><option value="Routine">Routine use</option><option value="QC">QC</option><option value="Calibration">Calibration</option><option value="Verification/Validation">Verification / Validation</option><option value="Repeat/Troubleshooting">Repeat / Troubleshooting</option><option value="Waste">Waste</option><option value="Other">Other</option></select></label></div>
    {scannedIndex>=0 && <div className="notice text-sm">เลือก LOT {item?.lot_number} ตาม Barcode ที่สแกน · ตรวจกับฉลากบนกล่องก่อนยืนยัน</div>}
    {needsReason && <label className="field">เหตุผลที่ไม่ใช้ LOT ตาม FEFO<textarea className="input min-h-24" name="override_reason" required placeholder="ระบุเหตุผลในการเลือก LOT อื่น"/></label>}
    <p className="muted text-sm">ระบบจะตรวจ FEFO และยอดคงเหลือซ้ำในฐานข้อมูลก่อนยืนยัน</p><SubmitButton label="ยืนยันการเบิก" pendingLabel="กำลังบันทึกการเบิก…"/>
  </form>;
}
