import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ASSESSMENT, assessmentError, deriveAcceptanceDecision, parseAssessment, toAssessmentPayload } from '@/lib/receipt-assessment';

test('receipt assessment defaults to all-pass and needs nothing more', () => {
  assert.equal(deriveAcceptanceDecision(DEFAULT_ASSESSMENT), 'accepted');
  assert.equal(assessmentError(DEFAULT_ASSESSMENT), null);
  const payload = toAssessmentPayload(DEFAULT_ASSESSMENT);
  assert.equal(payload.delivery_discrepancy, false);
  assert.equal(payload.temperature_ok, null);
  assert.equal(payload.shelf_life_ok, null);
});

test('any failed criterion requires a reason and a note, as in LABCBH-Stock', () => {
  const failed = { ...DEFAULT_ASSESSMENT, hasComplaint: true };
  assert.equal(deriveAcceptanceDecision(failed), 'accepted_with_justification');
  assert.match(assessmentError(failed) ?? '', /เหตุผล/);
  assert.match(assessmentError({ ...failed, reasonCodes: ['urgent_need'] }) ?? '', /หมายเหตุ/);
  assert.equal(assessmentError({ ...failed, reasonCodes: ['urgent_need'], note: 'กล่องบุบ' }), null);
  assert.equal(toAssessmentPayload({ ...failed, reasonCodes: ['urgent_need'], note: 'x' }).delivery_discrepancy, true);
});

test('"other" reason needs its own detail, and a clean receipt may not carry reasons', () => {
  const failed = { ...DEFAULT_ASSESSMENT, itemCorrectness: 'problem' as const, note: 'ขาด 1 กล่อง', reasonCodes: ['other' as const] };
  assert.match(assessmentError(failed) ?? '', /เหตุผลอื่น/);
  assert.equal(assessmentError({ ...failed, otherReasonDetail: 'รอของงวดสอง' }), null);
  assert.match(assessmentError({ ...DEFAULT_ASSESSMENT, reasonCodes: ['urgent_need'] }) ?? '', /ไม่ต้องมีเหตุผล/);
});

test('cold chain only counts when it applies', () => {
  assert.equal(deriveAcceptanceDecision({ ...DEFAULT_ASSESSMENT, coldChainApplicable: true, coldChainCondition: 'appropriate' }), 'accepted');
  assert.equal(deriveAcceptanceDecision({ ...DEFAULT_ASSESSMENT, coldChainApplicable: true, coldChainCondition: 'inappropriate' }), 'accepted_with_justification');
  assert.equal(toAssessmentPayload({ ...DEFAULT_ASSESSMENT, coldChainApplicable: true, coldChainCondition: 'inappropriate' }).temperature_ok, false);
});

test('posted assessment JSON is sanitised to known values', () => {
  const parsed = parseAssessment(JSON.stringify({ productCondition: 'weird', reasonCodes: ['urgent_need', 'hack', 'urgent_need'], coldChainApplicable: false, coldChainCondition: 'inappropriate' }));
  assert.equal(parsed?.productCondition, 'normal');
  assert.deepEqual(parsed?.reasonCodes, ['urgent_need']);
  assert.equal(parsed?.coldChainCondition, null);
  assert.equal(parseAssessment('not json'), null);
});
