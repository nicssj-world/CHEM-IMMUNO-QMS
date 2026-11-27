import assert from 'node:assert/strict';
import test from 'node:test';
import { addProducts, belowRop, defaultOrderQuantity, newLine, parseOrderQuantity, printableLines, refreshLines, ropText, stepOrderQuantity, searchTemplateProducts, splitTemplateProducts, type PoProduct, type PoMetric } from '../../src/lib/purchase-orders';
import { productTotals } from '../../src/lib/issue-results';

const metric = (product_id: string, rop: number | null, stock = 5, issued = 18): PoMetric => ({ product_id, warehouse_id: 1, issued_30d: issued, stock_balance: stock, rop, stock_requirement: 'required' });

test('owner rule: the starting order quantity is the ROP itself, never ROP − stock or issues − stock', () => {
  // Example from the brief: 30-day issues 18, stock 5, ROP 15 → order 15.
  assert.equal(newLine('p', metric('p', 15, 5, 18)).quantity, '15');
  assert.equal(defaultOrderQuantity(0), 0, 'ROP 0 is a real ROP');
  assert.equal(defaultOrderQuantity(12.2), 13, 'automatic ROP is rounded up to a whole unit');
  assert.equal(defaultOrderQuantity(null), null);
  assert.equal(newLine('p', metric('p', null)).quantity, '', 'no ROP: the user fills it in');
  assert.equal(ropText(null), 'ยังไม่กำหนด', 'missing ROP is not shown as 0');
  assert.equal(ropText(0), '0');
});

test('order quantity input: whole units, zero allowed, empty/negative/NaN refused', () => {
  assert.deepEqual(parseOrderQuantity('0'), { ok: true, value: 0 });
  assert.deepEqual(parseOrderQuantity(' 20 '), { ok: true, value: 20 });
  for (const bad of ['', '-1', '1.5', 'NaN', 'abc']) assert.equal(parseOrderQuantity(bad).ok, false, bad);
  assert.equal(stepOrderQuantity('0', -1), '0');
  assert.equal(stepOrderQuantity('15', 1), '16');
});

test('reloading numbers keeps quantities the user set; only empty untouched lines pick up a new ROP', () => {
  const metrics = new Map([['a', metric('a', 30)], ['b', metric('b', 7)], ['c', metric('c', 4)]]);
  const lines = [{ productId: 'a', quantity: '20', edited: true }, { productId: 'b', quantity: '', edited: false }, { productId: 'c', quantity: '9', edited: false }];
  assert.deepEqual(refreshLines(lines, metrics).map(l => l.quantity), ['20', '7', '9']);
});

test('adding products skips duplicates and starts each new line at its ROP', () => {
  const metrics = new Map([['a', metric('a', 10)], ['b', metric('b', 3)]]);
  const lines = addProducts([{ productId: 'a', quantity: '99', edited: true }], ['a', 'b', 'b'], metrics);
  assert.deepEqual(lines.map(l => [l.productId, l.quantity]), [['a', '99'], ['b', '3']]);
});

test('below-ROP flag and printable lines', () => {
  assert.equal(belowRop(5, 15), true);
  assert.equal(belowRop(20, 15), false);
  assert.equal(belowRop(0, null), false);
  assert.deepEqual(printableLines([{ order_quantity: 0 }, { order_quantity: '3' }]), [{ order_quantity: '3' }]);
});

test('issue result: all-LOT total comes from the last recorded line of each product', () => {
  const totals = productTotals([{ product_id: 'p', sequence: 2, product_after: 8 }, { product_id: 'p', sequence: 5, product_after: 5 }, { product_id: 'q', sequence: 3, product_after: 0 }]);
  assert.deepEqual([...totals], [['p', 5], ['q', 0]]);
});

const reagent = (i: number, active = true, warehouse_id = 1): PoProduct => ({ id: String(i), product_code: `CHE-${i}`, display_name: 'Reagent', packing_size_raw: null, base_stock_unit: 'pack', warehouse_id, active });

test('template search returns all matches beyond 30 and excludes selected and inactive rows', () => {
  const products = [...Array.from({ length: 65 }, (_, i) => reagent(i)), reagent(65, false)];
  const chosen = new Set<string>();
  assert.equal(searchTemplateProducts(products, chosen, 'che').length, 65);
  chosen.add('0'); chosen.add('34');
  assert.equal(searchTemplateProducts(products, chosen, 'che').length, 63);
  assert.ok(!searchTemplateProducts(products, chosen, 'che').some(p => p.id === '0' || p.id === '34'));
  chosen.delete('34');
  assert.ok(searchTemplateProducts(products, chosen, 'che').some(p => p.id === '34'));
  assert.deepEqual(searchTemplateProducts(products, chosen, '   '), []);
});

test('template edits submit only writable warehouse rows and preserve read-only rows', () => {
  assert.deepEqual(splitTemplateProducts(['2', '1', '3'], [reagent(1), reagent(2, true, 2)], [1]), { editableIds: ['1'], readOnlyIds: ['2', '3'] });
  assert.deepEqual(splitTemplateProducts(['2', '1'], [reagent(1), reagent(2, true, 2)], [1, 2]), { editableIds: ['2', '1'], readOnlyIds: [] });
});
