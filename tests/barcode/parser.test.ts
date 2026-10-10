import assert from 'node:assert/strict';
import test from 'node:test';
import { barcodeIdentifierCandidates, parseBarcode, scanBatchFields } from '../../src/lib/barcode';

test('GS1-128 retains GTIN leading zero, LOT, expiry, serial and AI 240 semantics', () => {
  const raw = ']C101000123456789051725123110LOT-A\x1d21SER-7\x1d240EXTRA';
  const parsed = parseBarcode(raw, 'CODE_128');
  assert.equal(parsed.raw, raw);
  assert.equal(parsed.standard, 'GS1');
  assert.equal(parsed.gtin, '00012345678905');
  assert.equal(parsed.lot, 'LOT-A');
  assert.equal(parsed.expiry, '2025-12-31');
  assert.equal(parsed.serial, 'SER-7');
  assert.equal(parsed.additionalProductId, 'EXTRA');
  assert.deepEqual(parsed.warnings, []);
});

test('GS1 DataMatrix and parenthesized manual payload parse without rewriting raw evidence', () => {
  const raw = ']d2\x1d01000123456789051725123110LOT-2<GS>21SER-2';
  assert.equal(parseBarcode(raw, 'DATA_MATRIX').lot, 'LOT-2');
  assert.equal(parseBarcode('(01)00012345678905(17)251231(10)L2').expiry, '2025-12-31');
});

test('standalone parenthesized AI 240 remains a distinct proposal value and bare 240 is not guessed', () => {
  const parsed = parseBarcode('(240)UNKNOWN-CATALOG-CODE');
  assert.equal(parsed.standard, 'GS1');
  assert.equal(parsed.additionalProductId, 'UNKNOWN-CATALOG-CODE');
  assert.equal(parsed.gtin, undefined);
  assert.equal(parsed.primary, undefined);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parseBarcode('240UNKNOWN-CATALOG-CODE').standard, 'UNKNOWN');
});

test('malformed GS1 retains warnings without guessing LOT or expiry', () => {
  const parsed = parseBarcode(']d201000123456789051799999910LOT');
  assert.equal(parsed.expiry, undefined);
  assert.ok(parsed.warnings.length > 0);
  assert.equal(parseBarcode(']C1010001234567890510LOT17251231').lot, 'LOT17251231');
});

test('HIBC Code128 and DataMatrix primary/secondary keep PCN separate from REF', () => {
  for (const symbology of [']C0', ']d1']) {
    const parsed = parseBarcode(`${symbology}+A99912345/$$52001510X33`, symbology);
    assert.equal(parsed.standard, 'HIBC');
    assert.equal(parsed.pcn, '1234');
    assert.equal(parsed.lot, '10X3');
    assert.equal(parsed.expiry, '2020-01-15');
    assert.equal(parsed.primary, 'A99912345');
    assert.deepEqual(parsed.warnings, []);
  }
});

test('HIBC supplemental serial, expiry and quantity use the final symbol check character', () => {
  const parsed = parseBarcode('+A99912349/$10X3/16D20111231/14D20200131/Q500Z', 'DATA_MATRIX');
  assert.equal(parsed.pcn, '1234');
  assert.equal(parsed.lot, '10X3');
  assert.equal(parsed.expiry, '2020-01-31');
  assert.equal(parsed.quantity, 500);
  assert.deepEqual(parsed.warnings, []);
  const serial = parseBarcode('+A99912345/$$52001510X3/16D20111212/S77DEFG457');
  assert.equal(serial.serial, '77DEFG45');
});

test('malformed HIBC remains reviewable', () => {
  const parsed = parseBarcode('+A99912345/$$52001510X34', 'CODE_128');
  assert.ok(parsed.warnings.length > 0);
  assert.equal(parsed.standard, 'HIBC');
  assert.equal(parsed.expiry, undefined);
});

test('Roche reagent optical Data Matrix bytes parse to exact REF/GTIN/LOT/expiry', () => {
  // Decoded directly from the matrix in two actual stock photos (not printed AI text).
  const samples = [
    { raw: '010087519700639110N29106\x1d172710311126032424009040765190', gtin: '00875197006391', ref: '09040765190', lot: 'N29106', expiry: '2027-10-31', made: '2026-03-24' },
    { raw: '01076133361215351094146701\x1d1727053124008058679190\x1d11251229', gtin: '07613336121535', ref: '08058679190', lot: '94146701', expiry: '2027-05-31', made: '2025-12-29' },
  ];
  for (const item of samples) {
    const parsed = parseBarcode(item.raw, 'DATA_MATRIX');
    assert.equal(parsed.standard, 'GS1');
    assert.deepEqual(parsed.warnings, []);
    assert.equal(parsed.gtin, item.gtin);
    assert.equal(parsed.additionalProductId, item.ref);
    assert.equal(parsed.lot, item.lot);
    assert.equal(parsed.expiry, item.expiry);
    assert.equal(parsed.productionDate, item.made);
    assert.ok(barcodeIdentifierCandidates(parsed).includes(item.ref));
    assert.ok(barcodeIdentifierCandidates(parsed).includes(item.gtin));
  }
});

test('common batch trust rejects malformed GS1 without discarding clean batch', () => {
  assert.deepEqual(scanBatchFields(parseBarcode('(01)00012345678905(17)271231(10)LOT-A')), {lot:'LOT-A',expiry:'2027-12-31',requiresReview:false});
  assert.deepEqual(scanBatchFields(parseBarcode(']d201000123456789051799999910LOT')), {lot:'',expiry:'',requiresReview:true});
});
 
test('batch trust keeps validated HIBC LOT/expiry despite unrelated supplement warning', () => {
  const parsed = parseBarcode('+A99912349/$10X3/16D20111231/14D20200131/Q500Z', 'DATA_MATRIX');
  assert.deepEqual(scanBatchFields({...parsed, warnings:['Unsupported HIBC supplemental field: X']}),
    {lot:'10X3',expiry:'2020-01-31',requiresReview:false});
  assert.deepEqual(scanBatchFields({...parsed, warnings:['Invalid HIBC 16D manufacture date']}),
    {lot:'10X3',expiry:'2020-01-31',requiresReview:false});
});

test('GS1 AI 17 day 00 is the last calendar day of the encoded month', () => {
  assert.equal(parseBarcode('(01)00012345678905(17)280200(10)FEB').expiry, '2028-02-29');
  assert.equal(parseBarcode('(01)00012345678905(17)270200(10)FEB').expiry, '2027-02-28');
  assert.equal(parseBarcode('(01)00012345678905(17)271200(10)DEC').expiry, '2027-12-31');
  assert.equal(parseBarcode('(01)00012345678905(17)271300(10)BAD').expiry, undefined);
});

test('GS1 trailing unknown AI retains decoded batch for explicit review only', () => {
  const parsed = parseBarcode('010087519700639110N29106\\x1d172710311126032424009040765190999');
  assert.equal(parsed.lot, 'N29106');
  assert.equal(parsed.expiry, '2027-10-31');
  assert.ok(parsed.warnings.some(w => w.startsWith('Unknown or malformed AI')));
  assert.deepEqual(scanBatchFields(parsed), {lot:'N29106',expiry:'2027-10-31',requiresReview:true});
  assert.deepEqual(scanBatchFields({...parsed,warnings:['Duplicate AI 17']}), {lot:'',expiry:'',requiresReview:true});
});
