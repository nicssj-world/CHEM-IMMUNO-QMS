'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ClipboardList, Plus, ScanLine, Search, Trash2 } from 'lucide-react';
import { BarcodeScanner } from './barcode-scanner';
import { resolveProductScan } from '@/app/actions/scanner';
import { scanBatchFields } from '@/lib/barcode';
import { createIssueGroup } from '@/app/actions/issue-groups';
import { mergeIssueLine, type IssueCartLine } from '@/lib/issue-cart';

export type IssueProduct={id:string;warehouse_id:number;product_code:string;display_name:string};
export type IssueCandidate={warehouse_id:number;product_id:string;lot_id:string;lot_number:string;expiry_date:string;location_id:string;location_code:string;balance:number};
export type OpenGroup={id:string;status:string;created_at:string;line_count:number;done_count:number};
const purposes=[['Routine','Routine'],['QC','QC'],['Calibration','Calibration'],['Verification/Validation','Verification / Validation'],['Repeat/Troubleshooting','Repeat / Troubleshooting'],['Waste','Waste'],['Other','Other']];
const date=(x:string)=>{const [y,m,d]=x.split('-');return [d,m,y].join('/');};
const storageKey=(mode:string)=>'ci-issue-v1-'+mode;

/** Multi-item issue and planned warehouse picking share the same editor, never the legacy single-item form. */
export function IssueGroupWorkbench({mode,products,candidates,openGroups}:{mode:'batch'|'prepare';products:IssueProduct[];candidates:IssueCandidate[];openGroups:OpenGroup[]}) {
 const router=useRouter();
 const [search,setSearch]=useState('');
 const [chosen,setChosen]=useState('');
 const [choice,setChoice]=useState('');
 const [amount,setAmount]=useState('1');
 const [reason,setReason]=useState('');
 const [lines,setLines]=useState<IssueCartLine[]>([]);
 const [purpose,setPurpose]=useState('Routine');
 const [review,setReview]=useState(false);
 const [editor,setEditor]=useState(false);
 const [busy,startTransition]=useTransition();
 const [message,setMessage]=useState('');
 const [clientKey,setClientKey]=useState('');
 const [hydrated,setHydrated]=useState(false);
 const [showLists,setShowLists]=useState(true);
 const product=products.find(x=>x.id===chosen);
 const lots=candidates.filter(x=>x.product_id===chosen).sort((a,b)=>a.expiry_date.localeCompare(b.expiry_date)||a.lot_number.localeCompare(b.lot_number));
 const selected=lots.find(x=>x.lot_id+':'+x.location_id===choice);
 const isFefo=Boolean(selected&&lots[0]?.lot_id===selected.lot_id);
 const filtered=products.filter(p=>[p.product_code,p.display_name].some(s=>s.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))).slice(0,search.trim()?30:10);
 const units=lines.reduce((s,x)=>s+x.quantity,0);
 const canSubmit=lines.length>0&&lines.every(x=>x.quantity>0&&Number.isSafeInteger(x.quantity));
 useEffect(()=>{
   let cancelled=false;
   // Hydrate saved drafts after mount without changing state synchronously during the effect.
   queueMicrotask(()=>{
    if(cancelled)return;
    try{
     const saved=localStorage.getItem(storageKey(mode));
     if(saved){const data=JSON.parse(saved) as {lines?:IssueCartLine[];purpose?:string;clientKey?:string};
       if(Array.isArray(data.lines))setLines(data.lines.filter(x=>products.some(p=>p.id===x.product_id)));
       if(data.purpose)setPurpose(data.purpose);
       setClientKey(data.clientKey||crypto.randomUUID());
     } else setClientKey(crypto.randomUUID());
    }catch{setClientKey(crypto.randomUUID());}
    setHydrated(true);
   });
   return ()=>{cancelled=true;};
 },[mode,products]);
 useEffect(()=>{
   if(!hydrated||!clientKey)return;
   try{localStorage.setItem(storageKey(mode),JSON.stringify({lines,purpose,clientKey}));}catch{/* storage unavailable; server still validates */}
 },[mode,lines,purpose,clientKey,hydrated]);
 function selectProduct(p:IssueProduct, scannedLot=''){
   const available=candidates.filter(x=>x.product_id===p.id).sort((a,b)=>a.expiry_date.localeCompare(b.expiry_date));
   setChosen(p.id);
   setSearch(p.product_code+' · '+p.display_name);
   const matches=scannedLot?available.filter(x=>x.lot_number.trim().toUpperCase()===scannedLot.trim().toUpperCase()):[];
   const next=matches.length===1?matches[0]:scannedLot?undefined:available[0];
   setChoice(next?next.lot_id+':'+next.location_id:'');
   setAmount('1');setReason('');setEditor(true);
   setMessage(scannedLot&&!next?(matches.length>1?'LOT อยู่หลายตำแหน่ง กรุณาเลือกตำแหน่งจริง':'LOT ที่สแกนไม่พบยอดคงเหลือ กรุณาตรวจสอบและเลือกเอง'):'');
 }
 async function onScan(raw:string,symbology:string){
   if(editor){setMessage('ตรวจรายการที่สแกนไว้ก่อนเพิ่มรายการถัดไป');return;}
   setMessage('กำลังตรวจ Barcode…');
   try{
    const result=await resolveProductScan(raw,symbology);
    if(!result.product){setMessage(result.message??'ไม่พบสินค้าในทะเบียน');return;}
    const p=products.find(x=>x.id===result.product?.id);
    if(!p){setMessage('สินค้านี้ไม่มีสิทธิ์เบิกในคลังของคุณ');return;}
    const lot=scanBatchFields(result.parsed).lot??'';
    selectProduct(p,lot);
   }catch(e){setMessage(e instanceof Error?e.message:'ไม่สามารถอ่าน Barcode ได้');}
 }
 function addItem(){
   if(!product||!selected){setMessage('เลือกน้ำยาและ LOT ที่จะเบิก');return;}
   const qty=Number(amount);
   if(!Number.isSafeInteger(qty)||qty<1){setMessage('จำนวนต้องเป็นจำนวนเต็มบวก');return;}
   if(!isFefo&&!reason.trim()){setMessage('กรุณาระบุเหตุผลที่ไม่ใช้ LOT ตาม FEFO');return;}
   try{
    const next:IssueCartLine={
     product_id:product.id,product_code:product.product_code,product_name:product.display_name,warehouse_id:product.warehouse_id,
     lot_id:selected.lot_id,lot_number:selected.lot_number,location_id:selected.location_id,
     location_code:selected.location_code,expiry_date:selected.expiry_date,
     quantity:qty,balance:Number(selected.balance),override_reason:!isFefo?reason.trim():''
    };
    setLines(old=>mergeIssueLine(old,next));
    setEditor(false);setChosen('');setSearch('');setChoice('');setAmount('1');setReason('');
    setMessage('เพิ่มรายการแล้ว · '+(mode==='batch'?'สแกนรายการต่อไปได้ทันที':'ค้นหาและเพิ่มรายการต่อไปได้'));
   }catch(e){setMessage(e instanceof Error?e.message:'เพิ่มรายการไม่ได้');}
 }
 function submit(){
   if(!canSubmit||busy)return;
   setMessage('');
   startTransition(async()=>{
    const res=await createIssueGroup({client_key:clientKey,purpose,lines:lines.map(x=>({
     product_id:x.product_id,lot_id:x.lot_id,location_id:x.location_id,quantity:x.quantity,override_reason:x.override_reason||null
    }))},mode==='batch');
    if(!res.ok){setMessage(res.message);return;}
    try{localStorage.removeItem(storageKey(mode));}catch{}
    router.push('/issue/groups/'+res.id);
    router.refresh();
   });
 }
 return <div className="grid gap-5">
   <section className="surface p-4 sm:p-6 grid gap-3">
     <div className="flex flex-wrap items-center gap-2">
       {mode==='batch'?<ScanLine size={22} aria-hidden/>:<ClipboardList size={22} aria-hidden/>}
       <h2 className="text-lg font-bold">{mode==='batch'?'สแกนเบิกหลายรายการ':'สร้างรายการเบิกล่วงหน้า'}</h2>
     </div>
     <p className="muted text-sm">{mode==='batch'?'สแกนและเพิ่มจำนวนทีละรายการ ระบบยังไม่ตัด Stock จนกว่าจะตรวจสรุปและยืนยัน':'ค้นหาสินค้า เลือก LOT ตาม FEFO และระบุจำนวน แล้วสร้าง Checklist สำหรับไปหยิบในคลัง'}</p>
     {mode==='batch'&&!review&&<BarcodeScanner onScan={onScan} continuous />}
     {!review&&<>
       <label className="field">ค้นหาน้ำยา / REF แบบ Realtime
        <div className="relative"><Search size={18} className="absolute left-3 top-3.5 text-slate-500" aria-hidden/>
        <input className="input pl-10" value={search} onChange={e=>{setSearch(e.target.value);setChosen('');setEditor(false);}}
         placeholder="พิมพ์ชื่อสินค้า หรือ REF" autoComplete="off" /></div>
       </label>
       {search.trim()&&!chosen&&<div className="max-h-60 overflow-y-auto rounded-xl border border-line" role="listbox" aria-label="ผลค้นหาน้ำยา">
         {filtered.map(p=><button type="button" key={p.id} className="block w-full text-left p-3 border-b border-line last:border-0 hover:bg-surface-2"
          onClick={()=>selectProduct(p)}><strong className="block">{p.product_code}</strong><span className="muted text-sm">{p.display_name}</span></button>)}
         {!filtered.length&&<p className="p-3 muted">ไม่พบรายการ กรุณาตรวจคำค้นหา</p>}
       </div>}
       {editor&&product&&<div className="rounded-2xl border-2 border-teal-600 bg-surface-2 p-4 grid gap-3" role="region" aria-label="เพิ่มรายการเบิก">
        <div className="flex items-start justify-between gap-2"><div><strong>{product.product_code}</strong><p className="muted text-sm">{product.display_name}</p></div>
         <button className="button secondary text-sm" type="button" onClick={()=>setEditor(false)}>ยกเลิก</button></div>
        <label className="field">LOT / EXP / ที่จัดเก็บ
         <select className="input" value={choice} onChange={e=>{setChoice(e.target.value);setReason('');}}>
          <option value="">เลือก LOT</option>
          {lots.map((x,i)=><option key={x.lot_id+':'+x.location_id} value={x.lot_id+':'+x.location_id}>
            {x.lot_number} · EXP {date(x.expiry_date)} · {x.location_code} · คงเหลือ {x.balance}{i===0?' · FEFO':''}
          </option>)}
         </select></label>
        {selected&&<div className="grid grid-cols-2 gap-2 text-sm"><p>คงเหลือ LOT นี้ <strong>{selected.balance}</strong></p>
         <p className={isFefo?'text-emerald-700':'text-amber-700 font-semibold'}>{isFefo?'✓ แนะนำตาม FEFO':'⚠ ไม่ใช่ LOT FEFO'}</p></div>}
        <label className="field">จำนวนที่จะเบิก
          <input className="input text-lg" type="number" inputMode="numeric" min={1} step={1} max={selected?.balance}
           value={amount} onChange={e=>setAmount(e.target.value)}/></label>
        {selected&&!isFefo&&<label className="field">เหตุผลที่เลือก LOT อื่น <span className="text-red-700">*</span>
         <textarea className="input min-h-20" value={reason} onChange={e=>setReason(e.target.value)} maxLength={500}
         placeholder="ระบุเหตุผลสั้น ๆ" required/></label>}
        <button type="button" className="button min-h-12" onClick={addItem} disabled={!selected}><Plus size={18} aria-hidden/> เพิ่มเข้ารายการ</button>
       </div>}
     </>}
     {message&&<p role="status" className="notice text-sm">{message}</p>}
   </section>
   <section className="surface p-4 sm:p-6 grid gap-3">
     <div className="flex flex-wrap items-baseline justify-between gap-2">
       <h2 className="font-bold text-lg">{review?'ตรวจสอบสรุปรายการก่อนเบิก':'รายการที่เพิ่มแล้ว'}</h2>
       <span className="muted text-sm">{lines.length} รายการ · {units.toLocaleString('th-TH')} ชิ้น</span>
     </div>
     {!lines.length&&<p className="muted text-sm py-5 text-center">ยังไม่มีรายการ · เริ่มจากสแกนหรือค้นหาสินค้าด้านบน</p>}
     <div className="grid gap-2">{lines.map((l,i)=><article key={l.lot_id+':'+l.location_id}
      className="rounded-xl border border-line p-3 grid gap-2">
       <div className="flex items-start justify-between gap-2"><div className="min-w-0"><strong>{i+1}. {l.product_code} · {l.product_name}</strong>
       <p className="muted text-xs">LOT {l.lot_number} · EXP {date(l.expiry_date)} · {l.location_code}</p>
       {l.override_reason&&<p className="text-amber-700 text-xs">ไม่ใช้ FEFO: {l.override_reason}</p>}</div>
       {!review&&<button type="button" className="button secondary px-2" aria-label={'ลบ '+l.product_code}
        onClick={()=>setLines(old=>old.filter(x=>x!==l))}><Trash2 size={18} aria-hidden/></button>}</div>
       {review?<p className="font-bold text-right">{l.quantity} ชิ้น</p>:<label className="flex justify-between gap-3 items-center text-sm">จำนวน
        <input type="number" className="input max-w-32 text-right" min="1" step="1" max={l.balance} value={l.quantity}
         onChange={e=>setLines(old=>old.map((x,k)=>k===i?{...x,quantity:Number(e.target.value)}:x))}/></label>}
     </article>)}</div>
     <label className="field">วัตถุประสงค์ของรายการ
       <select className="input" value={purpose} onChange={e=>setPurpose(e.target.value)} disabled={review}>
        {purposes.map(([val,name])=><option value={val} key={val}>{name}</option>)}</select></label>
     <div className="sticky bottom-16 md:bottom-3 z-10 bg-white/95 backdrop-blur rounded-xl border border-line p-3 grid gap-2 shadow-sm">
       {!review?<button type="button" disabled={!canSubmit} className="button min-h-12" onClick={()=>setReview(true)}>
        <Check size={18} aria-hidden/> {mode==='batch'?'ตรวจสอบสรุปรายการเบิก':'ตรวจสอบก่อนสร้างรายการ'}</button>
       :<div className="grid grid-cols-2 gap-2">
         <button type="button" className="button secondary min-h-12" onClick={()=>setReview(false)} disabled={busy}>ย้อนกลับแก้ไข</button>
         <button type="button" className="button min-h-12" onClick={submit} disabled={busy}>
          {busy?'กำลังบันทึก…':mode==='batch'?'ยืนยันเบิกออก':'สร้างรายการ Checklist'}</button></div>}
       <p className="muted text-xs text-center">{mode==='batch'?'ตัด Stock จริงเมื่อกดยืนยันเบิกออกเท่านั้น':'สร้างรายการแล้วยังไม่ตัด Stock · ตัดเมื่อหยิบครบและปิดรายการ'}</p>
     </div>
   </section>
   {mode==='prepare'&&<section className="surface p-4 sm:p-6 grid gap-3">
     <button type="button" className="flex w-full justify-between items-center text-left" onClick={()=>setShowLists(x=>!x)}>
       <h2 className="font-bold">รายการเบิกที่ยังไม่ปิด ({openGroups.length})</h2><span className="muted">{showLists?'ซ่อน':'แสดง'}</span></button>
     {showLists&&<div className="grid gap-2">{openGroups.map(x=><button type="button" key={x.id} className="rounded-xl border border-line p-3 text-left hover:bg-surface-2"
       onClick={()=>router.push('/issue/groups/'+x.id)}>
       <strong>รายการ #{x.id.slice(0,8).toUpperCase()}</strong><span className="ml-2 text-sm muted">{x.status==='picking'?'กำลังหยิบ':'รอหยิบ'}</span>
       <p className="muted text-sm">{x.done_count}/{x.line_count} รายการ · {new Date(x.created_at).toLocaleString('th-TH')}</p></button>)}
       {!openGroups.length&&<p className="muted text-sm">ไม่มีรายการที่รอหยิบ</p>}</div>}
   </section>}
 </div>;
}
