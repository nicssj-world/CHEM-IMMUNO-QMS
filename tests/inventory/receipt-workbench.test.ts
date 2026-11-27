import assert from 'node:assert/strict';
import test from 'node:test';
import { appendReceiptPackage, receiptPackageIssues, validateReceiptPackages, type ReceiptPackage } from '../../src/lib/receipt-workbench';
import { readWorkbenchDraft, saveWorkbenchDraft, clearWorkbenchDraft, workbenchDraftKey } from '../../src/lib/receive-workbench-draft';

const item = (id:string,lot:string,qty='1',locationId='locA',invoiceLineId='lineA',expiry='2027-12-31'):ReceiptPackage =>
  ({id,invoiceLineId,lot,quantity:qty,locationId,expiry});
const limits = [{ invoice_line_id:'lineA',remaining_quantity:8 },{invoice_line_id:'lineB',remaining_quantity:2 }];

test('same Product + LOT + expiry + location increments quantity, never duplicate row',()=>{
  const first=[item('a','LOT1','2')];
  const result=appendReceiptPackage(first,item('b','LOT1','3'),limits);
  assert.equal(result.ok,true);
  if (result.ok) {
    assert.equal(result.merged,true);
    assert.equal(result.packages.length,1);
    assert.equal(result.packages[0].quantity,'5');
    assert.equal(result.packages[0].id,'a');
  }
});

test('different LOT or different location remains a separate stock line',()=>{
  const a=item('a','LOT1','2');
  const b=appendReceiptPackage([a],item('b','LOT2','1'),limits);
  assert.equal(b.ok,true);
  if (!b.ok)return;
  assert.equal(b.packages.length,2);
  const c=appendReceiptPackage(b.packages,item('c','LOT1','1','locB'),limits);
  assert.equal(c.ok,true);
  if(c.ok)assert.equal(c.packages.length,3);
});

test('same LOT with different expiry is rejected before confirmation',()=>{
  const r=appendReceiptPackage([item('a','LOT1')],item('b','LOT1','1','locB','lineA','2028-01-01'),limits);
  assert.deepEqual(r,{ok:false,reason:'lot-expiry-conflict'});
});

test('invoice-wide remaining quantity applies across ALL lots and locations',()=>{
  assert.deepEqual(appendReceiptPackage([item('a','LOT1','6')],item('b','LOT2','3'),limits),{ok:false,reason:'capacity'});
  assert.equal(validateReceiptPackages([item('a','LOT1','6'),item('b','LOT2','3')],limits),'จำนวนรับเข้าเกินยอดค้างรับใน Invoice');
  assert.equal(validateReceiptPackages([item('a','LOT1','6'),item('b','LOT2','2')],limits),null);
});

test('multiple Product lines are counted independently and malformed quantities rejected',()=>{
  const r=appendReceiptPackage([item('a','L','8')],item('b','L','2','locA','lineB'),limits);
  assert.equal(r.ok,true);
  assert.equal(validateReceiptPackages([item('a','L','8'),item('b','L','2','locA','lineB')],limits),null);
  assert.equal(appendReceiptPackage([],item('x','LOT','0'),limits).ok,false);
  assert.equal(validateReceiptPackages([item('x','LOT','1.5')],limits),'กรุณาตรวจ LOT วันหมดอายุ จำนวน และตำแหน่งของทุกรายการ');
});

test('local auto-save is scoped to user and invoice and can be cleared after success',()=>{
  const previous=(globalThis as {localStorage?:Storage}).localStorage;
  const map=new Map<string,string>();
  const fake={ getItem:(k:string)=>map.get(k)??null, setItem:(k:string,v:string)=>{map.set(k,v);},removeItem:(k:string)=>{map.delete(k);} } as Storage;
  Object.defineProperty(globalThis,'localStorage',{value:fake,configurable:true});
  try {
    assert.equal(saveWorkbenchDraft('invoice','user1',[item('a','LOT1')],'key1'),true);
    assert.equal(readWorkbenchDraft('invoice','user1')?.packages[0].lot,'LOT1');
    assert.equal(readWorkbenchDraft('invoice','user2'),null);
    assert.equal(readWorkbenchDraft('other','user1'),null);
    map.set(workbenchDraftKey('invoice','user1'),JSON.stringify({packages:[item('a','LOT')],updatedAt:Date.now()-15*86400000,idempotencyKey:'key'}));
    assert.equal(readWorkbenchDraft('invoice','user1'),null,'expired drafts are not restored');
    clearWorkbenchDraft('invoice','user1');
    assert.equal(map.size,0);
  } finally {
    if(previous===undefined)delete (globalThis as {localStorage?:Storage}).localStorage;
    else Object.defineProperty(globalThis,'localStorage',{value:previous,configurable:true});
  }
});

test('receipt review identifies invalid LOT rows without blocking unrelated draft edits', () => {
  const packages = [item('valid','LOT-A','1'),item('location','LOT-B','1',''),item('capacity','LOT-C','8')];
  assert.deepEqual(receiptPackageIssues(packages, limits), [
    {id:'location',message:'ยังไม่เลือกตำแหน่งจัดเก็บ'},
    {id:'capacity',message:'จำนวนรวมของน้ำยานี้เกินยอดค้างรับ'},
  ]);
});
