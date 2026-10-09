import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAccess, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { AnnualEvaluationEditor } from '@/components/annual-evaluation-editor';
import type { AnnualRevision, Signer } from '@/lib/vendor-evaluation';
import { logUserMessage } from '@/lib/messages';

const uuid = /^[0-9a-f-]{36}$/i;
const COLUMNS = 'id,vendor_id,fiscal_year,revision_number,policy_id,status,evidence_snapshot,evidence_hash,frozen_snapshot,report_number,judgment_summary,strengths,risks_concerns,recommendations,evaluator_id,evaluator_name_snapshot,evaluator_position_snapshot,reviewer_id,reviewer_name_snapshot,reviewer_position_snapshot,approver_id,approver_name_snapshot,approver_position_snapshot,finalized_at,created_at,updated_at,ci_vendor_evaluation_policies(version,status)';

export default async function UnifiedAnnualPage({params}:{params:Promise<{id:string;revisionId:string}>}) {
  const {id,revisionId} = await params;
  const access = await requireAccess();
  if (!uuid.test(id) || !uuid.test(revisionId)) notFound();
  const client = await createClient();
  if (!client) notFound();
  const {data,error} = await client.from('ci_unified_vendor_reports').select(COLUMNS).eq('id',revisionId).eq('vendor_id',id).maybeSingle();
  if(error) return <main className="grid gap-4"><h1 className="page-title">รายงานประเมินผู้ขาย</h1><p className="error" role="alert">อ่านรายงานไม่ได้: {logUserMessage('annual-evaluation',error)}</p></main>;
  if(!data) notFound();
  const row = data as unknown as AnnualRevision & {vendor_id:string;fiscal_year:number};
  const revision:AnnualRevision = {...row,warehouse_id:0,
    ci_vendor_annual_evaluations:{vendor_id:id,warehouse_id:0,fiscal_year:row.fiscal_year}};
  const canManage=[1,2].every(scope=>access.warehouses.some(w=>Number(w.id)===scope && canSupervise(w.role)));
  const {data:signerData,error:signerError}=canManage && row.status==='draft' ? await client.rpc('ci_list_evaluation_signers') : {data:[],error:null};
  const signers=(signerData??[]) as Signer[];
  const snapshot=revision.frozen_snapshot?.evidence??revision.evidence_snapshot;
  return <main className="grid gap-6 max-w-[1000px]">
    <div><Link href={`/vendors/${id}`} className="text-sm">← {snapshot.vendor.name}</Link>
      <p className="eyebrow mt-3 mb-1">CHEM-IMMUNO · Unified vendor evaluation</p>
      <h1 className="page-title">รายงานประเมินผู้ขายประจำปี {row.fiscal_year}</h1>
      <p className="muted mt-1 text-sm">{snapshot.vendor.vendorCode} · {snapshot.vendor.name} · คลังน้ำยากลาง</p></div>
    {signerError && <p className="error" role="alert">อ่านข้อมูลผู้ลงนามไม่สำเร็จ</p>}
    <AnnualEvaluationEditor revision={revision} signers={signers} canManage={canManage && !signerError} policyApproved={row.ci_vendor_evaluation_policies.status==='approved'} vendorId={id} unified/>
  </main>;
}
