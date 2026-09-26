// Location QR codes carry one stable, random, revocable token in a plain application URL: {origin}/q/{token}.
// The token is only a lookup key. Scanning it still goes through login and row-level security, so it grants nothing by itself.
// Pure module (no qrcode import) so the barcode scanner guard and unit tests can use it.
import type { ParsedBarcode } from './barcode';

export const LOCATION_QR_TOKEN = /^[0-9a-f]{32}$/;
export const DEFAULT_APP_ORIGIN = 'https://chem-immuno-cbh.vercel.app';

export function isLocationQrToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && LOCATION_QR_TOKEN.test(value);
}

/**
 * The origin printed on labels. It comes from configuration, never from the request Host header, so a label printed from a
 * developer machine or a preview deployment still points at the real app.
 */
export function appOrigin(configured: string | undefined = process.env.NEXT_PUBLIC_APP_ORIGIN): string {
  const text = (configured ?? '').trim();
  if (!text) return DEFAULT_APP_ORIGIN;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return DEFAULT_APP_ORIGIN;
    return url.origin;
  } catch { return DEFAULT_APP_ORIGIN; }
}

export function locationQrPath(token: string) { return `/q/${token}`; }

export function locationQrUrl(token: string, origin: string = appOrigin()) { return `${origin}${locationQrPath(token)}`; }

/**
 * A scanned text that is exactly a Location QR: an http(s) URL whose path is /q/{32 lower-case hex}. The host is ignored on
 * purpose (labels printed before an origin change must still be recognised) and never followed: the returned path is always
 * relative to this app.
 */
export function detectLocationQr(raw: string | null | undefined): { token: string; path: string } | null {
  const text = (raw ?? '').trim();
  const match = /^https?:\/\/[^/?#\s]+\/q\/([0-9a-f]{32})\/?$/.exec(text);
  return match ? { token: match[1], path: locationQrPath(match[1]) } : null;
}

/**
 * Broader than detectLocationQr: any text that carries a Location QR token path `q/{32 hex}` (any case, any host or none, with
 * or without a scheme, a hardware scanner's AIM prefix such as `]Q1`, a query or a fragment). Used to refuse treating such
 * text as a product barcode or a mapping proposal, so an unusual copy of a location label can never become a barcode.
 * The `q/` must start a path segment and the token must end one, so ordinary GS1/HIBC/manufacturer barcodes never match.
 */
export function looksLikeLocationQr(raw: string | null | undefined): boolean {
  return /(?:^|[^0-9a-z])q\/[0-9a-f]{32}(?=$|[/?#\s])/i.test((raw ?? '').trim());
}

export const LOCATION_QR_SCAN_MESSAGE = 'นี่คือ QR ตำแหน่งจัดเก็บ · ไม่ใช่ Barcode สินค้า';

/**
 * The scanner guard. A scanned Location QR (a /q/{token} link) is never a product barcode: recognising it before any barcode
 * parsing means it can neither match a product nor become a barcode mapping proposal, and the caller does not record it as a
 * scan. The link is always relative to this app, whatever host the scanned text names. Returns null for anything else.
 */
export function locationQrScan(raw: string, symbology: string): { parsed: ParsedBarcode; locationQr: { path: string | null }; message: string } | null {
  if (!looksLikeLocationQr(raw)) return null;
  return { parsed: { raw, symbology, standard: 'UNKNOWN', warnings: [] }, locationQr: { path: detectLocationQr(raw)?.path ?? null }, message: LOCATION_QR_SCAN_MESSAGE };
}
