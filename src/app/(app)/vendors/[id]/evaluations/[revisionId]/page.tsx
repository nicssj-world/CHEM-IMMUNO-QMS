import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAccess, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { AnnualEvaluationEditor } from '@/components/annual-evaluation-editor';
import { REVISION_COLUMNS, type AnnualRevision, type Signer } from '@/lib/vendor-evaluation';
import { logUserMessage } from '@/lib/messages';

const uuid = /^[0-9a-f-]{36}$/i;

export default async function AnnualEvaluationPage({ params }: { params: Promise<{ id: string; revisionId: string }> }) {
  const { id, revisionId } = await params;
  const access = await requireAccess();
  const client = await createClient();
  if (!client || !uuid.test(id) || !uuid.test(revisionId)) notFound();
  const { data, error } = await client.from('ci_vendor_annual_evaluation_revisions').select(REVISION_COLUMNS).eq('id', revisionId).maybeSingle();
  if (error) return <main className="grid gap-4"><h1 className="page-title">รายงานประเมินผู้ขาย</h1><p className="error" role="alert">อ่านรายงานไม่สำเร็จ: {logUserMessage('annual-evaluation', error)}</p></main>;
  const revision = data as unknown as AnnualRevision | null;
  if (!revision || revision.ci_vendor_annual_evaluations.vendor_id !== id) notFound();
  const warehouse = access.warehouses.find(w => Number(w.id) === Number(revision.warehouse_id));
  const canManage = Boolean(warehouse && canSupervise(warehouse.role));
  const signers = canManage && revision.status === 'draft' ? (((await client.rpc('ci_list_evaluation_signers')).data ?? []) as Signer[]) : [];
  const snapshot = revision.frozen_snapshot?.evidence ?? revision.evidence_snapshot;
  return <main className="grid gap-6 max-w-[1000px]">
    <div><Link href={`/vendors/${id}?warehouse=${snapshot.warehouse.code}`} className="text-sm">← {snapshot.vendor.name}</Link><p className="eyebrow mt-3 mb-1">Vendor annual evaluation</p><h1 className="page-title">รายงานประเมินผู้ขายประจำปี {revision.ci_vendor_annual_evaluations.fiscal_year}</h1><p className="muted mt-1 text-sm">{snapshot.vendor.vendorCode} · {snapshot.vendor.name} · {snapshot.warehouse.name}</p></div>
    <AnnualEvaluationEditor revision={revision} signers={signers} canManage={canManage} policyApproved={revision.ci_vendor_evaluation_policies.status === 'approved'} vendorId={id} />
  </main>;
}
