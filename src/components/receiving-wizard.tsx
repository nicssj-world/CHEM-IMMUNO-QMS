'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { BarcodeScanner } from './barcode-scanner';
import { InvoiceReagentPicker } from './invoice-reagent-picker';
import { IntegerQuantityInput } from './integer-quantity-input';
import { ReceiptAssessmentFields } from './receipt-assessment-fields';
import { assessmentError, type AssessmentInput } from '@/lib/receipt-assessment';
import { resolveProductScan } from '@/app/actions/scanner';
import { createReceivingWizardDraft, saveReceivingWizardDraft, finalizeReceivingWizard } from '@/app/actions/receiving-wizard';
import { wizardHeaderError, wizardLineError, wizardTotals, remainingForLot, restoreWizardAssessment,
  type WizardDraft, type WizardHeader, type WizardLine, type WizardLot, type WizardLocation, type WizardProduct } from '@/lib/receiving-wizard';
import { scanBatchFields } from '@/lib/barcode';
import { userMessage } from '@/lib/messages';

type Vendor = { id: string; name: string };
type RecentInvoice = {id:string; invoice_number:string;invoice_date:string;status:string;vendor_id:string};
type RecentDraft = {id:string;invoice_number:string;invoice_date:string;vendor_id:string;step:number;updated_at:string};

const TITLES=['ข้อมูล Invoice','รับเข้าน้ำยา','ตรวจสอบข้อมูล','ประเมินและยืนยัน'];
const initialHeader={vendorId:'',invoiceNumber:'',invoiceDate:'',poNumber:''};
const makeLot=(locationId=''):WizardLot=>({id:crypto.randomUUID(),quantity:'1',lot:'',expiry:'',locationId});
const makeLine=(productId:string,locationId=''):WizardLine=>({
  id:crypto.randomUUID(),productId,orderedQuantity:'1',packages:[makeLot(locationId)],
});

