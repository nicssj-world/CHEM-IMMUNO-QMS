import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBarcode, barcodeIdentifierCandidates } from '../../src/lib/barcode';
import { scannedReceivingDefaults } from '../../src/lib/receiving-scan-defaults';

test('Roche-style GS1 Data Matrix auto-fills exact LOT and expiry into Step 2 without review when product/location exist', () => {
  const raw = '010087519700639110N29106\x1d172710311126032424009040765190';
  const parsed = parseBarcode(raw, 'DATA_MATRIX');
  assert.equal(parsed.additionalProductId, '09040765190');
  assert.ok(barcodeIdentifierCandidates(parsed).includes('09040765190'));
  assert.deepEqual(scannedReceivingDefaults(parsed,true,true),{
    lot:'N29106',expiry:'2027-10-31',requiresReview:false,
  });
});

test('a second Roche-style Data Matrix with another LOT fills both fields and preserves leading zeros in REF', () => {
  const raw='01076133361215351094146701\x1d1727053124008058679190\x1d11251229';
  const parsed=parseBarcode(raw,'DATA_MATRIX');
  assert.equal(parsed.additionalProductId,'08058679190');
  assert.deepEqual(scannedReceivingDefaults(parsed,true,true),{
    lot:'94146701',expiry:'2027-05-31',requiresReview:false,
  });
});

test('GS1 expiry day 00 auto-fills final day of leap and non-leap month',()=>{
  const leap=parseBarcode('(01)00012345678905(17)280200(10)LEAP','DATA_MATRIX');
  const normal=parseBarcode('(01)00012345678905(17)270200(10)NORMAL','DATA_MATRIX');
  assert.deepEqual(scannedReceivingDefaults(leap,true,true),{lot:'LEAP',expiry:'2028-02-29',requiresReview:false});
  assert.deepEqual(scannedReceivingDefaults(normal,true,true),{lot:'NORMAL',expiry:'2027-02-28',requiresReview:false});
});

test('unknown trailing AI retains valid parsed LOT/expiry only in explicit manual review, never auto-appends',()=>{
  const parsed=parseBarcode('010087519700639110N29106\x1d172710311126032424009040765190\x1d999','DATA_MATRIX');
  assert.ok(parsed.warnings.some(w=>w.startsWith('Unknown or malformed AI')));
  assert.deepEqual(scannedReceivingDefaults(parsed,true,true),{
    lot:'N29106',expiry:'2027-10-31',requiresReview:true,
  });
});

test('unknown Product or missing storage location must require review even if barcode parses cleanly',()=>{
  const parsed=parseBarcode('(01)00012345678905(17)271231(10)LOT-1','DATA_MATRIX');
  assert.deepEqual(scannedReceivingDefaults(parsed,false,true),{lot:'LOT-1',expiry:'2027-12-31',requiresReview:true});
  assert.deepEqual(scannedReceivingDefaults(parsed,true,false),{lot:'LOT-1',expiry:'2027-12-31',requiresReview:true});
});

test('invalid expiry or duplicate GS1 AI clears batch defaults to prevent untrusted stock data',()=>{
  const invalid=parseBarcode('(01)00012345678905(17)271300(10)LOT-1','DATA_MATRIX');
  assert.deepEqual(scannedReceivingDefaults(invalid,true,true),{lot:'',expiry:'',requiresReview:true});
  const dup=parseBarcode('(01)00012345678905(17)271231(10)LOT-1(17)281231','DATA_MATRIX');
  assert.deepEqual(scannedReceivingDefaults(dup,true,true),{lot:'',expiry:'',requiresReview:true});
});
