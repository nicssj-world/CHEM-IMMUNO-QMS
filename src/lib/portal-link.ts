// Portal equipment links are stored and shown, never fetched: CHEM-IMMUNO has no API, database or sync connection to the
// Lab Management Portal. Because the value is an arbitrary URL a supervisor typed, it is validated on the way in and again
// on the way out, and anything that fails is shown as an unavailable link instead of being navigated to.

export const DEFAULT_PORTAL_HOSTS = ['lab-management-cbh.vercel.app'];
export const PORTAL_URL_MAX_LENGTH = 500;

export type PortalUrlError = 'empty' | 'too_long' | 'invalid' | 'not_https' | 'credentials' | 'host' | 'port' | 'path';
export type PortalUrlResult = { ok: true; url: string } | { ok: false; reason: PortalUrlError };

/** Allowed hostnames (exact match, lower-case). Set PORTAL_ALLOWED_HOSTS to a comma-separated list to change the Portal domain. */
export function portalAllowedHosts(configured: string | undefined = process.env.PORTAL_ALLOWED_HOSTS): string[] {
  const hosts = (configured ?? '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  return hosts.length ? hosts : DEFAULT_PORTAL_HOSTS;
}

// The route segments are case-sensitive (Next.js routes are); only the hex digits of the equipment id may be either case.
const equipmentPath = /^\/staff\/equipment\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?:\/.*)?$/;

export function validatePortalEquipmentUrl(input: string | null | undefined, hosts: readonly string[] = portalAllowedHosts()): PortalUrlResult {
  const text = (input ?? '').trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > PORTAL_URL_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  // The URL parser silently drops tabs and newlines and trims control characters; refuse them instead of "repairing" them.
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return { ok: false, reason: 'invalid' };
  let url: URL;
  try { url = new URL(text); } catch { return { ok: false, reason: 'invalid' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  if (url.port) return { ok: false, reason: 'port' };
  // url.hostname is already lower-case and punycode-encoded, so an IDN look-alike never equals an allowed ASCII host.
  if (!hosts.includes(url.hostname)) return { ok: false, reason: 'host' };
  if (!equipmentPath.test(url.pathname)) return { ok: false, reason: 'path' };
  return { ok: true, url: url.href };
}

export const portalUrlErrorMessages: Record<PortalUrlError, string> = {
  empty: 'กรุณาระบุลิงก์',
  too_long: 'ลิงก์ยาวเกิน 500 ตัวอักษร',
  invalid: 'รูปแบบลิงก์ไม่ถูกต้อง',
  not_https: 'ลิงก์ต้องขึ้นต้นด้วย https://',
  credentials: 'ลิงก์ต้องไม่มีชื่อผู้ใช้หรือรหัสผ่าน',
  host: 'ลิงก์ต้องเป็นของ Lab Management Portal เท่านั้น',
  port: 'ลิงก์ต้องไม่ระบุพอร์ต',
  path: 'ลิงก์ต้องเป็นหน้าเครื่องมือของ Portal (/staff/equipment/…)',
};
