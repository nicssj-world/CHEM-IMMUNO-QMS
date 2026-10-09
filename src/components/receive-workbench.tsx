'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { createClient } from '@supabase/supabase-js';
import { BarcodeScanner, type ScanFeedback } from './barcode-scanner';
import { ReceiptPackageReview } from './receipt-package-review';
import { checkLotExpiryConflict, proposeScanMapping, registerInvoiceAttachment, removeInvoiceAttachment, resolveScan, type ScanResolution } from '@/app/actions/scanner';
import { confirmReceipt } from '@/app/actions/inventory';
import { clearReceiveDraft, readReceiveDraft } from '@/lib/receive-draft';
import { userMessage } from '@/lib/messages';
import { IntegerQuantityInput } from './integer-quantity-input';
import { SubmitButton } from './submit-button';
import { ReceiptAssessmentFields } from './receipt-assessment-fields';
import { DEFAULT_ASSESSMENT, assessmentError, type AssessmentInput } from '@/lib/receipt-assessment';
import { preselectLocation } from '@/lib/receive-location';
import { appendReceiptPackage, validateReceiptPackages, type ReceiptPackage } from '@/lib/receipt-workbench';
import { clearWorkbenchDraft, readWorkbenchDraft, saveWorkbenchDraft } from '@/lib/receive-workbench-draft';
import { scanBatchFields } from '@/lib/barcode';

type Product = { id: string; warehouse_id: number; product_code: string; display_name: string; default_location_id: string | null };
type Location = { id: string; warehouse_id: number; code: string; name: string; parent_code?: string | null };
type Line = { invoice_line_id: string; warehouse_id: number; product_id: string; remaining_quantity: number; ordered_quantity: number; received_quantity: number };
type Package = ReceiptPackage;
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

