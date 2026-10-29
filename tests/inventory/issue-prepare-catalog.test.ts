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
 { warehouse_id: 1, product_id: 'p-che', lot_id: 'che-fefo', lot_number: 'LOT-123', expiry_date: '2099-01-01', location_id: 'loc-2', location_code: 'CHEM-02', balance: 3, selectable: true },
 { warehouse_id: 1, product_id: 'p-che', lot_id: 'che-next', lot_number: 'LOT-456', expiry_date: '2099-06-01', location_id: 'loc-3', location_code: 'CHEM-03', balance: 7, selectable: true },
 { warehouse_id: 2, product_id: 'p-imm', lot_id: 'imm-a', lot_number: 'IMM-LOT', expiry_date: '2099-03-01', location_id: 'loc-4', location_code: 'IMM-01', balance: 5, selectable: true },
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

test('CHEM accordion groups a product once and renders distinct LOTs under it', () => {
 const markup = render();
 assert.match(markup, /CHEM/);
 assert.match(markup, /IMMUNO/);
 assert.equal(markup.match(/Triglyceride reagent/g)?.length, 1, 'a product name is displayed only once');
 assert.match(markup, /3 LOT/);
 assert.match(markup, /คงเหลือรวม 21/);
 assert.match(markup, /LOT LOT-123/);
 assert.match(markup, /LOT LOT-456/);
 assert.match(markup, /EXP 01\/01\/2099/);
 assert.match(markup, /aria-expanded="true"/);
 assert.match(markup, /aria-expanded="false"/);
});

test('the same LOT across two locations shows a single LOT heading but two independent checkboxes', () => {
 const markup = render();
 assert.equal(markup.match(/<strong[^>]*>LOT LOT-123<\/strong>/g)?.length, 1);
 assert.match(markup, /คงเหลือ LOT นี้/);
 assert.match(markup, /CHEM-01/);
 assert.match(markup, /CHEM-02/);
 assert.match(markup, /aria-label="เลือก CHE-0014 LOT LOT-123 ตำแหน่ง CHEM-01"/);
 assert.match(markup, /aria-label="เลือก CHE-0014 LOT LOT-123 ตำแหน่ง CHEM-02"/);
});

test('the earliest valid LOT has FEFO; expired stock remains visible but disabled', () => {
 const markup = render();
 assert.match(markup, /LOT OLD/);
 assert.match(markup, /หมดอายุ/);
 assert.match(markup, /aria-label="เลือก CHE-0014 LOT OLD ตำแหน่ง CHEM-01"[^>]*disabled/);
 assert.match(markup, /aria-label="เลือก CHE-0014 LOT LOT-123 ตำแหน่ง CHEM-01"/);
 assert.match(markup, /FEFO/);
});

test('IMMUNO initially expands when it is the only authorized warehouse', () => {
 const markup = render([], warehouses.slice(1));
 assert.match(markup, /IMMUNO/);
 assert.match(markup, /IMM-0001/);
 assert.match(markup, /LOT IMM-LOT/);
});

test('selected non-FEFO lot retains its amount and reason, including when sharing a product', () => {
 const selected: IssueCartLine = {
   product_id: 'p-che', product_code: 'CHE-0014', product_name: 'Triglyceride reagent', warehouse_id: 1,
   lot_id: 'che-next', lot_number: 'LOT-456', location_id: 'loc-3', location_code: 'CHEM-03',
   expiry_date: '2099-06-01', quantity: 3, balance: 7, override_reason: 'Older lot unavailable',
 };
 const markup = render([selected]);
 assert.match(markup, /เลือก 1 · 3 ชิ้น/);
 assert.match(markup, /value="3"/);
 assert.match(markup, /เหตุผลที่ไม่ใช้ LOT ตาม FEFO/);
 assert.match(markup, /Older lot unavailable/);
});

test('small screens do not require the previous wide scrolling table', () => {
 const markup = render();
 assert.doesNotMatch(markup, /min-w-\[780px\]/);
 assert.doesNotMatch(markup, /overflow-x-auto/);
 assert.match(markup, /grid-cols-\[1\.5rem_minmax\(0,1fr\)_auto\]/);
});
