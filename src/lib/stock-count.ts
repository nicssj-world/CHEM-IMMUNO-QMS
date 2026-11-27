// Pure rules for the physical-count checklist. No I/O here, so every rule is unit-tested.

export type CountMemberStatus = 'draft' | 'approved' | 'stale' | 'cancelled' | string;
export type CountProgress = { total: number; counted: number; variance: number; recount: number };
export type RoundState = 'counting' | 'complete' | 'partial' | 'recheck' | 'cancelled' | 'unreadable';

export const roundStateLabels: Record<RoundState, string> = {
  counting: 'กำลังตรวจนับ',
  complete: 'ตรวจครบแล้ว',
  partial: 'ตรวจบางส่วน',
  recheck: 'ต้องตรวจสอบใหม่',
  cancelled: 'ยกเลิก',
  unreadable: 'อ่านสถานะไม่ได้',
};

/** Maps the stored member statuses (and line progress) to the one state a lab user sees. */
export function roundState(statuses: readonly (CountMemberStatus | undefined)[], progress: CountProgress): RoundState {
  if (!statuses.length || statuses.some(status => !status)) return 'unreadable';
  if (statuses.every(status => status === 'approved')) return progress.counted < progress.total ? 'partial' : 'complete';
  if (statuses.some(status => status === 'stale')) return 'recheck';
  if (statuses.every(status => status === 'cancelled')) return 'cancelled';
  if (statuses.every(status => status === 'draft')) return progress.recount > 0 ? 'recheck' : 'counting';
  return 'unreadable';
}

/** A round may still be removed only while nothing in it adjusted stock (the database re-checks this). */
export function roundDeletable(statuses: readonly (CountMemberStatus | undefined)[]) {
  return statuses.length > 0 && statuses.every(status => status && status !== 'approved');
}

export function roundEditable(statuses: readonly (CountMemberStatus | undefined)[]) {
  return statuses.length > 0 && statuses.every(status => status === 'draft');
}

export type CountScopeType = 'all' | 'locations' | 'group' | 'products';
export function scopeLabel(type: string | null | undefined, scope: { warehouse_id?: number; location_ids?: unknown[]; product_ids?: unknown[] } | null | undefined, groupNames: Record<number, string> = { 1: 'CHEM', 2: 'IMMUNO' }) {
  switch (type) {
    case 'locations': return `เฉพาะตำแหน่ง (${scope?.location_ids?.length ?? 0} ตำแหน่ง)`;
    case 'group': return `เฉพาะกลุ่ม ${groupNames[Number(scope?.warehouse_id)] ?? ''}`.trim();
    case 'products': return `เลือกน้ำยา (${scope?.product_ids?.length ?? 0} รายการ)`;
    default: return 'น้ำยาทั้งหมด';
  }
}

export type ScopeBalance = { warehouse_id: number; product_id: string; lot_id: string; location_id: string };
export type ScopeLocation = { id: string; parent_location_id: string | null };
export type ScopeChoice = { type: CountScopeType; warehouseId?: number; locationIds?: string[]; productIds?: string[] };

/**
 * Lines a new round will contain: one per LOT and location with stock, exactly like the database
 * snapshot (a selected refrigerator includes the shelves inside it).
 */
export function scopeLineCount(balances: readonly ScopeBalance[], choice: ScopeChoice, locations: readonly ScopeLocation[]) {
  let locationSet: Set<string> | null = null;
  if (choice.type === 'locations') {
    const chosen = new Set(choice.locationIds ?? []);
    locationSet = new Set(locations.filter(l => chosen.has(l.id) || (l.parent_location_id !== null && chosen.has(l.parent_location_id))).map(l => l.id));
  }
  const products = choice.type === 'products' ? new Set(choice.productIds ?? []) : null;
  const keys = new Set<string>();
  for (const row of balances) {
    if (choice.type === 'group' && Number(row.warehouse_id) !== Number(choice.warehouseId)) continue;
    if (locationSet && !locationSet.has(row.location_id)) continue;
    if (products && !products.has(row.product_id)) continue;
    keys.add(`${row.lot_id}:${row.location_id}`);
  }
  return keys.size;
}

// ---------------------------------------------------------------------------
// Quantity input
// ---------------------------------------------------------------------------
export type QuantityParse = { ok: true; value: number } | { ok: false; message: string };

