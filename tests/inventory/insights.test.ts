import assert from 'node:assert/strict';
import test from 'node:test';
import { bangkokToday, expiryBucket, fiscalYear, stockStatus } from '../../src/lib/inventory-insights';

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
  assert.equal(stockStatus(3, null), 'ต้องตั้งค่า');
  assert.equal(stockStatus(0, null), 'stockout');
  assert.equal(stockStatus(2, 3), 'below ROP');
  assert.equal(fiscalYear('2026-09-30'), 2026);
  assert.equal(fiscalYear('2026-10-01'), 2027);
});
