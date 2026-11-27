import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';

type Invoice = {id:string;invoice_number:string;invoice_date:string;status:string;vendor_id:string;po_number:string|null};
const statuses:Record<string,string>={open:'ยังรับไม่ครบ (Invoice เดิม)',closed:'รับเข้าแล้ว',closed_short:'ปิดรับไม่ครบ (Invoice เดิม)',cancelled:'ยกเลิก'};
function dateTH(date:string){return new Date(date+'T12:00:00Z').toLocaleDateString('th-TH',{timeZone:'Asia/Bangkok'});}

export default async function InvoicesPage({searchParams}:{
  searchParams:Promise<{q?:string;status?:string;vendor?:string;page?:string}>
}){
  const params=await searchParams;
  const access=await requireAccess();
  const client=await createClient();
  if(!client)return <main className="error">ยังไม่ได้ตั้งค่า Supabase</main>;
  const q=(params.q??'').trim().slice(0,100).replace(/[%_,()]/g,'');
  const allowedStatuses=['all','closed','open','closed_short','cancelled','draft'];
  const status=allowedStatuses.includes(params.status??'')?params.status!:'all';
  const page=Math.min(1000,Math.max(1,Number.parseInt(params.page??'1',10)||1));
  const {data:vendorData,error:vendorError}=await client.from('ci_vendors')
    .select('id,name').order('name').limit(500);
  const vendors=vendorData??[];
  const selectedVendor=vendors.some(item=>item.id===params.vendor)?params.vendor??'':'';
  const vendorNames=new Map(vendors.map(item=>[item.id,item.name]));
  const canReceive=access.warehouses.some(w=>w.role!=='viewer');
  let invoices:Invoice[]=[];
  let count=0;
  let errorMessage='';
  if(status!=='draft'){
    let query=client.from('ci_invoices')
      .select('id,invoice_number,invoice_date,status,vendor_id,po_number',{count:'exact'})
      .order('invoice_date',{ascending:false}).order('created_at',{ascending:false});
    if(q)query=query.ilike('invoice_number',`%${q}%`);
    if(selectedVendor)query=query.eq('vendor_id',selectedVendor);
    if(status!=='all')query=query.eq('status',status);
    const {data,error,count:total}=await query.range((page-1)*20,page*20-1);
    if(error)errorMessage=logUserMessage('invoices-list',error);
    invoices=(data??[]) as Invoice[];
    count=total??0;
  }
  const draftQuery=client.from('ci_receive_wizard_drafts')
    .select('id,invoice_number,invoice_date,vendor_id,updated_at',{count:'exact'})
    .eq('status','draft').order('updated_at',{ascending:false});
  const filteredDraftQuery=q?draftQuery.ilike('invoice_number',`%${q}%`):draftQuery;
  const {data:draftData,error:draftError}=status==='draft'||status==='all'
    ?await (selectedVendor?filteredDraftQuery.eq('vendor_id',selectedVendor):filteredDraftQuery).limit(20)
    :{data:[],error:null};
  const visibleDrafts=draftData??[];
  const qs=new URLSearchParams({q,status,vendor:selectedVendor});
  const detailHref=(id:string)=>'/invoices/'+encodeURIComponent(id);
  return <main className="grid gap-5 min-w-0">
    <header className="flex flex-wrap justify-between items-start gap-3">
      <div className="grid gap-1">
        <p className="eyebrow">Invoice Registry</p>
        <h1 className="page-title">ทะเบียน Invoice</h1>
        <p className="muted text-sm">ค้นหาเลข Invoice และเปิดดูรายการ LOT ที่รับจริง เอกสารแนบ และผลการตรวจรับ</p>
      </div>
      {canReceive&&<Link href="/receive" className="button">+ รับน้ำยาใหม่</Link>}
    </header>
    <form method="get" action="/invoices" className="surface p-4 grid sm:grid-cols-[minmax(0,1fr)_200px_180px_auto] gap-3 items-end">
      <label className="field">ค้นหาเลข Invoice
        <input className="input" type="search" name="q" defaultValue={q} placeholder="พิมพ์เลข Invoice" maxLength={100}/>
      </label>
      <label className="field">ผู้ขาย
        <select className="input" name="vendor" defaultValue={selectedVendor}>
          <option value="">ทุกผู้ขาย</option>
          {vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </label>
      <label className="field">สถานะ
        <select className="input" name="status" defaultValue={status}>
          <option value="all">ทั้งหมด</option>
          <option value="closed">รับเข้าแล้ว</option>
          <option value="open">ยังรับไม่ครบ (เดิม)</option>
          <option value="closed_short">ปิดรับไม่ครบ (เดิม)</option>
          <option value="draft">ฉบับร่าง</option>
          <option value="cancelled">ยกเลิก</option>
        </select>
      </label>
      <button className="button min-h-11" type="submit">ค้นหา</button>
    </form>
    {vendorError&&<p role="alert" className="error">อ่านรายชื่อผู้ขายไม่สำเร็จ: {logUserMessage('invoice-vendors',vendorError)}</p>}
    {errorMessage&&<p role="alert" className="error">อ่านรายการ Invoice ไม่สำเร็จ: {errorMessage}</p>}
    {draftError&&<p role="alert" className="error">อ่านฉบับร่างไม่สำเร็จ: {logUserMessage('invoice-drafts',draftError)}</p>}
    {(status==='draft'||status==='all')&&visibleDrafts.length>0&&<section className="grid gap-2">
      <h2 className="font-bold">ฉบับร่างที่ยังไม่ยืนยัน {visibleDrafts.length} รายการล่าสุด</h2>
      {visibleDrafts.map(draft=><Link key={draft.id} href={'/receive?draft='+encodeURIComponent(draft.id)}
        className="surface p-4 flex flex-wrap items-center justify-between gap-3 no-underline text-[var(--ink)]">
        <div><strong>{draft.invoice_number}</strong>
          <p className="muted text-sm">{vendorNames.get(draft.vendor_id)??'ผู้ขาย'} · {dateTH(draft.invoice_date)}</p></div>
        <span className="badge">ดำเนินการต่อ →</span>
      </Link>)}
    </section>}
    {status!=='draft'&&!errorMessage&&<section className="grid gap-3" aria-label="รายการ Invoice ที่บันทึกแล้ว">
      <div className="flex flex-wrap justify-between gap-2 items-center">
        <h2 className="font-bold">Invoice ที่บันทึกแล้ว</h2>
        <p className="muted text-xs">{count.toLocaleString('th-TH')} รายการ · หน้า {page}</p>
      </div>
      {invoices.map(invoice=><Link href={detailHref(invoice.id)} key={invoice.id}
        className="surface p-4 sm:p-5 grid gap-3 no-underline text-[var(--ink)]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <strong className="text-base break-all">{invoice.invoice_number}</strong>
            <p className="text-sm muted mt-1">{vendorNames.get(invoice.vendor_id)??'ผู้ขาย'} · {dateTH(invoice.invoice_date)}</p>
            {invoice.po_number&&<p className="muted text-xs mt-1">PO: {invoice.po_number}</p>}
          </div>
          <span className="badge shrink-0">{statuses[invoice.status]??invoice.status}</span>
        </div>
        <span className="font-semibold text-brand text-sm">ดูรายละเอียด Invoice และ LOT →</span>
      </Link>)}
      {invoices.length===0&&<p className="surface p-5 muted text-sm">ไม่พบ Invoice ที่ตรงกับเงื่อนไข</p>}
      <nav aria-label="หน้ารายการ Invoice" className="flex justify-between gap-3">
        {page>1?<Link className="button secondary" href={`/invoices?${qs}&page=${page-1}`}>← ก่อนหน้า</Link>:<span/>}
        {page*20<count&&<Link className="button secondary" href={`/invoices?${qs}&page=${page+1}`}>ถัดไป →</Link>}
      </nav>
    </section>}
    <p className="muted text-xs">ทะเบียนนี้เป็นหน้าอ่านข้อมูล ไม่เปลี่ยน Stock · Invoice เดิมที่เคยรับบางส่วนยังเก็บสถานะเดิมไว้</p>
  </main>;
}
