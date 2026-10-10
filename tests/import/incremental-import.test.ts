import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { previewApprovedWorkbook } from '../../src/lib/import/approved-workbook';
import {
  classifyIncrementalImport,
  parseIncrementalWorkbook,
  type IncrementalCandidate,
  type IncrementalMaster,
} from '../../src/lib/import/incremental';

const approvedFixture = 'NEW Summary_72 items + FOC_Chonburi_revised 2026_20092026.xlsx';
const incrementalFixture = 'Summary_72 items + FOC_Chonburi_revised 2026_20092026.xlsx';

function warehouseId(code: string) { return code === 'CHE' ? 1 : 2; }

function masterFromInitialImport(products: Awaited<ReturnType<typeof previewApprovedWorkbook>>['payload']['products'], relations: Awaited<ReturnType<typeof previewApprovedWorkbook>>['payload']['product_relations'], platformRelations: Awaited<ReturnType<typeof previewApprovedWorkbook>>['payload']['platform_relations']): IncrementalMaster {
  const ids = new Map(products.map((product, index) => [product.ref_current, `product-${index}`]));
  const masterProducts: IncrementalMaster['products'] = products.map((product, index) => ({
    id: `product-${index}`,
    warehouse_id: warehouseId(product.warehouse_code),
    product_code: `${product.warehouse_code}-${String(index + 1).padStart(4, '0')}`,
    product_type: product.product_type,
    source_name: product.source_name,
    display_name: product.source_name,
    packing_size_raw: product.packing_size_raw,
    source_sheet: product.source_sheet,
    source_row: product.source_row,
    raw_source: product.raw_source,
  }));
  const identifiers: IncrementalMaster['identifiers'] = products.flatMap((product, index) => [
    { product_id: `product-${index}`, warehouse_id: warehouseId(product.warehouse_code), kind: 'REF_CURRENT', value: product.ref_current, approved: true },
    { product_id: `product-${index}`, warehouse_id: warehouseId(product.warehouse_code), kind: 'MANUFACTURER_BARCODE', value: product.manufacturer_barcode, approved: true },
    ...(product.legacy_ref ? [{ product_id: `product-${index}`, warehouse_id: warehouseId(product.warehouse_code), kind: 'REF_LEGACY', value: product.legacy_ref, approved: true }] : []),
  ]);
  const masterRelations: IncrementalMaster['relations'] = relations.map(item => ({
    source_product_id: ids.get(item.source_ref_current)!,
    target_product_id: ids.get(item.target_ref_current)!,
    relation_type: item.relation_type,
  }));
  const platformKeys = [...new Set(platformRelations.map(item => item.platform_key))];
  const platforms = platformKeys.map((platform_key, index) => ({
    id: `platform-${index}`,
    warehouse_id: 1,
    platform_key,
    display_name: platform_key,
  }));
  const product_platforms = platformRelations.map(item => ({
    product_id: ids.get(item.product_ref_current)!,
    platform_id: platforms.find(platform => platform.platform_key === item.platform_key)!.id,
  }));
  return { products: masterProducts, identifiers, relations: masterRelations, platforms, product_platforms };
}

const candidate = (overrides: Partial<IncrementalCandidate> = {}): IncrementalCandidate => ({
  warehouse_code: 'CHE', source_name: 'New Product', product_type: 'consumable', packing_size_raw: null,
  source_sheet: 'FOC item_chem c503 c703 ISE', source_row: 60, raw_source: {},
  ref_current: '12345678901', manufacturer_barcode: '123456789', replaces_ref: null, used_with: null,
  ...overrides,
});

