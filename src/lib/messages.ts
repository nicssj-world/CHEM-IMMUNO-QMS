// Database functions raise CI_* codes and Postgres/PostgREST raise English text; neither should reach a lab user as-is.
const codeMessages: Record<string, string> = {
  CI_ACCESS_DENIED: 'คุณไม่มีสิทธิ์ทำรายการนี้ในคลังนี้',
  CI_ACTIVE_USER_NEEDS_WAREHOUSE: 'ผู้ใช้ที่เปิดใช้งานต้องมีสิทธิ์อย่างน้อยหนึ่งคลัง',
  CI_ADJUSTMENT_REASON_OR_QUANTITY_INVALID: 'กรุณาระบุเหตุผล และจำนวนปรับที่ไม่เป็นศูนย์',
  CI_ALREADY_REVERSED: 'รายการนี้ถูกย้อนไปแล้ว ย้อนซ้ำไม่ได้',
  CI_CONFIRMED_HISTORY_IMMUTABLE: 'รายการที่ยืนยันแล้วแก้ไขไม่ได้ · ใช้การยกเลิกรายการแทน',
  CI_COUNT_APPROVAL_INVALID: 'อนุมัติรอบนับไม่ได้ · ยอดในระบบเปลี่ยนหลังเริ่มนับ หรือข้อมูลไม่ครบ',
  CI_COUNT_INCOMPLETE: 'ยังบันทึกยอดนับไม่ครบทุกรายการ',
  CI_COUNT_LINES_REQUIRED: 'ไม่มีรายการสำหรับตรวจนับ',
  CI_COUNT_LINE_INVALID: 'รายการตรวจนับไม่ถูกต้อง',
  CI_COUNT_NOT_FOUND: 'ไม่พบรอบตรวจนับนี้',
  CI_COUNT_SCOPE_INVALID: 'ขอบเขตการตรวจนับไม่ถูกต้อง',
  CI_DISPLAY_NAME_INVALID: 'ชื่อที่แสดงต้องมี 1–120 ตัวอักษร',
  CI_DISPOSAL_INVALID: 'ข้อมูลการกำจัดไม่ถูกต้อง · ตรวจจำนวนและเหตุผล',
  CI_EPHIS_ID_ALREADY_ASSIGNED: 'Ephis ID นี้ถูกใช้แล้ว',
  CI_EPHIS_ID_IMMUTABLE: 'เปลี่ยน Ephis ID ของผู้ใช้เดิมไม่ได้',
  CI_EPHIS_ID_INVALID: 'รูปแบบ Ephis ID ไม่ถูกต้อง',
  CI_EVALUATION_FROZEN: 'ผลประเมินนี้ถูกล็อกแล้ว แก้ไขไม่ได้',
  CI_EVALUATION_STATE_INVALID: 'สถานะผลประเมินไม่ถูกต้องสำหรับขั้นตอนนี้',
  CI_EXPIRED_OR_INVALID_LOT: 'LOT นี้หมดอายุแล้วหรือใช้เบิกไม่ได้',
  CI_FEFO_OVERRIDE_REASON_REQUIRED: 'กรุณาระบุเหตุผลที่ไม่ใช้ LOT ตาม FEFO',
  CI_IDEMPOTENCY_KEY_REQUIRED: 'ฟอร์มหมดอายุ · โหลดหน้าใหม่แล้วลองอีกครั้ง',
  CI_IDEMPOTENCY_PAYLOAD_CONFLICT: 'รายการนี้ถูกส่งไปแล้วด้วยข้อมูลต่างกัน · โหลดหน้าใหม่แล้วลองอีกครั้ง',
  CI_IDENTIFIER_AMBIGUOUS: 'Barcode นี้ตรงกับหลายสินค้า · ต้องให้หัวหน้างานตรวจสอบ',
  CI_IDENTIFIER_NOT_FOUND: 'ไม่พบสินค้าที่ตรงกับ Barcode',
  CI_INVOICE_LINES_REQUIRED: 'Invoice ต้องมีสินค้าอย่างน้อยหนึ่งรายการ',
  CI_INVOICE_LINE_NOT_FOUND: 'ไม่พบรายการนี้ใน Invoice',
  CI_INVOICE_NOT_FOUND: 'ไม่พบ Invoice',
  CI_INVOICE_NOT_OPEN: 'Invoice นี้ปิดแล้ว รับเข้าเพิ่มไม่ได้',
  CI_INVOICE_WAREHOUSE_INVALID: 'มีสินค้าใน Invoice ที่อยู่ในคลังที่คุณไม่มีสิทธิ์',
  CI_ISSUE_PURPOSE_REQUIRED: 'กรุณาเลือกวัตถุประสงค์การเบิก',
  CI_ISSUE_QUANTITY_INVALID: 'จำนวนเบิกไม่ถูกต้อง',
  CI_LOCATION_INVALID: 'ตำแหน่งไม่ถูกต้องหรือไม่อยู่ในคลังนี้',
  CI_LOT_EXPIRY_CONFLICT: 'LOT นี้มีวันหมดอายุไม่ตรงกับที่บันทึกไว้',
  CI_LOT_EXPIRY_REQUIRED: 'กรุณาระบุ LOT และวันหมดอายุ',
  CI_LOT_HAS_HISTORY: 'LOT นี้มีประวัติการเคลื่อนไหวแล้ว แก้ไขไม่ได้',
  CI_LOT_IDENTITY_IMMUTABLE: 'แก้ไขเลข LOT หรือวันหมดอายุที่บันทึกแล้วไม่ได้',
  CI_LOT_NOT_EXPIRED: 'LOT นี้ยังไม่หมดอายุ ใช้เมนูกำจัดหมดอายุไม่ได้',
  CI_MAPPING_AMBIGUOUS: 'Barcode นี้จับคู่ได้หลายสินค้า',
  CI_MAPPING_INVALID: 'ข้อมูลการจับคู่ Barcode ไม่ถูกต้อง',
  CI_MAPPING_NOT_OPEN: 'คำขอนี้ถูกพิจารณาไปแล้ว',
  CI_MAPPING_REASON_REQUIRED: 'กรุณาระบุเหตุผล',
  CI_NEGATIVE_STOCK: 'ยอดคงเหลือไม่พอ · รายการนี้จะทำให้ยอดติดลบ',
  CI_PRODUCT_CODE_WAREHOUSE_MISMATCH: 'รหัสสินค้าไม่ตรงกับคลัง',
  CI_PRODUCT_FIELD_NOT_EDITABLE: 'แก้ไขข้อมูลช่องนี้ไม่ได้',
  CI_PRODUCT_HAS_OPERATIONAL_HISTORY: 'สินค้านี้มีประวัติการเคลื่อนไหวแล้ว แก้ไขข้อมูลนี้ไม่ได้',
  CI_PRODUCT_IDENTIFIERS_REQUIRED: 'กรุณาระบุ REF ปัจจุบันของสินค้า',
  CI_PRODUCT_IDENTITY_IMMUTABLE: 'แก้ไขรหัสหรือคลังของสินค้าเดิมไม่ได้',
  CI_PRODUCT_NOT_FOUND: 'ไม่พบสินค้า',
  CI_PRODUCT_TYPE_HAS_RELATIONS: 'เปลี่ยนประเภทสินค้าไม่ได้ เพราะมีความสัมพันธ์กับสินค้าอื่นอยู่',
  CI_CURRENT_REF_REQUIRED: 'กรุณาระบุ REF ปัจจุบันของสินค้า',
  CI_RECEIPT_ASSESSMENT_REQUIRED: 'กรุณาบันทึกผลตรวจรับให้ครบ',
  CI_RECEIPT_REASON_REQUIRED: 'กรุณาเลือกเหตุผลที่ยอมรับสินค้าแบบมีเงื่อนไข',
  CI_RECEIPT_NOTE_REQUIRED: 'กรุณาระบุหมายเหตุเมื่อพบความผิดปกติ',
  CI_RECEIPT_REASON_NOT_ALLOWED: 'ผลรับสินค้าแบบปกติไม่ต้องมีเหตุผลแบบมีเงื่อนไข',
  CI_RECEIPT_OTHER_REASON_REQUIRED: 'กรุณาระบุเหตุผลอื่น',
  CI_RECEIPT_REASON_INVALID: 'เหตุผลที่เลือกไม่ถูกต้อง',
  CI_RECEIPT_EXCEEDS_INVOICE: 'จำนวนรับเกินยอดค้างรับใน Invoice',
  CI_RECEIPT_LINES_REQUIRED: 'กรุณาเพิ่มแพ็กเกจอย่างน้อยหนึ่งรายการ',
  CI_RECEIPT_QUANTITY_INVALID: 'จำนวนรับไม่ถูกต้อง',
  CI_RELATION_NOT_FOUND: 'ไม่พบความสัมพันธ์สินค้านี้',
  CI_RELATION_SOURCE_TYPE_INVALID: 'ประเภทสินค้าต้นทางไม่รองรับความสัมพันธ์นี้',
  CI_RELATION_TARGET_TYPE_INVALID: 'ประเภทสินค้าปลายทางไม่รองรับความสัมพันธ์นี้',
  CI_REPORT_MONTH_INVALID: 'เดือนรายงานไม่ถูกต้อง',
  CI_REVERSAL_REASON_REQUIRED: 'กรุณาระบุเหตุผลการยกเลิกรายการ',
  CI_REVERSAL_SOURCE_INVALID: 'ยกเลิกรายการนี้ไม่ได้',
  CI_TRANSFER_INVALID: 'ข้อมูลการย้ายไม่ถูกต้อง · ตรวจตำแหน่งปลายทางและจำนวน',
  CI_USER_ACTIVE_REQUIRED: 'บัญชีนี้ถูกปิดใช้งาน',
  CI_USER_ROLE_INVALID: 'บทบาทผู้ใช้ไม่ถูกต้อง',
  CI_USER_WAREHOUSE_INVALID: 'สิทธิ์คลังของผู้ใช้ไม่ถูกต้อง',
  CI_VENDOR_INVOICE_INVALID: 'ผู้ขายหรือเลขที่ Invoice ไม่ถูกต้อง',
  CI_WAREHOUSE_INVALID: 'คลังไม่ถูกต้อง',
  CI_ZERO_MOVEMENT: 'จำนวนต้องไม่เป็นศูนย์',
  CI_POLICY_FROZEN: 'นโยบายที่อนุมัติหรือเลิกใช้แล้วแก้ไขไม่ได้',
  CI_POLICY_INPUT_INVALID: 'ข้อมูลนโยบายไม่ถูกต้อง',
  CI_POLICY_CRITERIA_INCOMPLETE: 'นโยบายต้องมีเกณฑ์ครบ 8 ข้อและไม่ซ้ำ',
  CI_POLICY_WEIGHT_TOTAL: 'น้ำหนักเกณฑ์รวมต้องเท่ากับ 100',
  CI_POLICY_NOT_FOUND: 'ไม่พบนโยบายประเมินผู้ขาย',
  CI_POLICY_NOT_PROPOSED: 'อนุมัติได้เฉพาะนโยบายที่เป็นข้อเสนอ',
  CI_POLICY_INCOMPLETE: 'ยังระบุน้ำหนัก เกณฑ์ผ่าน หรือความครอบคลุมไม่ครบ',
  CI_POLICY_OVERLAP: 'ช่วงปีงบประมาณซ้อนกับนโยบายที่อนุมัติแล้ว',
  CI_POLICY_NOT_APPROVED: 'นโยบายที่ใช้กับรายงานนี้ยังไม่ได้อนุมัติ จึงสิ้นสุดรายงานไม่ได้ · หากมีนโยบายที่อนุมัติแล้ว กด “รีเฟรชหลักฐาน” เพื่อเปลี่ยนมาใช้นโยบายนั้น',
  CI_ANNUAL_REVISION_NOT_FOUND: 'ไม่พบรายงานประเมิน',
  CI_ANNUAL_REVISION_IMMUTABLE: 'รายงานที่สิ้นสุดแล้วแก้ไขไม่ได้ · สร้างฉบับร่างใหม่เพื่อแก้ไข',
  CI_ANNUAL_INPUT_INVALID: 'ข้อมูลรายงานไม่ถูกต้อง หรือข้อความยาวเกิน 4,000 ตัวอักษร',
  CI_ANNUAL_EVIDENCE_STALE: 'หลักฐานเปลี่ยนไปหลังสร้างร่าง · กด “รีเฟรชหลักฐาน” แล้วตรวจตัวเลขอีกครั้งก่อนสิ้นสุดรายงาน',
  CI_ANNUAL_COVERAGE_LOW: 'ความครอบคลุมของผลตรวจรับต่ำกว่าเกณฑ์ขั้นต่ำของนโยบาย',
  CI_ANNUAL_TEXT_REQUIRED: 'กรอกสรุป จุดแข็ง ความเสี่ยง และข้อเสนอแนะให้ครบทั้ง 4 ช่อง',
  CI_ANNUAL_SIGNERS_REQUIRED: 'เลือกผู้ประเมิน ผู้ทบทวน และผู้อนุมัติให้ครบ',
  CI_ANNUAL_SIGNATURE_MISSING: 'ผู้ลงนามอย่างน้อยหนึ่งคนยังไม่มีลายเซ็น · ให้ผู้ลงนามเซ็นที่เมนู “บัญชีของฉัน” ก่อน',
  CI_ANNUAL_NO_APPLICABLE_CRITERIA: 'ยังไม่มีข้อมูลในปีงบประมาณนี้สำหรับคำนวณคะแนน',
  CI_SIGNER_INACTIVE: 'ผู้ลงนามที่เลือกถูกปิดใช้งานหรือไม่พบ',
  CI_SIGNER_POSITION_REQUIRED: 'ผู้ลงนามที่เลือกยังไม่มีตำแหน่ง · ให้ระบุตำแหน่งที่เมนู “บัญชีของฉัน” หรือแอดมินระบุที่หน้าผู้ใช้',
  CI_SIGNATURE_INVALID: 'ไฟล์ลายเซ็นไม่ถูกต้องหรือมีขนาดใหญ่เกินไป',
  CI_POSITION_INVALID: 'ตำแหน่งยาวเกิน 200 ตัวอักษร',
  CI_USER_NOT_FOUND: 'ไม่พบผู้ใช้',
  CI_FISCAL_YEAR_INVALID: 'ปีงบประมาณไม่ถูกต้อง (ใช้ พ.ศ. 2500–3000)',
  CI_ISSUE_NOT_FOUND: 'ไม่พบปัญหาผู้ขาย',
  CI_ISSUE_NOT_OPEN: 'ปัญหานี้ไม่ได้อยู่ในสถานะรอดำเนินการ',
  CI_ISSUE_ALREADY_CANCELLED: 'ปัญหานี้ถูกยกเลิกแล้ว',
  CI_ISSUE_DESCRIPTION_REQUIRED: 'กรุณาระบุรายละเอียดปัญหา',
  CI_ISSUE_RESOLUTION_REQUIRED: 'กรุณาระบุวิธีและรายละเอียดการแก้ไขปัญหา',
  CI_ISSUE_CANCEL_REASON_INVALID: 'เหตุผลยกเลิกปัญหาไม่ถูกต้อง',
  CI_ISSUE_CANCEL_NOTE_REQUIRED: 'กรุณาระบุเหตุผลอื่นที่ยกเลิกปัญหา',
  CI_RECEIPT_ASSESSMENT_NOT_FOUND: 'ไม่พบผลตรวจรับ',
  CI_RECEIPT_ASSESSMENT_UNCHANGED: 'ไม่มีการเปลี่ยนแปลงจากผลตรวจรับเดิม',
  CI_RECEIPT_NOT_FOUND: 'ไม่พบการรับสินค้า',
  CI_ATTACHMENT_NOT_FOUND: 'ไม่พบไฟล์แนบ',
  CI_VENDOR_CODE_TAKEN: 'รหัสผู้ขายนี้ถูกใช้แล้ว',
  CI_VENDOR_NAME_TAKEN: 'ชื่อผู้ขายนี้ถูกใช้แล้ว',
  CI_VENDOR_TAX_TAKEN: 'เลขประจำตัวผู้เสียภาษีและสาขานี้ถูกใช้แล้ว',
  CI_VENDOR_CODE_NAME_REQUIRED: 'กรุณาระบุรหัสและชื่อผู้ขาย',
  CI_VENDOR_FIELD_INVALID: 'ข้อมูลผู้ขายไม่ถูกต้อง',
  CI_VENDOR_NOT_FOUND: 'ไม่พบผู้ขาย',
  CI_STALE_DATA: 'มีผู้อื่นแก้ข้อมูลนี้ก่อนหน้า · โหลดหน้าใหม่แล้วแก้อีกครั้ง',
  CI_REASON_REQUIRED: 'กรุณาระบุเหตุผล',
  CI_INVOICE_NOTHING_OUTSTANDING: 'Invoice นี้ไม่มีรายการค้างรับ',
};

