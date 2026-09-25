// Vendor issue vocabulary and record shape, ported from LABCBH-Stock lib/vendor-evaluation (schema.ts, presenter.ts).

export const VENDOR_ISSUE_TYPES = ['packaging_damage', 'documentation_discrepancy', 'temperature_out_of_range', 'complaint', 'quantity_discrepancy', 'expiry_non_compliant', 'item_discrepancy', 'other'] as const;
export const ISSUE_RESOLUTION_ACTIONS = ['vendor_replaced_goods', 'vendor_supplied_documents', 'vendor_clarified_accepted', 'credit_note_received', 'verified_no_impact', 'vendor_warned', 'other'] as const;
export const ISSUE_MANUAL_CANCEL_REASONS = ['duplicate', 'opened_in_error', 'other'] as const;
export const VENDOR_ISSUE_BUCKET = 'ci-vendor-issues';
export const ISSUE_FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export const ISSUE_FILE_MAX_BYTES = 10 * 1024 * 1024;

export const ISSUE_TYPE_LABELS: Record<string, string> = {
  packaging_damage: 'สภาพสินค้า / บรรจุภัณฑ์', documentation_discrepancy: 'เอกสารไม่ครบหรือไม่ถูกต้อง', temperature_out_of_range: 'อุณหภูมิไม่เหมาะสม',
  complaint: 'ข้อร้องเรียน', quantity_discrepancy: 'จำนวนส่งมอบไม่ครบ', expiry_non_compliant: 'อายุสินค้าไม่เป็นไปตามเกณฑ์', item_discrepancy: 'รายการสินค้าไม่ถูกต้อง', other: 'ปัญหาอื่น',
};
export const ISSUE_SOURCE_LABELS: Record<string, string> = {
  assessment: 'ผลตรวจรับ', receipt_line: 'รายการรับเข้า', invoice_closure: 'ปิด Invoice แบบรับไม่ครบ', manual: 'บันทึกโดยเจ้าหน้าที่',
};
export const ISSUE_RESOLUTION_LABELS: Record<string, string> = {
  vendor_replaced_goods: 'ผู้ขายเปลี่ยนสินค้า', vendor_supplied_documents: 'ผู้ขายส่งเอกสารเพิ่มเติม', vendor_clarified_accepted: 'ผู้ขายชี้แจงและยอมรับได้',
  credit_note_received: 'ได้รับใบลดหนี้', verified_no_impact: 'ตรวจสอบแล้วไม่มีผลกระทบ', vendor_warned: 'แจ้งเตือนผู้ขายแล้ว', other: 'การแก้ไขอื่น',
};
export const ISSUE_CANCEL_REASON_LABELS: Record<string, string> = {
  duplicate: 'รายการซ้ำ', opened_in_error: 'เปิดรายการผิด', other: 'เหตุผลอื่น', assessment_corrected: 'แก้ไขผลตรวจรับแล้ว (ยกเลิกอัตโนมัติ)', invoice_reopened: 'Invoice ถูกเปิดใหม่ (ยกเลิกอัตโนมัติ)',
};
export const ISSUE_STATUS_LABELS: Record<string, string> = { open: 'รอดำเนินการ', resolved: 'แก้ไขแล้ว', cancelled: 'ยกเลิก' };

export type VendorIssue = {
  id: string; vendor_id: string; warehouse_id: number; invoice_id: string | null; receipt_id: string | null; description: string; status: string;
  issue_type: string; source_kind: string; resolution_action: string | null; resolution_note: string | null; cancelled_reason: string | null; cancelled_note: string | null;
  created_at: string; resolved_at: string | null; cancelled_at: string | null;
};
export const ISSUE_COLUMNS = 'id,vendor_id,warehouse_id,invoice_id,receipt_id,description,status,issue_type,source_kind,resolution_action,resolution_note,cancelled_reason,cancelled_note,created_at,resolved_at,cancelled_at';
export type IssueAttachment = { id: string; issue_id: string; file_name: string; size_bytes: number; uploaded_at: string };
