'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PackagePlus, Pencil, Trash2 } from 'lucide-react';
import { SearchInput } from './search-input';
import { amendInvoice } from '@/app/actions/invoice-additions';

type Product = {id:string;product_code:string;display_name:string;warehouse_id:number};
type ExistingLine={product_id:string;ordered_quantity:number;received_quantity:number};
type Addition={product_id:string;quantity:number};
export function InvoiceAdditions({invoiceId,invoice,products,lines}:{
 invoiceId:string;
 invoice:{invoice_number:string;invoice_date:string;po_number:string|null;status:string};
 products:Product[];lines:ExistingLine[];
}) {
 const router=useRouter();
 const [open,setOpen]=useState(false);
 const [number,setNumber]=useState(invoice.invoice_number);
 const [date,setDate]=useState(invoice.invoice_date);
 const [po,setPo]=useState(invoice.po_number??'');
 const [query,setQuery]=useState('');
 const [productId,setProductId]=useState('');
 const [amount,setAmount]=useState('1');
 const [additions,setAdditions]=useState<Addition[]>([]);
 const [error,setError]=useState('');
 const [success,setSuccess]=useState('');
 const [busy,startTransition]=useTransition();
 const current=new Map(lines.map(x=>[x.product_id,x]));
 const chosen=products.find(x=>x.id===productId);
 const matches=products.filter(p=>!query.trim()||[p.display_name,p.product_code].some(s=>s.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))).slice(0,20);
 function addLine(){
  const n=Number(amount);
  if(!chosen||!Number.isSafeInteger(n)||n<1){setError('กรุณาเลือกน้ำยาและกรอกจำนวนเต็มมากกว่า 0');return;}
  setAdditions(old=>old.some(x=>x.product_id===productId)?old.map(x=>x.product_id===productId?{...x,quantity:x.quantity+n}:x):[...old,{product_id:productId,quantity:n}]);
  setProductId('');setQuery('');setAmount('1');setError('');
 }
 function save(){
  if(busy)return;
  setError('');setSuccess('');
  startTransition(async()=>{
   const res=await amendInvoice(invoiceId,{invoice_number:number,invoice_date:date,po_number:po,lines:additions});
   if(!res.ok){setError(res.message);return;}
   setOpen(false);setAdditions([]);
   setSuccess('อัปเดต Invoice สำเร็จ · รายการที่เพิ่มพร้อมให้รับเข้าใน Workflow เดิม');
   router.refresh();
  });
 }
 const changed=number.trim()!==invoice.invoice_number||date!==invoice.invoice_date||po.trim()!==(invoice.po_number??'');
 return <section className="surface p-4 sm:p-6 grid gap-3" aria-label="รับเข้าเพิ่มเติมและแก้ไข Invoice">
  <div className="flex flex-wrap items-start justify-between gap-3">
   <div className="grid gap-1"><h2 className="font-bold text-lg">รับเข้าเพิ่มเติมใน Invoice เดิม</h2>
    <p className="muted text-sm">เพิ่มจำนวนค้างรับหรือเพิ่มสินค้าใน Invoice เดิมโดยไม่เปลี่ยนประวัติที่รับแล้ว</p></div>
   <button type="button" className="button secondary min-h-11" onClick={()=>setOpen(x=>!x)}>
    {open?'ปิดแบบฟอร์ม':<><Pencil size={17} aria-hidden/> แก้ไข / รับเข้าเพิ่มเติม</>}</button>
  </div>
  {success&&<p role="status" className="notice">{success}</p>}
  {open&&<div className="grid gap-4 border-t border-line pt-4">
   <div className="grid sm:grid-cols-3 gap-3">
    <label className="field">เลข Invoice<input className="input" value={number} onChange={e=>setNumber(e.target.value)} maxLength={120}/></label>
    <label className="field">วันที่ Invoice<input type="date" className="input" value={date} onChange={e=>setDate(e.target.value)}/></label>
    <label className="field">เลข PO<input className="input" value={po} onChange={e=>setPo(e.target.value)} maxLength={200}/></label>
   </div>
   <div className="rounded-xl bg-surface-2 p-3 grid gap-2">
    <h3 className="font-semibold">เพิ่มสินค้า / เพิ่มจำนวนที่จะรับ</h3>
    <SearchInput label="ค้นหาชื่อสินค้า หรือ REF (Realtime)" placeholder="ค้นหาน้ำยา..."
      value={query} onChange={value=>{setQuery(value);setProductId('');}}/>
    {query.trim()&&!productId&&<div className="grid max-h-44 overflow-y-auto bg-white rounded-xl border border-line">
     {matches.map(p=><button type="button" key={p.id} className="text-left min-h-11 p-3 border-b last:border-0 border-line hover:bg-surface-2"
      onClick={()=>{setProductId(p.id);setQuery(p.product_code+' · '+p.display_name);}}>
       <strong>{p.product_code}</strong> <span className="muted text-sm">{p.display_name}</span>
     </button>)}
     {!matches.length&&<p className="p-3 muted">ไม่พบสินค้า</p>}
    </div>}
    {chosen&&<div className="grid gap-3 sm:grid-cols-[1fr_140px_auto] items-end">
      <p className="text-sm">{chosen.product_code} · {chosen.display_name}<br/>
       <span className="muted">เดิม {current.get(chosen.id)?.ordered_quantity??0} / รับแล้ว {current.get(chosen.id)?.received_quantity??0}</span></p>
      <label className="field">จำนวนที่จะเพิ่ม<input className="input" type="number" min="1" step="1" inputMode="numeric"
       value={amount} onChange={e=>setAmount(e.target.value)}/></label>
      <button className="button min-h-12" type="button" onClick={addLine}><PackagePlus size={17} aria-hidden/> เพิ่ม</button>
    </div>}
   </div>
   {additions.length>0&&<div className="grid gap-2" aria-label="สรุปรายการที่ต้องการเพิ่ม">
     <strong>รอเพิ่ม {additions.length} รายการ</strong>
     {additions.map(x=>{const p=products.find(p=>p.id===x.product_id);return <div key={x.product_id} className="rounded-xl border border-line p-3 flex items-center gap-2 justify-between">
       <div className="min-w-0"><strong className="text-sm">{p?.product_code} · {p?.display_name}</strong><p className="muted text-xs">เพิ่มอีก {x.quantity} หน่วย</p></div>
       <button className="button secondary px-2" type="button" onClick={()=>setAdditions(old=>old.filter(y=>y.product_id!==x.product_id))} aria-label="ลบรายการ"><Trash2 size={17}/></button>
      </div>})}
    </div>}
   <p className="muted text-sm">เมื่อบันทึกแล้ว Invoice จะเปิดให้รับเข้าเพิ่มเติมด้วยขั้นตอนรับเข้าเดิม และไม่ปรับ Stock จนกว่าจะยืนยันรับสินค้า</p>
   {error&&<p role="alert" className="error">{error}</p>}
   <button type="button" className="button min-h-12" disabled={busy||!(changed||additions.length>0)||!number.trim()||!date}
    onClick={save}>{busy?'กำลังบันทึก…':'บันทึกการแก้ไข Invoice'}</button>
  </div>}
 </section>;
}
