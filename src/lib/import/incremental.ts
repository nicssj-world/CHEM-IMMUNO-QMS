import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { ProductType, WarehouseCode } from './types';

const SHEET_NAMES = [
  'Reagent list',
  'FOC item_chem c503 c703 ISE',
  'FOC item_Imm e801',
] as const;

const PLATFORM_ALIASES: Record<string, string> = {
  'cobas pro c503 / c703 / ise': 'c503_c703_ise',
  'cobas pro ise neo': 'ise_neo',
  'cobas pro c703': 'c703',
  'cobas e801 system': 'e801',
};

export type IncrementalDisposition = 'New' | 'Existing' | 'Update' | 'Conflict' | 'Duplicate in file';

export interface IncrementalCandidate {
  warehouse_code: WarehouseCode;
  source_name: string;
  product_type: ProductType | null;
  packing_size_raw: string | null;
  source_sheet: string;
  source_row: number;
  raw_source: Record<string, string | number | null>;
  ref_current: string;
  manufacturer_barcode: string;
  replaces_ref: string | null;
  used_with: string | null;
}

export interface IncrementalWorkbook {
  source_filename: string;
  source_sha256: string;
  rows: IncrementalCandidate[];
}

export interface IncrementalProduct {
  id: string;
  warehouse_id: number;
  product_code: string;
  product_type: ProductType;
  source_name: string;
  display_name: string;
  packing_size_raw: string | null;
  source_sheet: string | null;
  source_row: number | null;
  raw_source: Record<string, unknown> | null;
}

export interface IncrementalIdentifier {
  product_id: string;
  warehouse_id: number;
  kind: string;
  value: string;
  approved: boolean;
}

export interface IncrementalRelation {
  source_product_id: string;
  target_product_id: string;
  relation_type: string;
}

export interface IncrementalPlatform {
  id: string;
  warehouse_id: number;
  platform_key: string;
  display_name: string;
}

export interface IncrementalProductPlatform {
  product_id: string;
  platform_id: string;
}

export interface IncrementalMaster {
  products: IncrementalProduct[];
  identifiers: IncrementalIdentifier[];
  relations: IncrementalRelation[];
  platforms: IncrementalPlatform[];
  product_platforms: IncrementalProductPlatform[];
}

export interface IncrementalChange {
  field: string;
  current: unknown;
  imported: unknown;
}

export interface IncrementalPreviewRow {
  candidate: IncrementalCandidate;
  classification: IncrementalDisposition;
  product_id: string | null;
  match_method: string | null;
  match_snapshot: null;
  changes: IncrementalChange[];
  relation_product_ids: string[] | null;
  platform_keys: string[] | null;
  message: string | null;
}

export class IncrementalWorkbookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncrementalWorkbookError';
  }
}

function fail(message: string): never { throw new IncrementalWorkbookError(message); }

function cellValue(row: ExcelJS.Row, column: number): unknown {
  const value = row.getCell(column).value;
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  fail(`${row.worksheet.name}!${row.number}: unsupported value in column ${column}`);
}

function rawSource(row: ExcelJS.Row, reagent: boolean): Record<string, string | number | null> {
  return {
    no: cellValue(row, 1) as string | number | null,
    manufacturer_barcode: cellValue(row, 2) as string | number | null,
    ref_code: cellValue(row, 3) as string | number | null,
    name: cellValue(row, 4) as string | number | null,
    packing_size: cellValue(row, 5) as string | number | null,
    ...(reagent
      ? { remark: cellValue(row, 6) as string | number | null }
      : {
          type: cellValue(row, 6) as string | number | null,
          used_with: cellValue(row, 7) as string | number | null,
        }),
  };
}

function digitIdentifier(value: unknown, field: string, context: string, allowNumeric: boolean): string {
  if (typeof value !== 'string' && !(allowNumeric && typeof value === 'number' && Number.isSafeInteger(value))) {
    fail(`${context}: ${field} must be stored as text${allowNumeric ? ' or an integer' : ''}`);
  }
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) fail(`${context}: ${field} must contain digits only`);
  return normalized;
}

