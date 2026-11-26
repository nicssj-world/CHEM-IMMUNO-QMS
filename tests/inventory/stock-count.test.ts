import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { compareLines, groupByLocation, matchesCountQuery, parseCountQuantity, roundDeletable, roundState, scopeLabel, scopeLineCount, stepQuantity, summarize, varianceText, type ChecklistLine } from '../../src/lib/stock-count';
import { formatThaiDateTime } from '../../src/lib/format';

const line = (over: Partial<ChecklistLine>): ChecklistLine => ({ id: 'id', countId: 'c', warehouseId: 1, productCode: 'CHE-0005', productName: 'ASTP2, 800T, C PACK GREEN', unit: 'pack',
  lotNumber: '96470401', expiryDate: '2027-01-31', locationCode: 'CHEM-01', locationName: 'ตู้เย็น 1', snapshot: 10, physical: null, counted: false, needsRecount: false, ...over });

test('round state uses stored statuses and progress, in lab language', () => {
  const p = (counted: number, total = 3, recount = 0) => ({ total, counted, variance: 0, recount });
  assert.equal(roundState(['draft', 'draft'], p(0)), 'counting');
  assert.equal(roundState(['draft'], p(1, 3, 1)), 'recheck');
  assert.equal(roundState(['approved', 'approved'], p(3)), 'complete');
  assert.equal(roundState(['approved'], p(2)), 'partial');
  assert.equal(roundState(['stale', 'draft'], p(0)), 'recheck');
  assert.equal(roundState(['cancelled'], p(0)), 'cancelled');
  assert.equal(roundState(['draft', undefined], p(0)), 'unreadable', 'a missing member is never shown as an empty round');
});

test('only rounds without an approved member can be deleted', () => {
  assert.equal(roundDeletable(['draft', 'stale']), true);
  assert.equal(roundDeletable(['cancelled']), true);
  assert.equal(roundDeletable(['approved', 'draft']), false);
  assert.equal(roundDeletable([]), false);
});

test('quantity input: empty is not zero, zero is allowed, negatives and text are refused', () => {
  assert.equal(parseCountQuantity('').ok, false);
  assert.deepEqual(parseCountQuantity(' 0 '), { ok: true, value: 0 });
  assert.deepEqual(parseCountQuantity('1,200'), { ok: true, value: 1200 });
  assert.equal(parseCountQuantity('-1').ok, false);
  assert.equal(parseCountQuantity('abc').ok, false);
  assert.equal(parseCountQuantity('NaN').ok, false);
  assert.equal(parseCountQuantity('1.2345').ok, false);
  assert.equal(stepQuantity('0', -1, 10), '0', 'never below zero');
  assert.equal(stepQuantity('', 1, 10), '11', 'blank field steps from the stock figure');
  assert.equal(varianceText(0), 'ยอดตรงกับระบบ');
  assert.equal(varianceText(2), 'เกิน +2');
  assert.equal(varianceText(-3), 'ขาด −3');
});

test('real-time search matches name, code, LOT and location, ignoring case and extra spaces, in Thai and English', () => {
  const item = line({});
  for (const query of ['astp2', '  ASTP2   800t ', 'che-0005', '9647', 'chem-01', 'ตู้เย็น', '']) assert.ok(matchesCountQuery(item, query), query);
  assert.equal(matchesCountQuery(item, 'ALB'), false);
});

test('lines group by location and sort by code, name and LOT (not by id)', () => {
  const lines = [line({ id: 'z', locationCode: 'CHEM-10', productCode: 'CHE-0001' }), line({ id: 'a', locationCode: 'CHEM-2', productCode: 'CHE-0009' }),
    line({ id: 'b', locationCode: 'CHEM-2', productCode: 'CHE-0003', lotNumber: 'B' }), line({ id: 'c', locationCode: 'CHEM-2', productCode: 'CHE-0003', lotNumber: 'A' })];
  const groups = groupByLocation(lines);
  assert.deepEqual(groups.map(g => g.code), ['CHEM-2', 'CHEM-10'], 'numeric-aware location order');
  assert.deepEqual(groups[0].lines.map(l => l.id), ['c', 'b', 'a']);
  assert.ok(compareLines(lines[0], lines[1]) > 0);
});

