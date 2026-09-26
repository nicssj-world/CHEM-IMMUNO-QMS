'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { createClient } from '@supabase/supabase-js';
import { BarcodeScanner } from './barcode-scanner';
import { checkLotExpiryConflict, proposeScanMapping, registerInvoiceAttachment, removeInvoiceAttachment, resolveScan, type ScanResolution } from '@/app/actions/scanner';
import { confirmReceipt } from '@/app/actions/inventory';
import { takeReceiveDraft } from '@/lib/receive-draft';
import { userMessage } from '@/lib/messages';
import { SubmitButton } from './submit-button';
import { ReceiptAssessmentFields } from './receipt-assessment-fields';
import { DEFAULT_ASSESSMENT, assessmentError, type AssessmentInput } from '@/lib/receipt-assessment';

type Product = { id: string; warehouse_id: number; product_code: string; display_name: string };
type Location = { id: string; warehouse_id: number; code: string; name: string; parent_code?: string | null };
type Line = { invoice_line_id: string; warehouse_id: number; product_id: string; remaining_quantity: number; ordered_quantity: number; received_quantity: number };
type Package = { id: string; invoiceLineId: string; quantity: string; lot: string; expiry: string; locationId: string; raw?: string };
type Draft = Omit<Package, 'id'>;
type Attachment = { id: string; attachment_type: string; uploaded_at: string };

let invoiceStorageClient: ReturnType<typeof createClient> | undefined;

