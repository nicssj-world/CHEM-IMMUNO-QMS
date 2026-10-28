import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildImportedWizardLines, normalizeSupplierCode, parseSupplierBillTable, supplierChecklistError,
} from '../../src/lib/supplier-bill-import';
import { importedLinesForFinalization, invoiceLinesFromActualReceipts } from '../../src/lib/receiving-wizard';

function sample(rows: unknown[][]) {
  return parseSupplierBillTable([
    ['Bill No.', 'Bill Date', 'Customer PO', 'RDTH Code', 'Material No.',
      'Description', 'Lot', 'Exp. Date', 'Qty'],
    ...rows,
  ]);
}
const example = (lot: string, qty: number, product = '08056692190') =>
  ['5346807724', '2026-10-07', 'consignment', product, '101002426',
    'Test reagent', lot, '2027-08-31', qty];

test('supplier Bill parses dates, 0-leading supplier REF and ignores consignment as PO', () => {
  const result = sample([example('A001', 10), example('B002', 5)]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bill.invoiceNumber, '5346807724');
  assert.equal(result.bill.invoiceDate, '2026-10-07');
  assert.equal(result.bill.poNumber, '');
  assert.equal(result.bill.rows.length, 2);
  assert.equal(result.bill.rows[0].rdthCode, '08056692190');
  assert.equal(normalizeSupplierCode('10825468 001'), '10825468001');
});

test('same product with multiple LOTs creates one product line and separate checkboxes', () => {
  const parsed = sample([example('A001', 10), example('B002', 5), example('A001', 2)]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  let sequence = 0;
  const mapping = new Map(parsed.bill.rows.map(row => [row.excelRow, {
    id: 'p1', warehouse_id: 1, product_code: 'CHE-0001',
    display_name: 'Reagent', default_location_id: null,
  }]));
  const grouped = buildImportedWizardLines(parsed.bill.rows, mapping,
    new Map([['p1', 'location-1']]), () => String(++sequence));
  assert.equal(grouped.ok, true);
  if (!grouped.ok) return;
  assert.equal(grouped.lines.length, 1);
  assert.equal(grouped.lines[0].packages.length, 2);
  assert.deepEqual(grouped.lines[0].packages.map(row => [row.lot, row.quantity]), [
    ['A001', '12'], ['B002', '5'],
  ]);
  assert.deepEqual(grouped.lines[0].packages[0].sourceRows, [2, 4]);
  assert.equal(grouped.lines[0].orderedQuantity, '17');
  assert.equal(grouped.lines[0].source, 'supplier_excel');
});

test('same product and LOT with conflicting expiration is rejected', () => {
  const parsed = sample([example('A001', 10),
    ['5346807724', '2026-10-07', 'consignment', '08056692190', '101002426',
      'Test reagent', 'A001', '2028-09-30', 2]]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const mapping = new Map(parsed.bill.rows.map(row => [row.excelRow, {
    id: 'p1', warehouse_id: 1, product_code: 'CHE-0001',
    display_name: 'Reagent', default_location_id: null,
  }]));
  const grouped = buildImportedWizardLines(parsed.bill.rows, mapping, new Map(), () => 'id');
  assert.equal(grouped.ok, false);
});

test('pending LOT cannot finalize and partial receiving preserves expected invoice quantity', () => {
  const parsed = sample([example('A001', 10), example('B002', 5)]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const mapping = new Map(parsed.bill.rows.map(row => [row.excelRow, {
    id: 'p1', warehouse_id: 1, product_code: 'CHE-0001',
    display_name: 'Reagent', default_location_id: null,
  }]));
  let id = 0;
  const grouped = buildImportedWizardLines(parsed.bill.rows, mapping,
    new Map([['p1', 'location-1']]), () => String(++id));
  assert.equal(grouped.ok, true);
  if (!grouped.ok) return;
  assert.match(supplierChecklistError(grouped.lines) ?? '', /ทุก LOT/);
  grouped.lines[0].packages[0].verified = true;
  grouped.lines[0].packages[0].quantity = '8';
  grouped.lines[0].packages[1].notReceived = true;
  assert.equal(supplierChecklistError(grouped.lines), null);

  const savedDraft = invoiceLinesFromActualReceipts(grouped.lines);
  assert.equal(savedDraft[0].packages.length, 2, 'autosave keeps outstanding LOT details');
  assert.equal(savedDraft[0].orderedQuantity, '15', 'Invoice quantity from supplier Bill');

  const submitted = invoiceLinesFromActualReceipts(importedLinesForFinalization(grouped.lines));
  assert.equal(submitted[0].orderedQuantity, '15');
  assert.equal(submitted[0].packages.length, 1, 'only checked LOT reaches stock');
  assert.equal(submitted[0].packages[0].quantity, '8');
  assert.equal(submitted[0].importedLots?.length, 2, 'retain original supplier LOTs in draft audit');
});

test('inconsistent Bill or invalid quantities are rejected before a database write', () => {
  assert.equal(sample([example('A001', 0)]).ok, false);
  assert.equal(sample([example('A001', 2.5)]).ok, false);
  assert.equal(sample([example('A001', 3), ['OTHER-BILL', '2026-10-07',
    'consignment', '08056692190', '101002426', 'Test reagent', 'B', '2027-08-31', 3]]).ok, false);
});
