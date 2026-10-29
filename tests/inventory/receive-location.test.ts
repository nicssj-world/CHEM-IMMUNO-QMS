import assert from 'node:assert/strict';
import test from 'node:test';
import { preselectLocation } from '../../src/lib/receive-location';

const che = (id: string) => ({ id, warehouse_id: 1 });
const imm = (id: string) => ({ id, warehouse_id: 2 });

test('a Product default location takes priority across the physical shared catalog', () => {
  const locations = [che('A'), che('B'), imm('C')];
  assert.equal(preselectLocation('A', 1, locations), 'A');
  assert.equal(preselectLocation('C', 1, locations), 'C', 'IMM-origin location works for a CHE product');
  assert.equal(preselectLocation('B', 2, locations), 'B', 'CHE-origin location works for an IMM product');
});

test('the only active shared location is preselected regardless of original owner', () => {
  assert.equal(preselectLocation(null, 1, [imm('C')]), 'C');
  assert.equal(preselectLocation(undefined, 2, [che('A')]), 'A');
  assert.equal(preselectLocation(null, 1, []), '');
});

test('multiple shared locations require selection unless Product default or receipt history exists', () => {
  const locations = [che('A'), imm('C')];
  assert.equal(preselectLocation(null, 1, locations), '');
  assert.equal(preselectLocation(null, 1, locations, 'C'), 'C');
  assert.equal(preselectLocation('A', 1, locations, 'C'), 'A');
  assert.equal(preselectLocation('gone', 1, locations, 'C'), 'C');
  assert.equal(preselectLocation('gone', 1, locations, 'missing'), '');
});

test('inactive or missing defaults never override an active last-used shared location', () => {
  assert.equal(preselectLocation('removed', 2, [imm('C')], 'C'), 'C');
  assert.equal(preselectLocation('removed', 2, [imm('C')], 'gone'), 'C');
});
