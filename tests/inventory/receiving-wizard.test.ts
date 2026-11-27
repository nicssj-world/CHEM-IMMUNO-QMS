import assert from 'node:assert/strict';
import test from 'node:test';
import { wizardHeaderError, wizardLineError, wizardTotals, invoiceLinesFromActualReceipts,
  restoreWizardAssessment, appendWizardScan, type WizardLine } from '../../src/lib/receiving-wizard';

const products=[
  {id:'p1',warehouse_id:1,product_code:'CHE-001',display_name:'Glucose',default_location_id:null},
  {id:'p2',warehouse_id:2,product_code:'IMM-001',display_name:'TSH',default_location_id:null},
];
const locations=[{id:'l1',warehouse_id:1,code:'R01',name:'Refrigerator'}];
const pkg=(id:string,quantity:string,lot:string,expiry='2027-12-31',locationId='l1')=>({id,quantity,lot,expiry,locationId});
const line=(orderedQuantity='9'):WizardLine=>({id:'row1',productId:'p1',orderedQuantity,packages:[pkg('a','4','LOT-A'),pkg('b','3','LOT-B')]});

test('Step 1 still validates Invoice identity without any reagent line',()=>{
  assert.equal(wizardHeaderError({vendorId:'v',invoiceNumber:'INV-1',invoiceDate:'2026-10-09',poNumber:''}),null);
  assert.match(wizardHeaderError({vendorId:'v',invoiceNumber:'',invoiceDate:'2026-10-09',poNumber:''})??'',/Invoice/);
});

test('A: Invoice quantity always derives from actual LOT quantities, including stale drafts',()=>{
  const rows=[line('999'),{id:'row2',productId:'p2',orderedQuantity:'',packages:[pkg('c','2','IMM-LOT')]}];
  assert.equal(wizardLineError(rows,products,locations),null);
  assert.deepEqual(wizardTotals(rows),{received:9,lots:3,products:2});
  const normalized=invoiceLinesFromActualReceipts(rows);
  assert.equal(normalized[0].orderedQuantity,'7');
  assert.equal(normalized[1].orderedQuantity,'2');
  assert.equal(rows[0].orderedQuantity,'999','source draft stays untouched');
  assert.equal(normalized[0].packages[0].lot,'LOT-A');
});

test('A: old Invoice limits never cap a new Wizard receipt; newest product goes to top',()=>{
  let seq=0;const id=()=>String(++seq);
  const start=[line('1'),{id:'row2',productId:'p2',orderedQuantity:'5',packages:[pkg('c','1','IMM-LOT')]}];
  const input={productId:'p1',quantity:'8',lot:'LOT-C',expiry:'2027-12-31',locationId:'l1'};
  const result=appendWizardScan(start,input,id);
  assert.equal(result.ok,true);if(!result.ok)return;
  assert.deepEqual(result.lines.map(l=>l.productId),['p1','p2']);
  assert.equal(result.lines[0].packages[0].lot,'LOT-C','latest LOT also comes first');
  assert.equal(result.lines[0].orderedQuantity,'15');
  assert.equal(wizardLineError(result.lines,products,locations),null);
});

test('two different products: latest scan appears first and stays first on LOT merge',()=>{
  let seq=0;const id=()=>String(++seq);
  const first=appendWizardScan([],{productId:'p1',quantity:'7',lot:'A',expiry:'2027-12-31',locationId:'l1'},id);
  assert.equal(first.ok,true);if(!first.ok)return;
  const second=appendWizardScan(first.lines,{productId:'p2',quantity:'2',lot:'B',expiry:'2027-12-31',locationId:'l1'},id);
  assert.equal(second.ok,true);if(!second.ok)return;
  assert.deepEqual(second.lines.map(l=>l.productId),['p2','p1']);
  const again=appendWizardScan(second.lines,{productId:'p1',quantity:'4',lot:'A',expiry:'2027-12-31',locationId:'l1'},id);
  assert.equal(again.ok,true);if(!again.ok)return;
  assert.deepEqual(again.lines.map(l=>l.productId),['p1','p2']);
  assert.equal(again.lines[0].packages[0].quantity,'11');
  assert.equal(invoiceLinesFromActualReceipts(again.lines)[0].orderedQuantity,'11');
});

