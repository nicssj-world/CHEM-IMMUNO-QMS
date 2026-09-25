// Server components run in UTC on Vercel, so every user-facing time is pinned to Bangkok.
// Gregorian years keep dates comparable with LOT expiry printed on packaging and with the fiscal year shown in the app.
const dateTimeFormat = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
const dateFormat = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });
const monthFormat = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' });

function toDate(value: string | Date) {
  // A bare YYYY-MM-DD is a calendar date; noon UTC keeps it on the same day in Bangkok.
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
}

export function formatDateTime(value: string | Date | null | undefined) {
  if (!value) return '—';
  const date = toDate(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateTimeFormat.format(date);
}

export function formatDate(value: string | Date | null | undefined) {
  if (!value) return '—';
  const date = toDate(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateFormat.format(date);
}

/** `2026-09` → `กันยายน 2026` */
export function formatMonth(value: string) {
  return /^\d{4}-\d{2}$/.test(value) ? monthFormat.format(new Date(`${value}-15T12:00:00Z`)) : value;
}

// Vendor evaluation reports use พ.ศ. dates like LABCBH-Stock; the rest of the app stays Gregorian.
const dateBE = new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });
const dateTimeBE = new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
export function formatDateBE(value: string | Date | null | undefined) {
  if (!value) return '—';
  const date = toDate(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateBE.format(date);
}
export function formatDateTimeBE(value: string | Date | null | undefined) {
  if (!value) return '—';
  const date = toDate(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateTimeBE.format(date);
}
