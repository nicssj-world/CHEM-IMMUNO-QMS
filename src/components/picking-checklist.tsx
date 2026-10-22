'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, CheckCheck, Search, X } from 'lucide-react';
import { matchesPickingQuery } from '@/lib/issue-cart';
import { setIssueLinePicked,completeIssueGroup,cancelIssueGroup } from '@/app/actions/issue-groups';

export type PickingLine={
 id:string;product_code:string;product_name:string;lot_number:string;
 expiry_date:string;location_code:string;quantity:number;picked:boolean;
};
const date=(s:string)=>{const [y,m,d]=s.split('-');return [d,m,y].join('/');};
export function PickingChecklist({id,status,initialLines,transactions}:{id:string;status:string;initialLines:PickingLine[];transactions:{warehouse_id:number;transaction_id:string}[]}) {
 const router=useRouter();
 const [lines,setLines]=useState(initialLines);
 const [query,setQuery]=useState('');
 const [showAll,setShowAll]=useState(false);
 const [showDone,setShowDone]=useState(false);
 const [error,setError]=useState('');
 const [pending,startTransition]=useTransition();
 const [working,setWorking]=useState('');
 const closed=status==='closed';
 const editable=status==='pending'||status==='picking';
 const done=lines.filter(x=>x.picked).length;
 const visible=lines.filter(x=>matchesPickingQuery(x,query));
 const filtered=query.trim()?visible:showAll?visible:visible.filter(x=>!x.picked);
 const sorted=[...filtered].sort((a,b)=>Number(a.picked)-Number(b.picked)||a.location_code.localeCompare(b.location_code,'th')||a.product_name.localeCompare(b.product_name,'th'));
 function toggle(x:PickingLine) {
   if(!editable||pending)return;
   setError('');setWorking(x.id);
   startTransition(async()=>{
     const result=await setIssueLinePicked(id,x.id,!x.picked);
     if(!result.ok){setError(result.message??'บันทึกไม่สำเร็จ');setWorking('');return;}
     setLines(old=>old.map(y=>y.id===x.id?{...y,picked:!x.picked}:y));
     setWorking('');
   });
 }
 function closeGroup() {
   if(pending||done!==lines.length||!editable)return;
   setError('');
   startTransition(async()=>{
     const result=await completeIssueGroup(id);
     if(!result.ok){setError(result.message??'ไม่สามารถปิดรายการได้');return;}
     router.refresh();
   });
 }
 function cancel() {
   if(pending||!editable)return;
   if(!window.confirm('ยกเลิกรายการที่ยังไม่ตัด Stock นี้?'))return;
   startTransition(async()=>{const result=await cancelIssueGroup(id);
    if(!result.ok)setError(result.message??'ยกเลิกรายการไม่ได้');
    else router.refresh();
   });
 }
 return <main className="max-w-[860px] grid gap-4 pb-24">
   <header className="flex flex-wrap items-center justify-between gap-3">
     <div><Link href="/issue?mode=prepare" className="text-sm underline text-teal-800">← รายการเบิกออก</Link>
      <h1 className="page-title mt-2">Picking Checklist</h1>
      <p className="muted text-sm">#{id.slice(0,8).toUpperCase()} · {closed?'ปิดรายการแล้ว':status==='cancelled'?'ยกเลิกแล้ว':status==='picking'?'กำลังหยิบ':'รอหยิบ'}</p></div>
     {editable&&<button className="button secondary text-sm" type="button" onClick={cancel} disabled={pending}>ยกเลิกรายการ</button>}
   </header>
   <section className="surface p-4 sm:p-6 grid gap-3">
     <div className="flex justify-between gap-3 items-center"><strong>หยิบแล้ว {done} / {lines.length} รายการ</strong><span className="muted text-sm">{Math.round((done/Math.max(1,lines.length))*100)}%</span></div>
     <div className="h-2 w-full rounded-full bg-slate-200 overflow-hidden" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={lines.length} aria-label="ความคืบหน้าการหยิบ">
       <div className="h-full bg-emerald-600 transition-all duration-200" style={{width:(100*done/Math.max(1,lines.length))+'%'}} />
     </div>
     <label className="field">ค้นหารายการแบบ Realtime
      <div className="relative"><Search className="absolute left-3 top-3.5 text-slate-500" size={18} aria-hidden/>
        <input className="input pl-10 pr-10" value={query} onChange={e=>setQuery(e.target.value)} placeholder="ชื่อสินค้า / REF / LOT" autoComplete="off"/>
        {query&&<button type="button" onClick={()=>setQuery('')} className="absolute right-3 top-3" aria-label="ล้างการค้นหา"><X size={20}/></button>}
      </div>
     </label>
     <div className="grid grid-cols-2 gap-2">
       <button type="button" onClick={()=>setShowAll(false)}
         aria-pressed={!showAll} className={'min-h-11 rounded-lg text-sm font-semibold border '+(!showAll?'bg-teal-800 text-white':'border-line bg-white')}>ยังไม่หยิบ ({lines.length-done})</button>
       <button type="button" onClick={()=>setShowAll(true)}
         aria-pressed={showAll} className={'min-h-11 rounded-lg text-sm font-semibold border '+(showAll?'bg-teal-800 text-white':'border-line bg-white')}>ทั้งหมด ({lines.length})</button>
     </div>
     <p className="muted text-xs">แตะรายการเพื่อยืนยันว่าหยิบแล้ว · แตะซ้ำเพื่อยกเลิกติ๊ก · ไม่ต้องสแกน LOT</p>
   </section>
   <section className="grid gap-2" aria-label="รายการน้ำยาที่ต้องหยิบ">
     {sorted.map(item=><button type="button" key={item.id} disabled={!editable||pending}
       onClick={()=>toggle(item)}
       aria-pressed={item.picked}
       className={'w-full text-left rounded-xl border p-3 sm:p-4 min-h-20 transition-colors '+(item.picked?'bg-emerald-50 border-emerald-200 text-slate-600':'bg-white border-line hover:bg-surface-2')}>
       <span className="flex gap-3 items-start">
         <span className={'shrink-0 w-8 h-8 border-2 rounded-lg grid place-items-center '+(item.picked?'bg-emerald-100 border-emerald-500 text-emerald-700':'border-slate-300')}>
           {item.picked&&<Check size={19} aria-hidden/>}
         </span>
         <span className="flex-1 min-w-0 grid gap-1">
           <strong className="text-sm sm:text-base">{item.product_code} · {item.product_name}</strong>
           <span className="text-xs">LOT {item.lot_number} · EXP {date(item.expiry_date)}</span>
           <span className="text-xs">ตำแหน่ง {item.location_code}</span>
           {item.picked&&<span className="text-emerald-700 text-xs font-semibold">✓ หยิบแล้ว</span>}
         </span>
         <span className="shrink-0 grid text-right"><strong className="text-xl tabular-nums">{item.quantity}</strong><span className="text-xs muted">ชิ้น</span></span>
       </span>
       {working===item.id&&<span className="muted text-xs">กำลังบันทึก…</span>}
     </button>)}
     {!sorted.length&&<div className="surface p-6 text-center muted">{query?'ไม่พบรายการที่ค้นหา':'ไม่มีรายการที่ยังไม่หยิบ'}</div>}
     {!query&&!showAll&&done>0&&<button type="button" className="button secondary" onClick={()=>setShowDone(x=>!x)}>
       {showDone?'ซ่อนรายการที่หยิบแล้ว':`ดูรายการที่หยิบแล้ว (${done})`}
     </button>}
     {!query&&!showAll&&showDone&&lines.filter(x=>x.picked).map(x=><button key={x.id} type="button" disabled={!editable||pending} onClick={()=>toggle(x)}
       className="rounded-lg bg-emerald-50 px-3 py-2 text-left text-sm text-slate-600">
       <Check size={16} className="inline text-emerald-700 mr-2" aria-hidden/>{x.product_code} · LOT {x.lot_number} · {x.quantity} ชิ้น
       <span className="text-emerald-700 ml-2">ยกเลิกติ๊ก</span></button>)}
   </section>
   {error&&<p role="alert" className="error">{error}</p>}
   {closed&&<section className="surface p-5 grid gap-2">
      <h2 className="text-emerald-800 font-bold text-lg"><CheckCheck size={20} className="inline mr-2"/>เบิกออกสำเร็จ</h2>
      <p className="muted text-sm">Stock ถูกตัดหลังปิดรายการ และมีหลักฐานธุรกรรมในประวัติ</p>
      {transactions.map(x=><p key={x.transaction_id} className="text-sm">คลัง {x.warehouse_id} · TX {x.transaction_id.slice(0,8)}</p>)}
      <Link href="/movements" className="button secondary">ดูประวัติการเบิก</Link>
   </section>}
   {editable&&<div className="fixed bottom-16 md:bottom-3 left-0 right-0 md:static z-20 bg-white/95 backdrop-blur border-t md:border-none border-line p-3">
     <div className="max-w-[860px] mx-auto grid gap-2">
       <button type="button" className="button min-h-12 w-full" disabled={pending||done!==lines.length||lines.length===0}
        onClick={closeGroup}><CheckCheck size={18} aria-hidden/> {pending?'กำลังบันทึก…':'ปิดรายการและตัด Stock'}</button>
       <p className="muted text-xs text-center">{done===lines.length?'ตรวจ Stock จริงอีกครั้งเมื่อกดปิด':'เหลือ '+(lines.length-done)+' รายการที่ยังไม่ได้หยิบ · ยังไม่ตัด Stock'}</p>
     </div>
   </div>}
 </main>;
}
