export type ExpiryBucket = 'EXPIRED' | '≤30' | '31–60' | '61–90' | '>90';

export function bangkokToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function expiryBucket(expiry: string, today = bangkokToday()): ExpiryBucket {
  const days = (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000;
  if (days < 0) return 'EXPIRED';
  if (days <= 30) return '≤30';
  if (days <= 60) return '31–60';
  if (days <= 90) return '61–90';
  return '>90';
}

export type StockRequirement = 'unclassified' | 'required' | 'on_demand';
export type StockStatus = 'stockout' | 'below ROP' | 'adequate' | 'ต้องตั้งค่า' | 'ต้องจัดประเภท' | 'ตามความต้องการ';

/** Inventory classification is explicit: a newly registered product is not automatically a stockout. */
export function stockStatus(usable: number, rop: number | null, requirement: StockRequirement): StockStatus {
  if (requirement === 'unclassified') return 'ต้องจัดประเภท';
  if (requirement === 'on_demand') return 'ตามความต้องการ';
  if (usable <= 0) return 'stockout';
  if (rop === null || !Number.isFinite(rop)) return 'ต้องตั้งค่า';
  // At the reorder point it is time to replenish, not after falling below it.
  return usable <= rop ? 'below ROP' : 'adequate';
}

export function fiscalYear(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month >= 10 ? year + 1 : year;
}

export type ReorderAttention = 'unclassified' | 'on_demand' | 'stockout' | 'below' | 'no-rop' | 'ok';

/** The same three-way stocking policy applies across dashboard, reports and attention.
 * A required reagent with zero usable stock is urgent even if its ROP is not yet set.
 */
export function reorderAttention(usable: number, rop: number | null, requirement: StockRequirement): ReorderAttention {
  if (requirement === 'unclassified') return 'unclassified';
  if (requirement === 'on_demand') return 'on_demand';
  if (usable <= 0) return 'stockout';
  if (rop === null || !Number.isFinite(rop)) return 'no-rop';
  return usable <= rop ? 'below' : 'ok';
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Buddhist-era fiscal year (1 Oct – 30 Sep), as vendor evaluation reports use: 2026-10-01 → 2570. */
export function fiscalYearBE(date: string): number { return fiscalYear(date) + 543; }
