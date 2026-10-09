import assert from 'node:assert/strict';
import test from 'node:test';
import { wizardHeaderError, wizardLineError, wizardTotals, remainingForLot, restoreWizardAssessment, appendWizardScan, type WizardLine } from '../../src/lib/receiving-wizard';

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

test('an unsuccessful Step 4 attempt remains editable after refreshing the draft',()=>{
  const afterFailure=restoreWizardAssessment({
    correct_product:true,correct_quantity:true,packaging_ok:false,
    documentation_complete:true,temperature_required:false,has_complaint:false,
    reason_codes:['urgent_need'],notes:'Used in urgent case',other_reason_detail:null,
  });
  assert.equal(afterFailure.productCondition,'abnormal');
  assert.deepEqual(afterFailure.reasonCodes,['urgent_need']);
  assert.equal(afterFailure.note,'Used in urgent case');
  assert.equal(restoreWizardAssessment(null).productCondition,'normal');
});

test('scanner appends same product/LOT/location and never adjusts invoiced quantity',()=>{
  let generated=0;
  const makeId=()=>String(++generated);
  const start=[{id:'row1',productId:'p1',orderedQuantity:'3',packages:[pkg('a','1','LOT-A')]}];
  const candidate={productId:'p1',quantity:'1',lot:'LOT-A',expiry:'2027-12-31',locationId:'l1',raw:'GS1-128'};
  const a=appendWizardScan(start,candidate,makeId);
  assert.equal(a.ok,true);if(!a.ok)return;
  assert.equal(a.merged,true);
  assert.equal(a.lines[0].packages[0].quantity,'2');
  assert.equal(a.lines[0].orderedQuantity,'3');
  const b=appendWizardScan(a.lines,candidate,makeId);
  assert.equal(b.ok,true);if(!b.ok)return;
  assert.equal(b.lines[0].packages[0].quantity,'3');
  assert.equal(b.lines[0].orderedQuantity,'3');
  const c=appendWizardScan(b.lines,candidate,makeId);
  assert.deepEqual(c,{ok:false,reason:'capacity'},'extra scan must warn without inflating Invoice');
  assert.equal(b.lines[0].orderedQuantity,'3');
});

test('scanner keeps same LOT separate by location and rejects conflicting expiry',()=>{
  let counter=0;const id=()=>String(++counter);
  const first=appendWizardScan([{id:'row1',productId:'p1',orderedQuantity:'5',packages:[]}],
    {productId:'p1',lot:'LOT-A',expiry:'2027-12-31',quantity:'1',locationId:'l1'},id);
  assert.equal(first.ok,true);if(!first.ok)return;
  const second=appendWizardScan(first.lines,{productId:'p1',lot:'LOT-A',expiry:'2027-12-31',quantity:'1',locationId:'l2'},id);
  assert.equal(second.ok,true);if(!second.ok)return;
  assert.equal(second.lines[0].packages.length,2);
  const conflict=appendWizardScan(second.lines,{productId:'p1',lot:'LOT-A',expiry:'2028-01-01',quantity:'1',locationId:'l1'},id);
  assert.deepEqual(conflict,{ok:false,reason:'lot-expiry-conflict'});
});

test('unreviewed manual LOT must not be silently discarded when scanning',()=>{
  const untouched=[{id:'row1',productId:'p1',orderedQuantity:'9',packages:[{...pkg('a','1','LOT-A'),locationId:''}]}];
  const before=JSON.stringify(untouched);
  assert.deepEqual(appendWizardScan(untouched,{productId:'p1',quantity:'1',lot:'LOT-B',expiry:'2027-12-31',locationId:'l1'},()=> 'generated'),{ok:false,reason:'review'});
  assert.equal(JSON.stringify(untouched),before);
});

test('first scan can open a Product without changing later manually entered quantity',()=>{
  const first=appendWizardScan([],{productId:'p2',lot:'IMM-LOT',expiry:'2027-12-31',quantity:'1',locationId:'l1'},()=>crypto.randomUUID());
  assert.equal(first.ok,true);if(!first.ok)return;
  assert.equal(first.lines[0].orderedQuantity,'1');
  const edited=[{...first.lines[0],orderedQuantity:'10'}];
  const again=appendWizardScan(edited,{productId:'p2',lot:'IMM-LOT',expiry:'2027-12-31',quantity:'1',locationId:'l1'},()=>crypto.randomUUID());
  assert.equal(again.ok,true);if(!again.ok)return;
  assert.equal(again.lines[0].orderedQuantity,'10');
  assert.equal(again.lines[0].packages[0].quantity,'2');
});