function getInvoiceStorageClient(url: string, key: string) {
  if (!invoiceStorageClient) {
    invoiceStorageClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return invoiceStorageClient;
}

export function ReceiveWorkbench({ invoiceId, idempotencyKey, lines, products, locations, warehouseIds, initialAttachments, savedToken }: { invoiceId: string; idempotencyKey: string; lines: Line[]; products: Product[]; locations: Location[]; warehouseIds: number[]; initialAttachments: Attachment[]; savedToken?: string }) {
  const [warehouseId, setWarehouseId] = useState(warehouseIds[0]);
  const [scan, setScan] = useState<ScanResolution | null>(null);
  const [draft, setDraft] = useState<Draft>({ invoiceLineId: '', quantity: '1', lot: '', expiry: '', locationId: '' });
  const [packages, setPackages] = useState<Package[]>([]);
  const [message, setMessage] = useState('');
  const [locationPath, setLocationPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [photoStatus, setPhotoStatus] = useState('ยังไม่มีภาพเอกสาร');
  const [attachments,setAttachments] = useState<Attachment[]>(initialAttachments);
  const lineById = useMemo(() => new Map(lines.map(l => [l.invoice_line_id, l])), [lines]);
  const productById = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  const currentLine = lineById.get(draft.invoiceLineId);
  const hydrated = useRef(false);
  const [assessment, setAssessment] = useState<AssessmentInput>(DEFAULT_ASSESSMENT);
  const [assessmentProblem, setAssessmentProblem] = useState('');
  // A successful receipt redirects back here with a new token; the packages it contained are now stock, so clear the draft.
  const [seenToken, setSeenToken] = useState(savedToken);
  if (savedToken !== seenToken) {
    setSeenToken(savedToken);
    if (savedToken) { setPackages([]); setAssessment(DEFAULT_ASSESSMENT); setAssessmentProblem(''); setMessage('บันทึกรับเข้าแล้ว · สแกนแพ็กเกจถัดไปได้'); }
  }

  // Lines scanned while creating the invoice arrive as ready-made packages; the user only picks locations.
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const scanned = takeReceiveDraft(invoiceId);
    if (!scanned.length) return;
    void (async () => {
      const accepted: Package[] = [];
      const skipped: string[] = [];
      const used = new Map<string, number>();
      for (const item of scanned) {
        const label = productById.get(item.productId)?.product_code ?? 'สินค้า';
        const line = lines.find(l => l.product_id === item.productId && warehouseIds.includes(l.warehouse_id));
        const quantity = Number(item.quantity);
        if (!line) { skipped.push(`${label}: ไม่พบใน Invoice หรือไม่มีสิทธิ์รับเข้า`); continue; }
        const total = (used.get(line.invoice_line_id) ?? 0) + quantity;
        if (!(quantity > 0) || total > Number(line.remaining_quantity)) { skipped.push(`${label}: จำนวนเกินยอดค้างรับ`); continue; }
        try {
          if (await checkLotExpiryConflict(item.productId, item.lot, item.expiry)) { skipped.push(`${label} LOT ${item.lot}: วันหมดอายุไม่ตรงกับที่บันทึกไว้`); continue; }
        } catch { skipped.push(`${label} LOT ${item.lot}: ตรวจ LOT ไม่สำเร็จ`); continue; }
        used.set(line.invoice_line_id, total);
        const options = locations.filter(l => l.warehouse_id === line.warehouse_id);
        accepted.push({ id: crypto.randomUUID(), invoiceLineId: line.invoice_line_id, quantity: item.quantity, lot: item.lot, expiry: item.expiry, locationId: options.length === 1 ? options[0].id : '', raw: item.raw });
      }
      setPackages(prev => [...prev, ...accepted]);
      setMessage(`นำเข้า ${accepted.length} แพ็กเกจจากที่สแกนไว้ · เลือกตำแหน่งแล้วบันทึกผลตรวจรับ${skipped.length ? ` · ข้าม ${skipped.length} รายการ: ${skipped.join(' / ')}` : ''}`);
    })();
  }, [invoiceId, lines, locations, productById, warehouseIds]);

  const candidateKind = scan?.parsed.gtin ? 'GTIN' : scan?.parsed.primary ? 'HIBC_PRIMARY' : scan?.parsed.additionalProductId ? 'GS1_AI240' : 'OTHER';
  const candidateValue = scan?.parsed.gtin ?? scan?.parsed.primary ?? scan?.parsed.additionalProductId ?? scan?.parsed.raw.trim() ?? '';

  async function onScan(raw: string, symbology: string) {
    setLocationPath(null);
    setMessage('กำลังตรวจ Barcode…');
    try {
      const result = await resolveScan(raw, symbology, warehouseId, invoiceId);
      if (result.locationQr) { setScan(null); setLocationPath(result.locationQr.path); setMessage(result.message ?? ''); return; }
      setScan(result);
      const lineId = result.invoiceLineId ?? '';
      setDraft({ invoiceLineId: lineId, quantity: '1', lot: result.parsed.warnings.length ? '' : result.parsed.lot ?? '', expiry: result.parsed.warnings.length ? '' : result.parsed.expiry ?? '', locationId: '', raw });
      setMessage(result.message ?? (result.parsed.warnings.length ? 'Barcode มีคำเตือน · ตรวจข้อมูลด้วยตนเอง' : 'พบสินค้า · LOT/วันหมดอายุมาจาก Barcode โปรดตรวจทาน'));
    } catch (error) { setMessage(userMessage(error instanceof Error ? error.message : null, 'อ่าน Barcode ไม่สำเร็จ')); }
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
    } catch (error) { setMessage(userMessage(error instanceof Error ? error.message : null, 'ตรวจ LOT ไม่สำเร็จ')); }
    finally { setBusy(false); }
  }

  async function propose() {
    const line = lineById.get(draft.invoiceLineId);
    if (!scan || !line || !candidateValue) { setMessage('เลือก Product ใน Invoice ก่อนเสนอการจับคู่'); return; }
    try { await proposeScanMapping(line.product_id,candidateKind,candidateValue,scan.parsed.raw); setMessage('ส่งข้อเสนอแล้ว · ต้องรอ Supervisor/Admin อนุมัติก่อนสแกนครั้งถัดไปจะจับคู่อัตโนมัติ'); }
    catch (error) { setMessage(userMessage(error instanceof Error ? error.message : null, 'เสนอ Barcode ไม่สำเร็จ')); }
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
      if (!url || !key) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อระบบจัดเก็บไฟล์');
      const client = getInvoiceStorageClient(url, key);
      const { error } = await client.storage.from('ci-invoice-evidence').uploadToSignedUrl(authorization.object_key,authorization.token,image,{ contentType: image.type });
      if (error) throw error;
      setPhotoStatus('อัปโหลดภาพเอกสารส่วนตัวสำเร็จ');
      setAttachments(prev=>[...prev,{id:authorization.attachment_id,attachment_type:'invoice_photo',uploaded_at:new Date().toISOString()}]);
      setImage(null);
    } catch (error) { setPhotoStatus(`อัปโหลดไม่สำเร็จ: ${userMessage(error instanceof Error ? error.message : null)}`); }
    finally { setBusy(false); }
  }

  async function removeImage(id:string) {
    setBusy(true);
    try { await removeInvoiceAttachment(id);setAttachments(prev=>prev.filter(item=>item.id!==id));chooseImage();setPhotoStatus('นำภาพออกแล้ว · เลือกภาพใหม่ได้'); }
    catch(error){setPhotoStatus(userMessage(error instanceof Error ? error.message : null, 'นำภาพออกไม่สำเร็จ'));}
    finally{setBusy(false);}
  }

  return <div className="grid gap-6">
    <section className="surface p-5 sm:p-7 grid gap-4"><h2 className="font-bold text-lg">ภาพ Invoice / เอกสารส่งของ</h2><p className="muted text-sm">เก็บใน Storage ส่วนตัว · จำกัด 10 MB · อนุญาตรูปภาพหรือ PDF</p><div className="grid sm:grid-cols-2 gap-3"><label className="field">ถ่ายภาพด้วยกล้อง<input className="input" type="file" accept="image/*" capture="environment" onChange={e => chooseImage(e.target.files?.[0])}/></label><label className="field">เลือกจากรูปภาพ/ไฟล์<input className="input" type="file" accept="image/*,application/pdf" onChange={e => chooseImage(e.target.files?.[0])}/></label></div>{imagePreview && <Image src={imagePreview} alt="ตัวอย่างเอกสารก่อนอัปโหลด" width={500} height={300} unoptimized className="max-h-64 max-w-full object-contain rounded-lg"/>}{attachments.length>0 && <div className="grid gap-2">{attachments.map(item=><div className="flex flex-wrap gap-2 items-center" key={item.id}><a className="button secondary" href={`/attachments/${item.id}`} target="_blank" rel="noopener noreferrer">ดูเอกสาร {item.uploaded_at}</a><button className="button danger" type="button" disabled={busy} onClick={() => void removeImage(item.id)}>ลบก่อนยืนยัน</button></div>)}<p className="muted text-xs">หากต้องการเปลี่ยนภาพ ให้ลบภาพที่อัปโหลดก่อน</p></div>}<p role="status" className="muted text-sm">{photoStatus}</p><div className="flex gap-2 flex-wrap"><button className="button" type="button" disabled={!image || busy || attachments.length>0} onClick={() => void uploadImage()}>บันทึกภาพ</button><button className="button secondary" type="button" disabled={!image} onClick={() => chooseImage()}>นำภาพที่เลือกออก</button></div></section>
    <section className="surface p-5 sm:p-7 grid gap-5"><div><h2 className="font-bold text-lg">สแกนสินค้าและจัดร่างรับเข้า</h2><p className="muted text-sm">หนึ่ง Invoice มีสินค้าได้ทั้งสองคลัง · การสแกนยังไม่เพิ่ม Stock</p></div><label className="field">คลังที่กำลังสแกน<select className="input" value={warehouseId} onChange={e => { setWarehouseId(Number(e.target.value)); setScan(null); }}>
      {warehouseIds.map(id => <option key={id} value={id}>{id === 1 ? 'CLINICAL CHEMISTRY' : id === 2 ? 'IMMUNOLOGY' : `คลัง ${id}`}</option>)}</select></label><BarcodeScanner onScan={onScan}/>
      {scan && <div className="notice grid gap-1 text-sm"><p><strong>Raw:</strong> <code className="break-all">{scan.parsed.raw}</code></p><p>{scan.productCode ?? 'ไม่พบสินค้า'} · {scan.parsed.standard} · {scan.parsed.symbology}</p><p>LOT: {scan.parsed.lot ?? 'ต้องกรอก'} · Expiry: {scan.parsed.expiry ?? 'ต้องกรอก'}</p>{scan.parsed.warnings.map((warning,i) => <p key={i} role="alert">⚠ {warning}</p>)}</div>}
      <p role="status" className="notice">{message || 'สแกนหรือเลือก Product ใน Invoice เพื่อเริ่มรับ'}</p>
      {locationPath && <a className="button secondary" href={locationPath}>เปิดตำแหน่งนี้</a>}
      <div className="grid sm:grid-cols-2 gap-3"><label className="field sm:col-span-2">Product ใน Invoice<select className="input" value={draft.invoiceLineId} onChange={e => setDraft({ ...draft, invoiceLineId: e.target.value, locationId: '' })}><option value="">เลือก Product</option>{lines.filter(l => l.warehouse_id === warehouseId && Number(l.remaining_quantity)>0).map(l => { const product=productById.get(l.product_id); return <option key={l.invoice_line_id} value={l.invoice_line_id}>{product?.product_code} · {product?.display_name} · ค้าง {l.remaining_quantity}</option>; })}</select></label><label className="field">LOT {scan?.parsed.lot && !scan.parsed.warnings.length ? '(จาก Barcode · ตรวจได้)' : ''}<input className="input" autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" value={draft.lot} onChange={e => setDraft({ ...draft, lot:e.target.value })}/></label><label className="field">หมดอายุ {scan?.parsed.expiry && !scan.parsed.warnings.length ? '(จาก Barcode · ตรวจได้)' : ''}<input className="input" type="date" value={draft.expiry} onChange={e => setDraft({ ...draft, expiry:e.target.value })}/></label><label className="field">จำนวนแพ็ก/หน่วยฐาน<input className="input" type="number" inputMode="decimal" min="0.001" step="0.001" value={draft.quantity} onChange={e => setDraft({ ...draft, quantity:e.target.value })}/></label><label className="field">ตำแหน่ง<select className="input" value={draft.locationId} onChange={e => setDraft({ ...draft, locationId:e.target.value })}><option value="">เลือกตำแหน่ง</option>{locations.filter(l => l.warehouse_id === currentLine?.warehouse_id).map(l => <option key={l.id} value={l.id}>{l.parent_code ? `${l.parent_code} › ` : ''}{l.code} · {l.name}</option>)}</select></label></div>
      {scan && !scan.invoiceLineId && <button className="button secondary" type="button" onClick={() => void propose()}>เสนอการจับคู่ Barcode กับ Product ที่เลือก</button>}
      <button className="button min-h-12" disabled={busy} type="button" onClick={() => void addPackage()}>เพิ่มแพ็กเกจในร่าง</button>
    </section>
    <form action={confirmReceipt} onSubmit={event => { const problem = assessmentError(assessment); setAssessmentProblem(problem ?? ''); if (problem) event.preventDefault(); }} className="surface p-5 sm:p-7 grid gap-5"><input type="hidden" name="invoice_id" value={invoiceId}/><input type="hidden" name="idempotency_key" value={idempotencyKey}/><h2 className="font-bold text-lg">ตรวจร่างและผลตรวจรับ</h2>
      <div className="grid gap-2">{packages.map((item,i) => { const line=lineById.get(item.invoiceLineId); const product=line && productById.get(line.product_id); return <article className="rounded-xl border border-line p-3" key={item.id}><input type="hidden" name="invoice_line_id" value={item.invoiceLineId}/><input type="hidden" name="quantity" value={item.quantity}/><input type="hidden" name="lot_number" value={item.lot}/><input type="hidden" name="expiry_date" value={item.expiry}/><input type="hidden" name="location_id" value={item.locationId}/><div className="flex justify-between gap-2"><strong>{i+1}. {product?.product_code} · {product?.display_name}</strong><button className="button secondary" type="button" onClick={() => setPackages(packages.filter(p => p.id!==item.id))}>ลบ</button></div><p className="muted text-sm">จำนวน {item.quantity} · LOT {item.lot} · หมดอายุ {item.expiry}</p><label className="field mt-2 max-w-sm">ตำแหน่ง<select className="input" value={item.locationId} onChange={e => setPackages(prev => prev.map(p => p.id === item.id ? { ...p, locationId: e.target.value } : p))}><option value="">เลือกตำแหน่ง</option>{locations.filter(l => l.warehouse_id === line?.warehouse_id).map(l => <option key={l.id} value={l.id}>{l.parent_code ? `${l.parent_code} › ` : ''}{l.code} · {l.name}</option>)}</select></label>{item.raw && <p className="muted text-xs break-all">Scan: {item.raw}</p>}</article>; })}{!packages.length && <p className="muted">ยังไม่มีแพ็กเกจในร่าง</p>}</div>
      <ReceiptAssessmentFields value={assessment} onChange={next => { setAssessment(next); if (assessmentProblem) setAssessmentProblem(assessmentError(next) ?? ''); }}/>
      {assessmentProblem && <p className="error" role="alert">{assessmentProblem}</p>}<p className="muted text-sm">ยืนยันแล้วจึงบันทึก Stock แบบ atomic ตามคลังของสินค้าแต่ละรายการ</p><SubmitButton label={`ยืนยันรับเข้า ${packages.length} แพ็กเกจ`} pendingLabel="กำลังบันทึกรับเข้า…" disabled={busy || !packages.length || packages.some(p => !p.locationId)}/>{packages.some(p => !p.locationId) && <p className="muted text-sm" role="status">เลือกตำแหน่งให้ครบทุกแพ็กเกจก่อนยืนยัน</p>}
    </form>
  </div>;
}
