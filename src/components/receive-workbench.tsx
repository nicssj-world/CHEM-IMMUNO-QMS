'use client';

import { useMemo, useState } from 'react';
import Image from 'next/image';
import { createClient } from '@supabase/supabase-js';
import { BarcodeScanner } from './barcode-scanner';
import { checkLotExpiryConflict, proposeScanMapping, registerInvoiceAttachment, removeInvoiceAttachment, resolveScan, type ScanResolution } from '@/app/actions/scanner';
import { confirmReceipt } from '@/app/actions/inventory';

type Product = { id: string; warehouse_id: number; product_code: string; display_name: string };
type Location = { id: string; warehouse_id: number; code: string; name: string };
type Line = { invoice_line_id: string; warehouse_id: number; product_id: string; remaining_quantity: number; ordered_quantity: number; received_quantity: number };
type Package = { id: string; invoiceLineId: string; quantity: string; lot: string; expiry: string; locationId: string; raw?: string };
type Draft = Omit<Package, 'id'>;
type Attachment = { id: string; attachment_type: string; uploaded_at: string };

const yesNo = [{ value: '', label: 'เลือกผลตรวจ' }, { value: 'yes', label: 'ใช่ / ผ่าน' }, { value: 'no', label: 'ไม่ใช่ / พบปัญหา' }];

