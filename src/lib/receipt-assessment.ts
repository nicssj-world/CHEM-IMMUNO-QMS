// Receipt assessment criteria and rules, matching LABCBH-Stock (lib/vendor-evaluation/schema.ts).
// The database function ci_save_receipt_assessment enforces the same rules.

export const ASSESSMENT_REASON_CODES = ['urgent_need', 'no_alternative', 'usable_condition', 'vendor_will_correct', 'documentation_pending', 'consume_before_expiry', 'approved_exception', 'other'] as const;
export type ReasonCode = (typeof ASSESSMENT_REASON_CODES)[number];

export const REASON_LABELS: Record<ReasonCode, string> = {
  urgent_need: 'จำเป็นต้องใช้เร่งด่วน',
  no_alternative: 'ไม่มีสินค้าทดแทน',
  usable_condition: 'ยังอยู่ในสภาพใช้งานได้',
  vendor_will_correct: 'ผู้ขายจะดำเนินการแก้ไข',
  documentation_pending: 'เอกสารอยู่ระหว่างติดตาม',
  consume_before_expiry: 'วางแผนใช้ก่อนหมดอายุ',
  approved_exception: 'ผู้มีอำนาจอนุมัติข้อยกเว้น',
  other: 'เหตุผลอื่น',
};

export type AssessmentAnswers = {
  productCondition: 'normal' | 'abnormal';
  documentation: 'complete' | 'incomplete';
  itemCorrectness: 'correct' | 'problem';
  coldChainApplicable: boolean;
  coldChainCondition: 'appropriate' | 'inappropriate' | null;
  hasComplaint: boolean;
};
export type AssessmentInput = AssessmentAnswers & { note: string; reasonCodes: ReasonCode[]; otherReasonDetail: string };

/** Every answer starts at "pass"; the user only touches what went wrong. */
export const DEFAULT_ASSESSMENT: AssessmentInput = {
  productCondition: 'normal', documentation: 'complete', itemCorrectness: 'correct',
  coldChainApplicable: false, coldChainCondition: null, hasComplaint: false,
  note: '', reasonCodes: [], otherReasonDetail: '',
};

export function deriveAcceptanceDecision(input: AssessmentAnswers) {
  return input.productCondition === 'abnormal' || input.documentation === 'incomplete' || input.itemCorrectness === 'problem'
    || input.coldChainCondition === 'inappropriate' || input.hasComplaint
    ? 'accepted_with_justification' as const : 'accepted' as const;
}

export function suggestedReasonCodes(input: AssessmentAnswers): ReasonCode[] {
  return input.documentation === 'incomplete' ? ['documentation_pending'] : [];
}

/** First problem as a Thai sentence, or null when the assessment can be saved. */
export function assessmentError(input: AssessmentInput): string | null {
  if (input.coldChainApplicable && input.coldChainCondition === null) return 'กรุณาระบุสภาพการควบคุมอุณหภูมิ';
  if (deriveAcceptanceDecision(input) === 'accepted_with_justification') {
    if (input.reasonCodes.length === 0) return 'กรุณาเลือกเหตุผลที่ยอมรับสินค้าแบบมีเงื่อนไข';
    if (!input.note.trim()) return 'กรุณาระบุหมายเหตุเมื่อพบความผิดปกติ';
  } else if (input.reasonCodes.length > 0) return 'ผลรับสินค้าแบบปกติไม่ต้องมีเหตุผลแบบมีเงื่อนไข';
  if (input.reasonCodes.includes('other') && !input.otherReasonDetail.trim()) return 'กรุณาระบุเหตุผลอื่น';
  return null;
}

/** Maps the five criteria onto the ci_receipt_assessments columns the RPC expects. */
export function toAssessmentPayload(input: AssessmentInput) {
  const correct = input.itemCorrectness === 'correct';
  return {
    correct_product: correct,
    correct_quantity: correct,
    packaging_ok: input.productCondition === 'normal',
    temperature_required: input.coldChainApplicable,
    temperature_ok: input.coldChainApplicable ? input.coldChainCondition === 'appropriate' : null,
    shelf_life_ok: null,
    documentation_complete: input.documentation === 'complete',
    has_complaint: input.hasComplaint,
    delivery_discrepancy: deriveAcceptanceDecision(input) === 'accepted_with_justification',
    reason_codes: input.reasonCodes,
    other_reason_detail: input.reasonCodes.includes('other') ? input.otherReasonDetail.trim() : null,
    notes: input.note.trim() || null,
  };
}

