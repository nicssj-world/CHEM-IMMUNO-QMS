import { getAccessContext } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { generateVendorAnnualEvaluationPdf } from '@/lib/vendor-evaluation-pdf';
import type { Frozen } from '@/lib/vendor-evaluation';

export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store'};
const fail=(message:string,status:number)=>new Response(message,{status,headers:{...headers,'Content-Type':'text/plain; charset=utf-8'}});
type RecordRow={
  status:'draft'|'final';vendor_id:string;revision_number:number;report_number:string|null;finalized_at:string|null;
  frozen_snapshot:Frozen|null;evaluator_signature:string|null;reviewer_signature:string|null;approver_signature:string|null;
  ci_vendor_evaluation_policies:{status:string};
};
export async function GET(_request:Request,{params}:{params:Promise<{id:string;revisionId:string}>}) {
  const {id,revisionId}=await params;
  if(!/^[0-9a-f-]{36}$/i.test(id)||!/^[0-9a-f-]{36}$/i.test(revisionId)) return fail('ไม่พบรายงาน',404);
  const access=await getAccessContext();
  if(!access) return fail('กรุณาเข้าสู่ระบบ',401);
  if(![1,2].every(scope=>access.warehouses.some(w=>Number(w.id)===scope))) return fail('ไม่มีสิทธิ์เข้าถึง',403);
  const client=await createClient();
  if(!client) return fail('ระบบฐานข้อมูลไม่พร้อม',503);
  const {data,error}=await client.from('ci_unified_vendor_reports')
    .select('vendor_id,status,revision_number,report_number,finalized_at,frozen_snapshot,evaluator_signature,reviewer_signature,approver_signature,ci_vendor_evaluation_policies(status)')
    .eq('id',revisionId).eq('vendor_id',id).maybeSingle();
  if(error) return fail('อ่านรายงานไม่สำเร็จ',500);
  const row=data as unknown as RecordRow|null;
  if(!row) return fail('ไม่พบรายงานหรือไม่มีสิทธิ์',404);
  if(row.status!=='final'||!row.frozen_snapshot||!row.report_number||!row.finalized_at) return fail('รายงานยังไม่ได้รับรอง',409);
  if(row.ci_vendor_evaluation_policies.status!=='approved') return fail('นโยบายยังไม่อนุมัติ',422);
  try {
    const pdf=await generateVendorAnnualEvaluationPdf({
      status:'final',frozen:row.frozen_snapshot,reportNumber:row.report_number,
      finalizedAt:row.finalized_at,revisionNumber:row.revision_number,policyApproved:true,
      warehouseName:'CHEM-IMMUNO',evaluatorSignature:row.evaluator_signature,
      reviewerSignature:row.reviewer_signature,approverSignature:row.approver_signature,
    });
    const filename=`รายงานประเมินผู้ขาย-${row.report_number}-R${row.revision_number}.pdf`;
    return new Response(Buffer.from(pdf),{status:200,headers:{
      ...headers,'Content-Type':'application/pdf','Content-Length':String(pdf.byteLength),
      'Content-Disposition':`inline; filename="vendor-evaluation-${row.report_number}.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`
    }});
  } catch(error) {
    console.error('Unified vendor annual PDF:',error instanceof Error?error.message:'unexpected failure');
    return fail('สร้าง PDF ไม่สำเร็จ',422);
  }
}
