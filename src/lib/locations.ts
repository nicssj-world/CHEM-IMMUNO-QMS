import { z } from 'zod';
import { portalUrlErrorMessages, validatePortalEquipmentUrl } from './portal-link';

// Location Master helpers shared by the list, form, detail and label pages. Pure: no database or framework imports.

export const LOCATION_TYPES = [
  { value: 'room', label: 'ห้อง', monitorable: true },
  { value: 'refrigerator', label: 'ตู้เย็น', monitorable: true },
  { value: 'freezer', label: 'ตู้แช่แข็ง', monitorable: true },
  { value: 'cabinet', label: 'ตู้เก็บ', monitorable: true },
  { value: 'shelf', label: 'ชั้นวาง', monitorable: false },
  { value: 'rack', label: 'แร็ค', monitorable: false },
  { value: 'bench', label: 'โต๊ะปฏิบัติการ', monitorable: false },
  { value: 'other', label: 'อื่น ๆ', monitorable: false },
] as const;
export type LocationType = (typeof LOCATION_TYPES)[number]['value'];
const typeValues = LOCATION_TYPES.map(type => type.value) as [LocationType, ...LocationType[]];

export function isLocationType(value: unknown): value is LocationType {
  return typeof value === 'string' && (typeValues as string[]).includes(value);
}
export function locationTypeLabel(type: string | null | undefined) {
  return LOCATION_TYPES.find(item => item.value === type)?.label ?? 'อื่น ๆ';
}
/** Room, refrigerator, freezer and cabinet are normally the monitored container; shelves, racks and benches inherit from their parent. */
export function isMonitorableType(type: string | null | undefined) {
  return LOCATION_TYPES.find(item => item.value === type)?.monitorable ?? false;
}

export type LocationRow = {
  id: string; warehouse_id: number; code: string; name: string; active: boolean; created_at: string; updated_at: string;
  location_type: string; parent_location_id: string | null; room: string | null; description: string | null; storage_condition: string | null;
  portal_equipment_url: string | null; portal_equipment_label: string | null; qr_token: string;
};
export type EnvConfigRow = {
  id: string; location_id: string; effective_from: string;
  temperature_monitored: boolean; temp_min_c: number | string | null; temp_max_c: number | string | null;
  humidity_monitored: boolean; rh_min_pct: number | string | null; rh_max_pct: number | string | null;
};

/** Every column the list, detail and edit pages read (never the audit-only ones). */
export const LOCATION_COLUMNS = 'id,warehouse_id,code,name,active,created_at,updated_at,location_type,parent_location_id,room,description,storage_condition,portal_equipment_url,portal_equipment_label,qr_token';
export const ENV_CONFIG_COLUMNS = 'id,location_id,effective_from,temperature_monitored,temp_min_c,temp_max_c,humidity_monitored,rh_min_pct,rh_max_pct';

/** `CHE-FR-01 › S1` for a shelf inside a refrigerator, `CHE-FR-01` for a top-level location. */
export function locationBreadcrumb(location: Pick<LocationRow, 'code' | 'parent_location_id'>, byId: ReadonlyMap<string, Pick<LocationRow, 'code'>>) {
  const parent = location.parent_location_id ? byId.get(location.parent_location_id) : undefined;
  return parent ? `${parent.code} › ${location.code}` : location.code;
}
/** Picker text: breadcrumb plus name. Selection still uses the location id, so nothing else about a picker changes. */
export function locationOptionLabel(location: Pick<LocationRow, 'code' | 'name' | 'parent_location_id'>, byId: ReadonlyMap<string, Pick<LocationRow, 'code'>>) {
  return `${locationBreadcrumb(location, byId)} · ${location.name}`;
}

