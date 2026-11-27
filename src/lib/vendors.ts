// Vendor master data, ported from LABCBH-Stock (lib/vendors/presenter.ts and schema.ts). Pure: no I/O.

export type VendorRecord = {
  id: string; vendor_code: string; name: string; legal_name: string | null; tax_id: string | null; tax_branch_code: string;
  address: string | null; contact_person: string | null; phone: string | null; email: string | null; note: string | null;
  active: boolean; created_at: string; updated_at: string;
};
export const VENDOR_COLUMNS = 'id,vendor_code,name,legal_name,tax_id,tax_branch_code,address,contact_person,phone,email,note,active,created_at,updated_at';

export type VendorInput = { vendorCode: string; name: string; legalName: string; taxId: string; taxBranchCode: string; address: string; contactPerson: string; phone: string; email: string; note: string };
export const VENDOR_FIELDS: (keyof VendorInput)[] = ['vendorCode', 'name', 'legalName', 'taxId', 'taxBranchCode', 'address', 'contactPerson', 'phone', 'email', 'note'];
const LIMITS: Record<keyof VendorInput, number> = { vendorCode: 80, name: 200, legalName: 300, taxId: 13, taxBranchCode: 5, address: 1000, contactPerson: 200, phone: 60, email: 200, note: 2000 };
const HEAD_OFFICE_BRANCH = '00000';

export function toVendorInput(vendor?: VendorRecord | null): VendorInput {
  return {
    vendorCode: vendor?.vendor_code ?? '', name: vendor?.name ?? '', legalName: vendor?.legal_name ?? '', taxId: vendor?.tax_id ?? '',
    taxBranchCode: vendor?.tax_branch_code ?? HEAD_OFFICE_BRANCH, address: vendor?.address ?? '', contactPerson: vendor?.contact_person ?? '',
    phone: vendor?.phone ?? '', email: vendor?.email ?? '', note: vendor?.note ?? '',
  };
}

/** Same rules the database enforces, checked first so mistakes come back in Thai before a round trip. */
export function vendorInputError(input: VendorInput): string | null {
  if (!input.vendorCode.trim()) return 'กรุณาระบุรหัสผู้ขาย';
  if (!input.name.trim()) return 'กรุณาระบุชื่อผู้ขาย';
  for (const field of VENDOR_FIELDS) if (input[field].length > LIMITS[field]) return 'ข้อมูลยาวเกินกำหนด';
  if (input.taxId.trim() && !/^[0-9]{13}$/.test(input.taxId.trim())) return 'เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก';
  if (input.taxBranchCode.trim() && !/^[0-9]{5}$/.test(input.taxBranchCode.trim())) return 'รหัสสาขาต้องเป็นตัวเลข 5 หลัก';
  if (input.email.trim() && !input.email.includes('@')) return 'รูปแบบอีเมลไม่ถูกต้อง';
  return null;
}

/** Only known fields, trimmed, so a posted payload cannot carry anything else. */
export function cleanVendorInput(value: unknown): VendorInput {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return Object.fromEntries(VENDOR_FIELDS.map(field => [field, typeof source[field] === 'string' ? (source[field] as string).trim() : ''])) as VendorInput;
}

export function formatTaxId(taxId: string | null): string {
  if (!taxId) return 'ไม่ระบุ';
  if (!/^[0-9]{13}$/.test(taxId)) return taxId;
  return `${taxId[0]}-${taxId.slice(1, 5)}-${taxId.slice(5, 10)}-${taxId.slice(10, 12)}-${taxId[12]}`;
}

export function formatTaxBranch(branchCode: string): string {
  return branchCode === HEAD_OFFICE_BRANCH ? 'สำนักงานใหญ่ (00000)' : `สาขา ${branchCode}`;
}

export function vendorStatusLabel(active: boolean) { return active ? 'ใช้งาน' : 'ปิดการใช้งาน'; }

/** "รหัส · ชื่อ": one line that says which vendor, and whether it can still be chosen. */
export function vendorOptionLabel(vendor: { vendor_code: string; name: string; active: boolean }) {
  return `${vendor.vendor_code} · ${vendor.name}${vendor.active ? '' : ' (ปิดการใช้งาน)'}`;
}

/** Vendor master is shared by both warehouses; LABCBH stock operators map to admin or supervisor in either one. */
export function canManageVendors(warehouses: { role: string }[]) {
  return warehouses.some(w => w.role === 'admin' || w.role === 'supervisor');
}
