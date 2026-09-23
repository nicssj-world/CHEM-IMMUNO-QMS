import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBarcode } from '../../src/lib/barcode';

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
