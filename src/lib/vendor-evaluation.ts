// Vendor evaluation policy and annual evaluation vocabulary, ported from LABCBH-Stock lib/vendor-evaluation/annual-schema.ts and annual-queries.ts.
import type { SupabaseClient } from '@supabase/supabase-js';

export const VENDOR_EVALUATION_CRITERIA = ['delivery_completeness', 'shelf_life', 'product_packaging', 'documentation', 'item_correctness', 'cold_chain', 'complaint_performance', 'corrective_action'] as const;
export type CriterionCode = (typeof VENDOR_EVALUATION_CRITERIA)[number];
export const VENDOR_EVALUATION_CRITERION_LABELS: Record<CriterionCode, string> = {
  delivery_completeness: 'การส่งมอบ / ความครบถ้วน', shelf_life: 'อายุสินค้า ณ วันที่รับ', product_packaging: 'สภาพสินค้า / บรรจุภัณฑ์', documentation: 'เอกสารประกอบ',
  item_correctness: 'ความถูกต้องของรายการ', cold_chain: 'การควบคุมอุณหภูมิ', complaint_performance: 'ข้อร้องเรียน / ปัญหา', corrective_action: 'การแก้ไขปัญหา',
};
export const criterionLabel = (code: string, fallback?: string) => VENDOR_EVALUATION_CRITERION_LABELS[code as CriterionCode] ?? fallback ?? code;

export type PolicyStatus = 'proposed' | 'approved' | 'retired';
export const POLICY_STATUS_LABELS: Record<PolicyStatus, string> = { approved: 'อนุมัติแล้ว', proposed: 'ข้อเสนอ · รออนุมัติ', retired: 'เลิกใช้แล้ว' };

export type EvaluationPolicy = {
  id: string; version: string; status: PolicyStatus; effectiveFromFiscalYear: number; effectiveToFiscalYear: number | null;
  passThreshold: number | null; minimumCoveragePercent: number | null; coverageStartDate: string; note: string | null;
  approvedAt: string | null; approvedByName: string | null;
  criteria: { criterionCode: string; displayOrder: number; label: string; weight: number | null; evidenceDefinition: string; calculationDefinition: string; naDefinition: string }[];
};

type PolicyRow = {
  id: string; version: string; status: PolicyStatus; effective_from_fiscal_year: number; effective_to_fiscal_year: number | null; pass_threshold: string | number | null;
  minimum_coverage_percent: string | number | null; coverage_start_date: string; note: string | null; approved_at: string | null; approved_by_name_snapshot: string | null;
  ci_vendor_evaluation_policy_criteria: { criterion_code: string; display_order: number; label: string; weight: string | number | null; evidence_definition: string; calculation_definition: string; na_definition: string }[];
};
const num = (v: string | number | null) => (v === null || v === undefined ? null : Number(v));

export async function listEvaluationPolicies(client: SupabaseClient) {
  const { data, error } = await client.from('ci_vendor_evaluation_policies')
    .select('id,version,status,effective_from_fiscal_year,effective_to_fiscal_year,pass_threshold,minimum_coverage_percent,coverage_start_date,note,approved_at,approved_by_name_snapshot,ci_vendor_evaluation_policy_criteria(criterion_code,display_order,label,weight,evidence_definition,calculation_definition,na_definition)')
    .order('effective_from_fiscal_year', { ascending: false }).order('created_at', { ascending: false });
  const policies = ((data ?? []) as unknown as PolicyRow[]).map<EvaluationPolicy>(r => ({
    id: r.id, version: r.version, status: r.status, effectiveFromFiscalYear: r.effective_from_fiscal_year, effectiveToFiscalYear: r.effective_to_fiscal_year,
    passThreshold: num(r.pass_threshold), minimumCoveragePercent: num(r.minimum_coverage_percent), coverageStartDate: r.coverage_start_date, note: r.note,
    approvedAt: r.approved_at, approvedByName: r.approved_by_name_snapshot,
    criteria: r.ci_vendor_evaluation_policy_criteria.map(c => ({ criterionCode: c.criterion_code, displayOrder: c.display_order, label: c.label, weight: num(c.weight), evidenceDefinition: c.evidence_definition, calculationDefinition: c.calculation_definition, naDefinition: c.na_definition })),
  }));
  return { policies, error };
}

