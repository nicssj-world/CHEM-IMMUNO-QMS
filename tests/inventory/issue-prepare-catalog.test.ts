import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IssuePrepareCatalog } from '../../src/components/issue-prepare-catalog';
import type { IssueCartLine } from '../../src/lib/issue-cart';

const warehouses = [{ id: 1, code: 'CHE' }, { id: 2, code: 'IMM' }];
const products = [
 { id: 'p-che', warehouse_id: 1, product_code: 'CHE-0014', display_name: 'Triglyceride reagent' },
 { id: 'p-imm', warehouse_id: 2, product_code: 'IMM-0001', display_name: 'Immuno reagent' },
];
const candidates = [
 { warehouse_id: 1, product_id: 'p-che', lot_id: 'che-old', lot_number: 'OLD', expiry_date: '2001-01-01', location_id: 'loc-1', location_code: 'CHEM-01', balance: 2, selectable: false },
 { warehouse_id: 1, product_id: 'p-che', lot_id: 'che-fefo', lot_number: 'LOT-123', expiry_date: '2099-01-01', location_id: 'loc-1', location_code: 'CHEM-01', balance: 9, selectable: true },
 { warehouse_id: 1, product_id: 'p-che', lot_id: 'che-next', lot_number: 'LOT-456', expiry_date: '2099-06-01', location_id: 'loc-2', location_code: 'CHEM-02', balance: 7, selectable: true },
 { warehouse_id: 2, product_id: 'p-imm', lot_id: 'imm-a', lot_number: 'IMM-LOT', expiry_date: '2099-03-01', location_id: 'loc-3', location_code: 'IMM-01', balance: 5, selectable: true },
];

function render(lines: IssueCartLine[] = [], visible = warehouses) {
 return renderToStaticMarkup(createElement(IssuePrepareCatalog, {
   warehouses: visible,
   products,
   candidates,
   lines,
   onChange: () => {},
 }));
}

test('table shows CHEM first, full lot, expiry, location and balance without requiring a search', () => {
 const markup = render();
 assert.match(markup, /CHEM/);
 assert.match(markup, /IMMUNO/);
 assert.match(markup, /CHE-0014/);
 assert.match(markup, /LOT-123/);
 assert.match(markup, /01\/01\/2099/);
 assert.match(markup, /CHEM-01/);
 assert.match(markup, />9<\/td>/);
 assert.match(markup, /aria-expanded="true"/);
 assert.match(markup, /aria-expanded="false"/);
});

test('expired stock is visible but its checkbox cannot be selected', () => {
 const markup = render();
 assert.match(markup, /OLD/);
 assert.match(markup, /หมดอายุ/);
 assert.match(markup, /aria-label="เลือก CHE-0014 LOT OLD"[^>]*disabled/);
 assert.match(markup, /aria-label="เลือก CHE-0014 LOT LOT-123"[^>]*>/);
});

test('IMMUNO can be the initially expanded warehouse when CHE access is absent', () => {
 const markup = render([], warehouses.slice(1));
 assert.match(markup, /IMMUNO/);
 assert.match(markup, /IMM-0001/);
 assert.match(markup, /IMM-LOT/);
});

test('selected non-FEFO lot prompts for a reason and retains quantity', () => {
 const selected: IssueCartLine = {
   product_id: 'p-che', product_code: 'CHE-0014', product_name: 'Triglyceride reagent', warehouse_id: 1,
   lot_id: 'che-next', lot_number: 'LOT-456', location_id: 'loc-2', location_code: 'CHEM-02',
   expiry_date: '2099-06-01', quantity: 3, balance: 7, override_reason: 'Older lot unavailable',
 };
 const markup = render([selected]);
 assert.match(markup, /LOT-456/);
 assert.match(markup, /value="3"/);
 assert.match(markup, /เหตุผลไม่ใช้ FEFO/);
 assert.match(markup, /Older lot unavailable/);
});
