/** Barcode text is evidence. Parsing never changes the raw payload or creates a catalog identifier. */
export type ParsedBarcode = {
  raw: string;
  symbology: string;
  standard: 'GS1' | 'HIBC' | 'UNKNOWN';
  gtin?: string;
  additionalProductId?: string;
  pcn?: string;
  lot?: string;
  expiry?: string;
  serial?: string;
  quantity?: number;
  primary?: string;
  secondary?: string;
  warnings: string[];
};

const GS = '\x1d';
const DATE_FORMAT_LENGTH: Record<string, number> = { '0': 3, '1': 3, '2': 6, '3': 6, '4': 8, '5': 5, '6': 7, '7': 0 };
const HIBC_CHARACTERS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';

function date(year: number, month: number, day: number): string | undefined {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function yymmdd(value: string): string | undefined {
  if (!/^\d{6}$/.test(value)) return;
  const yy = Number(value.slice(0, 2));
  return date(yy >= 50 ? 1900 + yy : 2000 + yy, Number(value.slice(2, 4)), Number(value.slice(4, 6)));
}

function hibcExpiry(format: string, value: string): string | undefined {
  if (format === '2') return date(2000 + Number(value.slice(4)), Number(value.slice(0, 2)), Number(value.slice(2, 4)));
  if (format === '3') return yymmdd(value);
  if (format === '4') return Number(value.slice(6)) <= 23 ? yymmdd(value.slice(0, 6)) : undefined;
  if (format === '5' || format === '6') {
    if (format === '6' && Number(value.slice(5)) > 23) return;
    const year = 2000 + Number(value.slice(0, 2));
    const ordinal = Number(value.slice(2, 5));
    const d = new Date(Date.UTC(year, 0, ordinal));
    return ordinal > 0 && d.getUTCFullYear() === year ? date(year, d.getUTCMonth() + 1, d.getUTCDate()) : undefined;
  }
}

function hibcCheck(value: string): boolean {
  if (value.length < 3) return false;
  const body = value.slice(0, -1).toUpperCase();
  const values = [...body].map(char => HIBC_CHARACTERS.indexOf(char));
  return values.every(number => number >= 0) && HIBC_CHARACTERS[values.reduce((sum,number) => sum+number,0)%43] === value.slice(-1).toUpperCase();
}

function parseGs1(payload: string, result: ParsedBarcode) {
  result.standard = 'GS1';
  const text = payload.replace(/^\](?:C1|d2|e0)/, '').replace(/^(?:<GS>|<FNC1>|\x1d)+/, '').replace(/<GS>|<FNC1>|\{GS\}|\{FNC1\}|␝/g, GS);
  const seen = new Set<string>();
  const parenthesized = text.startsWith('(');
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] === GS) { cursor++; continue; }
    const match = parenthesized ? /^\((01|10|17|21|240)\)/.exec(text.slice(cursor)) : /^(01|10|17|21|240)/.exec(text.slice(cursor));
    if (!match) { result.warnings.push(`Unknown or malformed AI at offset ${cursor}`); return; }
    const ai = match[1];
    cursor += match[0].length;
    if (seen.has(ai)) { result.warnings.push(`Duplicate AI ${ai}`); return; }
    seen.add(ai);
    let value: string;
    if (ai === '01' || ai === '17') {
      const length = ai === '01' ? 14 : 6;
      value = text.slice(cursor, cursor + length);
      if (!/^\d+$/.test(value) || value.length !== length) { result.warnings.push(`Invalid AI ${ai}`); return; }
      cursor += length;
      if (parenthesized && cursor < text.length && text[cursor] !== '(') { result.warnings.push(`Missing AI boundary after ${ai}`); return; }
    } else {
      const end = parenthesized ? text.indexOf('(', cursor) : text.indexOf(GS, cursor);
      const bound = end < 0 ? text.length : end;
      value = text.slice(cursor, bound);
      cursor = bound;
      if (!parenthesized && cursor < text.length) cursor++;
      if (!value || value.length > 30) { result.warnings.push(`Invalid AI ${ai} length`); return; }
      if (!parenthesized && cursor < text.length && text[cursor - 1] !== GS) { result.warnings.push(`Missing FNC1 after AI ${ai}`); return; }
    }
    if (ai === '01') result.gtin = value;
    if (ai === '10') result.lot = value;
    if (ai === '21') result.serial = value;
    if (ai === '240') result.additionalProductId = value;
    if (ai === '17') {
      result.expiry = yymmdd(value);
      if (!result.expiry) { result.warnings.push('Invalid AI 17 expiry'); return; }
    }
  }
}

