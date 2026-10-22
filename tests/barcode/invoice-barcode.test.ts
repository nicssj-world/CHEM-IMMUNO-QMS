import assert from 'node:assert/strict';
import test from 'node:test';
import { invoiceNumberFromScan } from '../../src/lib/invoice-barcode';

test('accepts common invoice barcodes verbatim without changing leading zeroes', () => {
  assert.deepEqual(invoiceNumberFromScan('  INV-0026/0014  ', 'CODE_128'), { ok: true, invoiceNumber: 'INV-0026/0014' });
  assert.deepEqual(invoiceNumberFromScan('0000100099', 'EAN_13'), { ok: true, invoiceNumber: '0000100099' });
  assert.deepEqual(invoiceNumberFromScan('IV.2026_00023', 'CODE_39'), { ok: true, invoiceNumber: 'IV.2026_00023' });
  assert.deepEqual(invoiceNumberFromScan('IV-2026-00024', 'QR_CODE'), { ok: true, invoiceNumber: 'IV-2026-00024' });
});

test('refuses structured QR, URL, embedded line breaks and GS1 reagent payloads', () => {
  const invalid = [
    ['https://supplier.example/invoice/123', 'QR_CODE'],
    ['{"invoice":"INV-100"}', 'QR_CODE'],
    ['INV-001\nINV-002', 'QR_CODE'],
    [']d201000123456789051725123110LOT-10', 'CODE_128'],
    ['(01)00012345678905(17)271231(10)LOT', 'CODE_128'],
    ['010012345678901710LOT', 'DATA_MATRIX'],
  ];
  for (const [raw, format] of invalid) assert.equal(invoiceNumberFromScan(raw, format).ok, false, raw);
});