/** Reads the assessment back out of a submitted form (the client component posts it as one JSON field). */
export function parseAssessment(raw: string): AssessmentInput | null {
  try {
    const value = JSON.parse(raw) as Partial<AssessmentInput>;
    const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T) => (allowed.includes(v as T) ? v as T : fallback);
    return {
      productCondition: pick(value.productCondition, ['normal', 'abnormal'], 'normal'),
      documentation: pick(value.documentation, ['complete', 'incomplete'], 'complete'),
      itemCorrectness: pick(value.itemCorrectness, ['correct', 'problem'], 'correct'),
      coldChainApplicable: value.coldChainApplicable === true,
      coldChainCondition: value.coldChainApplicable === true ? pick(value.coldChainCondition, ['appropriate', 'inappropriate'] as const, 'appropriate') : null,
      hasComplaint: value.hasComplaint === true,
      note: typeof value.note === 'string' ? value.note.slice(0, 2000) : '',
      reasonCodes: Array.isArray(value.reasonCodes) ? [...new Set(value.reasonCodes.filter((c): c is ReasonCode => (ASSESSMENT_REASON_CODES as readonly string[]).includes(c)))] : [],
      otherReasonDetail: typeof value.otherReasonDetail === 'string' ? value.otherReasonDetail.slice(0, 1000) : '',
    };
  } catch { return null; }
}

export type AssessmentRow = {
  id: string; receipt_id: string; warehouse_id: number; correct_product: boolean | null; correct_quantity: boolean | null; packaging_ok: boolean | null;
  temperature_required: boolean | null; temperature_ok: boolean | null; documentation_complete: boolean | null; has_complaint: boolean | null;
  delivery_discrepancy: boolean | null; notes: string | null; reason_codes: string[] | null; other_reason_detail: string | null;
  assessed_at: string; updated_at: string | null;
};
export const ASSESSMENT_COLUMNS = 'id,receipt_id,warehouse_id,correct_product,correct_quantity,packaging_ok,temperature_required,temperature_ok,documentation_complete,has_complaint,delivery_discrepancy,notes,reason_codes,other_reason_detail,assessed_at,updated_at';

/** Stored columns back to the five LABCBH criteria (item correctness = product and quantity both right). */
export function fromAssessmentRow(row: AssessmentRow): AssessmentInput {
  const cold = row.temperature_required === true;
  return {
    productCondition: row.packaging_ok === false ? 'abnormal' : 'normal',
    documentation: row.documentation_complete === false ? 'incomplete' : 'complete',
    itemCorrectness: row.correct_product === false || row.correct_quantity === false ? 'problem' : 'correct',
    coldChainApplicable: cold,
    coldChainCondition: cold ? (row.temperature_ok === false ? 'inappropriate' : 'appropriate') : null,
    hasComplaint: row.has_complaint === true,
    note: row.notes ?? '',
    reasonCodes: (row.reason_codes ?? []).filter((c): c is ReasonCode => (ASSESSMENT_REASON_CODES as readonly string[]).includes(c)),
    otherReasonDetail: row.other_reason_detail ?? '',
  };
}

/** Words for each answer, marking the ones that made the receipt "accepted with justification". */
export function assessmentAnswerLines(input: AssessmentInput): { label: string; value: string; exception: boolean }[] {
  return [
    { label: 'สภาพสินค้า', value: input.productCondition === 'normal' ? 'ปกติ' : 'ผิดปกติ', exception: input.productCondition === 'abnormal' },
    { label: 'เอกสารประกอบ', value: input.documentation === 'complete' ? 'ครบถ้วน' : 'ไม่ครบถ้วน', exception: input.documentation === 'incomplete' },
    { label: 'ความถูกต้องของรายการ', value: input.itemCorrectness === 'correct' ? 'ถูกต้อง' : 'พบปัญหา', exception: input.itemCorrectness === 'problem' },
    { label: 'การควบคุมอุณหภูมิ', value: input.coldChainApplicable ? (input.coldChainCondition === 'inappropriate' ? 'ไม่เหมาะสม' : 'เหมาะสม') : 'ไม่เกี่ยวข้อง', exception: input.coldChainApplicable && input.coldChainCondition === 'inappropriate' },
    { label: 'ข้อร้องเรียน', value: input.hasComplaint ? 'มีข้อร้องเรียน' : 'ไม่มี', exception: input.hasComplaint },
  ];
}