function parseHibc(payload: string, result: ParsedBarcode) {
  result.standard = 'HIBC';
  const text = payload.replace(/^\](?:A0|C0|d1)/, '').replace(/^\*/, '').replace(/\*$/, '').toUpperCase();
  if (!text.startsWith('+')) { result.warnings.push('Missing HIBC + prefix'); return; }
  if (!hibcCheck(text)) { result.warnings.push('HIBC Mod 43 check character failed'); return; }
  const parts = text.slice(1,-1).split('/');
  let secondary: string | undefined;
  if (parts[0].startsWith('$') || /^\d/.test(parts[0])) secondary = parts.shift();
  else {
    const primary = parts.shift();
    if (!primary || !/^[A-Z][A-Z0-9]{3}[A-Z0-9]{1,18}[0-9]$/.test(primary)) { result.warnings.push('Malformed HIBC primary'); return; }
    result.primary = primary;
    result.pcn = primary.slice(4,-1);
    secondary = parts.shift();
  }
  if (secondary) {
    // A standalone secondary retains the primary link character, while a
    // concatenated symbol omits it. The common final check was removed above.
    if (!result.primary) secondary = secondary.slice(0,-1);
    result.secondary = secondary;
    let serial=false;let format='7';let start=0;
    if (secondary.startsWith('$$+')) { serial=true;format=secondary[3];start=4; }
    else if (secondary.startsWith('$$')) { format=secondary[2];start=3; }
    else if (secondary.startsWith('$+')) { serial=true;start=2; }
    else if (secondary.startsWith('$')) start=1;
    else { result.warnings.push('Unsupported HIBC secondary format'); return; }
    const length=DATE_FORMAT_LENGTH[format];
    if (length===undefined || secondary.length<start+length || !/^\d*$/.test(secondary.slice(start,start+length))) { result.warnings.push('Malformed HIBC secondary date'); return; }
    const encodedDate=secondary.slice(start,start+length);
    if (length) {
      result.expiry=hibcExpiry(format,encodedDate);
      if (!result.expiry) result.warnings.push('HIBC expiry needs manual review');
    }
    const identity=secondary.slice(start+length);
    if (!identity || identity.length>18) { result.warnings.push('Malformed HIBC LOT/serial'); return; }
    if (serial) result.serial=identity;
    else result.lot=identity;
  }
  for (const part of parts) {
    if (/^Q\d{1,5}$/.test(part)) result.quantity=Number(part.slice(1));
    else if (/^S.{1,18}$/.test(part)) result.serial=part.slice(1);
    else if (/^14D\d{8}$/.test(part)) {
      result.expiry=date(Number(part.slice(3,7)),Number(part.slice(7,9)),Number(part.slice(9,11)));
      if (!result.expiry) result.warnings.push('Invalid HIBC 14D expiry');
    } else if (/^16D\d{8}$/.test(part)) {
      if (!date(Number(part.slice(3,7)),Number(part.slice(7,9)),Number(part.slice(9,11)))) result.warnings.push('Invalid HIBC 16D manufacture date');
    } else if (part) result.warnings.push(`Unsupported HIBC supplemental field: ${part}`);
  }
}

export function parseBarcode(raw: string, symbology = 'manual'): ParsedBarcode {
  const result: ParsedBarcode = { raw, symbology, standard: 'UNKNOWN', warnings: [] };
  const text = raw.trim();
  if (!text) { result.warnings.push('Empty barcode'); return result; }
  if (/^\](?:C1|d2|e0)/.test(text) || /^(?:\x1d|<GS>)?\(?01\)?\d{14}/.test(text)) parseGs1(text, result);
  else if (/^(?:\](?:A0|C0|d1))?\*?\+/.test(text)) parseHibc(text, result);
  else result.warnings.push('Unrecognized barcode standard; use manual Product search');
  return result;
}