export function ReceivingWizard({vendors,products,locations,initialDraft,recentInvoices,recentDrafts}:{
  vendors:Vendor[];products:WizardProduct[];locations:WizardLocation[];
  initialDraft?:WizardDraft|null;recentInvoices:RecentInvoice[];recentDrafts:RecentDraft[];
}) {
  const router=useRouter();
  const [step,setStep]=useState(initialDraft ? Math.min(4,Math.max(2,initialDraft.step)) : 1);
  const [draftId,setDraftId]=useState(initialDraft?.id ?? '');
  const [header,setHeader]=useState<WizardHeader>(initialDraft
    ? {vendorId:initialDraft.vendor_id,invoiceNumber:initialDraft.invoice_number,invoiceDate:initialDraft.invoice_date,poNumber:initialDraft.po_number??''}
    : initialHeader);
  const [lines,setLines]=useState<WizardLine[]>(initialDraft?.lines ?? []);
  const [assessment,setAssessment]=useState<AssessmentInput>(restoreWizardAssessment(initialDraft?.assessment));
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [pending,startTransition]=useTransition();
  const productsById=useMemo(()=>new Map(products.map(p=>[p.id,p])),[products]);
  const locationsById=useMemo(()=>new Map(locations.map(p=>[p.id,p])),[locations]);
  const vendorsById=useMemo(()=>new Map(vendors.map(p=>[p.id,p])),[vendors]);
  const totals=wizardTotals(lines);

  function alterLine(id:string,update:(line:WizardLine)=>WizardLine) {
    setLines(current=>current.map(line=>line.id===id?update(line):line));
  }
  function alterLot(lineId:string,lotId:string,change:Partial<WizardLot>) {
    alterLine(lineId,line=>({...line,packages:line.packages.map(pkg=>pkg.id===lotId?{...pkg,...change}:pkg)}));
  }
  function addProduct(productId:string) {
    if(!productId)return;
    if(lines.some(line=>line.productId===productId)){
      setNotice('น้ำยานี้อยู่ในรายการแล้ว · เพิ่ม LOT ในรายการเดิมได้');
      return;
    }
    if(lines.length>=250){setError('เพิ่มน้ำยาได้ไม่เกิน 250 รายการ');return;}
    const product=productsById.get(productId);
    if(!product)return;
    setLines(old=>[...old,makeLine(productId,product.default_location_id && locationsById.has(product.default_location_id)?product.default_location_id:'')]);
    setNotice('');
    setError('');
  }

  async function onScan(raw:string,symbology:string) {
    try {
      const scan=await resolveProductScan(raw,symbology);
      const product=scan.product?.id ? productsById.get(scan.product.id) : null;
      if(!product){setError(scan.message??'ไม่พบน้ำยาที่ตรงกับ Barcode ในทะเบียนที่รับเข้าได้');return;}
      const batch=scanBatchFields(scan.parsed);
      const knownLot=batch.lot;
      const expiry=batch.expiry;
      setLines(old=>{
        const existing=old.find(line=>line.productId===product.id);
        const current=existing ?? makeLine(product.id,product.default_location_id && locationsById.has(product.default_location_id)?product.default_location_id:'');
        const matched=current.packages.find(pkg=>knownLot && expiry && pkg.lot===knownLot && pkg.expiry===expiry);
        const nextPackages=matched
          ? current.packages.map(pkg=>pkg.id===matched.id?{...pkg,quantity:String(Number(pkg.quantity)+1)}:pkg)
          : current.packages.length===1 && !current.packages[0].lot && !current.packages[0].expiry
            ? [{...current.packages[0],lot:knownLot,expiry}]
            : [...current.packages,{...makeLot(product.default_location_id && locationsById.has(product.default_location_id)?product.default_location_id:''),lot:knownLot,expiry}];
        const received=nextPackages.reduce((total,pkg)=>total+(Number(pkg.quantity)||0),0);
        const updated={...current,packages:nextPackages,orderedQuantity:String(Math.max(Number(current.orderedQuantity)||0,received))};
        return existing ? old.map(line=>line.id===existing.id?updated:line) : [...old,updated];
      });
      setError('');
      setNotice(batch.requiresReview?'สแกนแล้ว · กรุณาตรวจและกรอก LOT/วันหมดอายุให้ครบ':'สแกนแล้ว · เพิ่มจำนวนรับเข้าในร่าง (ยังไม่เพิ่ม Stock)');
    } catch(cause) {
      setError(userMessage(cause instanceof Error?cause.message:null,'สแกนไม่สำเร็จ'));
    }
  }

  function save(nextStep:number) {
    setError('');setNotice('');
    const headerIssue=wizardHeaderError(header);
    if(headerIssue){setError(headerIssue);setStep(1);return;}
    if(nextStep>=3) {
      const lineIssue=wizardLineError(lines,products,locations);
      if(lineIssue){setError(lineIssue);setStep(2);return;}
    }
    startTransition(async()=>{
      try {
        if(!draftId) {
          const result=await createReceivingWizardDraft(header);
          if(!result.ok){setError(result.message);return;}
          if (result.existingInvoice) {
            router.replace('/receive?invoice='+encodeURIComponent(result.id));
            return;
          }
          setDraftId(result.id);
          router.replace('/receive?draft='+encodeURIComponent(result.id));
          return;
        }
        const result=await saveReceivingWizardDraft(draftId,header,lines,assessment,nextStep);
        if(!result.ok){setError(result.message);return;}
        setStep(nextStep);
        setNotice(nextStep===2?'บันทึกส่วนหัว Invoice เป็นร่างแล้ว':nextStep===3?'บันทึกร่างรับเข้าแล้ว':'');
      }catch(cause){setError(userMessage(cause instanceof Error?cause.message:null,'บันทึกร่างไม่สำเร็จ'));}
    });
  }

  function complete() {
    const lineIssue=wizardLineError(lines,products,locations);
    if(lineIssue){setError(lineIssue);setStep(2);return;}
    const assessmentIssue=assessmentError(assessment);
    if(assessmentIssue){setError(assessmentIssue);return;}
    if(!draftId){setError('ไม่พบร่าง Invoice · กรุณาบันทึกส่วนหัวก่อน');return;}
    setError('');
    startTransition(async()=>{
      try {
        const result=await finalizeReceivingWizard(draftId,header,lines,assessment);
        if(!result.ok){setError(result.message);return;}
        router.replace('/receive?invoice='+encodeURIComponent(result.id)+'&saved='+encodeURIComponent('ยืนยันรับน้ำยาเรียบร้อย')+'&at='+Date.now().toString(36));
        router.refresh();
      }catch(cause){setError(userMessage(cause instanceof Error?cause.message:null,'ยืนยันรับเข้าไม่สำเร็จ'));}
    });
  }

  const summary=<div className="grid grid-cols-3 gap-2">
    {[{label:'จำนวนตาม Invoice',value:totals.ordered},{label:'รับเข้าจริง',value:totals.received},{label:'ค้างรับ',value:totals.pending}].map(entry=>
      <div key={entry.label} className="min-w-0 rounded-lg bg-surface-2 p-3 text-center">
        <span className="text-xs muted block">{entry.label}</span>
        <strong className="block text-xl tabular-nums">{entry.value.toLocaleString('th-TH')}</strong>
      </div>)}
  </div>;

  return <div className="grid gap-5 max-w-[1100px]">
    <header className="grid gap-3">
      <div><p className="eyebrow mb-1">Receiving Wizard</p><h1 className="page-title">รับน้ำยาเข้าคลัง</h1></div>
      <nav aria-label="ขั้นตอนการรับน้ำยา" className="grid grid-cols-4 gap-2">
        {TITLES.map((name,index)=><div key={name}
          className={`min-w-0 rounded-xl border p-2 text-center ${step===index+1?'border-[#087d78] bg-[#e7f4f3]':'border-line bg-surface'}`}>
          <span className="block text-xs font-semibold">ขั้นที่ {index+1}</span>
          <span className="block text-xs sm:text-sm break-words">{name}</span>
        </div>)}
      </nav>
    </header>

    {step===1 && <section className="surface p-4 sm:p-7 grid gap-4">
      <div><h2 className="font-bold text-lg">Step 1 · ส่วนหัว Invoice</h2>
        <p className="muted text-sm">กรอกเฉพาะส่วนหัว ไม่มีรายการน้ำยาและยังไม่เพิ่ม Stock · กดถัดไปเพื่อเก็บ Draft และรับน้ำยา</p></div>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="field min-w-0"><span>ผู้ขาย <span className="text-[#b42318]">*</span></span>
          <select className="input" value={header.vendorId} onChange={e=>setHeader({...header,vendorId:e.target.value})} aria-required="true">
            <option value="">เลือกผู้ขาย</option>{vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
          </select></label>
        <label className="field min-w-0"><span>เลขที่ Invoice <span className="text-[#b42318]">*</span></span>
          <input className="input" value={header.invoiceNumber} onChange={e=>setHeader({...header,invoiceNumber:e.target.value})} maxLength={120} aria-required="true" placeholder="เลขที่บนเอกสาร"/></label>
        <label className="field min-w-0"><span>วันที่ Invoice <span className="text-[#b42318]">*</span></span>
          <input className="input" type="date" value={header.invoiceDate} onChange={e=>setHeader({...header,invoiceDate:e.target.value})} aria-required="true"/></label>
        <label className="field min-w-0">เลขที่ PO (ถ้ามี)
          <input className="input" value={header.poNumber} onChange={e=>setHeader({...header,poNumber:e.target.value})} maxLength={200}/></label>
      </div>
      <div className="flex justify-end"><button className="button min-h-12" type="button" disabled={pending}
        onClick={()=>save(2)}>{pending?'กำลังบันทึกร่าง…':'ถัดไป · รับน้ำยา →'}</button></div>
    </section>}

    {step===2 && <section className="surface p-4 sm:p-7 grid gap-4">
      <div><h2 className="font-bold text-lg">Step 2 · รับเข้าน้ำยา</h2>
        <p className="muted text-sm">กำหนดจำนวนตาม Invoice หนึ่งครั้งต่อ Product · จำนวนรับจริงระบุแยกตาม LOT · รับบางส่วนได้</p></div>
      <div className="rounded-lg bg-surface-2 p-3 text-sm"><strong>Invoice {header.invoiceNumber}</strong> · {vendorsById.get(header.vendorId)?.name??'—'}</div>
      <p className="muted text-xs">ภาพ Invoice หรือเอกสารส่งของสามารถแนบได้หลังยืนยันรับเข้า และยังเปิดดู/แนบเพิ่มได้จาก Invoice เดิม</p>
      <div className="grid gap-3 rounded-xl border border-line p-3">
        <h3 className="font-bold">เพิ่มน้ำยาจาก Barcode</h3>
        <BarcodeScanner onScan={onScan} dock continuous summary={<span className="text-sm font-semibold">ร่าง {totals.lots} LOT · {totals.received} หน่วย</span>}/>
        <h3 className="font-bold">หรือเพิ่มน้ำยาด้วยตนเอง</h3>
        <InvoiceReagentPicker products={products} value="" onChange={addProduct}/>
      </div>
      {lines.map((line,index)=>{
        const product=productsById.get(line.productId);
        const amount=line.packages.reduce((total,p)=>total+(Number(p.quantity)||0),0);
        const outstanding=Math.max(0,Number(line.orderedQuantity)-amount);
        return <article key={line.id} className="rounded-xl border border-line p-3 sm:p-4 grid gap-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0"><strong>{index+1}. {product?.product_code??'น้ำยา'}</strong>
              <p className="muted text-sm break-words">{product?.display_name??'—'}</p></div>
            <button className="button secondary text-[#a83442] shrink-0" disabled={pending} type="button"
              onClick={()=>setLines(old=>old.filter(item=>item.id!==line.id))}>ลบ</button>
          </div>
          <label className="field max-w-xs"><span>จำนวนตาม Invoice <span className="text-[#b42318]">*</span></span>
            <IntegerQuantityInput className="input" min="1" value={line.orderedQuantity}
              onChange={e=>alterLine(line.id,old=>({...old,orderedQuantity:e.target.value}))} aria-required="true"/>
          </label>
          <div className="grid gap-3">
            {line.packages.map((pkg,lotIndex)=><div key={pkg.id} className="rounded-lg bg-surface-2 p-3 grid gap-3">
              <div className="flex items-center justify-between gap-2">
                <strong className="text-sm">LOT {lotIndex+1}</strong>
                <button type="button" className="button secondary" disabled={line.packages.length<=1 || pending}
                  onClick={()=>alterLine(line.id,old=>({...old,packages:old.packages.filter(p=>p.id!==pkg.id)}))}>ลบ LOT</button>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="field min-w-0"><span>LOT <span className="text-[#b42318]">*</span></span>
                  <input className="input" autoCapitalize="characters" autoComplete="off" value={pkg.lot}
                    onChange={e=>alterLot(line.id,pkg.id,{lot:e.target.value})}/></label>
                <label className="field min-w-0"><span>วันหมดอายุ <span className="text-[#b42318]">*</span></span>
                  <input className="input" type="date" value={pkg.expiry}
                    onChange={e=>alterLot(line.id,pkg.id,{expiry:e.target.value})}/></label>
                <label className="field min-w-0"><span>ตำแหน่งจัดเก็บ <span className="text-[#b42318]">*</span></span>
                  <select className="input" value={pkg.locationId}
                    onChange={e=>alterLot(line.id,pkg.id,{locationId:e.target.value})}>
                    <option value="">เลือกตำแหน่ง</option>{locations.map(loc=><option key={loc.id} value={loc.id}>
                      {loc.parent_code?loc.parent_code+' › ':''}{loc.code} · {loc.name}
                    </option>)}</select></label>
                <div className="grid gap-1 min-w-0">
                  <label className="field" htmlFor={'receive-qty-'+pkg.id}>จำนวนรับจริง *</label>
                  <div className="flex gap-2 items-stretch min-w-0">
                    <IntegerQuantityInput id={'receive-qty-'+pkg.id} className="input min-w-0 flex-1" min="1"
                      value={pkg.quantity} onChange={e=>alterLot(line.id,pkg.id,{quantity:e.target.value})}/>
                    <button type="button" className="button secondary shrink-0 px-2" disabled={pending || remainingForLot(line,pkg.id)<1}
                      onClick={()=>alterLot(line.id,pkg.id,{quantity:String(remainingForLot(line,pkg.id))})}>รับครบ</button>
                  </div>
                </div>
              </div>
            </div>)}
          </div>
          <button className="button secondary justify-self-start" type="button" disabled={pending}
            onClick={()=>alterLine(line.id,old=>({...old,packages:[...old.packages,makeLot(product?.default_location_id && locationsById.has(product.default_location_id)?product.default_location_id:'')]}))}>+ เพิ่ม LOT</button>
          <p className="muted text-sm">ตาม Invoice {line.orderedQuantity||'—'} · รับจริง {amount} · ค้างรับ {outstanding}</p>
        </article>;
      })}
      {!lines.length && <p className="rounded-xl border border-dashed border-line p-4 muted text-sm">ยังไม่มีรายการ · สแกนหรือค้นหาน้ำยาเพื่อเริ่มรับเข้า</p>}
      {summary}
      <div className="flex flex-wrap gap-2 justify-between">
        <button className="button secondary" type="button" disabled={pending} onClick={()=>setStep(1)}>← ย้อนกลับ</button>
        <div className="flex flex-wrap gap-2">
          <button className="button secondary" type="button" disabled={pending} onClick={()=>save(2)}>บันทึกร่าง</button>
          <button className="button" type="button" disabled={pending} onClick={()=>save(3)}>ถัดไป · ตรวจสอบ →</button>
        </div>
      </div>
    </section>}

    {step===3 && <section className="surface p-4 sm:p-7 grid gap-4">
      <div><h2 className="font-bold text-lg">Step 3 · ตรวจสอบก่อนยืนยัน</h2>
        <p className="muted text-sm">ตรวจทุกรายการให้ถูกต้อง ก่อนทำการประเมิน · ยังไม่เพิ่ม Stock</p></div>
      <div className="rounded-xl bg-surface-2 p-4 text-sm grid gap-1">
        <strong>Invoice {header.invoiceNumber}</strong>
        <span>ผู้ขาย: {vendorsById.get(header.vendorId)?.name??'—'}</span>
        <span>วันที่: {header.invoiceDate} · PO: {header.poNumber||'—'}</span>
      </div>
      {lines.map(line=><div key={line.id} className="rounded-xl border border-line p-3 grid gap-2">
        <strong>{productsById.get(line.productId)?.product_code} · {productsById.get(line.productId)?.display_name}</strong>
        <p className="muted text-sm">ตาม Invoice {line.orderedQuantity} · รับจริง {line.packages.reduce((n,p)=>n+Number(p.quantity),0)} · ค้างรับ {Math.max(0,Number(line.orderedQuantity)-line.packages.reduce((n,p)=>n+Number(p.quantity),0))}</p>
        {line.packages.map(pkg=><div key={pkg.id} className="rounded-lg bg-surface-2 p-3 text-sm">
          <strong>LOT {pkg.lot}</strong> · {pkg.quantity} หน่วย
          <p className="muted">หมดอายุ {pkg.expiry} · {locationsById.get(pkg.locationId)?.name??'ไม่พบตำแหน่ง'}</p>
        </div>)}
      </div>)}
      {summary}
      {totals.pending>0 && <p className="notice text-sm" role="status">ยังมียอดค้างรับ {totals.pending} หน่วย · Invoice จะเปิดให้รับเพิ่มเติมภายหลัง</p>}
      <div className="flex flex-wrap gap-2 justify-between">
        <button className="button secondary" disabled={pending} type="button" onClick={()=>setStep(2)}>← แก้รายการรับเข้า</button>
        <button className="button" disabled={pending} type="button" onClick={()=>save(4)}>ถัดไป · ประเมิน →</button>
      </div>
    </section>}

    {step===4 && <section className="surface p-4 sm:p-7 grid gap-4">
      <div><h2 className="font-bold text-lg">Step 4 · ประเมินการรับเข้า</h2>
        <p className="muted text-sm">เมื่อยืนยัน ระบบสร้าง Invoice และบันทึก Stock กับผลประเมินเป็นธุรกรรมเดียว</p></div>
      {summary}
      <ReceiptAssessmentFields value={assessment} onChange={setAssessment}/>
      <button className="button secondary justify-self-start" type="button" disabled={pending} onClick={()=>save(4)}>บันทึกแบบประเมินเป็นร่าง</button>
      <div className="flex flex-wrap gap-2 justify-between">
        <button className="button secondary" type="button" disabled={pending} onClick={()=>setStep(3)}>← กลับไปตรวจสอบ</button>
        <button className="button min-h-12" type="button" disabled={pending || !!assessmentError(assessment)}
          onClick={complete}>{pending?'กำลังบันทึก…':'ยืนยันรับเข้าและจบกระบวนการ'}</button>
      </div>
    </section>}

    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice text-sm" role="status">{notice}</p>}

    {step===1 && <section className="surface p-4 sm:p-7 grid gap-3">
      <div><h2 className="font-bold text-lg">Invoice ล่าสุด</h2><p className="muted text-sm">เลือก Invoice เดิมเพื่อดูประวัติหรือรับส่วนที่ค้าง</p></div>
      {recentInvoices.map(item=><Link className="flex flex-wrap justify-between items-center gap-2 p-3 rounded-lg border border-line no-underline text-[var(--ink)]"
        key={item.id} href={'/receive?invoice='+item.id}>
        <span><strong className="block">{item.invoice_number}</strong>
          <span className="text-xs muted">{item.invoice_date} · {vendorsById.get(item.vendor_id)?.name??'ผู้ขาย'}</span></span>
        <span className="badge">{({open:'ค้างรับ',closed:'รับครบ',closed_short:'ปิดรับไม่ครบ',cancelled:'ยกเลิก'} as Record<string,string>)[item.status]??item.status}</span>
      </Link>)}
      {!recentInvoices.length&&<p className="muted text-sm">ยังไม่มี Invoice</p>}
      <h3 className="font-bold border-t border-line pt-3">ร่างที่ยังทำไม่เสร็จ</h3>
      {recentDrafts.filter(item=>item.id!==draftId).map(item=><Link className="flex justify-between items-center gap-2 p-3 rounded-lg border border-line no-underline text-[var(--ink)]"
        key={item.id} href={'/receive?draft='+item.id}>
        <span><strong>{item.invoice_number}</strong><span className="block text-xs muted">{vendorsById.get(item.vendor_id)?.name??'ผู้ขาย'} · บันทึกร่าง</span></span>
        <span className="text-sm underline">ทำรายการต่อ →</span>
      </Link>)}
      {!recentDrafts.length&&<p className="muted text-sm">ไม่มีร่างค้าง</p>}
    </section>}
  </div>;
}
