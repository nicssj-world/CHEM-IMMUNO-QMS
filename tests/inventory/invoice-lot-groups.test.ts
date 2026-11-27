import assert from 'node:assert/strict';
import test from 'node:test';
import {groupInvoiceReceiptLots,type InvoiceReceiptLotRow} from '../../src/lib/invoice-lot-groups';

const entry=(values:Partial<InvoiceReceiptLotRow>):InvoiceReceiptLotRow=>({
  id:'row-1',invoiceLineId:'line-a',receiptId:'receipt-1',
  lotNumber:'LOT-001',expiryDate:'2027-12-31',
  locationId:'loc-1',quantity:2,...values,
});

test('one Invoice Product lists LOTs below it; duplicate LOT/Location receipts combine with correct actual quantity',()=>{
  const rows=[
    entry({id:'a',receiptId:'receipt-1',quantity:2}),
    entry({id:'b',receiptId:'receipt-2',quantity:3}),
    entry({id:'c',lotNumber:'LOT-002',expiryDate:'2027-06-01',quantity:4}),
    entry({id:'d',locationId:'loc-2',quantity:7}),
  ];
  const result=groupInvoiceReceiptLots(rows,new Set());
  assert.deepEqual([...result.keys()],['line-a']);
  assert.deepEqual(result.get('line-a')?.map(lot=>[lot.lotNumber,lot.locationId,lot.quantity]),[
    ['LOT-002','loc-1',4],
    ['LOT-001','loc-1',5],
    ['LOT-001','loc-2',7],
  ]);
  assert.equal(result.get('line-a')?.reduce((n,lot)=>n+lot.quantity,0),16);
  assert.equal(rows[0].quantity,2);
});

test('reversed receipts do not inflate the active product/LOT list but remain in audit history source',()=>{
  const rows=[entry({id:'normal',quantity:5}),entry({id:'reversed',receiptId:'receipt-undo',quantity:50})];
  const actual=groupInvoiceReceiptLots(rows,new Set(['receipt-undo']));
  assert.equal(actual.get('line-a')?.[0].quantity,5);
  assert.equal(rows.length,2,'source records remain accessible for history');
  assert.deepEqual(groupInvoiceReceiptLots(rows,new Set(['receipt-1','receipt-undo'])),new Map());
});

test('same printed LOT does not merge across Invoice lines, even if location and expiry match',()=>{
  const rows=[entry({id:'a',invoiceLineId:'line-a',quantity:2}),
    entry({id:'b',invoiceLineId:'line-b',quantity:12})];
  const result=groupInvoiceReceiptLots(rows,new Set());
  assert.equal(result.get('line-a')?.[0].quantity,2);
  assert.equal(result.get('line-b')?.[0].quantity,12);
});

test('incomplete historical LOT reference is retained without mixing unrelated rows',()=>{
  const result=groupInvoiceReceiptLots([
    entry({id:'a',lotNumber:null,expiryDate:null}),
    entry({id:'b',lotNumber:null,expiryDate:null}),
    entry({id:'c',quantity:0}),
  ],new Set());
  assert.equal(result.get('line-a')?.length,2);
  assert.deepEqual(result.get('line-a')?.map(l=>l.quantity),[2,2]);
});
