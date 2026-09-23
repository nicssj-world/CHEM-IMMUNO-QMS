import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { requireAccess, canMutate, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { createVendor, createLocation, createInvoice } from '@/app/actions/inventory';
import { ReceiveWorkbench } from '@/components/receive-workbench';

type Product = { id: string; warehouse_id: number; product_code: string; display_name: string };
type Vendor = { id: string; name: string };
type Location = { id: string; warehouse_id: number; code: string; name: string };
type Invoice = { id: string; invoice_number: string; invoice_date: string; status: string; vendor_id: string };
type Line = { invoice_line_id: string; warehouse_id: number; product_id: string; ordered_quantity: number; received_quantity: number; remaining_quantity: number };

export default async function ReceivePage({ searchParams }: { searchParams: Promise<{ invoice?: string; error?: string; saved?: string }> }) {
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
  const anySupervisor = access.warehouses.some(w => canSupervise(w.role));
  const anyAdmin = access.warehouses.some(w => w.role === 'admin');
  return <main className="grid gap-6 max-w-[1100px]"><div><p className="eyebrow mb-2">Receiving</p><h1 className="page-title">รับสินค้าเข้าคลัง</h1><p className="muted mt-2 text-sm">Invoice หนึ่งฉบับมีสินค้าได้ทั้งสองคลัง · รับบางส่วนได้หลายครั้ง</p></div>
    {params.error && <p className="error" role="alert">{params.error}</p>}{params.saved && <p className="notice" role="status">บันทึกการรับเข้าสำเร็จ</p>}{(lineError||attachmentError) && <p className="error" role="alert">อ่าน Invoice ไม่สำเร็จ: {(lineError||attachmentError)?.message}</p>}
    {invoice ? <section className="grid gap-5"><div className="surface p-5 flex flex-wrap justify-between items-center gap-3"><div><p className="eyebrow">Invoice {invoice.invoice_number}</p><h2 className="font-extrabold text-xl">ตรวจและรับสินค้า</h2><p className="muted text-sm">{invoice.invoice_date} · {vendors.find(v => v.id === invoice.vendor_id)?.name ?? 'ผู้ขาย'}</p></div><Link className="button secondary" href="/receive">กลับรายการ Invoice</Link></div>{invoice.status === 'open' && warehouseIds.length ? <ReceiveWorkbench invoiceId={invoice.id} idempotencyKey={randomUUID()} lines={lines} products={products} locations={locations} warehouseIds={[...new Set(lines.map(l=>l.warehouse_id))].filter(id=>warehouseIds.includes(id))} initialAttachments={attachmentData??[]}/> : <><p className="notice">Invoice นี้ปิดแล้ว หรือบัญชีนี้ไม่มีสิทธิ์รับเข้า</p>{attachmentData?.map(item=><a key={item.id} href={`/attachments/${item.id}`} target="_blank" rel="noopener noreferrer" className="button secondary">ดูเอกสารรับเข้า {item.uploaded_at}</a>)}</>}</section> : <>
      {warehouseIds.length > 0 && <section className="surface p-5 sm:p-7"><h2 className="font-bold text-lg mb-2">สร้าง Invoice</h2><p className="muted text-sm mb-5">ตรวจเลขที่ Invoice ด้านล่างก่อนสร้าง เพื่อป้องกันการสร้างซ้ำ</p><form action={createInvoice} className="grid gap-5"><div className="grid sm:grid-cols-2 gap-4"><label className="field">ผู้ขาย<select className="input" name="vendor_id" required defaultValue=""><option value="">เลือกผู้ขาย</option>{vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label><label className="field">เลขที่ Invoice<input className="input" name="invoice_number" required/></label><label className="field">วันที่ Invoice<input className="input" name="invoice_date" type="date" required/></label><label className="field">PO number (ถ้ามี)<input className="input" name="po_number"/></label></div><div className="grid gap-3"><h3 className="font-bold">รายการสินค้า</h3>{Array.from({length:5},(_,i) => <div className="grid sm:grid-cols-[1fr_170px] gap-3 rounded-xl bg-[#f4f8f8] p-3" key={i}><label className="field">สินค้า {i+1}<select className="input" name="product_id" defaultValue=""><option value="">เลือกสินค้า</option>{products.map(p => <option key={p.id} value={p.id}>{p.product_code} · {p.display_name}</option>)}</select></label><label className="field">จำนวน<input className="input" name="quantity" type="number" min="0.001" step="0.001"/></label></div>)}</div><button className="button" type="submit">สร้าง Invoice และเริ่มรับ</button></form></section>}
      <section className="surface p-5 sm:p-7"><h2 className="font-bold text-lg mb-3">Invoice ล่าสุด</h2><div className="grid gap-2">{invoices.map(item => <Link href={`/receive?invoice=${item.id}`} className="flex justify-between gap-3 rounded-xl border border-[#dce7eb] p-3 no-underline text-[var(--ink)] min-h-12" key={item.id}><span><strong>{item.invoice_number}</strong><span className="muted text-xs block">{item.invoice_date} · {vendors.find(v=>v.id===item.vendor_id)?.name ?? '—'}</span></span><span className="badge">{item.status}</span></Link>)}{!invoices.length && <p className="muted text-sm">ยังไม่มี Invoice</p>}</div></section></>}
    {(anySupervisor || anyAdmin) && <section className="surface p-5 sm:p-7"><h2 className="font-bold text-lg mb-3">ข้อมูลพื้นฐานการรับเข้า</h2><div className="grid sm:grid-cols-2 gap-6">{anyAdmin && <form action={createVendor} className="grid gap-3"><h3 className="font-bold">เพิ่มผู้ขาย</h3><label className="field">ชื่อผู้ขาย<input className="input" name="name" required/></label><button className="button secondary" type="submit">บันทึกผู้ขาย</button></form>}{anySupervisor && <form action={createLocation} className="grid gap-3"><h3 className="font-bold">เพิ่มตำแหน่ง</h3><label className="field">คลัง<select className="input" name="warehouse_id">{access.warehouses.filter(w=>canSupervise(w.role)).map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label><label className="field">รหัส<input className="input" name="code" required/></label><label className="field">ชื่อ<input className="input" name="name" required/></label><button className="button secondary" type="submit">บันทึกตำแหน่ง</button></form>}</div></section>}
  </main>;
}
