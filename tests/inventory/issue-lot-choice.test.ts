import assert from 'node:assert/strict';
import test from 'node:test';
import {issueBalanceAfter,isFefoLot,scannedIssueLotIndex,scannedIssueLotStatus,type IssueLotOption} from '../../src/lib/issue-lot-choice';

const options:IssueLotOption[]=[
  {lot_id:'a',lot_number:'A1',expiry_date:'2027-01-01',location_id:'1',location_code:'FR1',balance:5},
  {lot_id:'b',lot_number:'B1',expiry_date:'2027-03-01',location_id:'1',location_code:'FR1',balance:8},
  {lot_id:'b',lot_number:'B1',expiry_date:'2027-03-01',location_id:'2',location_code:'FR2',balance:2},
  {lot_id:'c',lot_number:'C1',expiry_date:'2027-05-01',location_id:'1',location_code:'FR1',balance:12},
];

test('unique scanned LOT auto-targets the correct row without changing inventory',()=>{
  assert.equal(scannedIssueLotIndex(options,'c1'),3);
  assert.equal(scannedIssueLotStatus(options,' c1 '),'unique');
  assert.equal(options[3].balance,12);
});

test('duplicate printed LOT in two locations is ambiguous and must not preselect a location',()=>{
  assert.equal(scannedIssueLotIndex(options,'B1'),-1);
  assert.equal(scannedIssueLotStatus(options,'B1'),'ambiguous');
  assert.equal(scannedIssueLotStatus(options,'UNKNOWN'),'missing');
  assert.equal(scannedIssueLotIndex(options,''),-1);
  assert.equal(scannedIssueLotStatus(options,''),'none');
});

test('first expiry lot is FEFO; another location for same LOT is not a FEFO override',()=>{
  assert.equal(isFefoLot(options,'a'),true);
  assert.equal(isFefoLot(options,'b'),false);
  assert.equal(isFefoLot(options,'c'),false);
  const sameLot=[{...options[0],location_id:'2'},options[0],options[1]];
  assert.equal(isFefoLot(sameLot,'a'),true);
});

test('remaining preview only accepts positive safe integers within location balance',()=>{
  assert.equal(issueBalanceAfter(8,'3'),5);
  assert.equal(issueBalanceAfter(8,'8'),0);
  assert.equal(issueBalanceAfter(8,'9'),null);
  assert.equal(issueBalanceAfter(8,'0'),null);
  assert.equal(issueBalanceAfter(8,''),null);
  assert.equal(issueBalanceAfter(8,'2.5'),null);
  assert.equal(issueBalanceAfter(8,'NaN'),null);
  assert.equal(issueBalanceAfter(8,'999999999999999999'),null);
});