// Check-constraint names that reach users through PostgREST when a value slips past the form.
const constraintMessages: Record<string, string> = {
  ci_vendors_tax_id_check: 'เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก',
  ci_vendors_tax_branch_check: 'รหัสสาขาต้องเป็นตัวเลข 5 หลัก',
  ci_vendors_email_check: 'รูปแบบอีเมลไม่ถูกต้อง',
};

const thai = /[฀-๿]/;

/** Turns a raw error (CI_* code, Postgres/PostgREST text, or our own Thai message) into a sentence a lab user can act on. */
export function userMessage(error: { message?: string | null; code?: string | null } | string | null | undefined, fallback = 'ทำรายการไม่สำเร็จ กรุณาลองใหม่ หรือแจ้งผู้ดูแลระบบ'): string {
  const text = (typeof error === 'string' ? error : error?.message ?? '').trim();
  const pgCode = typeof error === 'string' ? '' : error?.code ?? '';
  const ciCode = text.match(/CI_[A-Z0-9_]+/)?.[0];
  if (ciCode) return codeMessages[ciCode] ?? `${fallback} (รหัส ${ciCode})`;
  const constraint = Object.keys(constraintMessages).find(name => text.includes(name));
  if (constraint) return constraintMessages[constraint];
  if (text && thai.test(text)) return text;
  if (pgCode === '23505' || /duplicate key/i.test(text)) return 'ข้อมูลนี้มีอยู่แล้วในระบบ';
  if (pgCode === '42501' || /permission denied|row-level security/i.test(text)) return codeMessages.CI_ACCESS_DENIED;
  if (/JWT|fetch failed|network|timeout|ECONN/i.test(text)) return 'เชื่อมต่อระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
  return fallback;
}

/** Same as userMessage, but keeps the technical detail in the server log for support. */
export function logUserMessage(context: string, error: { message?: string | null; code?: string | null } | string | null | undefined, fallback?: string) {
  const text = typeof error === 'string' ? error : error?.message;
  if (text && !thai.test(text)) console.error(`[${context}]`, text);
  return userMessage(error, fallback);
}

/** Success banner text: the fixed sentence plus the summary the action put in `?saved=`. */
export function savedNotice(saved: string | undefined, text: string) {
  return !saved || saved === '1' ? text : `${text} · ${saved}`;
}