function parseType(value: unknown, sheet: ExcelJS.Worksheet, context: string): ProductType | null {
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim().toLowerCase();
    if (['reagent', 'calibrator', 'control', 'consumable'].includes(normalized)) return normalized as ProductType;
    fail(`${context}: unsupported Product Type`);
  }
  const sourceContext = `${String(sheet.getRow(1).getCell(1).value ?? '')} ${String(sheet.getRow(2).getCell(1).value ?? '')}`.toLowerCase();
  if (sourceContext.includes('consumable')) return 'consumable';
  return null;
}

function parseCandidate(row: ExcelJS.Row, warehouse: WarehouseCode, reagent: boolean): IncrementalCandidate | null {
  const ordinal = cellValue(row, 1);
  if (!Number.isInteger(ordinal) || Number(ordinal) <= 0) return null;
  const context = `${row.worksheet.name}!${row.number}`;
  const source = rawSource(row, reagent);
  const rawName = source.name;
  const rawRef = source.ref_code;
  if (typeof rawName !== 'string' || !rawName.trim()) fail(`${context}: Product Name is required`);
  const ref = digitIdentifier(rawRef, 'REF', context, false);
  const barcode = digitIdentifier(source.manufacturer_barcode, 'Manufacturer Barcode', context, true);
  const rawPacking = source.packing_size;
  if (rawPacking !== null && typeof rawPacking !== 'string' && typeof rawPacking !== 'number') {
    fail(`${context}: unsupported Packing Size`);
  }
  const remark = reagent && typeof source.remark === 'string' ? source.remark.trim() : '';
  const replacement = /^Revised: replaces (\d+)$/i.exec(remark);
  if (remark && !replacement) fail(`${context}: unrecognized REF replacement note`);
  const productType = reagent ? 'reagent' : parseType(source.type, row.worksheet, context);
  const rawUsedWith = !reagent ? source.used_with : null;
  return {
    warehouse_code: warehouse,
    source_name: rawName.trim(),
    product_type: productType,
    packing_size_raw: rawPacking === null ? null : String(rawPacking).trim() || null,
    source_sheet: row.worksheet.name,
    source_row: row.number,
    raw_source: source,
    ref_current: ref,
    manufacturer_barcode: barcode,
    replaces_ref: replacement?.[1] ?? null,
    used_with: typeof rawUsedWith === 'string' ? rawUsedWith.trim() || null : null,
  };
}

function verifyHeaders(sheet: ExcelJS.Worksheet, reagent: boolean): void {
  const header = sheet.getRow(4);
  const name = String(header.getCell(4).value ?? '').toLowerCase();
  const ref = String(header.getCell(3).value ?? '').toLowerCase();
  if (header.getCell(1).value !== 'No' || !ref.includes('ref code') || !name.includes('product')) {
    fail(`${sheet.name}: unsupported workbook columns`);
  }
  if (!reagent && String(header.getCell(6).value ?? '').trim() !== 'Type') {
    fail(`${sheet.name}: expected a Type column`);
  }
}

