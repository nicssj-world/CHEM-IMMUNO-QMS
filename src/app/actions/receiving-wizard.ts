'use server';

import { revalidatePath } from 'next/cache';
import { requireAccess, canMutate } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';
import { assessmentError, toAssessmentPayload, type AssessmentInput } from '@/lib/receipt-assessment';
import { wizardHeaderError, wizardLineError, type WizardHeader, type WizardLine, type WizardProduct, type WizardLocation } from '@/lib/receiving-wizard';

export type WizardActionResult =
  | { ok: true; id: string; existingInvoice?: boolean }
  | { ok: false; message: string };

async function authorizedClient() {
  const access = await requireAccess();
  const client = await createClient();
  return { access, client };
}

export async function createReceivingWizardDraft(header: WizardHeader): Promise<WizardActionResult> {
  const issue=wizardHeaderError(header);
  if (issue) return {ok:false,message:issue};
  const {access,client}=await authorizedClient();
  if (!client || !access.warehouses.some(w=>canMutate(w.role))) return {ok:false,message:'ไม่มีสิทธิ์สร้างใบรับเข้า'};
  const {data,error}=await client.rpc('ci_create_receive_draft',{
    p_vendor:header.vendorId,p_number:header.invoiceNumber.trim(),
    p_date:header.invoiceDate,p_po:header.poNumber.trim() || null,
  });
  if (error?.message?.includes('CI_INVOICE_EXISTS')) {
    const {data:existing}=await client.from('ci_invoices').select('id').eq('vendor_id',header.vendorId)
      .eq('invoice_number',header.invoiceNumber.trim()).neq('status','cancelled').limit(1).maybeSingle();
    if(existing) return {ok:true,id:existing.id,existingInvoice:true};
    return {ok:false,message:'Invoice นี้มีอยู่แล้ว · กรุณาเปิด Invoice เดิมจากรายการล่าสุดเพื่อรับต่อ'};
  }
  if (error || !data) return {ok:false,message:logUserMessage('receive-draft',error,'ไม่สามารถบันทึกร่าง Invoice ได้')};
  revalidatePath('/receive');
  return {ok:true,id:String(data)};
}

export async function saveReceivingWizardDraft(
  id:string,header:WizardHeader,lines:WizardLine[],assessment:AssessmentInput,step:number,
):Promise<WizardActionResult> {
  const issue=wizardHeaderError(header);
  if (issue) return {ok:false,message:issue};
  if (!Number.isSafeInteger(step) || step<1 || step>4 || lines.length>250) return {ok:false,message:'ข้อมูลร่างรับเข้าไม่ถูกต้อง'};
  const {access,client}=await authorizedClient();
  if (!client || !access.warehouses.some(w=>canMutate(w.role))) return {ok:false,message:'ไม่มีสิทธิ์บันทึกร่างรับเข้า'};
  const {error}=await client.rpc('ci_save_receive_draft',{
    p_id:id,p_header:header,p_lines:lines,p_assessment:assessment,p_step:step,
  });
  if (error) return {ok:false,message:logUserMessage('receive-save-draft',error,'ไม่สามารถบันทึกร่างได้')};
  revalidatePath('/receive');
  return {ok:true,id};
}

export async function finalizeReceivingWizard(
  id:string,header:WizardHeader,lines:WizardLine[],assessment:AssessmentInput,
):Promise<WizardActionResult> {
  const headerProblem=wizardHeaderError(header);
  if (headerProblem) return {ok:false,message:headerProblem};
  const assessProblem=assessmentError(assessment);
  if (assessProblem) return {ok:false,message:assessProblem};
  const {access,client}=await authorizedClient();
  if (!client) return {ok:false,message:'ยังไม่ได้ตั้งค่า Supabase'};
  const scopedProducts=(await client.from('ci_products')
    .select('id,warehouse_id,product_code,display_name,default_location_id')
    .eq('active',true).in('warehouse_id',access.warehouses.filter(w=>canMutate(w.role)).map(w=>Number(w.id)))
    .limit(1000)).data as WizardProduct[]|null;
  const scopedLocations=(await client.from('ci_locations').select('id,code,name').eq('active',true).limit(1000)).data as WizardLocation[]|null;
  if (!scopedProducts || !scopedLocations) return {ok:false,message:'ไม่สามารถตรวจสอบทะเบียนน้ำยาและตำแหน่งได้'};
  const lineProblem=wizardLineError(lines,scopedProducts,scopedLocations);
  if (lineProblem) return {ok:false,message:lineProblem};
  // Saving is independently idempotent; final RPC creates Invoice, receipt, and assessment
  // in ONE PostgreSQL transaction and locks the draft against a second submit.
  const {error:saveError}=await client.rpc('ci_save_receive_draft',{
    p_id:id,p_header:header,p_lines:lines,
    p_assessment:toAssessmentPayload(assessment),p_step:4,
  });
  if (saveError) return {ok:false,message:logUserMessage('receive-save-final',saveError,'บันทึกร่างก่อนยืนยันไม่สำเร็จ')};
  const {data,error}=await client.rpc('ci_finalize_receive_draft',{p_id:id});
  if (error || !data) return {ok:false,message:logUserMessage('receive-finalize',error,'ยืนยันรับน้ำยาไม่สำเร็จ ข้อมูลร่างยังอยู่')};
  for (const path of ['/receive','/stock','/vendors','/movements','/attention']) revalidatePath(path);
  return {ok:true,id:String(data)};
}