export type PolicyProposalInput = {
  policyId: string | null; version: string; effectiveFromFiscalYear: number; effectiveToFiscalYear: number | null; passThreshold: number; minimumCoveragePercent: number;
  coverageStartDate: string; note: string; criteria: { criterionCode: string; weight: number }[];
};

/** Same rules the database applies, so a slip is reported in Thai before a round trip. */
export function policyProposalError(input: PolicyProposalInput): string | null {
  if (!input.version.trim()) return 'กรุณาระบุเวอร์ชันนโยบาย';
  if (!Number.isInteger(input.effectiveFromFiscalYear) || input.effectiveFromFiscalYear < 2500 || input.effectiveFromFiscalYear > 3000) return 'ปีงบประมาณที่เริ่มใช้ต้องเป็น พ.ศ. (2500–3000)';
  if (input.effectiveToFiscalYear !== null && (!Number.isInteger(input.effectiveToFiscalYear) || input.effectiveToFiscalYear < input.effectiveFromFiscalYear || input.effectiveToFiscalYear > 3000)) return 'ปีสิ้นสุดต้องไม่น้อยกว่าปีเริ่มใช้';
  for (const [value, name] of [[input.passThreshold, 'เกณฑ์ผ่าน'], [input.minimumCoveragePercent, 'ความครอบคลุมขั้นต่ำ']] as const) if (!Number.isFinite(value) || value < 0 || value > 100) return `${name}ต้องอยู่ระหว่าง 0–100`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.coverageStartDate)) return 'กรุณาระบุวันเริ่มช่วงข้อมูล';
  if (input.criteria.length !== VENDOR_EVALUATION_CRITERIA.length || new Set(input.criteria.map(c => c.criterionCode)).size !== VENDOR_EVALUATION_CRITERIA.length) return 'กรุณาระบุเกณฑ์ให้ครบและไม่ซ้ำ';
  if (input.criteria.some(c => !Number.isFinite(c.weight) || c.weight <= 0 || c.weight > 100)) return 'น้ำหนักแต่ละเกณฑ์ต้องมากกว่า 0 และไม่เกิน 100';
  if (Math.abs(input.criteria.reduce((sum, c) => sum + c.weight, 0) - 100) > 0.001) return 'น้ำหนักรวมต้องเท่ากับ 100';
  return null;
}

// ---- Evidence snapshot and annual evaluation records --------------------------------------------------------------------

export type Criterion = { criterionCode: string; displayOrder: number; numerator: number; denominator: number; applicable: boolean; percentage: number | null; supplementaryCount?: number };
export type SnapshotIssue = { id: string; issueType: string; sourceKind: string; status: string; openedAt: string; description: string; resolutionAction: string | null; resolutionNote: string | null; resolvedAt: string | null; invoiceNumber: string | null; eventNumber: string | null };
export type SnapshotReceipt = { eventNumber: string | null; receivedDate: string; invoiceNumber: string; poNumber: string | null; assessmentState: 'completed' | 'pending' | 'not_required' };
export type SnapshotAssessment = {
  eventNumber: string | null; receivedDate: string; invoiceNumber: string; productCondition: 'normal' | 'abnormal'; documentation: 'complete' | 'incomplete'; itemCorrectness: 'correct' | 'problem';
  coldChainApplicable: boolean; coldChainCondition: 'appropriate' | 'inappropriate' | null; hasComplaint: boolean; acceptanceDecision: 'accepted' | 'accepted_with_justification'; note: string | null; reasons: string[]; otherReasonDetail: string | null;
};
export type Snapshot = {
  vendor: { id: string; vendorCode: string; name: string; legalName: string | null; taxId: string | null; taxBranchCode: string; address: string | null };
  warehouse: { id: number; code: string; name: string };
  fiscalYear: number;
  coverage: { startDate: string; endDate: string; assessmentRequiredFrom: string; completed: number; pending: number; percentage: number | null };
  activity: { invoices: number; receipts: number; completedAssessments: number; pendingAssessments: number; openIssues: number; resolvedIssues: number };
  criteria: Criterion[]; issues?: SnapshotIssue[]; receipts?: SnapshotReceipt[]; assessments?: SnapshotAssessment[]; capturedAt: string;
};
export type FrozenCriterion = Criterion & { label: string; weight: number; effectiveWeight: number | null; weightedScore: number | null; evidenceDefinition: string; calculationDefinition: string; naDefinition: string };
export type Signatory = { id: string; name: string; position: string };
export type Frozen = {
  evidence: Snapshot; criteria: FrozenCriterion[]; score: number; result: 'pass' | 'fail';
  policy: { id: string; version: string; passThreshold: number; minimumCoveragePercent: number; approvedAt: string; approvedByName: string };
  judgment: { summary: string; strengths: string; risksConcerns: string; recommendations: string };
  signatories: { evaluator: Signatory; reviewer: Signatory; approver: Signatory }; reportNumber: string; revision: number; finalizedAt: string;
};

