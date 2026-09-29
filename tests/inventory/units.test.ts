import assert from 'node:assert/strict';
import test from 'node:test';
import { STOCK_UNITS, isStockUnit, unitLabel } from '../../src/lib/units';

test('stock units come from a fixed list and never include liquid volume', () => {
  assert.ok(isStockUnit('pack') && isStockUnit('กล่อง') && isStockUnit('เทสต์'));
  assert.equal(isStockUnit('ml'), false);
  assert.equal(isStockUnit('กล่อง '), false);
  assert.equal(isStockUnit(''), false);
  assert.equal(new Set(STOCK_UNITS.map(u => u.value)).size, STOCK_UNITS.length);
});

test('the legacy "pack" value reads as แพ็ก and unknown values are shown, not hidden', () => {
  assert.equal(unitLabel('pack'), 'แพ็ก');
  assert.equal(unitLabel('ชุด'), 'ชุด');
  assert.equal(unitLabel('อื่น'), 'อื่น');
  assert.equal(unitLabel(null), '');
  assert.equal(unitLabel(undefined), '');
});