/** Empty is never 0, and negative / non-numeric input is refused rather than coerced. */
export function parseCountQuantity(raw: string): QuantityParse {
  const text = raw.trim().replace(/,/g, '');
  if (!text) return { ok: false, message: 'กรอกยอดตรวจนับจริง (กรอก 0 ได้)' };
  if (!/^\d+(\.\d{1,3})?$/.test(text)) return { ok: false, message: 'กรอกเป็นตัวเลข 0 ขึ้นไป ไม่เกินทศนิยม 3 ตำแหน่ง' };
  const value = Number(text);
  if (!Number.isFinite(value) || value > 100_000_000) return { ok: false, message: 'จำนวนมากเกินไป' };
  return { ok: true, value };
}

/** +/− buttons: whole steps, never below zero. A blank field starts from the stock figure. */
export function stepQuantity(raw: string, delta: 1 | -1, fallback: number) {
  const parsed = parseCountQuantity(raw);
  const base = parsed.ok ? parsed.value : fallback;
  const next = Math.max(0, Math.round((base + delta) * 1000) / 1000);
  return formatQuantity(next);
}

export function formatQuantity(value: number) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

export function variance(physical: number | null, snapshot: number) {
  return physical === null ? null : Math.round((physical - snapshot) * 1000) / 1000;
}

export function varianceText(diff: number | null) {
  if (diff === null) return '';
  if (diff === 0) return 'ยอดตรงกับระบบ';
  return diff > 0 ? `เกิน +${formatQuantity(diff)}` : `ขาด −${formatQuantity(Math.abs(diff))}`;
}

// ---------------------------------------------------------------------------
// Checklist lines: search, tabs, grouping and summary
// ---------------------------------------------------------------------------
export type ChecklistLine = {
  id: string; countId: string; warehouseId: number;
  productCode: string; productName: string; unit: string;
  lotNumber: string; expiryDate: string | null;
  locationCode: string; locationName: string;
  snapshot: number; physical: number | null; counted: boolean; needsRecount: boolean;
};

export function normalizeSearch(value: string) {
  return value.normalize('NFC').toLocaleLowerCase('th-TH').replace(/\s+/g, ' ').trim();
}

export function matchesCountQuery(line: ChecklistLine, query: string) {
  const needle = normalizeSearch(query);
  if (!needle) return true;
  const hay = normalizeSearch([line.productCode, line.productName, line.lotNumber, line.locationCode, line.locationName].join(' '));
  return needle.split(' ').every(part => hay.includes(part));
}

export type CountTab = 'pending' | 'counted' | 'all';
export function inTab(line: ChecklistLine, tab: CountTab) {
  return tab === 'all' || (tab === 'counted' ? line.counted : !line.counted);
}

const collator = new Intl.Collator('th-TH', { numeric: true, sensitivity: 'base' });
export function compareLines(a: ChecklistLine, b: ChecklistLine) {
  return collator.compare(a.locationCode, b.locationCode)
    || collator.compare(a.productCode, b.productCode)
    || collator.compare(a.productName, b.productName)
    || collator.compare(a.lotNumber, b.lotNumber)
    || a.id.localeCompare(b.id);
}

/** Lines grouped by storage location, so a counter walks one fridge or cabinet at a time. */
export function groupByLocation(lines: readonly ChecklistLine[]) {
  const groups = new Map<string, { code: string; name: string; lines: ChecklistLine[] }>();
  for (const line of [...lines].sort(compareLines)) {
    const group = groups.get(line.locationCode) ?? { code: line.locationCode, name: line.locationName, lines: [] };
    group.lines.push(line);
    groups.set(line.locationCode, group);
  }
  return [...groups.values()];
}

export function summarize(lines: readonly ChecklistLine[]) {
  let counted = 0, match = 0, over = 0, short = 0, recount = 0;
  for (const line of lines) {
    if (line.needsRecount && !line.counted) recount += 1;
    if (!line.counted) continue;
    counted += 1;
    const diff = variance(line.physical, line.snapshot) ?? 0;
    if (diff === 0) match += 1; else if (diff > 0) over += 1; else short += 1;
  }
  return { total: lines.length, counted, pending: lines.length - counted, match, over, short, adjust: over + short, recount,
    percent: lines.length ? Math.floor((counted / lines.length) * 100) : 0 };
}
