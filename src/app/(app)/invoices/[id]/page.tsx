import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { loadReceiptEvents } from '@/lib/receipt-events';
import { InvoiceEvidenceManager } from '@/components/invoice-evidence-manager';
import { ReceiptAssessmentCard } from '@/components/receipt-assessment-card';
import { logUserMessage } from '@/lib/messages';

const labels:Record<string,string>={open:'ยังรับไม่ครบ (Invoice เดิม)',closed:'รับเข้าแล้ว',closed_short:'ปิดรับไม่ครบ (Invoice เดิม)',cancelled:'ยกเลิก'};
type Invoice={id:string;invoice_number:string;invoice_date:string;po_number:string|null;vendor_id:string;status:string};
type Progress={invoice_line_id:string;product_id:string;ordered_quantity:number;received_quantity:number;remaining_quantity:number};
type ReceiptLine={id:string;receipt_id:string;invoice_line_id:string;quantity:number;location_id:string;
  ci_stock_lots:{lot_number:string;expiry_date:string}|{lot_number:string;expiry_date:string}[]|null};
const single=<T,>(value:T|T[]|null):T|null=>Array.isArray(value)?value[0]??null:value;
const dateText=(value:string)=>new Date(value+'T12:00:00Z').toLocaleDateString('th-TH',{timeZone:'Asia/Bangkok'});