test('same LOT different Locations stays separate; conflicting expiry remains rejected',()=>{
  let seq=0;const id=()=>String(++seq);
  const first=appendWizardScan([],{productId:'p1',quantity:'2',lot:'LOT',expiry:'2027-12-31',locationId:'l1'},id);
  assert.equal(first.ok,true);if(!first.ok)return;
  const split=appendWizardScan(first.lines,{productId:'p1',quantity:'3',lot:'LOT',expiry:'2027-12-31',locationId:'l2'},id);
  assert.equal(split.ok,true);if(!split.ok)return;
  assert.deepEqual(split.lines[0].packages.map(p=>p.locationId),['l2','l1']);
  assert.deepEqual(appendWizardScan(split.lines,{productId:'p1',quantity:'1',lot:'LOT',expiry:'2028-01-01',locationId:'l1'},id),
    {ok:false,reason:'lot-expiry-conflict'});
});

test('unfilled manual LOT is replaceable, partly entered manual LOT must be reviewed first',()=>{
  const untouched=[{id:'p',productId:'p1',orderedQuantity:'',packages:[pkg('a','','', '', 'l1')]}];
  const ok=appendWizardScan(untouched,{productId:'p1',quantity:'4',lot:'SCAN',expiry:'2027-12-31',locationId:'l1'},()=>crypto.randomUUID());
  assert.equal(ok.ok,true);
  const editing=[{id:'p',productId:'p1',orderedQuantity:'',packages:[pkg('a','2','','', 'l1')]}];
  const before=JSON.stringify(editing);
  assert.deepEqual(appendWizardScan(editing,{productId:'p1',quantity:'4',lot:'SCAN',expiry:'2027-12-31',locationId:'l1'},()=> 'x'),
    {ok:false,reason:'review'});
  assert.equal(JSON.stringify(editing),before);
});

test('manual or scanned receipt requires complete LOT, active Location, and positive actual quantity',()=>{
  assert.match(wizardLineError([{...line(),packages:[pkg('x','2','')]}],products,locations)??'',/LOT/);
  assert.match(wizardLineError([{...line(),packages:[pkg('x','2','LOT','2027-12-31','bad')]}],products,locations)??'',/ตำแหน่ง/);
  assert.match(wizardLineError([{...line(),packages:[pkg('x','','LOT')]}],products,locations)??'',/จำนวนรับจริง/);
  assert.match(wizardLineError([{...line(),packages:[]}],products,locations)??'',/จำนวนรับจริง/);
  assert.match(wizardLineError([line(),{...line(),id:'duplicated'}],products,locations)??'',/ซ้ำ/);
  assert.match(wizardLineError([{...line(),packages:[pkg('x','1000001','LOT')]}],products,locations)??'',/1,000,000/);
  assert.deepEqual(appendWizardScan([],{productId:'p1',quantity:'',lot:'LOT',expiry:'2027-12-31',locationId:'l1'},()=> 'x'),
    {ok:false,reason:'invalid'},'popup cannot append without explicit quantity');
});

test('incomplete manual LOT never inflates the received total',()=>{
  const draft:[WizardLine]=[{id:'p',productId:'p1',orderedQuantity:'100',packages:[pkg('b','','','','l1')]}];
  assert.deepEqual(wizardTotals(draft),{received:0,lots:0,products:1});
});

test('Step 4 assessment can be restored after a failed confirmation',()=>{
  const assessment=restoreWizardAssessment({correct_product:true,correct_quantity:true,
    packaging_ok:false,documentation_complete:true,temperature_required:false,has_complaint:false,
    reason_codes:['urgent_need'],notes:'used in urgent case',other_reason_detail:null});
  assert.equal(assessment.productCondition,'abnormal');
  assert.deepEqual(assessment.reasonCodes,['urgent_need']);
  assert.equal(restoreWizardAssessment(null).productCondition,'normal');
});
