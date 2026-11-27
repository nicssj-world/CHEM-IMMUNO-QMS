import assert from 'node:assert/strict';
import test from 'node:test';
import {groupStockByProduct, type StockBalanceEntry} from '../../src/lib/stock-lot-view';

const row=(args:Partial<StockBalanceEntry>):StockBalanceEntry=>({
  product_id:'p1',product_code:'CHE-001',display_name:'Reagent',
  lot_id:'lot-a',lot_number:'A01',expiry_date:'2027-12-31',
  location_id:'loc1',location_code:'FRIDGE1',balance:1,...args,
});

test('LOT totals aggregate locations, show FEFO order and never mix different products',()=>{
  const data=[
    row({product_id:'p2',product_code:'IMM-002',lot_id:'lot-z',lot_number:'A01',balance:3}),
    row({lot_id:'lot-b',lot_number:'B',expiry_date:'2029-05-01',balance:2}),
    row({lot_id:'lot-a',lot_number:'A01',expiry_date:'2028-02-01',location_id:'loc1',balance:4}),
    row({lot_id:'lot-a',lot_number:'A01',expiry_date:'2028-02-01',location_id:'loc2',location_code:'FRIDGE2',balance:5}),
    row({lot_id:'lot-a',lot_number:'A01',expiry_date:'2028-02-01',location_id:'loc1',balance:2}),
  ];
  const products=groupStockByProduct(data);
  assert.deepEqual(products.map(p=>p.code),['CHE-001','IMM-002']);
  assert.equal(products[0].balance,13);
  assert.deepEqual(products[0].lots.map(l=>l.number),['A01','B']);
  assert.equal(products[0].lots[0].balance,11);
  assert.deepEqual(products[0].lots[0].locations.map(l=>l.balance),[6,5]);
  assert.equal(products[1].balance,3,'other product with same printed LOT remains independent');
});

test('same printed LOT with different lot IDs stays separate; zero balances do not inflate totals',()=>{
  const rows=[row({lot_id:'id1',lot_number:'A01',balance:3}),
    row({lot_id:'id2',lot_number:'A01',balance:2}),
    row({lot_id:'id3',lot_number:'Z',balance:0}),
    row({lot_id:'id4',lot_number:'Z',balance:-2})];
  assert.deepEqual(groupStockByProduct(rows)[0].lots.map(l=>l.balance),[3,2]);
  assert.equal(groupStockByProduct(rows)[0].balance,5);
  assert.deepEqual(groupStockByProduct([row({balance:0})]),[]);
  assert.equal(rows[0].balance,3,'input stays immutable');
});