export function ReceiveWorkbench({ invoiceId, idempotencyKey, lines, products, locations, warehouseIds, initialAttachments }: { invoiceId: string; idempotencyKey: string; lines: Line[]; products: Product[]; locations: Location[]; warehouseIds: number[]; initialAttachments: Attachment[] }) {
  const [warehouseId, setWarehouseId] = useState(warehouseIds[0]);
  const [scan, setScan] = useState<ScanResolution | null>(null);
  const [draft, setDraft] = useState<Draft>({ invoiceLineId: '', quantity: '1', lot: '', expiry: '', locationId: '' });
  const [packages, setPackages] = useState<Package[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [photoStatus, setPhotoStatus] = useState('ยังไม่มีภาพเอกสาร');
  const [attachments,setAttachments] = useState<Attachment[]>(initialAttachments);
  const lineById = useMemo(() => new Map(lines.map(l => [l.invoice_line_id, l])), [lines]);
  const productById = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  const currentLine = lineById.get(draft.invoiceLineId);
  const candidateKind = scan?.parsed.gtin ? 'GTIN' : scan?.parsed.primary ? 'HIBC_PRIMARY' : scan?.parsed.additionalProductId ? 'GS1_AI240' : 'OTHER';
  const candidateValue = scan?.parsed.gtin ?? scan?.parsed.primary ?? scan?.parsed.additionalProductId ?? scan?.parsed.raw.trim() ?? '';

  async function onScan(raw: string, symbology: string) {
    setMessage('กำลังตรวจ Barcode…');
    try {
      const result = await resolveScan(raw, symbology, warehouseId, invoiceId);
      setScan(result);
      const lineId = result.invoiceLineId ?? '';
      setDraft({ invoiceLineId: lineId, quantity: '1', lot: result.parsed.warnings.length ? '' : result.parsed.lot ?? '', expiry: result.parsed.warnings.length ? '' : result.parsed.expiry ?? '', locationId: '', raw });
      setMessage(result.message ?? (result.parsed.warnings.length ? 'Barcode มีคำเตือน · ตรวจข้อมูลด้วยตนเอง' : 'พบสินค้า · LOT/วันหมดอายุมาจาก Barcode โปรดตรวจทาน'));
    } catch (error) { setMessage(error instanceof Error ? error.message : 'อ่าน Barcode ไม่สำเร็จ'); }
  }

  async function addPackage() {
    const line = lineById.get(draft.invoiceLineId);
    if (!line || !draft.lot.trim() || !draft.expiry || !draft.locationId || Number(draft.quantity) <= 0) { setMessage('กรุณาเลือก Product, LOT, วันหมดอายุ, จำนวน และตำแหน่ง'); return; }
    const already = packages.filter(p => p.invoiceLineId === line.invoice_line_id).reduce((sum,p) => sum + Number(p.quantity),0);
    if (already + Number(draft.quantity) > Number(line.remaining_quantity)) { setMessage('จำนวนรวมเกินยอดค้างรับ'); return; }
    setBusy(true);
    try {
      if (await checkLotExpiryConflict(line.product_id,draft.lot,draft.expiry)) { setMessage('LOT นี้มีวันหมดอายุไม่ตรงกับที่บันทึกไว้ · พักรายการเพื่อตรวจสอบ'); return; }
      setPackages(prev => [...prev, { ...draft, id: crypto.randomUUID() }]);
      setScan(null);
      setDraft({ invoiceLineId: '', quantity: '1', lot: '', expiry: '', locationId: '' });
      setMessage('เพิ่มแพ็กเกจในร่างแล้ว · สแกนอีกครั้งได้ทันที');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'ตรวจ LOT ไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  async function propose() {
    const line = lineById.get(draft.invoiceLineId);
    if (!scan || !line || !candidateValue) { setMessage('เลือก Product ใน Invoice ก่อนเสนอการจับคู่'); return; }
    try { await proposeScanMapping(line.product_id,candidateKind,candidateValue,scan.parsed.raw); setMessage('ส่งข้อเสนอแล้ว · ต้องรอ Supervisor/Admin อนุมัติก่อนสแกนครั้งถัดไปจะจับคู่อัตโนมัติ'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'เสนอ Barcode ไม่สำเร็จ'); }
  }

  function chooseImage(file?: File) {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImage(file ?? null);
    setImagePreview(file?.type.startsWith('image/') ? URL.createObjectURL(file) : null);
    setPhotoStatus(file ? `${file.name} · ${(file.size/1024/1024).toFixed(2)} MB` : 'ยังไม่มีภาพเอกสาร');
  }

  async function uploadImage() {
    if (!image) return;
    setBusy(true);
    try {
      const authorization = await registerInvoiceAttachment(invoiceId,warehouseId,{ type: image.type, size: image.size });
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      if (!url || !key) throw new Error('Supabase public configuration missing');
      const client = createClient(url,key);
      const { error } = await client.storage.from('ci-invoice-evidence').uploadToSignedUrl(authorization.object_key,authorization.token,image,{ contentType: image.type });
      if (error) throw error;
      setPhotoStatus('อัปโหลดภาพเอกสารส่วนตัวสำเร็จ');
      setAttachments(prev=>[...prev,{id:authorization.attachment_id,attachment_type:'invoice_photo',uploaded_at:new Date().toISOString()}]);
      setImage(null);
    } catch (error) { setPhotoStatus(error instanceof Error ? `อัปโหลดไม่สำเร็จ: ${error.message}` : 'อัปโหลดไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  async function removeImage(id:string) {
    setBusy(true);
    try { await removeInvoiceAttachment(id);setAttachments(prev=>prev.filter(item=>item.id!==id));chooseImage();setPhotoStatus('นำภาพออกแล้ว · เลือกภาพใหม่ได้'); }
    catch(error){setPhotoStatus(error instanceof Error ? error.message : 'นำภาพออกไม่สำเร็จ');}
    finally{setBusy(false);}
  }

  return <div className="grid gap-6">
    <section className="surface p-5 sm:p-7 grid gap-4"><h2 className="font-bold text-lg">ภาพ Invoice / เอกสารส่งของ</h2><p className="muted text-sm">เก็บใน Storage ส่วนตัว · จำกัด 10 MB · อนุญาตรูปภาพหรือ PDF</p><div className="grid sm:grid-cols-2 gap-3"><label className="field">ถ่ายภาพด้วยกล้อง<input className="input" type="file" accept="image/*" capture="environment" onChange={e => chooseImage(e.target.files?.[0])}/></label><label className="field">เลือกจากรูปภาพ/ไฟล์<input className="input" type="file" accept="image/*,application/pdf" onChange={e => chooseImage(e.target.files?.[0])}/></label></div>{imagePreview && <Image src={imagePreview} alt="ตัวอย่างเอกสารก่อนอัปโหลด" width={500} height={300} unoptimized className="max-h-64 max-w-full object-contain rounded-lg"/>}<p role="status" className="muted text-sm">{photoStatus}</p>{attachments.length>0 && <div className="grid gap-2">{attachments.map(item=><div className="flex flex-wrap gap-2 items-center" key={item.id}><a className="button secondary" href={`/attachments/${item.id}`} target="_blank" rel="noopener noreferrer">ดูเอกสาร {item.uploaded_at}</a><button className="button danger" type="button" disabled={busy} onClick={() => void removeImage(item.id)}>ลบก่อนยืนยัน</button></div>)}<p className="muted text-xs">หากต้องการเปลี่ยนภาพ ให้ลบภาพที่อัปโหลดก่อน</p></div>}<p role="status" className="muted text-sm">{photoStatus}</p><div className="flex gap-2 flex-wrap"><button className="button" type="button" disabled={!image || busy || attachments.length>0} onClick={() => void uploadImage()}>บันทึกภาพ</button><button className="button secondary" type="button" disabled={!image} onClick={() => chooseImage()}>นำภาพที่เลือกออก</button></div></section>
    <section className="surface p-5 sm:p-7 grid gap-5"><div><h2 className="font-bold text-lg">สแกนสินค้าและจัดร่างรับเข้า</h2><p className="muted text-sm">หนึ่ง Invoice มีสินค้าได้ทั้งสองคลัง · การสแกนยังไม่เพิ่ม Stock</p></div><label className="field">คลังที่กำลังสแกน<select className="input" value={warehouseId} onChange={e => { setWarehouseId(Number(e.target.value)); setScan(null); }}>
      {warehouseIds.map(id => <option key={id} value={id}>{id === 1 ? 'CLINICAL CHEMISTRY' : 'IMMUNOLOGY'}</option>)}</select></label><BarcodeScanner onScan={onScan}/>
      {scan && <div className="notice grid gap-1 text-sm"><p><strong>Raw:</strong> <code className="break-all">{scan.parsed.raw}</code></p><p>{scan.productCode ?? 'ไม่พบสินค้า'} · {scan.parsed.standard} · {scan.parsed.symbology}</p><p>LOT: {scan.parsed.lot ?? 'ต้องกรอก'} · Expiry: {scan.parsed.expiry ?? 'ต้องกรอก'}</p>{scan.parsed.warnings.map((warning,i) => <p key={i} role="alert">⚠ {warning}</p>)}</div>}
      <p role="status" className="notice">{message || 'สแกนหรือเลือก Product ใน Invoice เพื่อเริ่มรับ'}</p>
      <div className="grid sm:grid-cols-2 gap-3"><label className="field sm:col-span-2">Product ใน Invoice<select className="input" value={draft.invoiceLineId} onChange={e => setDraft({ ...draft, invoiceLineId: e.target.value, locationId: '' })}><option value="">เลือก Product</option>{lines.filter(l => l.warehouse_id === warehouseId && Number(l.remaining_quantity)>0).map(l => { const product=productById.get(l.product_id); return <option key={l.invoice_line_id} value={l.invoice_line_id}>{product?.product_code} · {product?.display_name} · ค้าง {l.remaining_quantity}</option>; })}</select></label><label className="field">LOT {scan?.parsed.lot && !scan.parsed.warnings.length ? '(จาก Barcode · ตรวจได้)' : ''}<input className="input" value={draft.lot} onChange={e => setDraft({ ...draft, lot:e.target.value })}/></label><label className="field">หมดอายุ {scan?.parsed.expiry && !scan.parsed.warnings.length ? '(จาก Barcode · ตรวจได้)' : ''}<input className="input" type="date" value={draft.expiry} onChange={e => setDraft({ ...draft, expiry:e.target.value })}/></label><label className="field">จำนวนแพ็ก/หน่วยฐาน<input className="input" type="number" min="0.001" step="0.001" value={draft.quantity} onChange={e => setDraft({ ...draft, quantity:e.target.value })}/></label><label className="field">ตำแหน่ง<select className="input" value={draft.locationId} onChange={e => setDraft({ ...draft, locationId:e.target.value })}><option value="">เลือกตำแหน่ง</option>{locations.filter(l => l.warehouse_id === currentLine?.warehouse_id).map(l => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}</select></label></div>
      {scan && !scan.invoiceLineId && <button className="button secondary" type="button" onClick={() => void propose()}>เสนอการจับคู่ Barcode กับ Product ที่เลือก</button>}
      <button className="button min-h-12" disabled={busy} type="button" onClick={() => void addPackage()}>เพิ่มแพ็กเกจในร่าง</button>
    </section>
    <form action={confirmReceipt} onSubmit={() => setBusy(true)} className="surface p-5 sm:p-7 grid gap-5"><input type="hidden" name="invoice_id" value={invoiceId}/><input type="hidden" name="idempotency_key" value={idempotencyKey}/><h2 className="font-bold text-lg">ตรวจร่างและผลตรวจรับ</h2>
      <div className="grid gap-2">{packages.map((item,i) => { const line=lineById.get(item.invoiceLineId); const product=line && productById.get(line.product_id); return <article className="rounded-xl border border-[#dce7eb] p-3" key={item.id}><input type="hidden" name="invoice_line_id" value={item.invoiceLineId}/><input type="hidden" name="quantity" value={item.quantity}/><input type="hidden" name="lot_number" value={item.lot}/><input type="hidden" name="expiry_date" value={item.expiry}/><input type="hidden" name="location_id" value={item.locationId}/><div className="flex justify-between gap-2"><strong>{i+1}. {product?.product_code} · {product?.display_name}</strong><button className="button secondary" type="button" onClick={() => setPackages(packages.filter(p => p.id!==item.id))}>ลบ</button></div><p className="muted text-sm">จำนวน {item.quantity} · LOT {item.lot} · หมดอายุ {item.expiry}</p>{item.raw && <p className="muted text-xs break-all">Scan: {item.raw}</p>}</article>; })}{!packages.length && <p className="muted">ยังไม่มีแพ็กเกจในร่าง</p>}</div>
      <div className="grid sm:grid-cols-2 gap-3">{([['correct_product','สินค้า/รายการถูกต้อง'],['correct_quantity','จำนวนถูกต้อง'],['packaging_ok','สภาพบรรจุภัณฑ์ดี'],['temperature_required','ต้องควบคุมอุณหภูมิ'],['temperature_ok','ผลอุณหภูมิเหมาะสม'],['shelf_life_ok','อายุคงเหลือเพียงพอ'],['documentation_complete','เอกสารครบถ้วน'],['delivery_discrepancy','พบความคลาดเคลื่อน']] as const).map(([key,label]) => <label className="field" key={key}>{label}<select className="input" name={key} required={['correct_product','correct_quantity','packaging_ok','temperature_required','shelf_life_ok','documentation_complete','delivery_discrepancy'].includes(key)} defaultValue="">{yesNo.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}</div>
      <label className="field">บันทึกผลตรวจ / ความคลาดเคลื่อน<textarea className="input min-h-24" name="assessment_notes"/></label><p className="muted text-sm">ยืนยันแล้วจึงบันทึก Stock แบบ atomic ตามคลังของสินค้าแต่ละรายการ</p><button className="button min-h-12" disabled={busy || !packages.length} type="submit">ยืนยันรับเข้า {packages.length} แพ็กเกจ</button>
    </form>
  </div>;
}
