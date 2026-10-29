import assert from 'node:assert/strict';
import test from 'node:test';
import { groupReceiptEvents } from '../../src/lib/receipt-groups';

const invoice = '5c2a10b3-80be-4f78-80d5-ee497215737e';
const earlier = { id: 'previous', invoice_id: 'cancelled-invoice-id', received_at: '2026-10-09T04:04:10.477974Z', event_number: 'RC-2570-0001' };
const chem = { id: 'chem-receipt', invoice_id: invoice, received_at: '2026-10-09T06:46:33.792656Z', event_number: 'RC-2570-0002' };
const imm = { id: 'imm-receipt', invoice_id: invoice, received_at: chem.received_at, event_number: 'RC-2570-0003' };

test('one confirmed mixed Invoice is shown as one receipt with both original event references', () => {
  const grouped = groupReceiptEvents([imm, chem], [
    { id: 'tx-imm', receipt_id: imm.id, idempotency_key: 'one-confirmation' },
    { id: 'tx-chem', receipt_id: chem.id, idempotency_key: 'one-confirmation' },
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].displayNumber, 'RC-2570-0002');
  assert.deepEqual(grouped[0].referenceNumbers, ['RC-2570-0002', 'RC-2570-0003']);
  assert.deepEqual(grouped[0].events.map(event => event.id), [chem.id, imm.id]);
});

test('a cancelled Invoice with the same visible invoice number remains separate', () => {
  const grouped = groupReceiptEvents([earlier, imm, chem], [
    { id: 'old-tx', receipt_id: earlier.id, idempotency_key: 'one-confirmation' },
    { id: 'chem-tx', receipt_id: chem.id, idempotency_key: 'one-confirmation' },
    { id: 'imm-tx', receipt_id: imm.id, idempotency_key: 'one-confirmation' },
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped.find(group => group.events.some(row => row.id === earlier.id))?.events.length, 1);
});

test('two separately confirmed deliveries for one Invoice stay separate even at the same timestamp', () => {
  const grouped = groupReceiptEvents([chem, imm], [
    { id: 'tx-chem', receipt_id: chem.id, idempotency_key: 'confirm-A' },
    { id: 'tx-imm', receipt_id: imm.id, idempotency_key: 'confirm-B' },
  ]);
  assert.equal(grouped.length, 2);
});

test('missing transaction visibility never invents a joined receipt', () => {
  const grouped = groupReceiptEvents([chem, imm], [
    { id: 'tx-chem', receipt_id: chem.id, idempotency_key: 'confirm-A' },
  ]);
  assert.equal(grouped.length, 2);
});

test('null keys never group unrelated events and duplicate rows cannot double count', () => {
  const grouped = groupReceiptEvents([chem, chem, imm], [
    { id: 'tx-chem', receipt_id: chem.id, idempotency_key: null },
    { id: 'tx-imm', receipt_id: imm.id, idempotency_key: null },
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].events.length, 1);
});