/** Parses the fixed CHE/IMM workbook layout; it deliberately does not infer arbitrary column mappings. */
export async function parseIncrementalWorkbook(bytes: Buffer, sourceFilename: string): Promise<IncrementalWorkbook> {
  if (!sourceFilename.toLowerCase().endsWith('.xlsx')) fail('Choose an Excel .xlsx workbook');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer); }
  catch { fail('The selected file is not a readable Excel workbook'); }
  if (workbook.worksheets.length !== SHEET_NAMES.length ||
      workbook.worksheets.map(sheet => sheet.name).join('|') !== SHEET_NAMES.join('|')) {
    fail('Workbook sheets differ from the CHE/IMM Product workbook');
  }
  const reagent = workbook.getWorksheet(SHEET_NAMES[0])!;
  const chemistry = workbook.getWorksheet(SHEET_NAMES[1])!;
  const immunology = workbook.getWorksheet(SHEET_NAMES[2])!;
  verifyHeaders(reagent, true);
  verifyHeaders(chemistry, false);
  verifyHeaders(immunology, false);

  const rows: IncrementalCandidate[] = [];
  for (let sourceRow = 6; sourceRow <= 47; sourceRow++) {
    const candidate = parseCandidate(reagent.getRow(sourceRow), 'CHE', true);
    if (candidate) rows.push(candidate);
  }
  for (let sourceRow = 49; sourceRow <= reagent.rowCount; sourceRow++) {
    const candidate = parseCandidate(reagent.getRow(sourceRow), 'IMM', true);
    if (candidate) rows.push(candidate);
  }
  for (let sourceRow = 5; sourceRow <= chemistry.rowCount; sourceRow++) {
    const candidate = parseCandidate(chemistry.getRow(sourceRow), 'CHE', false);
    if (candidate) rows.push(candidate);
  }
  for (let sourceRow = 5; sourceRow <= immunology.rowCount; sourceRow++) {
    const candidate = parseCandidate(immunology.getRow(sourceRow), 'IMM', false);
    if (candidate) rows.push(candidate);
  }
  if (!rows.length || rows.length > 500) fail('Workbook has no Product rows or exceeds the 500-row limit');
  return {
    source_filename: sourceFilename,
    source_sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
    rows,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function warehouseId(code: WarehouseCode): number { return code === 'CHE' ? 1 : 2; }
function normalizedName(value: string): string { return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US'); }
function relationProposal(candidate: IncrementalCandidate, master: IncrementalMaster) {
  if (!candidate.used_with) return { supplied: false as const, ids: null, platformKeys: null, message: null };
  const platformKey = PLATFORM_ALIASES[candidate.used_with.toLowerCase()];
  if (platformKey) return { supplied: true as const, ids: null, platformKeys: [platformKey], message: null };
  const tokens = candidate.warehouse_code === 'CHE'
    ? candidate.used_with.split(',').map(token => token.trim()).filter(Boolean)
    : [candidate.used_with];
  const matchedIds: string[] = [];
  for (const token of tokens) {
    const matches = master.products.filter(item => item.warehouse_id === warehouseId(candidate.warehouse_code) &&
      item.product_type === 'reagent' && (candidate.warehouse_code === 'CHE'
        ? item.source_name.split(',', 1)[0].trim() === token
        : item.source_name === token || item.display_name === token));
    if (matches.length !== 1) {
      return { supplied: true as const, ids: null, platformKeys: null, message: `Used with “${token}” has no unique exact Product match` };
    }
    matchedIds.push(matches[0].id);
  }
  const expectedRelationType = candidate.product_type ? `uses_${candidate.product_type}` : null;
  if (!expectedRelationType || !['uses_calibrator', 'uses_control', 'uses_consumable'].includes(expectedRelationType)) {
    return { supplied: true as const, ids: null, platformKeys: null, message: 'Used with cannot map to a Product relationship for this Product Type' };
  }
  if (!['calibrator', 'control', 'consumable'].includes(candidate.product_type ?? '')) {
    return { supplied: true as const, ids: null, platformKeys: null, message: 'Used with Product relationships require a Calibrator, Control, or Consumable' };
  }
  return { supplied: true as const, ids: [...new Set(matchedIds)].sort(), platformKeys: null, message: null };
}

function addChange(changes: IncrementalChange[], field: string, current: unknown, imported: unknown): void {
  if (!sameJson(current, imported)) changes.push({ field, current, imported });
}

function currentPlatforms(productId: string, master: IncrementalMaster): string[] {
  const ids = master.product_platforms.filter(item => item.product_id === productId).map(item => item.platform_id);
  return ids.map(id => master.platforms.find(platform => platform.id === id)?.platform_key)
    .filter((key): key is string => !!key).sort();
}

export function classifyIncrementalImport(rows: IncrementalCandidate[], master: IncrementalMaster): IncrementalPreviewRow[] {
  const bySource = new Map(master.products.filter(product => product.source_sheet && product.source_row !== null)
    .map(product => [`${product.warehouse_id}|${product.source_sheet}|${product.source_row}`, product]));
  const deltas = rows.filter(candidate => {
    const prior = bySource.get(`${warehouseId(candidate.warehouse_code)}|${candidate.source_sheet}|${candidate.source_row}`);
    return !prior || !sameJson(prior.raw_source, candidate.raw_source);
  });
  const duplicateValues = new Map<string, number>();
  for (const candidate of deltas) {
    for (const value of [candidate.ref_current, candidate.manufacturer_barcode]) {
      duplicateValues.set(value, (duplicateValues.get(value) ?? 0) + 1);
    }
  }

  return deltas.map(candidate => {
    const empty = (classification: IncrementalDisposition, message: string | null, productId: string | null = null, matchMethod: string | null = null, changes: IncrementalChange[] = [], relationIds: string[] | null = null, platformKeys: string[] | null = null): IncrementalPreviewRow => ({
      candidate, classification, product_id: productId, match_method: matchMethod,
      match_snapshot: null, changes, relation_product_ids: relationIds, platform_keys: platformKeys, message,
    });
    const repeated = [candidate.ref_current, candidate.manufacturer_barcode]
      .find(value => (duplicateValues.get(value) ?? 0) > 1);
    if (repeated) return empty('Duplicate in file', `Repeated identifier ${repeated} appears in multiple changed rows`);

    const sameRefCurrent = master.identifiers.filter(item => item.kind === 'REF_CURRENT' && item.value === candidate.ref_current);
    const sameBarcode = master.identifiers.filter(item => item.kind === 'MANUFACTURER_BARCODE' && item.value === candidate.manufacturer_barcode && item.approved);
    const replacement = candidate.replaces_ref
      ? master.identifiers.filter(item => ['REF_CURRENT', 'REF_LEGACY'].includes(item.kind) && item.value === candidate.replaces_ref)
      : [];
    const strong = new Map<string, Set<string>>();
    const addMatch = (kind: string, matches: IncrementalIdentifier[]) => {
      for (const match of matches) {
        const methods = strong.get(match.product_id) ?? new Set<string>();
        methods.add(kind);
        strong.set(match.product_id, methods);
      }
    };
    addMatch('REF_CURRENT', sameRefCurrent);
    addMatch('MANUFACTURER_BARCODE', sameBarcode);
    addMatch('REPLACES_REF', replacement);
    const legacyRef = master.identifiers.filter(item => item.kind === 'REF_LEGACY' && item.value === candidate.ref_current);
    const identifiersWithIncomingValues = master.identifiers.filter(item =>
      item.value === candidate.ref_current || item.value === candidate.manufacturer_barcode);
    const productIds = [...strong.keys()];
    if (productIds.length > 1) return empty('Conflict', 'REF and Manufacturer Barcode identify different Products');

    const targetId = productIds[0] ?? null;
    if (targetId) {
      const target = master.products.find(item => item.id === targetId);
      if (!target || target.warehouse_id !== warehouseId(candidate.warehouse_code)) {
        return empty('Conflict', 'Identifier belongs to a Product in another warehouse', targetId);
      }
      if (legacyRef.some(item => item.product_id === targetId)) {
        return empty('Conflict', 'Imported REF is historical for this Product; automatic rollback is blocked', targetId);
      }
      if (identifiersWithIncomingValues.some(item => item.product_id !== targetId)) {
        return empty('Conflict', 'REF or Manufacturer Barcode collides with another Product', targetId);
      }
      const methods = strong.get(targetId)!;
      const currentRef = master.identifiers.find(item => item.product_id === targetId && item.kind === 'REF_CURRENT')?.value ?? null;
      if (currentRef !== candidate.ref_current && !methods.has('MANUFACTURER_BARCODE') && !methods.has('REPLACES_REF')) {
        return empty('Conflict', 'REF replacement lacks a current matching barcode or explicit Replaces reference', targetId);
      }
      const targetBarcode = master.identifiers.find(item => item.product_id === targetId && item.kind === 'MANUFACTURER_BARCODE')?.value ?? null;
      const candidateBarcodeCollision = master.identifiers.some(item => item.value === candidate.manufacturer_barcode && item.product_id !== targetId);
      if (candidateBarcodeCollision) return empty('Conflict', 'Manufacturer Barcode collides with another Product', targetId);
      const mapped = relationProposal(candidate, master);
      if (mapped.message) return empty('Conflict', mapped.message, targetId);

      const changes: IncrementalChange[] = [];
      if (candidate.ref_current !== currentRef) addChange(changes, 'REF', currentRef, candidate.ref_current);
      if (candidate.manufacturer_barcode !== targetBarcode) addChange(changes, 'Manufacturer Barcode', targetBarcode, candidate.manufacturer_barcode);
      addChange(changes, 'Product Name', target.display_name, candidate.source_name);
      if (candidate.packing_size_raw !== null) addChange(changes, 'Packing Size', target.packing_size_raw, candidate.packing_size_raw);
      if (candidate.product_type) addChange(changes, 'Product Type', target.product_type, candidate.product_type);
      let relationIds: string[] | null = null;
      let platformKeys: string[] | null = null;
      if (mapped.supplied && mapped.ids) {
        relationIds = mapped.ids;
        const relationRows = master.relations.filter(item => item.target_product_id === targetId && item.relation_type.startsWith('uses_'));
        const currentTargets = relationRows.map(item => item.source_product_id).sort();
        if (!sameJson(currentTargets, mapped.ids)) {
          const human = (ids: string[]) => ids.map(id => {
            const product = master.products.find(item => item.id === id);
            return product ? `${product.product_code} · ${product.display_name}` : id;
          });
          addChange(changes, 'Used with / Product relationship', human(currentTargets), human(mapped.ids));
        }
      }
      if (mapped.supplied && mapped.platformKeys) {
        platformKeys = mapped.platformKeys;
        addChange(changes, 'Platform mapping', currentPlatforms(targetId, master), mapped.platformKeys);
      }
      if (candidate.product_type && candidate.product_type !== target.product_type && !mapped.ids) {
        const incompatible = master.relations.some(item =>
          (item.source_product_id === targetId && item.relation_type.startsWith('uses_') && candidate.product_type !== 'reagent') ||
          (item.target_product_id === targetId && item.relation_type === 'uses_calibrator' && candidate.product_type !== 'calibrator') ||
          (item.target_product_id === targetId && item.relation_type === 'uses_control' && candidate.product_type !== 'control') ||
          (item.target_product_id === targetId && item.relation_type === 'uses_consumable' && candidate.product_type !== 'consumable'));
        if (incompatible) return empty('Conflict', 'Product Type change would invalidate an existing Product relationship', targetId);
      }
      return empty(changes.length ? 'Update' : 'Existing', changes.length ? null : 'No Product fields changed; Apply will skip this row', targetId,
        [...methods].sort().join(' + '), changes, relationIds, platformKeys);
    }

    const collision = identifiersWithIncomingValues.length > 0;
    if (collision) return empty('Conflict', 'REF or Manufacturer Barcode collides with a different identifier on a Product');
    const nameMatch = master.products.some(item => item.warehouse_id === warehouseId(candidate.warehouse_code) &&
      (normalizedName(item.display_name) === normalizedName(candidate.source_name) || normalizedName(item.source_name) === normalizedName(candidate.source_name)));
    if (nameMatch) return empty('Conflict', 'Product Name matches an existing Product, but no deterministic identifier matches');
    if (!candidate.product_type) return empty('Conflict', 'Product Type is missing and the source does not establish it');
    return empty('New', null);
  });
}
