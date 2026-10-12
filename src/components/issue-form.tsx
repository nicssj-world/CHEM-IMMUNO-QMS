'use client';

import { useState } from 'react';
import { issueStock } from '@/app/actions/inventory';
import { IntegerQuantityInput } from './integer-quantity-input';
import { SubmitButton } from './submit-button';
import { isFefoLot, issueBalanceAfter, scannedIssueLotIndex, scannedIssueLotStatus,
  type IssueLotOption } from '@/lib/issue-lot-choice';

type Candidate=IssueLotOption;
const numberText=(n:number)=>n.toLocaleString('th-TH');
function shortDate(iso:string) {
  const [year,month,day]=iso.split('-');
  return [day,month,year].join('/');
}

/** The only mutation remains the existing explicit issueStock server action.
 * All LOT choice and balance previews are client-side, from permitted FEFO rows.
 */
export function IssueForm({productId,productCode,warehouseCode,candidates,submissionKey,preferredLot=''}:{
  productId:string;productCode:string;warehouseCode:string;
  candidates:Candidate[];submissionKey:string;preferredLot?:string;
}) {
  const scannedIndex=scannedIssueLotIndex(candidates,preferredLot);
  const scannedStatus=scannedIssueLotStatus(candidates,preferredLot);
  const [selected,setSelected]=useState(scannedIndex>=0?scannedIndex:candidates.length===1?0:-1);
  const [quantity,setQuantity]=useState('');
  const [showAll,setShowAll]=useState(scannedIndex>=4);
  const item=selected>=0?candidates[selected]:undefined;
  const balanceAfter=item?issueBalanceAfter(Number(item.balance),quantity):null;
  const hasValidQuantity=balanceAfter!==null;
  const needsReason=Boolean(item&&!isFefoLot(candidates,item.lot_id));
  const visible=showAll?candidates:candidates.slice(0,4);

  function chooseLot(index:number) {
    setSelected(index);
    setQuantity('');
  }

  return <form action={issueStock} className="surface p-4 sm:p-7 grid gap-4" aria-label="เลือก LOT และบันทึกการเบิก">
    <input type="hidden" name="product_id" value={productId}/>
    <input type="hidden" name="lot_id" value={item?.lot_id??''}/>
    <input type="hidden" name="location_id" value={item?.location_id??''}/>
    <input type="hidden" name="idempotency_key" value={submissionKey}/>
    {/* Errors return to the same Product/LOT; only confirmation changes Stock. */}
    <input type="hidden" name="warehouse" value={warehouseCode}/>
    <input type="hidden" name="product" value={productId}/>
    <input type="hidden" name="lot" value={preferredLot}/>
    <input type="hidden" name="summary" value={`${productCode} LOT ${item?.lot_number??''}`}/>

    <div className="grid gap-1">
      <h2 className="text-lg font-bold">เลือก LOT ที่จะเบิก</h2>
      <p className="muted text-sm">{productCode} · {candidates.length} ตำแหน่ง/LOT ที่เบิกได้ · เรียงตามวันหมดอายุ (FEFO)</p>
    </div>
    {scannedStatus==='missing'&&<p role="alert" className="notice text-sm">
      LOT {preferredLot} ที่สแกนไม่มียอดที่เบิกได้ · กรุณาตรวจฉลากและเลือก LOT เอง ระบบจะไม่เปลี่ยน LOT ให้โดยอัตโนมัติ
    </p>}
    {scannedStatus==='ambiguous'&&<p role="status" className="notice text-sm">
      พบ LOT {preferredLot} หลายตำแหน่งจัดเก็บ · กรุณาเลือกตำแหน่งที่จะเบิกให้ตรงกับกล่องจริง
    </p>}
    {scannedStatus==='unique'&&<p role="status" className="notice text-sm">
      พบ LOT {preferredLot} จาก Barcode และเลือกตำแหน่งที่ตรงกันแล้ว · กรุณาตรวจรายละเอียดก่อนยืนยัน
    </p>}

    <fieldset className="grid gap-2">
      <legend className="text-sm font-semibold mb-2">LOT / วันหมดอายุ / คงเหลือ <span className="text-red-700">*</span></legend>
      {visible.map((candidate,index)=>{
        const active=selected===index;
        const fefo=isFefoLot(candidates,candidate.lot_id);
        return <label key={`${candidate.lot_id}:${candidate.location_id}`}
          className={`relative flex cursor-pointer items-start gap-3 rounded-xl border p-3 sm:p-4 min-h-16 transition-colors ${active?'border-blue-600 bg-blue-50':'border-line hover:bg-surface-2'}`}>
          <input type="radio" name="issue_lot_choice" value={index} checked={active}
            onChange={()=>chooseLot(index)} className="mt-1 shrink-0 accent-blue-700"/>
          <span className="min-w-0 flex-1 grid gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <strong className="text-sm break-all">LOT {candidate.lot_number}</strong>
              {fefo&&<span className="rounded-full bg-emerald-100 text-emerald-800 px-2 py-1 text-xs font-semibold">FEFO · แนะนำเบิกก่อน</span>}
              {preferredLot.trim().toLocaleUpperCase()===candidate.lot_number.trim().toLocaleUpperCase()&&
                <span className="rounded-full bg-blue-100 text-blue-800 px-2 py-1 text-xs font-semibold">ตรงกับ Barcode</span>}
            </span>
            <span className="text-sm">EXP <strong>{shortDate(candidate.expiry_date)}</strong> · {candidate.location_code}</span>
          </span>
          <span className="text-right shrink-0 grid gap-1">
            <strong className="text-xl tabular-nums">{numberText(Number(candidate.balance))}</strong>
            <span className="muted text-xs">คงเหลือ</span>
          </span>
        </label>;
      })}
      {candidates.length>4&&<button className="button secondary justify-self-start" type="button"
        onClick={()=>setShowAll(!showAll)}>
        {showAll?'แสดงเฉพาะ 4 รายการแรก':`ดู LOT/ตำแหน่งทั้งหมด (${candidates.length})`}
      </button>}
    </fieldset>
    {item&&<section className="rounded-xl bg-surface-2 p-3 sm:p-4 grid gap-3" aria-label="จำนวนและยอดคงเหลือหลังเบิก">
      <p className="font-semibold text-sm">กำลังเบิก LOT {item.lot_number} · {item.location_code}</p>
      <label className="field">จำนวนที่เบิก <span className="text-red-700">*</span>
        <IntegerQuantityInput className="input min-h-12 text-lg font-semibold" name="quantity" min="1"
          max={Number(item.balance)} placeholder="ระบุจำนวนที่เบิกจริง"
          autoFocus={scannedStatus==='unique'||candidates.length===1} required value={quantity}
          onChange={event=>setQuantity(event.target.value)}/>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-white p-3">
          <span className="muted text-xs block">คงเหลือก่อนเบิก</span>
          <strong className="text-xl tabular-nums">{numberText(Number(item.balance))}</strong>
        </div>
        <div className="rounded-lg bg-white p-3">
          <span className="muted text-xs block">คงเหลือหลังเบิก</span>
          <strong className="text-xl tabular-nums">{balanceAfter===null?'—':numberText(balanceAfter)}</strong>
        </div>
      </div>
      {quantity&&!hasValidQuantity&&<p role="alert" className="text-sm text-red-700">
        กรุณาระบุจำนวนเต็มตั้งแต่ 1 ถึง {numberText(Number(item.balance))} หน่วย (ยอดที่เบิกได้)
      </p>}
    </section>}
    {!item&&<p className="muted text-sm">เลือก LOT และตำแหน่งที่ต้องการด้านบน เพื่อระบุจำนวนที่จะเบิก</p>}
    <label className="field">วัตถุประสงค์
      <select className="input" name="purpose" required defaultValue="Routine">
        <option value="Routine">Routine use</option>
        <option value="QC">QC</option>
        <option value="Calibration">Calibration</option>
        <option value="Verification/Validation">Verification / Validation</option>
        <option value="Repeat/Troubleshooting">Repeat / Troubleshooting</option>
        <option value="Waste">Waste</option>
        <option value="Other">Other</option>
      </select>
    </label>
    {needsReason&&<label className="field">เหตุผลที่ไม่ใช้ LOT ตาม FEFO <span className="text-red-700">*</span>
      <textarea className="input min-h-24" name="override_reason" required
        placeholder="ระบุเหตุผลในการเลือก LOT อื่น"/>
    </label>}
    <p className="muted text-xs">ยอดคงเหลือหลังเบิกเป็นค่าประมาณจากหน้าจอ · ระบบตรวจ FEFO และยอดจริงในฐานข้อมูลอีกครั้งก่อนบันทึก</p>
    <SubmitButton disabled={!item||!hasValidQuantity} label="ยืนยันการเบิก" pendingLabel="กำลังบันทึกการเบิก…"/>
  </form>;
}