export type AnnualRevision = {
  id: string; evaluation_id: string; warehouse_id: number; revision_number: number; supersedes_revision_id: string | null; policy_id: string; status: 'draft' | 'final';
  evidence_snapshot: Snapshot; evidence_hash: string; frozen_snapshot: Frozen | null; report_number: string | null;
  judgment_summary: string | null; strengths: string | null; risks_concerns: string | null; recommendations: string | null;
  evaluator_id: string | null; evaluator_name_snapshot: string | null; evaluator_position_snapshot: string | null;
  reviewer_id: string | null; reviewer_name_snapshot: string | null; reviewer_position_snapshot: string | null;
  approver_id: string | null; approver_name_snapshot: string | null; approver_position_snapshot: string | null;
  finalized_at: string | null; created_at: string; updated_at: string;
  ci_vendor_annual_evaluations: { vendor_id: string; warehouse_id: number; fiscal_year: number };
  ci_vendor_evaluation_policies: { version: string; status: PolicyStatus };
};
// Signature images are large and only the PDF needs them, so they are never part of the normal column list.
export const REVISION_COLUMNS = 'id,evaluation_id,warehouse_id,revision_number,supersedes_revision_id,policy_id,status,evidence_snapshot,evidence_hash,frozen_snapshot,report_number,judgment_summary,strengths,risks_concerns,recommendations,evaluator_id,evaluator_name_snapshot,evaluator_position_snapshot,reviewer_id,reviewer_name_snapshot,reviewer_position_snapshot,approver_id,approver_name_snapshot,approver_position_snapshot,finalized_at,created_at,updated_at,ci_vendor_annual_evaluations!evaluation_id!inner(vendor_id,warehouse_id,fiscal_year),ci_vendor_evaluation_policies(version,status)';

export async function loadAnnualRevisions(client: SupabaseClient, vendorId: string, warehouseId: number) {
  const { data, error } = await client.from('ci_vendor_annual_evaluation_revisions').select(REVISION_COLUMNS)
    .eq('ci_vendor_annual_evaluations.vendor_id', vendorId).eq('warehouse_id', warehouseId).order('created_at', { ascending: false }).limit(100);
  const rows = ((data ?? []) as unknown as AnnualRevision[]).sort((a, b) => b.ci_vendor_annual_evaluations.fiscal_year - a.ci_vendor_annual_evaluations.fiscal_year || b.revision_number - a.revision_number);
  return { revisions: rows, error };
}

/** A score is only shown when the report is official: final, on an approved policy, with a number. */
export function isOfficial(r: AnnualRevision) {
  return r.status === 'final' && r.ci_vendor_evaluation_policies?.status === 'approved' && r.frozen_snapshot !== null && r.report_number !== null;
}

export const RESULT_LABELS = { pass: 'ผ่าน', fail: 'ไม่ผ่าน' } as const;
export type Signer = { id: string; name: string; position: string; hasSignature: boolean };

export function draftInputError(input: { summary: string; strengths: string; risksConcerns: string; recommendations: string }): string | null {
  for (const value of Object.values(input)) if (value.length > 4000) return 'ข้อความยาวเกิน 4,000 ตัวอักษร';
  return null;
}
export function finalizeReadiness(r: AnnualRevision, policyApproved: boolean): string[] {
  const problems: string[] = [];
  if (!policyApproved) problems.push('นโยบายที่ใช้ยังเป็นข้อเสนอ ยังไม่ได้อนุมัติ');
  if (!r.judgment_summary || !r.strengths || !r.risks_concerns || !r.recommendations) problems.push('กรอกสรุป จุดแข็ง ความเสี่ยง และข้อเสนอแนะให้ครบทั้ง 4 ช่อง');
  if (!r.evaluator_id || !r.reviewer_id || !r.approver_id) problems.push('เลือกผู้ประเมิน ผู้ทบทวน และผู้อนุมัติให้ครบ');
  return problems;
}