export default async function InvoiceDetailPage({params}:{params:Promise<{id:string}>}){
  const {id}=await params;
  const access=await requireAccess();
  const client=await createClient();
  if(!client)notFound();
  const {data:invoiceData,error:invoiceError}=await client.from('ci_invoices')
    .select('id,invoice_number,invoice_date,po_number,vendor_id,status').eq('id',id).maybeSingle();
  if(invoiceError||!invoiceData)notFound();
  const invoice=invoiceData as Invoice;
  const [vendorResult,lineResult,attachmentResult]=await Promise.all([
    client.from('ci_vendors').select('name').eq('id',invoice.vendor_id).maybeSingle(),
    client.from('ci_invoice_line_progress')
      .select('invoice_line_id,product_id,ordered_quantity,received_quantity,remaining_quantity')
      .eq('invoice_id',id).limit(1000),
    client.from('ci_attachments').select('id,attachment_type,uploaded_at')
      .eq('invoice_id',id).order('uploaded_at',{ascending:false}).limit(100),
  ]);
  const lines=(lineResult.data??[]) as Progress[];
  const invoiceLineIds=lines.map(line=>line.invoice_line_id);
  const productIds=[...new Set(lines.map(line=>line.product_id))];
  const [productsResult,eventsResult]=await Promise.all([
    productIds.length?client.from('ci_products').select('id,product_code,display_name').in('id',productIds).limit(1000)
      :Promise.resolve({data:[],error:null}),
    loadReceiptEvents(client,{invoiceId:id,limit:200}),
  ]);
  const productNames=new Map((productsResult.data??[]).map(product=>[product.id,product]));
  const receiptIds=eventsResult.events.map(event=>event.id);
  const [receiptsResult,txReversals,locationsResult]=await Promise.all([
    receiptIds.length?client.from('ci_receipt_lines')
      .select('id,receipt_id,invoice_line_id,quantity,location_id,ci_stock_lots(lot_number,expiry_date)')
      .in('receipt_id',receiptIds).limit(1500)
      :Promise.resolve({data:[],error:null}),
    eventsResult.transactions.length?client.from('ci_stock_transactions')
      .select('source_transaction_id').eq('kind','reversal')
      .in('source_transaction_id',eventsResult.transactions.map(tx=>tx.id))
      :Promise.resolve({data:[],error:null}),
    client.from('ci_locations').select('id,code,name').limit(1000),
  ]);
  const reversedTx=new Set((txReversals.data??[]).map(row=>row.source_transaction_id));
  const reversedReceiptIds=new Set(eventsResult.transactions.filter(tx=>reversedTx.has(tx.id)).map(tx=>tx.receipt_id));
  const locMap=new Map((locationsResult.data??[]).map(location=>[location.id,location]));
  const productIdByLine=new Map(lines.map(line=>[line.invoice_line_id,line.product_id]));
  const received=(receiptsResult.data??[]) as unknown as ReceiptLine[];
  const receiptMap=new Map<string,ReceiptLine[]>();
  for(const row of received)receiptMap.set(row.receipt_id,[...(receiptMap.get(row.receipt_id)??[]),row]);
  const totalReceived=lines.reduce((sum,line)=>sum+Number(line.received_quantity||0),0);
  const errors=[lineResult.error,attachmentResult.error,productsResult.error,eventsResult.error,
    receiptsResult.error,txReversals.error,locationsResult.error].filter(Boolean);
  const hasReadPermission=access.warehouses.length>0;
  if(!hasReadPermission)notFound();
  return <main className="grid gap-5 min-w-0">
    <nav><Link href="/invoices" className="text-sm font-semibold text-brand">← ทะเบียน Invoice</Link></nav>
    <header className="surface p-4 sm:p-6 grid gap-3">
      <div className="flex flex-wrap justify-between items-start gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Invoice Detail</p>
          <h1 className="text-xl sm:text-2xl font-extrabold break-all">{invoice.invoice_number}</h1>
          <p className="muted text-sm mt-1">{vendorResult.data?.name??'ผู้ขาย'} · {dateText(invoice.invoice_date)}</p>
          {invoice.po_number&&<p className="muted text-sm mt-1">PO {invoice.po_number}</p>}
        </div>
        <span className="badge">{labels[invoice.status]??invoice.status}</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <div className="rounded-lg bg-surface-2 p-3"><strong className="text-xl tabular-nums block">{lines.length}</strong><span className="muted text-xs">รายการน้ำยา</span></div>
        <div className="rounded-lg bg-surface-2 p-3"><strong className="text-xl tabular-nums block">{totalReceived.toLocaleString('th-TH')}</strong><span className="muted text-xs">จำนวนที่รับจริง</span></div>
        <div className="rounded-lg bg-surface-2 p-3"><strong className="text-xl tabular-nums block">{eventsResult.events.length}</strong><span className="muted text-xs">เหตุการณ์รับเข้า</span></div>
      </div>
    </header>
    {errors.length>0&&<p role="alert" className="error">อ่านรายละเอียดบางส่วนไม่สำเร็จ: {logUserMessage('invoice-detail',errors[0])}</p>}
    <section className="surface p-4 sm:p-6 grid gap-3">
      <h2 className="text-lg font-bold">รายการน้ำยาใน Invoice</h2>
      <p className="muted text-xs">จำนวนรับจริงตามรายการที่ระบบบันทึก · Invoice เดิมที่มีการรับบางส่วนคงประวัติเดิมไว้</p>
      {lines.map(line=>{
        const product=productNames.get(line.product_id);
        return <article key={line.invoice_line_id} className="rounded-lg border border-line p-3 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Link href={`/products/${line.product_id}?tab=lots`} className="font-semibold text-brand">{product?.product_code??'น้ำยา'}</Link>
            <p className="muted text-sm break-words">{product?.display_name??'ข้อมูลทะเบียนไม่พร้อม'}</p>
          </div>
          <div className="text-right shrink-0"><strong className="text-xl tabular-nums">{Number(line.received_quantity).toLocaleString('th-TH')}</strong><p className="muted text-xs">รับจริง</p></div>
        </article>;
      })}
      {!lines.length&&<p className="muted text-sm">ยังไม่พบรายการน้ำยา</p>}
    </section>
    <section className="surface p-4 sm:p-6 grid gap-4">
      <h2 className="text-lg font-bold">รายละเอียด LOT ที่รับเข้า</h2>
      {eventsResult.events.map(event=>{
        const rows=receiptMap.get(event.id)??[];
        const reversed=reversedReceiptIds.has(event.id);
        return <article key={event.id} className="rounded-xl border border-line p-3 sm:p-4 grid gap-3">
          <div className="flex flex-wrap justify-between items-start gap-2">
            <div><h3 className="font-bold">ใบรับเข้า {event.event_number??'—'}</h3>
              <p className="muted text-xs">{new Date(event.received_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'})}</p></div>
            <span className="badge">{reversed?'ย้อนรายการแล้ว':'บันทึกรับเข้าแล้ว'}</span>
          </div>
          {rows.map(row=>{
            const productId=productIdByLine.get(row.invoice_line_id);
            const product=productId?productNames.get(productId):null;
            const lot=single(row.ci_stock_lots);
            const loc=locMap.get(row.location_id);
            return <div key={row.id} className="rounded-lg bg-surface-2 p-3 grid gap-2">
              <div className="flex justify-between gap-2 items-start">
                <div className="min-w-0">
                  <p className="font-semibold text-sm">{product?.product_code??'น้ำยา'} · {product?.display_name??'—'}</p>
                  <p className="text-sm break-all mt-1">LOT <strong>{lot?.lot_number??'—'}</strong></p>
                </div>
                <strong className="text-lg shrink-0 tabular-nums">{Number(row.quantity).toLocaleString('th-TH')}</strong>
              </div>
              <p className="muted text-xs">EXP {lot?.expiry_date??'—'} · ที่เก็บ {loc?.code??'—'}{loc?' · '+loc.name:''}</p>
            </div>;
          })}
          {!rows.length&&<p className="muted text-sm">ไม่มีรายการ LOT สำหรับใบรับเข้านี้</p>}
          <details className="border-t border-line pt-3">
            <summary className="cursor-pointer font-semibold text-brand text-sm min-h-9 flex items-center">ผลประเมินการรับเข้า</summary>
            <div className="pt-3"><ReceiptAssessmentCard eventNumber={event.event_number}
              invoiceNumber={invoice.invoice_number} receivedAt={event.received_at}
              assessment={event.assessment} revisions={event.revisions} canRevise={false}/></div>
          </details>
        </article>;
      })}
      {!eventsResult.events.length&&<p className="muted text-sm">ยังไม่มีเหตุการณ์รับเข้า</p>}
    </section>
    <InvoiceEvidenceManager invoiceId={invoice.id} warehouseId={null} canUpload={false}
      initialAttachments={attachmentResult.data??[]}/>
    <div className="flex flex-wrap gap-3">
      <Link className="button secondary" href={'/receive?invoice='+encodeURIComponent(invoice.id)}>เปิดหน้ารายละเอียดและประวัติเดิม</Link>
      <Link className="button secondary" href="/invoices">กลับทะเบียน Invoice</Link>
    </div>
    <p className="muted text-xs">หน้าอ่านข้อมูลย้อนหลัง ใช้สิทธิ์การมองเห็นตามฐานข้อมูลเดิม · ไม่สร้างรายการรับเข้าหรือปรับ Stock</p>
  </main>;
}
