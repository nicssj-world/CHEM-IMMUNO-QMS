import { appendReceiptPackage } from '@/lib/receipt-workbench';
import { ASSESSMENT_REASON_CODES, DEFAULT_ASSESSMENT, type AssessmentInput, type ReasonCode } from '@/lib/receipt-assessment';

export type WizardLot = {
  id: string; quantity: string; lot: string; expiry: string; locationId: string;
  raw?: string;
};
export type WizardLine = {
  id: string; productId: string; orderedQuantity: string; packages: WizardLot[];
};
export type WizardHeader = {
  vendorId: string; invoiceNumber: string; invoiceDate: string; poNumber: string;
};
export type WizardDraft = {
  id: string; vendor_id: string; invoice_number: string; invoice_date: string;
  po_number: string | null; lines: WizardLine[]; assessment: AssessmentInput | null;
  step: number; status: 'draft' | 'submitted'; invoice_id: string | null;
  updated_at: string;
};
export type WizardProduct = {
  id: string; warehouse_id: number; product_code: string; display_name: string;
  default_location_id: string | null;
};
export type WizardLocation = { id: string; warehouse_id: number; code: string; name: string; parent_code?: string | null };

/** Keep the identical LOT/location merging and invoice-cap guard used by
 * pre-wizard ReceiveWorkbench. Scanning MUST NEVER edit orderedQuantity.
 */
export function appendWizardScan(
  lines: readonly WizardLine[],
  next: { productId: string; lot: string; expiry: string; locationId: string; quantity: string; raw?: string },
  makeId: () => string,
): {ok:true;lines:WizardLine[];merged:boolean} | {ok:false;reason:'invalid'|'capacity'|'lot-expiry-conflict'|'review'} {
  const line=lines.find(l=>l.productId===next.productId);
  const ordered=line?.orderedQuantity ?? '';
  const packages=line?.packages ?? [];
  // Do not silently discard a partially edited/manual LOT or count it twice.
  const blank=packages.length===1 && !packages[0].lot && !packages[0].expiry && packages[0].quantity==='1';
  const source=blank?[]:packages;
  if(source.some(p=>!p.lot.trim()||!p.expiry||!p.locationId)) return {ok:false,reason:'review'};
  const existing=source.map(p=>({...p,invoiceLineId:next.productId}));
  const result=appendReceiptPackage(existing,{
    id:makeId(),invoiceLineId:next.productId,lot:next.lot,expiry:next.expiry,
    locationId:next.locationId,quantity:next.quantity,raw:next.raw,
  },[{invoice_line_id:next.productId,remaining_quantity:ordered.trim()?Number(ordered):Number.MAX_SAFE_INTEGER}]);
  if(!result.ok) return result;
  const updated:WizardLine=line
    ? {...line,packages:result.packages.map(({invoiceLineId:unused,...p})=>{void unused;return p;})}
    : {id:makeId(),productId:next.productId,orderedQuantity:ordered,
       packages:result.packages.map(({invoiceLineId:unused,...p})=>{void unused;return p;})};
  return {ok:true,lines:line?lines.map(l=>l.id===line.id?updated:l):[...lines,updated],merged:result.merged};
}

export function wizardHeaderError(header: WizardHeader): string | null {
  if (!header.vendorId || !header.invoiceNumber.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(header.invoiceDate)) {
    return 'กรุณาระบุผู้ขาย เลขที่ Invoice และวันที่ให้ครบ';
  }
  if (header.invoiceNumber.trim().length > 120 || header.poNumber.length > 200) return 'ข้อมูลส่วนหัว Invoice ยาวเกินกำหนด';
  return null;
}

