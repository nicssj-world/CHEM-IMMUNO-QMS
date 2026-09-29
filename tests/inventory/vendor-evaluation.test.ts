import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { fiscalYearBE } from '../../src/lib/inventory-insights';
import { finalizeReadiness, isOfficial, policyProposalError, VENDOR_EVALUATION_CRITERIA, type AnnualRevision, type Frozen, type PolicyProposalInput } from '../../src/lib/vendor-evaluation';
import { generateVendorAnnualEvaluationPdf, type AnnualPdfRevision } from '../../src/lib/vendor-evaluation-pdf';

// 1x1 transparent PNG: a valid image for the three signature slots.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function frozen(overrides: { summary?: string; issues?: number; receipts?: number } = {}): Frozen {
  const receipts = Array.from({ length: overrides.receipts ?? 3 }, (_, i) => ({ eventNumber: `RC-2569-${String(i + 1).padStart(4, '0')}`, receivedDate: '2026-09-25', invoiceNumber: `INV-${i + 1}`, poNumber: null, assessmentState: 'completed' as const }));
  const assessments = receipts.map(r => ({ eventNumber: r.eventNumber, receivedDate: r.receivedDate, invoiceNumber: r.invoiceNumber, productCondition: 'normal' as const, documentation: 'complete' as const, itemCorrectness: 'correct' as const, coldChainApplicable: false, coldChainCondition: null, hasComplaint: false, acceptanceDecision: 'accepted' as const, note: null, reasons: [], otherReasonDetail: null }));
  const issues = Array.from({ length: overrides.issues ?? 1 }, (_, i) => ({ id: `i${i}`, issueType: 'quantity_discrepancy', sourceKind: 'manual', status: 'open', openedAt: '2026-09-25T03:00:00Z', description: 'x', resolutionAction: null, resolutionNote: null, resolvedAt: null, invoiceNumber: 'INV-1', eventNumber: 'RC-2569-0001' }));
  const criteria = VENDOR_EVALUATION_CRITERIA.map((code, i) => ({ criterionCode: code, displayOrder: i + 1, numerator: 1, denominator: 1, applicable: true, percentage: 100, label: code, weight: 12.5, effectiveWeight: 12.5, weightedScore: 12.5, evidenceDefinition: 'หลักฐาน', calculationDefinition: 'คำนวณ', naDefinition: 'N/A' }));
  const sig = { id: 'u1', name: 'ผู้ทดสอบ', position: 'หัวหน้ากลุ่มงาน' };
  return {
    evidence: {
      vendor: { id: 'v1', vendorCode: 'V-0001', name: 'ผู้ขายทดสอบ', legalName: null, taxId: null, taxBranchCode: '00000', address: null },
      warehouse: { id: 1, code: 'CHE', name: 'CLINICAL CHEMISTRY' }, fiscalYear: 2569,
      coverage: { startDate: '2025-10-01', endDate: '2026-09-30', assessmentRequiredFrom: '2026-09-25', completed: receipts.length, pending: 0, percentage: 100 },
      activity: { invoices: 3, receipts: receipts.length, completedAssessments: receipts.length, pendingAssessments: 0, openIssues: issues.length, resolvedIssues: 0 },
      criteria, issues, receipts, assessments, capturedAt: '2026-09-25T00:00:00Z',
    },
    criteria, score: 100, result: 'pass',
    policy: { id: 'p1', version: 'VE-POLICY-V1', passThreshold: 80, minimumCoveragePercent: 70, approvedAt: '2026-09-25T00:00:00Z', approvedByName: 'ผู้อนุมัติ' },
    judgment: { summary: overrides.summary ?? 'สรุปผล', strengths: 'ส่งตรงเวลา', risksConcerns: 'ไม่มี', recommendations: 'ติดตามต่อ' },
    signatories: { evaluator: sig, reviewer: sig, approver: sig }, reportNumber: 'VE-2569-0001', revision: 1, finalizedAt: '2026-09-25T00:00:00Z',
  };
}

