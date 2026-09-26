'use server';

import { revalidatePath } from 'next/cache';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage } from '@/lib/messages';
import { policyProposalError, type PolicyProposalInput } from '@/lib/vendor-evaluation';

export type EvalResult<T = null> = { ok: true; data: T } | { ok: false; message: string };
async function client() {
  await requireAccess();
  const supabase = await createClient();
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล');
  return supabase;
}

export async function saveEvaluationPolicyProposal(input: PolicyProposalInput): Promise<EvalResult<string>> {
  const invalid = policyProposalError(input);
  if (invalid) return { ok: false, message: invalid };
  const supabase = await client();
  const { data, error } = await supabase.rpc('ci_save_vendor_evaluation_policy_proposal', {
    p_policy_id: input.policyId,
    p_policy: {
      version: input.version.trim(), effectiveFromFiscalYear: input.effectiveFromFiscalYear, effectiveToFiscalYear: input.effectiveToFiscalYear,
      passThreshold: input.passThreshold, minimumCoveragePercent: input.minimumCoveragePercent, coverageStartDate: input.coverageStartDate, note: input.note.trim(),
    },
    p_criteria: input.criteria,
  });
  if (error || !data) return { ok: false, message: logUserMessage('savePolicy', error, 'บันทึกนโยบายไม่สำเร็จ') };
  revalidatePath('/vendors/evaluation-policy');
  return { ok: true, data: data as string };
}

export async function approveEvaluationPolicy(policyId: string): Promise<EvalResult> {
  const supabase = await client();
  const { error } = await supabase.rpc('ci_approve_vendor_evaluation_policy', { p_policy_id: policyId });
  if (error) return { ok: false, message: logUserMessage('approvePolicy', error, 'อนุมัตินโยบายไม่สำเร็จ') };
  revalidatePath('/vendors/evaluation-policy');
  return { ok: true, data: null };
}

// ---- Annual evaluation (draft → finalize) -------------------------------------------------------------------------

export async function createAnnualEvaluationDraft(vendorId: string, warehouseId: number, fiscalYear: number): Promise<EvalResult<string>> {
  const supabase = await client();
  const { data, error } = await supabase.rpc('ci_create_vendor_annual_evaluation_draft', { p_vendor_id: vendorId, p_warehouse_id: warehouseId, p_fiscal_year: fiscalYear });
  if (error || !data) return { ok: false, message: logUserMessage('createAnnualDraft', error, 'สร้างฉบับร่างไม่สำเร็จ') };
  revalidatePath(`/vendors/${vendorId}`);
  return { ok: true, data: data as string };
}

export type DraftInput = { summary: string; strengths: string; risksConcerns: string; recommendations: string; evaluatorId: string; reviewerId: string; approverId: string };

export async function saveAnnualEvaluationDraft(revisionId: string, input: DraftInput): Promise<EvalResult> {
  const supabase = await client();
  const { error } = await supabase.rpc('ci_save_vendor_annual_evaluation_draft', { p_revision_id: revisionId, p_data: {
    summary: input.summary, strengths: input.strengths, risksConcerns: input.risksConcerns, recommendations: input.recommendations,
    evaluatorId: input.evaluatorId || null, reviewerId: input.reviewerId || null, approverId: input.approverId || null } });
  if (error) return { ok: false, message: logUserMessage('saveAnnualDraft', error, 'บันทึกฉบับร่างไม่สำเร็จ') };
  revalidatePath('/vendors');
  return { ok: true, data: null };
}

export async function refreshAnnualEvaluationDraft(revisionId: string): Promise<EvalResult> {
  const supabase = await client();
  const { error } = await supabase.rpc('ci_refresh_vendor_annual_evaluation_draft', { p_revision_id: revisionId });
  if (error) return { ok: false, message: logUserMessage('refreshAnnualDraft', error, 'รีเฟรชหลักฐานไม่สำเร็จ') };
  revalidatePath('/vendors');
  return { ok: true, data: null };
}

/** Saves the draft first so what the user sees is what gets frozen, then finalizes; returns the report number. */
export async function finalizeAnnualEvaluation(revisionId: string, input: DraftInput): Promise<EvalResult<string>> {
  const saved = await saveAnnualEvaluationDraft(revisionId, input);
  if (!saved.ok) return saved;
  const supabase = await client();
  const { data, error } = await supabase.rpc('ci_finalize_vendor_annual_evaluation', { p_revision_id: revisionId });
  if (error || !data) return { ok: false, message: logUserMessage('finalizeAnnual', error, 'สิ้นสุดรายงานไม่สำเร็จ') };
  revalidatePath('/vendors');
  return { ok: true, data: data as string };
}

export async function listSigners(): Promise<EvalResult<{ id: string; name: string; position: string; hasSignature: boolean }[]>> {
  const supabase = await client();
  const { data, error } = await supabase.rpc('ci_list_evaluation_signers');
  if (error) return { ok: false, message: logUserMessage('listSigners', error) };
  return { ok: true, data: (data ?? []) as { id: string; name: string; position: string; hasSignature: boolean }[] };
}