export function wizardLineError(lines: readonly WizardLine[], products: readonly WizardProduct[], locations: readonly WizardLocation[]): string | null {
  if (lines.length === 0) return 'กรุณาเพิ่มน้ำยาอย่างน้อยหนึ่งรายการ';
  if (lines.length > 250) return 'จำนวนรายการน้ำยาเกินกำหนด';
  const knownProducts = new Set(products.map(p => p.id));
  const knownLocations = new Set(locations.map(p => p.id));
  const used = new Set<string>();
  let lots = 0;
  const expiryByLot = new Map<string, string>();
  for (const line of lines) {
    if (!knownProducts.has(line.productId) || used.has(line.productId)) return 'โปรดเลือกน้ำยาที่อยู่ในทะเบียนและไม่ซ้ำรายการ';
    used.add(line.productId);
    const ordered = Number(line.orderedQuantity);
    if (!Number.isSafeInteger(ordered) || ordered < 1) return 'จำนวนตาม Invoice ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป';
    let received = 0;
    for (const pkg of line.packages) {
      lots++;
      if (lots > 500) return 'จำนวน LOT มากเกินกำหนด';
      const count = Number(pkg.quantity);
      if (!Number.isSafeInteger(count) || count < 1 || !pkg.lot.trim() ||
          !/^\d{4}-\d{2}-\d{2}$/.test(pkg.expiry) || !knownLocations.has(pkg.locationId)) {
        return 'กรุณากรอก LOT วันหมดอายุ จำนวนรับจริง และตำแหน่งให้ครบ';
      }
      const key = JSON.stringify([line.productId,pkg.lot.trim().toLocaleLowerCase()]);
      if (expiryByLot.has(key) && expiryByLot.get(key) !== pkg.expiry) return 'LOT เดียวกันมีวันหมดอายุต่างกัน';
      expiryByLot.set(key,pkg.expiry);
      received += count;
    }
    if (received > ordered) return 'จำนวนรับเข้าจริงเกินจำนวนตาม Invoice';
  }
  if (!lots) return 'กรุณาระบุจำนวนรับเข้าจริงอย่างน้อยหนึ่ง LOT';
  return null;
}
export function wizardTotals(lines: readonly WizardLine[]) {
  const ordered = lines.reduce((sum,l)=>sum+(Number(l.orderedQuantity)||0),0);
  const received = lines.reduce((sum,l)=>sum+l.packages.reduce((n,p)=>n+(p.lot.trim()&&p.expiry&&p.locationId?Number(p.quantity)||0:0),0),0);
  return {ordered,received,pending:Math.max(0,ordered-received),lots:lines.reduce((sum,l)=>sum+l.packages.filter(p=>p.lot.trim()&&p.expiry&&p.locationId).length,0)};
}
export function remainingForLot(line: WizardLine, lotId: string) {
  return Math.max(0,Number(line.orderedQuantity) -
    line.packages.filter(p=>p.id!==lotId).reduce((n,p)=>n+(Number(p.quantity)||0),0));
}

/** A failed Step 4 retry can contain the backend assessment payload. Restore the
 * interactive form shape safely instead of showing an invalid editor on refresh.
 */
export function restoreWizardAssessment(raw: unknown): AssessmentInput {
  if (!raw || typeof raw !== 'object') return DEFAULT_ASSESSMENT;
  const data=raw as Record<string,unknown>;
  if ('productCondition' in data) {
    const form=data as unknown as AssessmentInput;
    return {...DEFAULT_ASSESSMENT,...form,
      reasonCodes:Array.isArray(form.reasonCodes)?form.reasonCodes.filter(x=>ASSESSMENT_REASON_CODES.includes(x)):[],
      note:typeof form.note==='string'?form.note:'',
      otherReasonDetail:typeof form.otherReasonDetail==='string'?form.otherReasonDetail:''};
  }
  const reasons=Array.isArray(data.reason_codes)
    ? data.reason_codes.filter((x):x is ReasonCode=>ASSESSMENT_REASON_CODES.includes(x as ReasonCode))
    : [];
  const cold=data.temperature_required===true;
  return {
    productCondition:data.packaging_ok===false?'abnormal':'normal',
    documentation:data.documentation_complete===false?'incomplete':'complete',
    itemCorrectness:data.correct_product===false||data.correct_quantity===false?'problem':'correct',
    coldChainApplicable:cold,
    coldChainCondition:cold?(data.temperature_ok===false?'inappropriate':'appropriate'):null,
    hasComplaint:data.has_complaint===true,
    note:typeof data.notes==='string'?data.notes:'',
    reasonCodes:reasons,
    otherReasonDetail:typeof data.other_reason_detail==='string'?data.other_reason_detail:'',
  };
}
