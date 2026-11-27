import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSupplierProducts, supplierIdentifier, type ApprovedIdentifier } from '../../src/lib/supplier-identifier';
import type { SupplierBillRow, SupplierProductMatch } from '../../src/lib/supplier-bill-import';

const product: SupplierProductMatch = {
  id: 'product-a', warehouse_id: 1, product_code: 'CHE-0001',
  display_name: 'Example reagent', default_location_id: null,
};
const catalog = new Map([[product.id, product]]);
const row = (number: number, rdthCode: string, materialNo: string): SupplierBillRow => ({
  excelRow: number, billNumber: 'BILL01', billDate: '2026-10-29', customerPo: 'consignment',
  rdthCode, materialNo, description: 'Test reagent',
  lot: number % 2 ? 'A' : 'B', expiry: '2027-10-29', quantity: 1,
});
const approved = (kind: string, value: string, productId = product.id): ApprovedIdentifier => ({
  product_id: productId, kind, value, approved: true,
});
test('supplier aliases preserve zero-leading REF and do not use primary barcode kinds', () => {
  assert.equal(supplierIdentifier('rdth', '09040803190'), 'SUPPLIER_RDTH:09040803190');
  assert.equal(supplierIdentifier('material', '101180539'), 'SUPPLIER_MATERIAL:101180539');
  assert.equal(supplierIdentifier('rdth', '10825468 001'), 'SUPPLIER_RDTH:10825468001');
  assert.throws(() => supplierIdentifier('rdth', 'a/b'));
});

test('unmatched supplier product is reported once with all source Excel rows', () => {
  const result = resolveSupplierProducts([
    row(2, '09040803190', '101180539'),
    row(7, '09040803190', '101180539'),
    row(8, '09040803191', '101180540'),
  ], [], catalog);
  assert.equal(result.matched.size, 0);
  assert.equal(result.issues.length, 2);
  assert.deepEqual(result.issues[0].excelRows, [2, 7]);
  assert.equal(result.issues[0].reason, 'missing');
  assert.deepEqual(result.issues[1].excelRows, [8]);
});

test('approved supplier alias resolves all LOTs to one product after supervisor maps it', () => {
  const codes = [approved('OTHER', supplierIdentifier('rdth', '09040803190')),
    approved('OTHER', supplierIdentifier('material', '101180539'))];
  const resolution = resolveSupplierProducts([
    row(2, '09040803190', '101180539'),
    row(3, '09040803190', '101180539'),
  ], codes, catalog);
  assert.equal(resolution.issues.length, 0);
  assert.equal(resolution.matched.size, 2);
  assert.equal(resolution.matched.get(2)?.id, 'product-a');
  assert.equal(resolution.matched.get(3)?.id, 'product-a');
});

test('unapproved request is not accepted as a supplier match', () => {
  const denied = { ...approved('OTHER', supplierIdentifier('rdth', '09040803190')), approved: false };
  const resolution = resolveSupplierProducts([row(2, '09040803190', '101180539')], [denied], catalog);
  assert.equal(resolution.issues[0]?.reason, 'missing');
});

test('conflicting REF and manufacturer identifiers are never auto-matched', () => {
  const other = { ...product, id: 'product-b', product_code: 'CHE-0002' };
  const resolution = resolveSupplierProducts([row(2, '09040803190', '101180539')], [
    approved('REF_CURRENT', '09040803190', product.id),
    approved('MANUFACTURER_BARCODE', '101180539', other.id),
  ], new Map([[product.id, product], [other.id, other]]));
  assert.equal(resolution.matched.size, 0);
  assert.equal(resolution.issues[0]?.reason, 'conflict');
});

test('old master identifiers still match without supplier aliases', () => {
  const resolution = resolveSupplierProducts([row(2, '10825468001', '101180539')], [
    approved('REF_CURRENT', '10825468 001'),
  ], catalog);
  assert.equal(resolution.matched.size, 1);
});