test('Incremental Product import classifies deterministic matches and protects ambiguities', async () => {
  const base = await previewApprovedWorkbook(await readFile(join('tests/import/fixtures', approvedFixture)));
  const master = masterFromInitialImport(base.payload.products, base.payload.product_relations, base.payload.platform_relations);

  const newRow = classifyIncrementalImport([candidate()], { products: [], identifiers: [], relations: [], platforms: [], product_platforms: [] });
  assert.equal(newRow[0].classification, 'New');

  const existingCandidate = candidate({ ref_current: '07700814001', manufacturer_barcode: '100759360', source_name: 'Reaction Cell c 503 / c513', source_row: 53 });
  const existing = classifyIncrementalImport([existingCandidate], master)[0];
  assert.equal(existing.classification, 'Existing');
  assert.equal(existing.product_id, master.products.find(item =>
    master.identifiers.some(identifier => identifier.product_id === item.id && identifier.kind === 'REF_CURRENT' && identifier.value === '07700814001'))?.id);
  assert.equal(existing.changes.length, 0);

  const replacement = candidate({
    ref_current: '12345678901', manufacturer_barcode: '100759360', source_name: 'Reaction Cell c 503 / c513',
    source_row: 61, replaces_ref: '07700814001',
  });
  const replacementRow = classifyIncrementalImport([replacement], master)[0];
  assert.equal(replacementRow.classification, 'Update');
  assert.equal(replacementRow.product_id, existing.product_id);
  assert.equal(replacementRow.changes.find(change => change.field === 'REF')?.current, '07700814001');
  assert.equal(master.products.find(item => item.id === replacementRow.product_id)?.product_code,
    master.products.find(item => item.id === existing.product_id)?.product_code);

  const masterWithLegacyRef = structuredClone(master);
  masterWithLegacyRef.identifiers.push({
    product_id: existing.product_id!, warehouse_id: 1, kind: 'REF_LEGACY', value: '07770000000', approved: true,
  });
  const replacementByLegacyNote = classifyIncrementalImport([candidate({
    ref_current: '12345678902', manufacturer_barcode: '123456790', source_name: 'Updated reaction cell',
    source_row: 68, replaces_ref: '07770000000',
  })], masterWithLegacyRef)[0];
  assert.equal(replacementByLegacyNote.classification, 'Update');
  assert.equal(replacementByLegacyNote.product_id, existing.product_id);
  const attemptedHistoricalRollback = classifyIncrementalImport([candidate({
    ref_current: '07770000000', manufacturer_barcode: '100759360', source_name: 'Reaction Cell c 503 / c513',
    source_row: 69,
  })], masterWithLegacyRef)[0];
  assert.equal(attemptedHistoricalRollback.classification, 'Conflict');
  assert.equal(attemptedHistoricalRollback.product_id, existing.product_id);

  const duplicates = classifyIncrementalImport([
    candidate({ source_row: 62 }), candidate({ source_row: 63, source_name: 'Second row' }),
  ], { products: [], identifiers: [], relations: [], platforms: [], product_platforms: [] });
  assert.deepEqual(duplicates.map(item => item.classification), ['Duplicate in file', 'Duplicate in file']);

  const collision = classifyIncrementalImport([
    candidate({ ref_current: '07700814001', manufacturer_barcode: '101270281', source_row: 64 }),
  ], master)[0];
  assert.equal(collision.classification, 'Conflict');

  const ambiguousName = classifyIncrementalImport([
    candidate({ source_name: 'Reaction Cell c 503 / c513', source_row: 65 }),
  ], master)[0];
  assert.equal(ambiguousName.classification, 'Conflict');
});

test('current incremental workbook yields 3 New and 2 Existing without touching Initial Import fixture', async () => {
  const baselineBytes = await readFile(join('tests/import/fixtures', approvedFixture));
  const incrementalBytes = await readFile(join('tests/import/fixtures', incrementalFixture));
  const baseline = await previewApprovedWorkbook(baselineBytes);
  const workbook = await parseIncrementalWorkbook(incrementalBytes, incrementalFixture);
  const preview = classifyIncrementalImport(workbook.rows, masterFromInitialImport(
    baseline.payload.products, baseline.payload.product_relations, baseline.payload.platform_relations,
  ));
  assert.equal(preview.length, 5);
  assert.deepEqual(preview.map(row => row.classification), ['Existing', 'Existing', 'New', 'New', 'New']);
  assert.deepEqual(preview.map(row => row.candidate.ref_current), [
    '07700814001', '09796762001', '08463115190', '08463123190', '04813707001',
  ]);
  assert.equal(preview.filter(row => row.classification === 'New').length, 3);
  assert.equal(preview.filter(row => row.classification === 'Existing').length, 2);
  assert.ok(preview.filter(row => row.classification === 'New').every(row => row.candidate.product_type === 'consumable'));
  assert.ok(preview.every(row => row.candidate.source_sheet === 'FOC item_chem c503 c703 ISE'));
  assert.notEqual(workbook.source_sha256, baseline.payload.source_sha256);
  assert.equal(baseline.payload.products.length, 162);
});

test('source-backed platform and Product relationship changes appear in the preview', async () => {
  const base = await previewApprovedWorkbook(await readFile(join('tests/import/fixtures', approvedFixture)));
  const master = masterFromInitialImport(base.payload.products, base.payload.product_relations, base.payload.platform_relations);
  const reaction = base.payload.products.find(item => item.ref_current === '07700814001')!;
  const platformUpdate = classifyIncrementalImport([candidate({
    ref_current: reaction.ref_current,
    manufacturer_barcode: reaction.manufacturer_barcode,
    source_name: reaction.source_name,
    product_type: reaction.product_type,
    source_row: 66,
    used_with: 'cobas pro c703',
  })], master)[0];
  assert.equal(platformUpdate.classification, 'Update');
  assert.ok(platformUpdate.changes.some(change => change.field === 'Platform mapping'));
  assert.deepEqual(platformUpdate.platform_keys, ['c703']);

  const foc = base.payload.products.find(item => item.product_type === 'consumable' && item.warehouse_code === 'CHE')!;
  const target = base.payload.products.find(item => item.product_type === 'reagent' && item.warehouse_code === 'CHE' &&
    item.source_name.split(',', 1)[0].trim() !== 'ALT')!;
  const relationUpdate = classifyIncrementalImport([candidate({
    ref_current: foc.ref_current,
    manufacturer_barcode: foc.manufacturer_barcode,
    source_name: foc.source_name,
    product_type: foc.product_type,
    source_row: 67,
    used_with: target.source_name.split(',', 1)[0].trim(),
  })], master)[0];
  assert.ok(['Existing', 'Update'].includes(relationUpdate.classification));
  assert.ok(relationUpdate.relation_product_ids?.length);
});
