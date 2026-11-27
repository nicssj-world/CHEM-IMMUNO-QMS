import assert from 'node:assert/strict';
import test from 'node:test';
import { bangkokToday, expiryBucket, fiscalYear, stockStatus, reorderAttention } from '../../src/lib/inventory-insights';

test('Bangkok day boundary and expiry buckets', () => {
  assert.equal(bangkokToday(new Date('2026-09-23T17:00:00Z')), '2026-09-24');
  assert.equal(expiryBucket('2026-09-23', '2026-09-24'), 'EXPIRED');
  assert.equal(expiryBucket('2026-09-24', '2026-09-24'), '≤30');
  assert.equal(expiryBucket('2026-10-24', '2026-09-24'), '≤30');
  assert.equal(expiryBucket('2026-10-25', '2026-09-24'), '31–60');
  assert.equal(expiryBucket('2026-11-24', '2026-09-24'), '61–90');
  assert.equal(expiryBucket('2026-12-24', '2026-09-24'), '>90');
});

test('missing ROP stays explicit and fiscal year starts in October', () => {
  assert.equal(stockStatus(3, null, 'required'), 'ต้องตั้งค่า');
  assert.equal(stockStatus(0, null, 'required'), 'stockout');
  assert.equal(stockStatus(2, 3, 'required'), 'below ROP');
  assert.equal(stockStatus(3, 3, 'required'), 'below ROP', 'reorder is due at the threshold');
  assert.equal(stockStatus(4, 3, 'required'), 'adequate');
  assert.equal(stockStatus(0, null, 'on_demand'), 'ตามความต้องการ');
  assert.equal(stockStatus(0, null, 'unclassified'), 'ต้องจัดประเภท');
  assert.equal(reorderAttention(0, null, 'required'), 'stockout', 'required stockout is visible even without ROP');
  assert.equal(reorderAttention(3, null, 'required'), 'no-rop');
  assert.equal(reorderAttention(3, 3, 'required'), 'below');
  assert.equal(reorderAttention(0, null, 'unclassified'), 'unclassified');
  assert.equal(reorderAttention(0, 5, 'on_demand'), 'on_demand');
  assert.equal(fiscalYear('2026-09-30'), 2026);
  assert.equal(fiscalYear('2026-10-01'), 2027);
});
