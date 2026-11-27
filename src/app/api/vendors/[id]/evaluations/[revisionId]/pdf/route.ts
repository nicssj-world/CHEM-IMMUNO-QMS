import { getAccessContext } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { generateVendorAnnualEvaluationPdf } from '@/lib/vendor-evaluation-pdf';
import type { Frozen } from '@/lib/vendor-evaluation';

export const runtime = 'nodejs';

const noStore = { 'Cache-Control': 'private, no-store' };
const fail = (message: string, status: number) => new Response(message, { status, headers: { ...noStore, 'Content-Type': 'text/plain; charset=utf-8' } });

type Row = {
  revision_number: number; status: 'draft' | 'final'; report_number: string | null; finalized_at: string | null; frozen_snapshot: Frozen | null;
  evaluator_signature: string | null; reviewer_signature: string | null; approver_signature: string | null;
  ci_vendor_annual_evaluations: { vendor_id: string };
  ci_vendor_evaluation_policies: { status: string };
};

// Official annual report as PDF (LABCBH-Stock route parity: 401 / 403 / 409 / 422). RLS on the revision row decides who may read it.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; revisionId: string }> }) {
  const { id, revisionId } = await params;
  const access = await getAccessContext();
  if (!access) return fail('กรุณาเข้าสู่ระบบ', 401);
  const client = await createClient();
  if (!client) return fail('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล', 503);
  const { data, error } = await client.from('ci_vendor_annual_evaluation_revisions')
    .select('revision_number,status,report_number,finalized_at,frozen_snapshot,evaluator_signature,reviewer_signature,approver_signature,ci_vendor_annual_evaluations!evaluation_id!inner(vendor_id),ci_vendor_evaluation_policies(status)')
    .eq('id', revisionId).maybeSingle();
  if (error) return fail('อ่านรายงานไม่สำเร็จ', 500);
  const row = data as unknown as Row | null;
  // RLS hides other warehouses' reports, so "not visible" and "not found" are the same answer.
  if (!row || row.ci_vendor_annual_evaluations.vendor_id !== id) return fail('ไม่พบรายงานหรือไม่มีสิทธิ์เข้าถึง', 404);
  if (row.status !== 'final' || !row.frozen_snapshot || !row.report_number || !row.finalized_at) return fail('ดาวน์โหลด PDF ได้เฉพาะรายงานที่สิ้นสุดและตรึงข้อมูลแล้ว', 409);
  if (row.ci_vendor_evaluation_policies?.status !== 'approved') return fail('รายงานอย่างเป็นทางการต้องใช้นโยบายที่อนุมัติแล้ว', 422);
  try {
    const pdf = await generateVendorAnnualEvaluationPdf({
      status: row.status, frozen: row.frozen_snapshot, reportNumber: row.report_number, finalizedAt: row.finalized_at, revisionNumber: row.revision_number,
      policyApproved: true, warehouseName: row.frozen_snapshot.evidence.warehouse.name,
      evaluatorSignature: row.evaluator_signature, reviewerSignature: row.reviewer_signature, approverSignature: row.approver_signature,
    });
    const filename = `รายงานประเมินผู้ขาย-${row.report_number}-R${row.revision_number}.pdf`;
    return new Response(Buffer.from(pdf), { status: 200, headers: {
      ...noStore, 'Content-Type': 'application/pdf', 'Content-Length': String(pdf.byteLength),
      'Content-Disposition': `inline; filename="vendor-evaluation-${row.report_number}-R${row.revision_number}.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    } });
  } catch (cause) {
    console.error('vendor evaluation pdf failed', cause instanceof Error ? cause.message : cause);
    return fail('สร้าง PDF ไม่สำเร็จ', 422);
  }
}
