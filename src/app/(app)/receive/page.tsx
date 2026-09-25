import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { requireAccess, canMutate, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { ReceiveWorkbench } from '@/components/receive-workbench';
import { NewInvoiceForm } from '@/components/new-invoice-form';
import { ConfirmForm } from '@/components/confirm-form';
import { SubmitButton } from '@/components/submit-button';
import { closeInvoiceShort } from '@/app/actions/vendors';
import { canManageVendors } from '@/lib/vendors';
import { logUserMessage, savedNotice } from '@/lib/messages';
import { label, invoiceStatusLabels } from '@/lib/labels';
import { VendorIssuePanel } from '@/components/vendor-issue-panel';
import { ReceiptAssessmentCard } from '@/components/receipt-assessment-card';
import { loadReceiptEvents } from '@/lib/receipt-events';
import { ISSUE_COLUMNS, type IssueAttachment, type VendorIssue } from '@/lib/vendor-issues';

type Product = { id: string; warehouse_id: number; product_code: string; display_name: string };
type Vendor = { id: string; name: string };
type Location = { id: string; warehouse_id: number; code: string; name: string };
type Invoice = { id: string; invoice_number: string; invoice_date: string; status: string; vendor_id: string };
type Line = { invoice_line_id: string; warehouse_id: number; product_id: string; ordered_quantity: number; received_quantity: number; remaining_quantity: number };

export default async function ReceivePage({ searchParams }: { searchParams: Promise<{ invoice?: string; error?: string; saved?: string; at?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const client = await createClient();
  const warehouseIds = access.warehouses.filter(w => canMutate(w.role)).map(w => Number(w.id));
  const [productsResult, vendorsResult, locationsResult, invoicesResult] = client ? await Promise.all([
    client.from('ci_products').select('id,warehouse_id,product_code,display_name').eq('active',true).in('warehouse_id',warehouseIds).order('product_code').limit(300),
    client.from('ci_vendors').select('id,name').eq('active',true).order('name').limit(100),
    client.from('ci_locations').select('id,warehouse_id,code,name').eq('active',true).in('warehouse_id',warehouseIds).order('code').limit(200),
    client.from('ci_invoices').select('id,invoice_number,invoice_date,status,vendor_id').order('created_at',{ascending:false}).limit(30),
  ]) : [{data:[],error:null},{data:[],error:null},{data:[],error:null},{data:[],error:null}];
  const products = (productsResult.data ?? []) as Product[];
  const vendors = (vendorsResult.data ?? []) as Vendor[];
  const locations = (locationsResult.data ?? []) as Location[];
  const invoices = (invoicesResult.data ?? []) as Invoice[];
  const invoice = params.invoice ? invoices.find(item => item.id === params.invoice) ?? (client ? (await client.from('ci_invoices').select('id,invoice_number,invoice_date,status,vendor_id').eq('id',params.invoice).maybeSingle()).data as Invoice | null : null) : null;
  const { data: lineData, error: lineError } = invoice && client ? await client.from('ci_invoice_line_progress').select('invoice_line_id,warehouse_id,product_id,ordered_quantity,received_quantity,remaining_quantity').eq('invoice_id',invoice.id).limit(100) : {data:[],error:null};
  const lines = (lineData ?? []) as Line[];
  const {data:attachmentData,error:attachmentError}=invoice&&client?await client.from('ci_attachments').select('id,attachment_type,uploaded_at').eq('invoice_id',invoice.id).order('uploaded_at',{ascending:false}).limit(20):{data:[],error:null};
  const canAddVendor = canManageVendors(access.warehouses);
  const outstanding = lines.filter(l => Number(l.remaining_quantity) > 0);
  const canCloseShort = Boolean(invoice && invoice.status === 'open' && outstanding.length && [...new Set(outstanding.map(l => Number(l.warehouse_id)))].every(id => access.warehouses.some(w => Number(w.id) === id && canSupervise(w.role))));
  const supervisedCodes = access.warehouses.filter(w => canSupervise(w.role)).map(w => w.code);
  // Warehouses on this invoice that have no storage location yet: packages cannot be put away until one exists.
  const invoiceWarehouses = [...new Set(lines.map(l => Number(l.warehouse_id)))];
  const missingLocations = access.warehouses.filter(w => invoiceWarehouses.includes(Number(w.id)) && !locations.some(l => Number(l.warehouse_id) === Number(w.id)));
  const back = (path: string) => encodeURIComponent(path);
  // Quality record for this invoice: receipt events with their assessments, and the vendor issues raised against it.
  const { events: receiptEvents } = invoice && client ? await loadReceiptEvents(client, { invoiceId: invoice.id }) : { events: [] };
  const { data: invoiceIssueData } = invoice && client ? await client.from('ci_vendor_issues').select(ISSUE_COLUMNS).eq('invoice_id', invoice.id).order('created_at', { ascending: false }).limit(100) : { data: [] };
  const invoiceIssues = (invoiceIssueData ?? []) as VendorIssue[];
  const { data: invoiceIssueFiles } = invoiceIssues.length && client ? await client.from('ci_vendor_issue_attachments').select('id,issue_id,file_name,size_bytes,uploaded_at').in('issue_id', invoiceIssues.map(i => i.id)) : { data: [] };
  const supervisesAny = access.warehouses.some(w => canSupervise(w.role));
  return <main className="grid gap-6 max-w-[1100px]"><div><p className="eyebrow mb-2">Receiving</p><h1 className="page-title">รับสินค้าเข้าคลัง</h1><p className="muted mt-2 text-sm">Invoice หนึ่งฉบับมีสินค้าได้ทั้งสองคลัง · รับบางส่วนได้หลายครั้ง</p></div>
    {params.error && <p className="error" role="alert">{params.error}</p>}{params.saved && <p className="notice" role="status">{savedNotice(params.saved,'บันทึกสำเร็จ')}</p>}{(lineError||attachmentError) && <p className="error" role="alert">อ่าน Invoice ไม่สำเร็จ: {logUserMessage('receive', lineError||attachmentError)}</p>}
    {invoice ? <section className="grid gap-5"><div className="surface p-5 flex flex-wrap justify-between items-center gap-3"><div><p className="eyebrow">Invoice {invoice.invoice_number}</p><h2 className="font-extrabold text-xl">ตรวจและรับสินค้า</h2><p className="muted text-sm">{invoice.invoice_date} · {vendors.find(v => v.id === invoice.vendor_id)?.name ?? 'ผู้ขาย'}</p></div><Link className="button secondary" href="/receive">กลับรายการ Invoice</Link></div>{invoice.status === 'closed_short' && <p className="notice">Invoice นี้ปิดแบบรับไม่ครบแล้ว · ระบบบันทึกปัญหา “จำนวนส่งมอบไม่ครบ” ให้ผู้ขาย</p>}{canCloseShort && <details className="surface p-5"><summary className="cursor-pointer font-bold min-h-11 flex items-center">ผู้ขายส่งของไม่ครบและจะไม่ส่งเพิ่ม? ปิด Invoice แบบรับไม่ครบ</summary><ConfirmForm action={closeInvoiceShort} message={`ยืนยันปิด Invoice ${invoice.invoice_number} แบบรับไม่ครบ?
รายการค้างรับ ${outstanding.length} รายการจะไม่รับเพิ่ม และระบบจะบันทึกเป็นปัญหาผู้ขาย`} className="grid gap-3 mt-3"><input type="hidden" name="invoice_id" value={invoice.id}/><p className="muted text-sm">ค้างรับ {outstanding.length} รายการ · หลังปิดจะรับเข้าเพิ่มไม่ได้ (ถ้าย้อนรายการรับ ระบบจะเปิด Invoice ใหม่)</p><label className="field">เหตุผล<textarea className="input min-h-20" name="reason" required maxLength={1000} placeholder="เช่น ผู้ขายแจ้งสินค้าหมด ยกเลิกส่งส่วนที่เหลือ"/></label><div><SubmitButton className="button danger" label="ปิด Invoice แบบรับไม่ครบ" pendingLabel="กำลังบันทึก…"/></div></ConfirmForm></details>}{invoice.status === 'open' && missingLocations.map(w => <p key={w.id} className="error" role="alert">{w.name} ยังไม่มีตำแหน่งจัดเก็บ จึงรับสินค้าของคลังนี้ไม่ได้ · {canSupervise(w.role) ? <Link href={`/locations?warehouse=${w.code}&return=${back(`/receive?invoice=${invoice.id}`)}`}>เพิ่มตำแหน่งก่อนเริ่มสแกน</Link> : 'แจ้งหัวหน้างานให้เพิ่มตำแหน่ง'}</p>)}{invoice.status === 'open' && warehouseIds.length ? <ReceiveWorkbench savedToken={params.saved ? params.at : undefined} invoiceId={invoice.id} idempotencyKey={randomUUID()} lines={lines} products={products} locations={locations} warehouseIds={[...new Set(lines.map(l=>l.warehouse_id))].filter(id=>warehouseIds.includes(id))} initialAttachments={attachmentData??[]}/> : <><p className="notice">Invoice นี้ปิดแล้ว หรือบัญชีนี้ไม่มีสิทธิ์รับเข้า</p>{attachmentData?.map(item=><a key={item.id} href={`/attachments/${item.id}`} target="_blank" rel="noopener noreferrer" className="button secondary">ดูเอกสารรับเข้า {item.uploaded_at}</a>)}</>}
      {receiptEvents.length > 0 && <section className="surface p-5 sm:p-7 grid gap-4" aria-labelledby="invoice-receipts"><h2 id="invoice-receipts" className="font-bold text-lg">ผลตรวจรับของ Invoice นี้</h2>{receiptEvents.map(e => <ReceiptAssessmentCard key={e.id} eventNumber={e.event_number} invoiceNumber={invoice.invoice_number} receivedAt={e.received_at} assessment={e.assessment} revisions={e.revisions} canRevise={access.warehouses.some(w => Number(w.id) === Number(e.warehouse_id) && canSupervise(w.role))} />)}</section>}
      {invoiceIssues.length > 0 && <section className="surface p-5 sm:p-7 grid gap-4" aria-labelledby="invoice-issues"><h2 id="invoice-issues" className="font-bold text-lg">ปัญหาผู้ขายของ Invoice นี้</h2><VendorIssuePanel issues={invoiceIssues} attachments={(invoiceIssueFiles ?? []) as IssueAttachment[]} vendorId={invoice.vendor_id} warehouseId={Number(invoiceIssues[0].warehouse_id)} invoices={[]} canOpen={false} canResolve={supervisesAny} canCancel={access.warehouses.some(w => w.role === 'admin')} /></section>}
    </section> : <>
      {warehouseIds.length > 0 && <section className="surface p-5 sm:p-7"><h2 className="font-bold text-lg mb-2">สร้าง Invoice</h2><p className="muted text-sm mb-5">ตรวจเลขที่ Invoice ก่อนสร้าง เพื่อป้องกันการสร้างซ้ำ · ถ้าเลขที่ซ้ำกับผู้ขายเดิม ระบบจะเปิด Invoice เดิม</p>{(canAddVendor || supervisedCodes.length > 0) && <p className="muted text-sm -mt-3 mb-5 flex flex-wrap gap-x-4 gap-y-1">{canAddVendor && <Link href={`/vendors/new?return=${back('/receive')}`}>ไม่มีผู้ขายในรายการ? เพิ่มผู้ขาย</Link>}{supervisedCodes.length > 0 && <Link href={`/locations?warehouse=${supervisedCodes[0]}&return=${back('/receive')}`}>จัดการตำแหน่งจัดเก็บ</Link>}</p>}<NewInvoiceForm vendors={vendors} products={products}/></section>}
      <section className="surface p-5 sm:p-7"><h2 className="font-bold text-lg mb-3">Invoice ล่าสุด</h2><div className="grid gap-2">{invoices.map(item => <Link href={`/receive?invoice=${item.id}`} className="flex justify-between gap-3 rounded-xl border border-line p-3 no-underline text-[var(--ink)] min-h-12" key={item.id}><span><strong>{item.invoice_number}</strong><span className="muted text-xs block">{item.invoice_date} · {vendors.find(v=>v.id===item.vendor_id)?.name ?? '—'}</span></span><span className="badge">{label(invoiceStatusLabels,item.status)}</span></Link>)}{!invoices.length && <p className="muted text-sm">ยังไม่มี Invoice</p>}</div></section></>}
  </main>;
}
