// Stored enum values stay English in the database; these are the words people see.
type Labels = Record<string, string>;

export const movementKindLabels: Labels = { receive: 'รับเข้า', issue: 'เบิกใช้', transfer: 'ย้ายตำแหน่ง', adjustment: 'ปรับยอด', reversal: 'ย้อนรายการ', expired_disposal: 'กำจัดหมดอายุ' };
export const stockStatusLabels: Labels = { stockout: 'หมดสต็อก', 'below ROP': 'ต่ำกว่า ROP', adequate: 'เพียงพอ', 'ต้องตั้งค่า': 'ยังไม่ตั้ง ROP' };
export const productTypeLabels: Labels = { reagent: 'Reagent', calibrator: 'Calibrator', control: 'Control', consumable: 'Consumable' };
export const roleLabels: Labels = { admin: 'ผู้ดูแลระบบ', supervisor: 'หัวหน้างาน', staff: 'เจ้าหน้าที่', viewer: 'ดูอย่างเดียว' };
export const roleShortLabels: Labels = { admin: 'แอดมิน', supervisor: 'หัวหน้า', staff: 'เจ้าหน้าที่', viewer: 'ดู' };
export const invoiceStatusLabels: Labels = { open: 'เปิดรับ', closed: 'รับครบแล้ว', closed_short: 'ปิดแบบรับไม่ครบ', cancelled: 'ยกเลิก' };
export const countStatusLabels: Labels = { draft: 'กำลังนับ', approved: 'อนุมัติแล้ว', stale: 'ต้องนับใหม่', cancelled: 'ยกเลิก' };
export const issueStatusLabels: Labels = { open: 'รอดำเนินการ', resolved: 'แก้ไขแล้ว', cancelled: 'ยกเลิก' };
export const mappingStatusLabels: Labels = { proposed: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ' };
export const relationTypeLabels: Labels = { uses_calibrator: 'ใช้ Calibrator', uses_control: 'ใช้ Control', uses_consumable: 'ใช้ Consumable', compatible_with: 'ใช้ร่วมกันได้', replacement_for: 'ใช้แทนกันได้', other: 'อื่น ๆ' };
export const auditActionLabels: Labels = { INSERT: 'สร้าง', CREATE: 'สร้าง', UPDATE: 'แก้ไข', DELETE: 'ลบ', CONFIRM: 'ยืนยัน', ACTIVATE: 'เปิดใช้งาน', DEACTIVATE: 'ปิดการใช้งาน', CLOSE_SHORT: 'ปิดแบบรับไม่ครบ', REOPEN_AFTER_RECEIPT_REVERSAL: 'เปิด Invoice ใหม่หลังย้อนรายการ', PROVISION: 'ตั้งค่าผู้ใช้', BOOTSTRAP_ADMIN: 'สร้างผู้ดูแลคนแรก', REVISE: 'แก้ไขผลตรวจรับ', ANNUAL_DRAFT_CREATED: 'สร้างฉบับร่างรายงานประจำปี', ANNUAL_FINALIZED: 'สิ้นสุดรายงานประจำปี', POLICY_PROPOSAL_SAVED: 'บันทึกข้อเสนอนโยบาย', POLICY_APPROVED: 'อนุมัตินโยบาย', SIGNATURE_SAVED: 'บันทึกลายเซ็น', POSITION_SET: 'กำหนดตำแหน่ง' };
export const entityTableLabels: Labels = {
  ci_products: 'สินค้า', ci_product_identifiers: 'Barcode / REF', ci_product_relations: 'ความสัมพันธ์สินค้า', ci_platform_product_mappings: 'Platform',
  ci_stock_transactions: 'ธุรกรรมสต็อก', ci_stock_lots: 'LOT', ci_stock_counts: 'ตรวจนับ', ci_locations: 'ตำแหน่ง', ci_reorder_settings: 'ตั้งค่า ROP',
  ci_invoices: 'Invoice', ci_receipts: 'การรับเข้า', ci_receipt_assessments: 'ผลตรวจรับ', ci_vendors: 'ผู้ขาย', ci_vendor_issues: 'ปัญหาผู้ขาย', ci_vendor_evaluations: 'ประเมินผู้ขาย (เดิม)', ci_vendor_annual_evaluations: 'รายงานประเมินประจำปี', ci_vendor_evaluation_policies: 'นโยบายประเมินผู้ขาย', ci_vendor_issue_attachments: 'หลักฐานปัญหาผู้ขาย', ci_user_signatures: 'ลายเซ็น',
  ci_user_profiles: 'ผู้ใช้', ci_user_access: 'สิทธิ์ผู้ใช้', ci_identifier_mapping_requests: 'คำขอจับคู่ Barcode', ci_attachments: 'เอกสารแนบ', ci_import_batches: 'นำเข้าข้อมูล',
};

export function label(labels: Labels, value: string | null | undefined) {
  if (value == null || value === '') return '—';
  return labels[value] ?? value;
}