export function ReceiveWorkbench({ invoiceId, userId, idempotencyKey, lines, products, locations, warehouseIds, initialAttachments, savedToken, recentLocationByProduct = {} }: { invoiceId: string; userId: string; idempotencyKey: string; lines: Line[]; products: Product[]; locations: Location[]; warehouseIds: number[]; initialAttachments: Attachment[]; savedToken?: string; recentLocationByProduct?: Record<string, string> }) {
  const [warehouseId, setWarehouseId] = useState(warehouseIds[0]);
  const [scan, setScan] = useState<ScanResolution | null>(null);
  const [showScanDetails, setShowScanDetails] = useState(false);
  const [draft, setDraft] = useState<Draft>({ invoiceLineId: '', quantity: '1', lot: '', expiry: '', locationId: '' });
  const [packages, setPackages] = useState<Package[]>([]);
  const packagesRef = useRef<Package[]>([]);
  const setPack = (next: Package[]) => { packagesRef.current = next; setPackages(next); };
  const [draftKey, setDraftKey] = useState(idempotencyKey);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftStorageWarning, setDraftStorageWarning] = useState(false);
  const [sessionLocationByWarehouse, setSessionLocationByWarehouse] = useState<Record<number,string>>({});
  const [scanFeedback, setScanFeedback] = useState<ScanFeedback | null>(null);
  const scanFeedbackId = useRef(0);
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
  const scanReady = Boolean(scan?.invoiceLineId && draft.lot && draft.expiry && draft.locationId && !scanBatchFields(scan.parsed).requiresReview);
  const hydrated = useRef(false);
  const [assessment, setAssessment] = useState<AssessmentInput>(DEFAULT_ASSESSMENT);
  const [assessmentProblem, setAssessmentProblem] = useState('');

  // After a confirmed receipt the new URL token means its packages are already stock.
  useEffect(() => {
    if (!savedToken) return;
    clearReceiveDraft(invoiceId);
    clearWorkbenchDraft(invoiceId,userId);
    setPack([]);
    setDraftKey(crypto.randomUUID());
    setAssessment(DEFAULT_ASSESSMENT);
    setAssessmentProblem('');
    setMessage('บันทึกรับเข้าแล้ว · สแกนแพ็กเกจถัดไปได้');
  },[savedToken,invoiceId,userId]);

  // Restore local unconfirmed packages (user + invoice scoped) before falling back
  // to the original per-tab handoff from New Invoice.
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    if (savedToken) { clearReceiveDraft(invoiceId); clearWorkbenchDraft(invoiceId,userId); setDraftRestored(true); return; }
    const stored = readWorkbenchDraft(invoiceId,userId);
    if (stored?.packages.length) {
      const accepted: Package[] = [];
      let dropped = 0;
      for (const item of stored.packages) {
        const line = lines.find(l => l.invoice_line_id === item.invoiceLineId && warehouseIds.includes(l.warehouse_id));
        const validLocation = locations.some(l => l.id === item.locationId && l.warehouse_id === line?.warehouse_id);
        if (!line || (item.locationId && !validLocation)) { dropped++; continue; }
        // A draft without a location must survive a page reload so staff can
        // finish it after the storage master has been configured.
        if (!item.locationId) {
          const used = accepted.filter(p => p.invoiceLineId===line.invoice_line_id).reduce((n,p)=>n+Number(p.quantity),0);
          const n = Number(item.quantity);
          if (!item.lot.trim() || !item.expiry || !Number.isSafeInteger(n) || n<1 || used+n>Number(line.remaining_quantity)) { dropped++;continue; }
          accepted.push(item);
          continue;
        }
        const result = appendReceiptPackage(accepted,item,lines);
        if (result.ok) accepted.splice(0,accepted.length,...result.packages);
        else dropped++;
      }
      setDraftKey(stored.idempotencyKey);
      setPack(accepted);
      setMessage(accepted.length
        ? `กู้คืนร่างรับเข้า ${accepted.length} LOT/ตำแหน่งจากอุปกรณ์นี้แล้ว${dropped ? ` · ข้าม ${dropped} รายการที่ใช้ต่อไม่ได้` : ''}`
        : 'ร่างเดิมไม่ตรงกับยอดค้างรับหรือรายการตำแหน่งปัจจุบัน');
      clearReceiveDraft(invoiceId);
      setDraftRestored(true);
      return;
    }
    const scanned = readReceiveDraft(invoiceId);
    if (!scanned.length) { setDraftRestored(true); return; }
    void (async () => {
      const accepted: Package[] = [];
      const skipped: string[] = [];
      for (const item of scanned) {
        const line = lines.find(l => l.product_id === item.productId && warehouseIds.includes(l.warehouse_id));
        const label = productById.get(item.productId)?.product_code ?? 'น้ำยา';
        if (!line) { skipped.push(`${label}: ไม่พบใน Invoice`); continue; }
        try {
          if (await checkLotExpiryConflict(item.productId,item.lot,item.expiry)) { skipped.push(`${label}: LOT/วันหมดอายุขัดแย้ง`); continue; }
        } catch { skipped.push(`${label}: ตรวจสอบ LOT ไม่สำเร็จ`); continue; }
        const locationId = preselectLocation(productById.get(item.productId)?.default_location_id,line.warehouse_id,locations,recentLocationByProduct[item.productId]);
        const candidate: Package = { id: crypto.randomUUID(),invoiceLineId:line.invoice_line_id,quantity:item.quantity,lot:item.lot,expiry:item.expiry,locationId,raw:item.raw };
        // Missing location is kept as an unconfirmed draft, never sent to stock.
        if (!locationId) {
          const used=accepted.filter(x=>x.invoiceLineId===line.invoice_line_id).reduce((n,x)=>n+Number(x.quantity),0);
          if (used + Number(item.quantity) > Number(line.remaining_quantity)) {skipped.push(`${label}: จำนวนเกินยอดค้างรับ`);continue;}
          accepted.push(candidate);
          continue;
        }
        const result = appendReceiptPackage(accepted,candidate,lines);
        if (!result.ok) { skipped.push(`${label}: LOT หรือจำนวนไม่ถูกต้อง`); continue; }
        accepted.splice(0,accepted.length,...result.packages);
      }
      setPack(accepted);
      setMessage(`นำเข้า ${accepted.length} LOT/ตำแหน่งจากที่สแกนไว้ · ตรวจตำแหน่งก่อนยืนยัน${skipped.length ? ` · ข้าม ${skipped.length} รายการ: ${skipped.join(' / ')}` : ''}`);
      setDraftRestored(true);
    })();
  }, [invoiceId,userId,lines,locations,productById,warehouseIds,savedToken,recentLocationByProduct]);

  useEffect(() => {
    if (!draftRestored) return;
    if (!saveWorkbenchDraft(invoiceId,userId,packages,draftKey) && packages.length) setDraftStorageWarning(true);
    else setDraftStorageWarning(false);
  },[draftRestored,invoiceId,userId,packages,draftKey]);

  const packageError = validateReceiptPackages(packages,lines);
  const totalUnits = packages.reduce((sum,item)=>sum+(Number(item.quantity)||0),0);
  function suggestedLocation(productId: string, warehouse: number): string {
    const latest = [...packagesRef.current].reverse().find(item => lineById.get(item.invoiceLineId)?.product_id===productId);
    const session = sessionLocationByWarehouse[warehouse];
    if (session && locations.some(location => location.id===session && location.warehouse_id===warehouse)) return session;
    return preselectLocation(productById.get(productId)?.default_location_id,warehouse,locations,latest?.locationId ?? recentLocationByProduct[productId]);
  }
  function showAddLot(lineId: string) {
    const line = lineById.get(lineId);
    if (!line) return;
    setWarehouseId(line.warehouse_id);
    setScan(null);
    setShowScanDetails(true);
    setDraft({invoiceLineId:lineId,lot:'',expiry:'',quantity:'1',locationId:suggestedLocation(line.product_id,line.warehouse_id)});
    document.getElementById('ci-receive-entry')?.scrollIntoView({behavior:'smooth',block:'start'});
  }

  const candidateKind = scan?.parsed.gtin ? 'GTIN' : scan?.parsed.primary ? 'HIBC_PRIMARY' : scan?.parsed.additionalProductId ? 'GS1_AI240' : 'OTHER';
  const candidateValue = scan?.parsed.gtin ?? scan?.parsed.primary ?? scan?.parsed.additionalProductId ?? scan?.parsed.raw.trim() ?? '';

  const scanNotice = (tone: ScanFeedback['tone'], title: string, detail: string) =>
    setScanFeedback({ id: ++scanFeedbackId.current, tone, title, detail });

  async function onScan(raw: string, symbology: string) {
    if (!draftRestored || busy) return;
    setLocationPath(null);
    setShowScanDetails(false);
    setMessage('กำลังตรวจ Barcode…');
    try {
      const result = await resolveScan(raw,symbology,warehouseId,invoiceId);
      if (result.locationQr) { setScan(null);setLocationPath(result.locationQr.path);setMessage(result.message ?? '');return; }
      setScan(result);
      const lineId = result.invoiceLineId ?? '';
      const line = lineById.get(lineId);
      const locationId = result.productId ? suggestedLocation(result.productId,warehouseId) : '';
      const batch = scanBatchFields(result.parsed);
      const candidate: Package = {id:crypto.randomUUID(),invoiceLineId:lineId,quantity:'1',lot:batch.lot,expiry:batch.expiry,locationId,raw};
      if (line && !batch.requiresReview && batch.lot && batch.expiry && locationId) {
        if (await checkLotExpiryConflict(line.product_id,batch.lot,batch.expiry)) {
          setDraft(candidate);setMessage('LOT นี้มีวันหมดอายุไม่ตรงกับที่บันทึกไว้ กรุณาตรวจสอบ');
          scanNotice('warn','ตรวจสอบ LOT','วันหมดอายุขัดแย้งกับ Stock เดิม');
          return;
        }
        const added=appendReceiptPackage(packagesRef.current,candidate,lines);
        if (added.ok) {
          setPack(added.packages);
          setScan(null);
          setDraft({invoiceLineId:'',quantity:'1',lot:'',expiry:'',locationId:''});
          setMessage(`${result.productCode ?? 'น้ำยา'} · LOT ${batch.lot} ${added.merged ? 'นับเพิ่ม 1' : 'เพิ่มเป็นรายการใหม่'} · ยังไม่ยืนยัน Stock`);
          scanNotice('ok',added.merged?'นับเพิ่ม 1 แพ็กเกจ':'เพิ่ม LOT ใหม่',`${result.productCode ?? ''} · LOT ${batch.lot}`);
          return;
        }
        if (added.reason === 'capacity') {
          setMessage('จำนวนสแกนรวมเกินยอดค้างรับของ Product นี้');
          scanNotice('warn','ยอดเกิน Invoice','ตรวจจำนวนก่อนสแกนต่อ');
          return;
        }
        if (added.reason === 'lot-expiry-conflict') {
          setMessage('LOT เดียวกันมีวันหมดอายุไม่ตรงกับร่างรับเข้า');
          scanNotice('warn','LOT ไม่ตรงกัน','ตรวจวันหมดอายุในร่างก่อน');
          return;
        }
      }
      // Unrecognized barcode / missing location / review warnings: require manual check.
      setDraft(candidate);
      setShowScanDetails(true);
      setMessage(result.message ?? 'ข้อมูลจาก Barcode ยังไม่ครบ กรุณาเลือก Product, LOT, วันหมดอายุ และตำแหน่งก่อนเพิ่ม');
      scanNotice('warn','ตรวจรายละเอียด',locationId ? 'ตรวจ LOT และวันหมดอายุก่อนเพิ่ม' : 'กรุณาเลือกตำแหน่งจัดเก็บก่อนเพิ่ม');
    } catch(error) {
      setMessage(userMessage(error instanceof Error ? error.message : null,'อ่าน Barcode ไม่สำเร็จ'));
      scanNotice('error','สแกนไม่สำเร็จ','โปรดสแกนใหม่');
    }
  }

  async function addPackage() {
    if (!draftRestored) return;
    const line=lineById.get(draft.invoiceLineId);
    if (!line) {setMessage('กรุณาเลือก Product ใน Invoice');return;}
    const candidate: Package = { ...draft,id:crypto.randomUUID() };
    const initial=appendReceiptPackage(packagesRef.current,candidate,lines);
    if (!initial.ok) {
      setMessage(initial.reason==='capacity'?'จำนวนรวมเกินยอดค้างรับ':initial.reason==='lot-expiry-conflict'?'LOT นี้มีวันหมดอายุต่างจากร่างเดิม':'กรุณากรอก LOT วันหมดอายุ จำนวน และตำแหน่งให้ครบ');
      return;
    }
    setBusy(true);
    try {
      if (await checkLotExpiryConflict(line.product_id,draft.lot,draft.expiry)) {
        setMessage('LOT นี้มีวันหมดอายุไม่ตรงกับ Stock ที่มีอยู่ · โปรดตรวจสอบ');return;
      }
      const added=appendReceiptPackage(packagesRef.current,candidate,lines);
      if (!added.ok) {setMessage('ยอดค้างรับเปลี่ยน กรุณาตรวจร่างอีกครั้ง');return;}
      setPack(added.packages);
      setSessionLocationByWarehouse(prev=>({...prev,[line.warehouse_id]:candidate.locationId}));
      setScan(null);
      setShowScanDetails(false);
      setDraft({invoiceLineId:'',quantity:'1',lot:'',expiry:'',locationId:''});
      setMessage(added.merged?'เพิ่มจำนวนให้ LOT เดิมแล้ว · ยังไม่ยืนยัน Stock':'เพิ่ม LOT เข้าร่างแล้ว · ยังไม่ยืนยัน Stock');
      scanNotice('ok',added.merged?'เพิ่มจำนวน LOT เดิม':'เพิ่มรายการในร่าง',`LOT ${candidate.lot}`);
    } catch(error){setMessage(userMessage(error instanceof Error?error.message:null,'ตรวจ LOT ไม่สำเร็จ'));}
    finally{setBusy(false);}
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
    <section id="ci-receive-entry" className="surface p-4 sm:p-7 grid gap-4 scroll-mt-4"><div><h2 className="font-bold text-lg">สแกนน้ำยาและจัดร่างรับเข้า</h2><p className="muted text-sm">หนึ่ง Invoice มีน้ำยาได้ทั้งสองคลัง · การสแกนยังไม่เพิ่ม Stock</p></div><label className="field">คลังที่กำลังสแกน<select className="input" value={warehouseId} onChange={e => { setWarehouseId(Number(e.target.value)); setScan(null); setShowScanDetails(false); setDraft({ invoiceLineId: '', quantity: '1', lot: '', expiry: '', locationId: '' }); }}>
      {warehouseIds.map(id => <option key={id} value={id}>{id === 1 ? 'CLINICAL CHEMISTRY' : id === 2 ? 'IMMUNOLOGY' : `คลัง ${id}`}</option>)}</select></label>
      <label className="field">ตำแหน่งจัดเก็บสำหรับการสแกนรอบนี้ (ถ้ามี)
        <select className="input min-h-11" value={sessionLocationByWarehouse[warehouseId] ?? ''} onChange={e=>setSessionLocationByWarehouse(prev=>({...prev,[warehouseId]:e.target.value}))}>
          <option value="">เลือกอัตโนมัติจาก Product / ครั้งก่อน</option>
          {locations.filter(loc=>loc.warehouse_id===warehouseId).map(loc=><option key={loc.id} value={loc.id}>{loc.parent_code ? loc.parent_code+' › ' : ''}{loc.code} · {loc.name}</option>)}
        </select>
        <span className="muted text-xs">เลือกครั้งเดียวเพื่อใช้กับการสแกนถัดไป · เปลี่ยนตำแหน่งของแต่ละ LOT ในร่างได้</span>
      </label>
      <BarcodeScanner onScan={onScan} continuous dock feedback={scanFeedback} summary={<span className="text-sm font-semibold">ร่าง {packages.length} LOT/ตำแหน่ง · {totalUnits.toLocaleString('th-TH')} หน่วย</span>}/>
      {scan && <div className="notice grid gap-1 text-sm"><p><strong>Raw:</strong> <code className="break-all">{scan.parsed.raw}</code></p><p>{scan.productCode ?? 'ไม่พบน้ำยา'} · {scan.parsed.standard} · {scan.parsed.symbology}</p><p>REF (240): {scan.parsed.additionalProductId ?? '—'} · GTIN (01): {scan.parsed.gtin ?? '—'}</p><p>LOT: {scan.parsed.lot ?? 'ต้องกรอก'} · Expiry: {scan.parsed.expiry ?? 'ต้องกรอก'}</p>{scan.parsed.warnings.map((warning,i) => <p key={i} role="alert">⚠ {warning}</p>)}</div>}
      <p role="status" className="notice">{message || 'สแกนหรือเลือก Product ใน Invoice เพื่อเริ่มรับ'}</p>
      {locationPath && <a className="button secondary" href={locationPath}>เปิดตำแหน่งนี้</a>}
      {scanReady && !showScanDetails && <div className="notice grid gap-2 text-sm"><strong>ข้อมูลจาก Data Matrix พร้อมรับเข้า</strong><p>{scan?.productCode} · LOT {draft.lot} · หมดอายุ {draft.expiry}</p><button className="button secondary justify-self-start" type="button" onClick={() => setShowScanDetails(true)}>แก้ไขข้อมูลที่สแกน</button></div>}
       <label className="field">จำนวนแพ็ก/หน่วยฐาน<IntegerQuantityInput className="input" min="1" value={draft.quantity} onChange={e => setDraft({ ...draft, quantity:e.target.value })} required/></label>
       {(!scanReady || showScanDetails) && <div className="grid sm:grid-cols-2 gap-3"><label className="field sm:col-span-2">Product ใน Invoice<select className="input" value={draft.invoiceLineId} onChange={e => { const line = lineById.get(e.target.value); setDraft({ ...draft, invoiceLineId: e.target.value, locationId: line ? suggestedLocation(line.product_id,line.warehouse_id) : '' }); }} required><option value="">เลือก Product</option>{lines.filter(l => l.warehouse_id === warehouseId && Number(l.remaining_quantity)>0).map(l => { const product=productById.get(l.product_id); return <option key={l.invoice_line_id} value={l.invoice_line_id}>{product?.product_code} · {product?.display_name} · ค้าง {l.remaining_quantity}</option>; })}</select></label><label className="field">LOT {scan?.parsed.lot && !scanBatchFields(scan.parsed).requiresReview ? '(จาก Barcode · ตรวจได้)' : ''}<input className="input" autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" value={draft.lot} onChange={e => setDraft({ ...draft, lot:e.target.value })} required/></label><label className="field">หมดอายุ {scan?.parsed.expiry && !scanBatchFields(scan.parsed).requiresReview ? '(จาก Barcode · ตรวจได้)' : ''}<input className="input" type="date" value={draft.expiry} onChange={e => setDraft({ ...draft, expiry:e.target.value })} required/></label><label className="field">ตำแหน่ง<select className="input" value={draft.locationId} onChange={e => setDraft({ ...draft, locationId:e.target.value })} required><option value="">เลือกตำแหน่ง</option>{locations.filter(l => l.warehouse_id === currentLine?.warehouse_id).map(l => <option key={l.id} value={l.id}>{l.parent_code ? `${l.parent_code} › ` : ''}{l.code} · {l.name}</option>)}</select></label></div>}
       {scan && !scan.invoiceLineId && <button className="button secondary" type="button" onClick={() => void propose()}>เสนอการจับคู่ Barcode กับ Product ที่เลือก</button>}
      <button className="button min-h-12" disabled={busy} type="button" onClick={() => void addPackage()}>เพิ่มแพ็กเกจในร่าง</button>
    </section>
    <form action={confirmReceipt} onSubmit={event => {
      const problem = validateReceiptPackages(packages,lines) ?? assessmentError(assessment);
      setAssessmentProblem(problem ?? '');
      if (problem || !draftRestored) event.preventDefault();
    }} className="surface p-4 sm:p-7 grid gap-4">
      <input type="hidden" name="invoice_id" value={invoiceId}/>
      <input type="hidden" name="idempotency_key" value={draftKey}/>
      {packages.map(item => <div key={item.id} hidden>
        <input type="hidden" name="invoice_line_id" value={item.invoiceLineId}/>
        <input type="hidden" name="quantity" value={item.quantity}/>
        <input type="hidden" name="lot_number" value={item.lot}/>
        <input type="hidden" name="expiry_date" value={item.expiry}/>
        <input type="hidden" name="location_id" value={item.locationId}/>
      </div>)}
      <div className="flex flex-wrap gap-3 items-start justify-between">
        <div><h2 className="font-bold text-lg">ตรวจร่างและผลตรวจรับ</h2>
          <p className="muted text-sm">{packages.length} LOT/ตำแหน่ง · รวม {totalUnits.toLocaleString('th-TH')} หน่วย · ยังไม่เพิ่ม Stock จนกดยืนยัน</p>
        </div>
        {packages.length > 0 && <button type="button" className="button secondary" onClick={() => {
          if (!window.confirm('ต้องการล้างรายการในร่างนี้ทั้งหมดหรือไม่? รายการที่รับเข้าจริงแล้วจะไม่ถูกเปลี่ยน')) return;
          setPack([]);
          clearReceiveDraft(invoiceId);
          clearWorkbenchDraft(invoiceId,userId);
          setDraftKey(crypto.randomUUID());
          setMessage('ล้างร่างรับเข้าแล้ว');
        }}>ล้างร่าง</button>}
      </div>
      {draftStorageWarning && <p role="alert" className="error">อุปกรณ์นี้ไม่อนุญาตให้บันทึกร่างอัตโนมัติ · โปรดอย่าออกจากหน้าก่อนยืนยัน</p>}
      {!draftStorageWarning && packages.length>0 && <p role="status" className="muted text-xs">บันทึกร่างอัตโนมัติบนอุปกรณ์นี้ · ผู้ใช้คนเดิมกลับมาทำต่อได้ · ไม่ซิงก์ข้ามเครื่อง</p>}
      <ReceiptPackageReview packages={packages} lines={lines} products={products} locations={locations}
        onChange={(id,change)=>setPack(packagesRef.current.map(item=>item.id===id?{...item,...change}:item))}
        onRemove={id=>setPack(packagesRef.current.filter(item=>item.id!==id))}
        onAddLot={showAddLot}/>
      {packageError && packages.length>0 && <p role="alert" className="error">{packageError}</p>}
      <ReceiptAssessmentFields value={assessment} onChange={next => { setAssessment(next); if (assessmentProblem) setAssessmentProblem(assessmentError(next) ?? ''); }}/>
      {assessmentProblem && <p className="error" role="alert">{assessmentProblem}</p>}<p className="muted text-sm">ยืนยันแล้วจึงบันทึก Stock แบบ atomic ตามคลังของน้ำยาแต่ละรายการ</p><SubmitButton label={`ยืนยันรับเข้า ${packages.length} LOT/ตำแหน่ง`} pendingLabel="กำลังบันทึกรับเข้า…" disabled={busy || !draftRestored || Boolean(packageError) || Boolean(assessmentError(assessment))}/>{packageError && <p className="muted text-sm" role="status">ตรวจสอบข้อมูลทุก LOT ให้ครบก่อนยืนยัน</p>}
    </form>
  </div>;
}