const pdfInput = (f: Frozen, over: Partial<AnnualPdfRevision> = {}): AnnualPdfRevision => ({
  status: 'final', frozen: f, reportNumber: 'VE-2569-0001', finalizedAt: '2026-09-25T00:00:00Z', revisionNumber: 1, policyApproved: true, warehouseName: 'CLINICAL CHEMISTRY',
  evaluatorSignature: PNG, reviewerSignature: PNG, approverSignature: PNG, ...over,
});
const pageCount = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();

test('annual report PDF: normal fixture is the six standard pages', async () => {
  const bytes = await generateVendorAnnualEvaluationPdf(pdfInput(frozen()));
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  assert.equal(await pageCount(bytes), 6);
});

test('annual report PDF: long judgment text and many receipts continue onto more pages', async () => {
  const bytes = await generateVendorAnnualEvaluationPdf(pdfInput(frozen({ summary: 'ผู้ขายส่งของครบถ้วน '.repeat(400), issues: 40, receipts: 60 })));
  assert.ok(await pageCount(bytes) > 6);
});

test('annual report PDF refuses drafts, unapproved policy, mismatched references and missing signatures', async () => {
  await assert.rejects(generateVendorAnnualEvaluationPdf(pdfInput(frozen(), { status: 'draft' })), /เฉพาะรายงานที่สิ้นสุด/);
  await assert.rejects(generateVendorAnnualEvaluationPdf(pdfInput(frozen(), { policyApproved: false })), /นโยบายที่อนุมัติแล้ว/);
  await assert.rejects(generateVendorAnnualEvaluationPdf(pdfInput(frozen(), { reportNumber: 'VE-2569-0002' })), /ไม่ตรงกับ revision/);
  await assert.rejects(generateVendorAnnualEvaluationPdf(pdfInput(frozen(), { reviewerSignature: null })), /ไม่พบลายเซ็น/);
});

test('Buddhist-era fiscal year rolls over on 1 October', () => {
  assert.equal(fiscalYearBE('2026-09-30'), 2569);
  assert.equal(fiscalYearBE('2026-10-01'), 2570);
  assert.equal(fiscalYearBE('2027-01-15'), 2570);
});

const proposal = (): PolicyProposalInput => ({
  policyId: null, version: 'QP-1', effectiveFromFiscalYear: 2569, effectiveToFiscalYear: null, passThreshold: 80, minimumCoveragePercent: 70, coverageStartDate: '2025-10-01', note: '',
  criteria: VENDOR_EVALUATION_CRITERIA.map((criterionCode, i) => ({ criterionCode, weight: i === 0 ? 30 : 10 })),
});

test('policy proposal validation mirrors the database rules', () => {
  assert.equal(policyProposalError(proposal()), null);
  assert.match(policyProposalError({ ...proposal(), version: ' ' }) ?? '', /เวอร์ชัน/);
  assert.match(policyProposalError({ ...proposal(), effectiveFromFiscalYear: 2026 }) ?? '', /พ\.ศ\./);
  assert.match(policyProposalError({ ...proposal(), passThreshold: 101 }) ?? '', /เกณฑ์ผ่าน/);
  assert.match(policyProposalError({ ...proposal(), criteria: proposal().criteria.slice(1) }) ?? '', /ให้ครบ/);
  assert.match(policyProposalError({ ...proposal(), criteria: proposal().criteria.map(c => ({ ...c, weight: 10 })) }) ?? '', /เท่ากับ 100/);
});

test('a report is official only when final, on an approved policy, with a number and a frozen snapshot', () => {
  const base = { status: 'final', report_number: 'VE-2569-0001', frozen_snapshot: frozen(), ci_vendor_evaluation_policies: { version: 'V1', status: 'approved' }, judgment_summary: 'a', strengths: 'b', risks_concerns: 'c', recommendations: 'd', evaluator_id: '1', reviewer_id: '2', approver_id: '3' } as unknown as AnnualRevision;
  assert.equal(isOfficial(base), true);
  assert.equal(isOfficial({ ...base, status: 'draft' }), false);
  assert.equal(isOfficial({ ...base, ci_vendor_evaluation_policies: { version: 'V1', status: 'proposed' } }), false);
  assert.equal(isOfficial({ ...base, frozen_snapshot: null }), false);
  assert.deepEqual(finalizeReadiness(base, true), []);
  assert.equal(finalizeReadiness({ ...base, strengths: '', evaluator_id: null }, false).length, 3);
});
