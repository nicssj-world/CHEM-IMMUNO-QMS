import assert from 'node:assert/strict';
import test from 'node:test';
import { wizardHeaderError, wizardLineError, wizardTotals, remainingForLot, type WizardLine } from '../../src/lib/receiving-wizard';

const products=[
  {id:'p1',warehouse_id:1,product_code:'CHE-001',display_name:'Glucose',default_location_id:null},
  {id:'p2',warehouse_id:2,product_code:'IMM-001',display_name:'TSH',default_location_id:null}
];
const locations=[{id:'l1',code:'R01',name:'Refrigerator'}];
const pkg=(id:string,quantity:string,lot:string,expiry='2027-12-31')=>({id,quantity,lot,expiry,locationId:'l1'});
const line=(orderedQuantity='10'):WizardLine=>({id:'row1',productId:'p1',orderedQuantity,packages:[pkg('a','4','LOT-A'),pkg('b','3','LOT-B')]});

test('Step1 requires only Invoice header and allows no reagent lines yet',()=>{
  assert.equal(wizardHeaderError({vendorId:'v',invoiceNumber:' INV-001 ',invoiceDate:'2026-10-09',poNumber:''}),null);
  assert.match(wizardHeaderError({vendorId:'v',invoiceNumber:'',invoiceDate:'2026-10-09',poNumber:''})??'',/Invoice/);
});

test('Step2 tracks Invoice quantity once, actual amount across LOTs, and pending automatically',()=>{
  const rows=[line()];
  assert.equal(wizardLineError(rows,products,locations),null);
  assert.deepEqual(wizardTotals(rows),{ordered:10,received:7,pending:3,lots:2});
  assert.equal(remainingForLot(rows[0],'b'),6);
});

test('same reagent two lots and mixed CHE/IMM products are valid',()=>{
  const rows=[line(),{id:'row2',productId:'p2',orderedQuantity:'2',packages:[pkg('c','2','IMM-LOT')]}];
  assert.equal(wizardLineError(rows,products,locations),null);
  assert.deepEqual(wizardTotals(rows),{ordered:12,received:9,pending:3,lots:3});
});

test('cannot receive more than the Invoice quantity even across separate LOTs',()=>{
  assert.match(wizardLineError([line('6')],products,locations)??'',/เกิน/);
});

test('cannot submit incomplete LOT, unapproved storage, or duplicated Product',()=>{
  assert.match(wizardLineError([{...line(),packages:[pkg('z','1','')]}],products,locations)??'',/LOT/);
  assert.match(wizardLineError([{...line(),packages:[{...pkg('z','1','LOT'),locationId:'bad'}]}],products,locations)??'',/ตำแหน่ง/);
  assert.match(wizardLineError([line(),{...line(),id:'row-d'}],products,locations)??'',/ซ้ำ/);
});

test('same reagent and LOT with conflicting expiry must be corrected before Step3',()=>{
  const rows=[{...line(),packages:[pkg('a','1','LOT-A'),pkg('b','1','LOT-A','2028-01-01')]}];
  assert.match(wizardLineError(rows,products,locations)??'',/LOT เดียวกัน/);
});
