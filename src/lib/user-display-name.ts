/** Profile display names must identify a person, not repeat their authorization role. */
const GENERIC_USER_NAMES = new Set([
  'admin', 'administrator', 'staff', 'supervisor', 'viewer',
  'ผู้ดูแลระบบ', 'เจ้าหน้าที่', 'หัวหน้างาน', 'ผู้ใช้งาน',
]);

export function isGenericUserName(name: string): boolean {
  return GENERIC_USER_NAMES.has(name.trim().toLocaleLowerCase('en-US'));
}
