import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeIssueLine, matchesPickingQuery, type IssueCartLine } from '../../src/lib/issue-cart';

const lot:IssueCartLine={
 product_id:'p1',product_code:'CHE-001',product_name:'Cobas Reagent',
 warehouse_id:1,lot_id:'lot-a',lot_number:'LOT-A',
 location_id:'fridge-1',location_code:'REFRIGERATOR-A',
 expiry_date:'2026-12-31',quantity:2,balance:10,override_reason:''
};
test('batch scanning same LOT/location consolidates quantities',()=>{
 const rows=mergeIssueLine([lot],{...lot,quantity:3});
 assert.equal(rows.length,1);
 assert.equal(rows[0].quantity,5);
});
test('same LOT different location remains separate',()=>{
 const rows=mergeIssueLine([lot],{...lot,location_id:'fridge-2',quantity:2});
 assert.equal(rows.length,2);
});
test('batch scan refuses aggregated amount exceeding real candidate balance',()=>{
 assert.throws(()=>mergeIssueLine([lot],{...lot,quantity:9}),/เกินยอดคงเหลือ/);
});
test('search is realtime, case insensitive and includes checked row irrespective of UI state',()=>{
 assert.equal(matchesPickingQuery(lot,'cobas'),true);
 assert.equal(matchesPickingQuery(lot,'CHE-001'),true);
 assert.equal(matchesPickingQuery(lot,'lot-a'),true);
 assert.equal(matchesPickingQuery(lot,'missing'),false);
});
test('quantity must be positive integer',()=>{
 assert.throws(()=>mergeIssueLine([],{...lot,quantity:0}),/จำนวนเต็ม/);
 assert.throws(()=>mergeIssueLine([],{...lot,quantity:1.5}),/จำนวนเต็ม/);
});
