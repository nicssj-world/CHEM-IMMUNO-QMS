import assert from 'node:assert/strict';
import test from 'node:test';
import { mostRecentReceivedLocations } from '../../src/lib/recent-receive-location';

test('last successful receipt wins; reversed transactions never supply a suggested location', () => {
  const result = mostRecentReceivedLocations([
    {receipt_id:'reversed',invoice_line_id:'l1',location_id:'B',created_at:'2026-10-09T11:00:00Z'},
    {receipt_id:'valid',invoice_line_id:'l1',location_id:'A',created_at:'2026-10-08T11:00:00Z'},
    {receipt_id:'other',invoice_line_id:'l2',location_id:'C',created_at:'2026-10-07T11:00:00Z'},
  ], [{id:'l1',product_id:'p1'},{id:'l2',product_id:'p2'}], new Set(['reversed']), new Set(['p1']));
  assert.deepEqual(result, {p1:'A'});
});

test('two locations in an equally recent receipt require manual selection', () => {
  assert.deepEqual(mostRecentReceivedLocations([
    {receipt_id:'r',invoice_line_id:'l',location_id:'A',created_at:'2026-10-09T11:00:00Z'},
    {receipt_id:'r',invoice_line_id:'l',location_id:'B',created_at:'2026-10-09T11:00:00Z'},
  ],[{id:'l',product_id:'p'}],new Set(),new Set(['p'])),{});
});
