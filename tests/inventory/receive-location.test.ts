import assert from 'node:assert/strict';
import test from 'node:test';
import { preselectLocation } from '../../src/lib/receive-location';

const che = (id: string) => ({ id, warehouse_id: 1 });
const imm = (id: string) => ({ id, warehouse_id: 2 });

test('a valid active default Location in the right warehouse is preselected first', () => {
  const locations = [che('A'), che('B'), imm('C')];
  assert.equal(preselectLocation('A', 1, locations), 'A');
  assert.equal(preselectLocation('B', 1, locations), 'B');
});

test('no default, exactly one Location in the warehouse: existing single-Location auto-select is preserved', () => {
  assert.equal(preselectLocation(null, 1, [che('A'), imm('C')]), 'A');
  assert.equal(preselectLocation(undefined, 1, [che('A')]), 'A');
});

test('no default, several Locations in the warehouse: blank, the user chooses', () => {
  assert.equal(preselectLocation(null, 1, [che('A'), che('B')]), '');
});

test('no default and no Location at all in the warehouse: blank', () => {
  assert.equal(preselectLocation(null, 1, [imm('C')]), '');
  assert.equal(preselectLocation(null, 1, []), '');
});

test('a default that is not a valid option here (deactivated, deleted, or cross-warehouse) falls back to the normal rule', () => {
  // Deactivated/deleted: not present in the (already active-only) list at all.
  assert.equal(preselectLocation('gone', 1, [che('A')]), 'A', 'falls back to single-location auto-select');
  assert.equal(preselectLocation('gone', 1, [che('A'), che('B')]), '', 'falls back to blank with several candidates');
  // Cross-warehouse leakage: a default id that only exists in the OTHER warehouse's location list must never leak in.
  assert.equal(preselectLocation('C', 1, [che('A'), che('B'), imm('C')]), '', 'a default from another warehouse is never selected here');
});

test('two Products with different defaults each resolve independently', () => {
  const locations = [che('A'), che('B'), che('C')];
  assert.equal(preselectLocation('B', 1, locations), 'B');
  assert.equal(preselectLocation('C', 1, locations), 'C');
});