/** Locations a location may be placed under: top-level, active, same warehouse, not itself, and only if it has no children of its own. */
export function parentOptions(locations: readonly LocationRow[], { warehouseId, selfId }: { warehouseId: number; selfId?: string }) {
  const hasChildren = selfId ? locations.some(location => location.parent_location_id === selfId) : false;
  if (hasChildren) return [];
  return locations.filter(location => location.warehouse_id === warehouseId && location.parent_location_id === null && location.active && location.id !== selfId);
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------
function toNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
const plain = (value: number) => String(Number(value.toFixed(2)));

/** `2 – 8 °C`, `≥ 15 °C`, `≤ -20 °C`; null when neither bound is set. Trailing zeros are dropped (2.00 → 2). */
export function formatRange(min: number | string | null | undefined, max: number | string | null | undefined, unit: string) {
  const low = toNumber(min);
  const high = toNumber(max);
  if (low !== null && high !== null) return `${plain(low)} – ${plain(high)} ${unit}`;
  if (low !== null) return `≥ ${plain(low)} ${unit}`;
  if (high !== null) return `≤ ${plain(high)} ${unit}`;
  return null;
}
export function describeEnvConfig(config: Pick<EnvConfigRow, 'temperature_monitored' | 'temp_min_c' | 'temp_max_c' | 'humidity_monitored' | 'rh_min_pct' | 'rh_max_pct'> | null | undefined) {
  return {
    temperature: config?.temperature_monitored ? formatRange(config.temp_min_c, config.temp_max_c, '°C') : null,
    humidity: config?.humidity_monitored ? formatRange(config.rh_min_pct, config.rh_max_pct, '%RH') : null,
  };
}

/** Lab staff type `2.5`, `2,5` or `−20`; phones show a Unicode minus. Returns null for blank and NaN for text that is not a number. */
export function parseDecimalInput(text: string | null | undefined): number | null {
  const value = (text ?? '').trim().replace(/[−–—]/g, '-').replace(',', '.');
  if (value === '') return null;
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return Number.NaN;
  return Math.round(Number(value) * 100) / 100;
}

export type EnvConfigInput = { temperature_monitored: boolean; temp_min_c: number | null; temp_max_c: number | null; humidity_monitored: boolean; rh_min_pct: number | null; rh_max_pct: number | null };
export const NO_ENV_CONFIG: EnvConfigInput = { temperature_monitored: false, temp_min_c: null, temp_max_c: null, humidity_monitored: false, rh_min_pct: null, rh_max_pct: null };

// ---------------------------------------------------------------------------
// Form validation (the database re-checks every rule; this gives per-field messages before the round trip)
// ---------------------------------------------------------------------------
const nullableText = (max: number) => z.string().trim().max(max, `ยาวเกิน ${max} ตัวอักษร`).transform(value => (value === '' ? null : value));
const bound = z.number({ error: 'ตัวเลขไม่ถูกต้อง' }).nullable();

const envSchema = z.object({
  temperature_monitored: z.boolean(), temp_min_c: bound, temp_max_c: bound,
  humidity_monitored: z.boolean(), rh_min_pct: bound, rh_max_pct: bound,
}).superRefine((env, ctx) => {
  const check = (on: boolean, min: number | null, max: number | null, lo: number, hi: number, minKey: string, maxKey: string, unit: string) => {
    if (!on) {
      if (min !== null) ctx.addIssue({ code: 'custom', path: [minKey], message: 'ปิดการเฝ้าระวังอยู่ จึงไม่ต้องระบุค่า' });
      if (max !== null) ctx.addIssue({ code: 'custom', path: [maxKey], message: 'ปิดการเฝ้าระวังอยู่ จึงไม่ต้องระบุค่า' });
      return;
    }
    if (min === null && max === null) ctx.addIssue({ code: 'custom', path: [minKey], message: `ระบุค่าต่ำสุดหรือสูงสุดอย่างน้อยหนึ่งค่า (${unit})` });
    for (const [key, value] of [[minKey, min], [maxKey, max]] as const) {
      if (value !== null && (value < lo || value > hi)) ctx.addIssue({ code: 'custom', path: [key], message: `ต้องอยู่ระหว่าง ${lo} ถึง ${hi} ${unit}` });
    }
    if (min !== null && max !== null && min >= max) ctx.addIssue({ code: 'custom', path: [minKey], message: 'ค่าต่ำสุดต้องน้อยกว่าค่าสูงสุด' });
  };
  check(env.temperature_monitored, env.temp_min_c, env.temp_max_c, -100, 100, 'temp_min_c', 'temp_max_c', '°C');
  check(env.humidity_monitored, env.rh_min_pct, env.rh_max_pct, 0, 100, 'rh_min_pct', 'rh_max_pct', '%RH');
});
export function validateEnvConfig(input: EnvConfigInput) {
  const parsed = envSchema.safeParse(input);
  return parsed.success ? { ok: true as const, value: parsed.data as EnvConfigInput } : { ok: false as const, errors: flattenIssues(parsed.error.issues) };
}

const locationShape = z.object({
  code: z.string().trim().min(1, 'กรุณาระบุรหัสตำแหน่ง').max(40, 'รหัสยาวเกิน 40 ตัวอักษร'),
  name: z.string().trim().min(1, 'กรุณาระบุชื่อตำแหน่ง').max(120, 'ชื่อยาวเกิน 120 ตัวอักษร'),
  location_type: z.enum(typeValues, { error: 'ประเภทตำแหน่งไม่ถูกต้อง' }),
  parent_location_id: z.union([z.literal(''), z.uuid('ตำแหน่งแม่ไม่ถูกต้อง')]).transform(value => (value === '' ? null : value)),
  room: nullableText(120),
  description: nullableText(1000),
  storage_condition: nullableText(120),
  portal_equipment_url: nullableText(500),
  portal_equipment_label: nullableText(120),
});
export type LocationFormValue = z.output<typeof locationShape> & { env: EnvConfigInput };

function flattenIssues(issues: readonly { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) { const key = String(issue.path[0] ?? 'form'); errors[key] ??= issue.message; }
  return errors;
}
const formText = (form: FormData, key: string) => String(form.get(key) ?? '');
const formFlag = (form: FormData, key: string) => form.get(key) === 'on';
function formNumber(form: FormData, key: string): number | null | undefined {
  const parsed = parseDecimalInput(formText(form, key));
  return parsed !== null && Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Turns the location form into the RPC payload. Rooms, refrigerators, freezers and cabinets take their monitoring toggles
 * directly; shelves, racks, benches and other types only when the explicit "own monitoring" override is ticked, otherwise
 * they inherit from their parent and their own configuration is switched off.
 */
export function parseLocationForm(form: FormData, portalHosts?: readonly string[]): { ok: true; value: LocationFormValue } | { ok: false; errors: Record<string, string> } {
  const base = locationShape.safeParse({
    code: formText(form, 'code'), name: formText(form, 'name'), location_type: formText(form, 'location_type') || 'other',
    parent_location_id: formText(form, 'parent_location_id'), room: formText(form, 'room'), description: formText(form, 'description'),
    storage_condition: formText(form, 'storage_condition'), portal_equipment_url: formText(form, 'portal_equipment_url'),
    portal_equipment_label: formText(form, 'portal_equipment_label'),
  });
  const errors: Record<string, string> = base.success ? {} : flattenIssues(base.error.issues);

  const type = base.success ? base.data.location_type : 'other';
  const monitoringAllowed = isMonitorableType(type) || formFlag(form, 'own_monitoring');
  let env: EnvConfigInput = NO_ENV_CONFIG;
  if (monitoringAllowed) {
    const numbers = { temp_min_c: formNumber(form, 'temp_min_c'), temp_max_c: formNumber(form, 'temp_max_c'), rh_min_pct: formNumber(form, 'rh_min_pct'), rh_max_pct: formNumber(form, 'rh_max_pct') };
    for (const [key, value] of Object.entries(numbers)) if (value === undefined) errors[key] ??= 'ตัวเลขไม่ถูกต้อง';
    const candidate: EnvConfigInput = {
      temperature_monitored: formFlag(form, 'temperature_monitored'), temp_min_c: numbers.temp_min_c ?? null, temp_max_c: numbers.temp_max_c ?? null,
      humidity_monitored: formFlag(form, 'humidity_monitored'), rh_min_pct: numbers.rh_min_pct ?? null, rh_max_pct: numbers.rh_max_pct ?? null,
    };
    const checked = validateEnvConfig(candidate);
    if (checked.ok) env = checked.value; else for (const [key, message] of Object.entries(checked.errors)) errors[key] ??= message;
  }

  let portalUrl: string | null = base.success ? base.data.portal_equipment_url : null;
  if (portalUrl) {
    const checked = validatePortalEquipmentUrl(portalUrl, portalHosts);
    if (checked.ok) portalUrl = checked.url; else errors.portal_equipment_url ??= portalUrlErrorMessages[checked.reason];
  }
  if (base.success && !portalUrl && base.data.portal_equipment_label) errors.portal_equipment_label ??= 'ระบุชื่อเครื่องมือได้เมื่อมีลิงก์ Portal';

  if (!base.success || Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { ...base.data, portal_equipment_url: portalUrl, env } };
}

// ---------------------------------------------------------------------------
// Stock on a location, derived from the signed ledger (never stored on the location)
// ---------------------------------------------------------------------------
export type BalanceRow = { product_id: string; lot_id: string; lot_number: string; expiry_date: string; location_id: string; balance: number | string };
export type StockProduct = { id: string; product_code: string; display_name: string; base_stock_unit: string | null };
export type LocationStockRow = { key: string; product_id: string; product_code: string; product_name: string; unit: string | null; lot_number: string; expiry_date: string; location_id: string; location_code: string; quantity: number };

/** Non-zero balances for the given locations (a container and its direct children), oldest expiry first. */
export function buildLocationStock(balances: readonly BalanceRow[], products: readonly StockProduct[], locationCodes: ReadonlyMap<string, string>): LocationStockRow[] {
  const productById = new Map(products.map(product => [product.id, product]));
  return balances
    .filter(row => Number(row.balance) !== 0 && locationCodes.has(row.location_id))
    .map(row => {
      const product = productById.get(row.product_id);
      return {
        key: `${row.lot_id}:${row.location_id}`, product_id: row.product_id, product_code: product?.product_code ?? '—', product_name: product?.display_name ?? '',
        unit: product?.base_stock_unit ?? null, lot_number: row.lot_number, expiry_date: row.expiry_date, location_id: row.location_id,
        location_code: locationCodes.get(row.location_id) ?? '—', quantity: Number(row.balance),
      };
    })
    .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date) || a.product_code.localeCompare(b.product_code) || a.lot_number.localeCompare(b.lot_number) || a.location_code.localeCompare(b.location_code));
}
