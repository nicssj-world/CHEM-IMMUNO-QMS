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

export function stockStatus(usable: number, rop: number | null): 'stockout' | 'below ROP' | 'adequate' | 'ต้องตั้งค่า' {
  if (usable <= 0) return 'stockout';
  if (rop === null || !Number.isFinite(rop)) return 'ต้องตั้งค่า';
  return usable < rop ? 'below ROP' : 'adequate';
}

export function fiscalYear(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month >= 10 ? year + 1 : year;
}