test('summary counts matches, overs, shorts and lines to adjust; uncounted lines are never adjusted', () => {
  const s = summarize([line({ counted: true, physical: 10 }), line({ counted: true, physical: 12 }), line({ counted: true, physical: 0 }), line({}), line({ needsRecount: true })]);
  assert.deepEqual({ ...s }, { total: 5, counted: 3, pending: 2, match: 1, over: 1, short: 1, adjust: 2, recount: 1, percent: 60 });
});

test('scope preview counts LOT × location lines exactly like the database snapshot', () => {
  const balances = [
    { warehouse_id: 1, product_id: 'p1', lot_id: 'l1', location_id: 'fridge' }, { warehouse_id: 1, product_id: 'p1', lot_id: 'l1', location_id: 'shelf' },
    { warehouse_id: 2, product_id: 'p2', lot_id: 'l2', location_id: 'fridge' }, { warehouse_id: 1, product_id: 'p3', lot_id: 'l3', location_id: 'cab' },
  ];
  const locations = [{ id: 'fridge', parent_location_id: null }, { id: 'shelf', parent_location_id: 'fridge' }, { id: 'cab', parent_location_id: null }];
  assert.equal(scopeLineCount(balances, { type: 'all' }, locations), 4);
  assert.equal(scopeLineCount(balances, { type: 'group', warehouseId: 2 }, locations), 1);
  assert.equal(scopeLineCount(balances, { type: 'locations', locationIds: ['fridge'] }, locations), 3, 'a fridge includes its shelves');
  assert.equal(scopeLineCount(balances, { type: 'products', productIds: ['p1'] }, locations), 2, 'different locations stay separate lines');
  assert.equal(scopeLineCount(balances, { type: 'locations', locationIds: [] }, locations), 0);
  assert.equal(scopeLabel('group', { warehouse_id: 2 }), 'เฉพาะกลุ่ม IMMUNO');
});

test('count times are shown in Asia/Bangkok with a Buddhist year, independent of the server timezone', () => {
  assert.equal(formatThaiDateTime('2026-11-26T09:15:00Z'), '26 พ.ย. 2569 เวลา 16:15 น.');
  assert.equal(formatThaiDateTime('2026-11-26T17:30:00Z'), '27 พ.ย. 2569 เวลา 00:30 น.', 'past midnight in Bangkok is the next day');
});

test('regression: no query embeds ci_locations from a table that references the shared location mapping', async () => {
  // These tables reference ci_location_warehouses, so PostgREST cannot embed ci_locations(...) from them (HTTP 400).
  const shared = ['ci_stock_count_lines', 'ci_stock_movement_lines', 'ci_receipt_lines', 'ci_issue_group_lines', 'ci_products'];
  const files: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full); else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  }
  await walk('src');
  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/from\('(ci_[a-z_]+)'\)[\s\S]{0,40}?\.select\(\s*'([^']*)'/g)) {
      if (shared.includes(match[1]) && /ci_locations\s*(!\w+)?\s*\(/.test(match[2])) offenders.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('loader pages past the 1,000-row API limit and refuses a silently truncated list', async () => {
  const { readAll, readByIds } = await import('../../src/lib/stock-count-data');
  const rows = Array.from({ length: 2345 }, (_, i) => ({ id: i }));
  const pages: [number, number][] = [];
  const full = await readAll<{ id: number }>(async (from, to) => { pages.push([from, to]); return { data: rows.slice(from, to + 1), error: null, count: rows.length }; });
  assert.equal(full.data?.length, 2345);
  assert.deepEqual(pages, [[0, 999], [1000, 1999], [2000, 2999]]);
  const short = await readAll<{ id: number }>(async (from, to) => ({ data: rows.slice(from, Math.min(to + 1, 1500)), error: null, count: rows.length }));
  assert.equal(short.data, null);
  assert.match(short.error?.message ?? '', /CI_COUNT_LINES_INCOMPLETE/);
  const chunks: number[] = [];
  const byIds = await readByIds<string>(Array.from({ length: 400 }, (_, i) => `id${i}`), async chunk => { chunks.push(chunk.length); return { data: chunk, error: null }; });
  assert.deepEqual(chunks, [150, 150, 100], 'batched, never one query per row');
  assert.equal(byIds.data?.length, 400);
});
