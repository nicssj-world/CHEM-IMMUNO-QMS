import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { requireAccess, canMutate, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { ReceiveWorkbench } from '@/components/receive-workbench';
import { mostRecentReceivedLocations } from '@/lib/recent-receive-location';
import { NewInvoiceForm } from '@/components/new-invoice-form';
import { ConfirmForm } from '@/components/confirm-form';
import { SubmitButton } from '@/components/submit-button';
import { closeInvoiceShort } from '@/app/actions/vendors';
import { canManageVendors } from '@/lib/vendors';
import { logUserMessage, savedNotice } from '@/lib/messages';
import { label, invoiceStatusLabels } from '@/lib/labels';
import { VendorIssuePanel } from '@/components/vendor-issue-panel';
import { ReceiptAssessmentCard } from '@/components/receipt-assessment-card';
import { ReceiptEditForm } from '@/components/receipt-edit-form';
import { loadReceiptEvents } from '@/lib/receipt-events';
import { ISSUE_COLUMNS, type IssueAttachment, type VendorIssue } from '@/lib/vendor-issues';

type Product = { id: string; warehouse_id: number; product_code: string; display_name: string; default_location_id: string | null };
type Vendor = { id: string; name: string };
type Location = { id: string; warehouse_id: number; code: string; name: string; parent_code?: string | null };
type Invoice = { id: string; invoice_number: string; invoice_date: string; status: string; vendor_id: string; po_number: string | null };
type Line = { invoice_line_id: string; warehouse_id: number; product_id: string; ordered_quantity: number; received_quantity: number; remaining_quantity: number };
type ReceiptLineRow = { id: string; receipt_id: string; invoice_line_id: string; quantity: number; location_id: string; ci_stock_lots: { lot_number: string; expiry_date: string } | { lot_number: string; expiry_date: string }[] | null };

export default async function ReceivePage({ searchParams }: { searchParams: Promise<{ invoice?: string; error?: string; saved?: string; at?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const client = await createClient();
  const warehouseIds = access.warehouses.filter(w => canMutate(w.role)).map(w => Number(w.id));
  const [productsResult, vendorsResult, locationsResult, invoicesResult] = client ? await Promise.all([
    client.from('ci_products').select('id,warehouse_id,product_code,display_name,default_location_id').eq('active',true).in('warehouse_id',warehouseIds).order('product_code').limit(1000),
    client.from('ci_vendors').select('id,name').eq('active',true).order('name').limit(100),
    client.from('ci_locations').select('id,warehouse_id,code,name,parent_location_id').eq('active',true).in('warehouse_id',warehouseIds).order('code').limit(1000),
    client.from('ci_invoices').select('id,invoice_number,invoice_date,status,vendor_id,po_number').order('created_at',{ascending:false}).limit(30),
  ]) : [{data:[],error:null},{data:[],error:null},{data:[],error:null},{data:[],error:null}];
  const products = (productsResult.data ?? []) as Product[];
  const vendors = (vendorsResult.data ?? []) as Vendor[];
  const locationRows = (locationsResult.data ?? []) as (Location & { parent_location_id: string | null })[];
  const locationCodes = new Map(locationRows.map(l => [l.id,l.code]));
  const locations: Location[] = locationRows.map(l => ({ id: l.id, warehouse_id: l.warehouse_id, code: l.code, name: l.name, parent_code: l.parent_location_id ? locationCodes.get(l.parent_location_id) ?? null : null }));
  const invoices = (invoicesResult.data ?? []) as Invoice[];
  const invoice = params.invoice ? invoices.find(item => item.id === params.invoice) ?? (client ? (await client.from('ci_invoices').select('id,invoice_number,invoice_date,status,vendor_id,po_number').eq('id',params.invoice).maybeSingle()).data as Invoice | null : null) : null;
  const { data: lineData, error: lineError } = invoice && client ? await client.from('ci_invoice_line_progress').select('invoice_line_id,warehouse_id,product_id,ordered_quantity,received_quantity,remaining_quantity').eq('invoice_id',invoice.id).limit(1000) : {data:[],error:null};
  const lines = (lineData ?? []) as Line[];
  // History-based suggestion is optional: failures cannot block receiving or manufacture a Location.
  // All three reads are restricted by the existing per-warehouse RLS policies.
  let recentLocationByProduct: Record<string, string> = {};
  if (invoice && client && lines.length && warehouseIds.length) {
    const currentProducts = new Set(lines.map(line => line.product_id));
    const history = await client.from('ci_receipt_lines')
      .select('id,receipt_id,invoice_line_id,location_id,created_at,warehouse_id')
      .in('warehouse_id', warehouseIds).order('created_at', { ascending: false }).limit(500);
    if (!history.error && history.data?.length) {
      const historyLineIds = [...new Set(history.data.map(row => row.invoice_line_id))];
      const historyReceipts = [...new Set(history.data.map(row => row.receipt_id))];
      const [historicalInvoices, receivedTransactions] = await Promise.all([
        client.from('ci_invoice_lines').select('id,product_id').in('id', historyLineIds),
        client.from('ci_stock_transactions').select('id,receipt_id').eq('kind', 'receive').in('receipt_id', historyReceipts),
      ]);
      if (!historicalInvoices.error && !receivedTransactions.error) {
        const receiveIds = (receivedTransactions.data ?? []).map(row => row.id);
        const reversals = receiveIds.length
          ? await client.from('ci_stock_transactions').select('source_transaction_id').eq('kind', 'reversal').in('source_transaction_id', receiveIds)
          : { data: [], error: null };
        if (!reversals.error) {
          const reversedTx = new Set((reversals.data ?? []).map(row => row.source_transaction_id));
          const reversedReceipts = new Set((receivedTransactions.data ?? [])
            .filter(row => reversedTx.has(row.id)).map(row => row.receipt_id));
          recentLocationByProduct = mostRecentReceivedLocations(history.data, historicalInvoices.data ?? [], reversedReceipts, currentProducts);
        }
      }
    }
  }
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
  const { events: receiptEvents, error: receiptEventsError } = invoice && client
    ? await loadReceiptEvents(client, { invoiceId: invoice.id })
    : { events: [], error: null };
  const { data: receiptLineData, error: receiptLineError } = receiptEvents.length && client
    ? await client.from('ci_receipt_lines').select('id,receipt_id,invoice_line_id,quantity,location_id,ci_stock_lots(lot_number,expiry_date)').in('receipt_id',receiptEvents.map(event => event.id)).limit(1000)
    : { data: [], error: null };
  const receiptLinesByReceipt = new Map<string, { id: string; invoice_line_id: string; quantity: number; lot_number: string; expiry_date: string; location_id: string }[]>();
  for (const row of (receiptLineData ?? []) as unknown as ReceiptLineRow[]) {
    const lot = Array.isArray(row.ci_stock_lots) ? row.ci_stock_lots[0] : row.ci_stock_lots;
    if (!lot) continue;
    receiptLinesByReceipt.set(row.receipt_id, [...(receiptLinesByReceipt.get(row.receipt_id) ?? []), {
      id: row.id, invoice_line_id: row.invoice_line_id, quantity: Number(row.quantity), lot_number: lot.lot_number,
      expiry_date: lot.expiry_date, location_id: row.location_id,
    }]);
  }
  // Historical receipts must be readable even when a Product/Location is now inactive, and
  // for warehouse viewers who cannot use the receiving workbench. RLS still scopes each read.
  const historicalProductIds = [...new Set(lines.map(line => line.product_id))];
  const historicalLocationIds = [...new Set(((receiptLineData ?? []) as unknown as ReceiptLineRow[]).map(line => line.location_id))];
  const [historicalProductsResult, historicalLocationsResult] = client && invoice
    ? await Promise.all([
      historicalProductIds.length
        ? client.from('ci_products').select('id,product_code,display_name').in('id', historicalProductIds).limit(1000)
        : Promise.resolve({ data: [], error: null }),
      historicalLocationIds.length
        ? client.from('ci_locations').select('id,code,name').in('id', historicalLocationIds).limit(1000)
        : Promise.resolve({ data: [], error: null }),
    ])
    : [{ data: [], error: null }, { data: [], error: null }];
  const productNameById = new Map(
    [...products, ...(historicalProductsResult.data ?? [])].map(product => [product.id, { code: product.product_code, name: product.display_name }]),
  );
  const locationNameById = new Map(
    [...locations, ...(historicalLocationsResult.data ?? [])].map(location => [location.id, { code: location.code, name: location.name }]),
  );
  const productIdByInvoiceLine = new Map(lines.map(line => [line.invoice_line_id, line.product_id]));
  const { data: receiveTransactionData } = receiptEvents.length && client ? await client.from('ci_stock_transactions').select('id,receipt_id').eq('kind', 'receive').in('receipt_id', receiptEvents.map(event => event.id)) : { data: [] };
  const receiveTransactions = (receiveTransactionData ?? []) as { id: string; receipt_id: string }[];
  const { data: reversalData } = receiveTransactions.length && client ? await client.from('ci_stock_transactions').select('source_transaction_id').eq('kind', 'reversal').in('source_transaction_id', receiveTransactions.map(transaction => transaction.id)) : { data: [] };
  const reversedTransactionIds = new Set(((reversalData ?? []) as { source_transaction_id: string | null }[]).map(row => row.source_transaction_id).filter((id): id is string => Boolean(id)));
  const reversedReceiptIds = new Set(receiveTransactions.filter(transaction => reversedTransactionIds.has(transaction.id)).map(transaction => transaction.receipt_id));
  const { data: invoiceIssueData } = invoice && client ? await client.from('ci_vendor_issues').select(ISSUE_COLUMNS).eq('invoice_id', invoice.id).order('created_at', { ascending: false }).limit(100) : { data: [] };
  const invoiceIssues = (invoiceIssueData ?? []) as VendorIssue[];
  const { data: invoiceIssueFiles } = invoiceIssues.length && client ? await client.from('ci_vendor_issue_attachments').select('id,issue_id,file_name,size_bytes,uploaded_at').in('issue_id', invoiceIssues.map(i => i.id)) : { data: [] };
  const supervisesAny = access.warehouses.some(w => canSupervise(w.role));
  return (
    <main className="grid gap-6 max-w-[1100px]">
      <div><p className="eyebrow mb-2">Receiving</p><h1 className="page-title">รับน้ำยาเข้าคลัง</h1><p className="muted mt-2 text-sm">Invoice หนึ่งฉบับมีน้ำยาได้ทั้งสองคลัง · รับบางส่วนได้หลายครั้ง</p></div>
      {params.error && <p className="error" role="alert">{params.error}</p>}
      {params.saved && <p className="notice" role="status">{savedNotice(params.saved, 'บันทึกสำเร็จ')}</p>}
      {(lineError || attachmentError) && <p className="error" role="alert">อ่าน Invoice ไม่สำเร็จ: {logUserMessage('receive', lineError || attachmentError)}</p>}
      {invoice ? <section className="grid gap-5">
        <div className="surface p-5 flex flex-wrap justify-between items-center gap-3">
          <div><p className="eyebrow">Invoice {invoice.invoice_number}</p><h2 className="font-extrabold text-xl">ตรวจและรับน้ำยา</h2><p className="muted text-sm">{invoice.invoice_date} · {vendors.find(v => v.id === invoice.vendor_id)?.name ?? 'ผู้ขาย'}</p></div>
          <Link className="button secondary" href="/receive">กลับรายการ Invoice</Link>
        </div>
        {invoice.status === 'closed_short' && <p className="notice">Invoice นี้ปิดแบบรับไม่ครบแล้ว · ระบบบันทึกปัญหา “จำนวนส่งมอบไม่ครบ” ให้ผู้ขาย</p>}
        {canCloseShort && <details className="surface p-5">
          <summary className="cursor-pointer font-bold min-h-11 flex items-center">ผู้ขายส่งของไม่ครบและจะไม่ส่งเพิ่ม? ปิด Invoice แบบรับไม่ครบ</summary>
          <ConfirmForm action={closeInvoiceShort} message={'ยืนยันปิด Invoice ' + invoice.invoice_number + ' แบบรับไม่ครบ?\nรายการค้างรับ ' + outstanding.length + ' รายการจะไม่รับเพิ่ม และระบบจะบันทึกเป็นปัญหาผู้ขาย'} className="grid gap-3 mt-3">
            <input type="hidden" name="invoice_id" value={invoice.id}/>
            <p className="muted text-sm">ค้างรับ {outstanding.length} รายการ · ถ้าแก้ใบรับเข้าแล้วเกิดยอดค้าง ระบบจะเปิด Invoice ให้รับต่อได้</p>
            <label className="field">เหตุผล<textarea className="input min-h-20" name="reason" required maxLength={1000} placeholder="เช่น ผู้ขายแจ้งน้ำยาหมด ยกเลิกส่งส่วนที่เหลือ"/></label>
            <div><SubmitButton className="button danger" label="ปิด Invoice แบบรับไม่ครบ" pendingLabel="กำลังบันทึก…"/></div>
          </ConfirmForm>
        </details>}
        {invoice.status === 'open' && missingLocations.map(w => <p key={w.id} className="error" role="alert">{w.name} ยังไม่มีตำแหน่งจัดเก็บ จึงรับน้ำยาของคลังนี้ไม่ได้ · {canSupervise(w.role) ? <Link href={'/locations?warehouse=' + w.code + '&return=' + back('/receive?invoice=' + invoice.id)}>เพิ่มตำแหน่งก่อนเริ่มสแกน</Link> : 'แจ้งหัวหน้างานให้เพิ่มตำแหน่ง'}</p>)}
        {invoice.status === 'open' && warehouseIds.length ? <ReceiveWorkbench userId={access.userId} recentLocationByProduct={recentLocationByProduct} savedToken={params.saved ? params.at : undefined} invoiceId={invoice.id} idempotencyKey={randomUUID()} lines={lines} products={products} locations={locations} warehouseIds={[...new Set(lines.map(line => line.warehouse_id))].filter(id => warehouseIds.includes(id))} initialAttachments={attachmentData ?? []}/> : <>
          <p className="notice">Invoice นี้ปิดแล้ว หรือบัญชีนี้ไม่มีสิทธิ์รับเข้า</p>
          {attachmentData?.map(item => <a key={item.id} href={'/attachments/' + item.id} target="_blank" rel="noopener noreferrer" className="button secondary">ดูเอกสารรับเข้า {item.uploaded_at}</a>)}
        </>}
        {receiptEventsError && <p role="alert" className="error">ไม่สามารถโหลดประวัติใบรับเข้าได้: {logUserMessage('receipt-events', receiptEventsError)}</p>}
        {receiptEvents.length > 0 && <section className="surface p-5 sm:p-7 grid gap-4" aria-labelledby="invoice-receipts">
          <h2 id="invoice-receipts" className="font-bold text-lg">ใบรับเข้าและผลตรวจรับของ Invoice นี้</h2>
          {receiptLineError && <p role="alert" className="error">โหลดรายการน้ำยาในใบรับเข้าไม่สำเร็จ: {logUserMessage('receipt-lines', receiptLineError)}</p>}
          {historicalProductsResult.error && <p role="alert" className="error">อ่านชื่อ Product ของใบรับเข้าไม่สำเร็จ: {logUserMessage('receipt-products', historicalProductsResult.error)}</p>}
          {historicalLocationsResult.error && <p role="alert" className="error">อ่านชื่อตำแหน่งจัดเก็บของใบรับเข้าไม่สำเร็จ: {logUserMessage('receipt-locations', historicalLocationsResult.error)}</p>}
          {receiptEvents.map(event => {
            const canEdit = access.warehouses.some(warehouse => Number(warehouse.id) === Number(event.warehouse_id) && canSupervise(warehouse.role));
            const reversed = reversedReceiptIds.has(event.id);
            const received = receiptLinesByReceipt.get(event.id) ?? [];
            const receivedUnits = received.reduce((total, item) => total + item.quantity, 0);
            return <div key={event.id} className="grid gap-3">
              <div className="rounded-xl border border-line p-4 grid gap-3" aria-label={`รายการน้ำยาที่รับเข้า ${event.event_number ?? ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="font-bold">ใบรับเข้า {event.event_number ?? '—'}</h3>
                    <p className="muted text-sm">รับเข้าเมื่อ {new Date(event.received_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}</p>
                  </div>
                  <span className="badge">{reversed ? 'ย้อนรายการแล้ว' : 'บันทึกรับเข้าแล้ว'}</span>
                </div>
                {!receiptLineError && (received.length ? <>
                  <p className="text-sm font-semibold">รายการน้ำยาที่รับเข้า {received.length} รายการ · จำนวนรวม {receivedUnits.toLocaleString('th-TH')} หน่วย</p>
                  <div className="grid gap-2">
                    {received.map((item, index) => {
                      const product = productNameById.get(productIdByInvoiceLine.get(item.invoice_line_id) ?? '');
                      const location = locationNameById.get(item.location_id);
                      return <article key={item.id} className="rounded-lg border border-line p-3 grid gap-2">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <strong className="block break-words">{index + 1}. {product ? `${product.code} · ${product.name}` : 'Product ในใบรับเข้า'}</strong>
                          </div>
                          <span className="font-semibold whitespace-nowrap">จำนวน {item.quantity.toLocaleString('th-TH')}</span>
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm muted">
                          <span>LOT: {item.lot_number}</span>
                          <span>หมดอายุ: {item.expiry_date}</span>
                          <span>ตำแหน่ง: {location ? `${location.code} · ${location.name}` : 'ไม่พบชื่อตำแหน่ง'}</span>
                        </div>
                      </article>;
                    })}
                  </div>
                </> : <p className="muted text-sm">ไม่พบรายการน้ำยาสำหรับใบรับเข้านี้ หากคาดว่ามีข้อมูล โปรดแจ้งผู้ดูแลระบบตรวจสอบ</p>)}
              </div>
              {canEdit && !reversed && <ReceiptEditForm
                receiptId={event.id}
                warehouseId={Number(event.warehouse_id)}
                eventNumber={event.event_number}
                invoice={{ invoice_number: invoice.invoice_number, invoice_date: invoice.invoice_date, po_number: invoice.po_number }}
                lines={lines}
                receiptLines={receiptLinesByReceipt.get(event.id) ?? []}
                products={products}
                locations={locations}
                assessmentRow={event.assessment}
              />}
              {canEdit && reversed && <p className="notice">ใบรับเข้านี้ถูกย้อนรายการแล้ว จึงแก้ไขโดยตรงไม่ได้</p>}
              <ReceiptAssessmentCard eventNumber={event.event_number} invoiceNumber={invoice.invoice_number} receivedAt={event.received_at} assessment={event.assessment} revisions={event.revisions} canRevise={false}/>
            </div>;
          })}
        </section>}
        {invoiceIssues.length > 0 && <section className="surface p-5 sm:p-7 grid gap-4" aria-labelledby="invoice-issues">
          <h2 id="invoice-issues" className="font-bold text-lg">ปัญหาผู้ขายของ Invoice นี้</h2>
          <VendorIssuePanel issues={invoiceIssues} attachments={(invoiceIssueFiles ?? []) as IssueAttachment[]} vendorId={invoice.vendor_id} warehouseId={Number(invoiceIssues[0].warehouse_id)} invoices={[]} canOpen={false} canResolve={supervisesAny} canCancel={access.warehouses.some(w => w.role === 'admin')}/>
        </section>}
      </section> : <>
        {warehouseIds.length > 0 && <section className="surface p-5 sm:p-7">
          <h2 className="font-bold text-lg mb-2">สร้าง Invoice</h2>
          <p className="muted text-sm mb-5">ตรวจเลขที่ Invoice ก่อนสร้าง เพื่อป้องกันการสร้างซ้ำ · ถ้าเลขที่ซ้ำกับผู้ขายเดิม ระบบจะเปิด Invoice เดิม</p>
          {(canAddVendor || supervisedCodes.length > 0) && <p className="muted text-sm -mt-3 mb-5 flex flex-wrap gap-x-4 gap-y-1">{canAddVendor && <Link href={'/vendors/new?return=' + back('/receive')}>ไม่มีผู้ขายในรายการ? เพิ่มผู้ขาย</Link>}{supervisedCodes.length > 0 && <Link href={'/locations?warehouse=' + supervisedCodes[0] + '&return=' + back('/receive')}>จัดการตำแหน่งจัดเก็บ</Link>}</p>}
          <NewInvoiceForm vendors={vendors} products={products}/>
        </section>}
        <section className="surface p-5 sm:p-7">
          <h2 className="font-bold text-lg mb-3">Invoice ล่าสุด</h2>
          <div className="grid gap-2">{invoices.map(item => <Link href={'/receive?invoice=' + item.id} className="flex justify-between gap-3 rounded-xl border border-line p-3 no-underline text-[var(--ink)] min-h-12" key={item.id}><span><strong>{item.invoice_number}</strong><span className="muted text-xs block">{item.invoice_date} · {vendors.find(v => v.id === item.vendor_id)?.name ?? '—'}</span></span><span className="badge">{label(invoiceStatusLabels, item.status)}</span></Link>)}{!invoices.length && <p className="muted text-sm">ยังไม่มี Invoice</p>}</div>
        </section>
      </>}
    </main>
  );
}
