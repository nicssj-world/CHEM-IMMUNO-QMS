import assert from 'node:assert/strict';
import test from 'node:test';
import { ScanIntakeGate } from '../../src/lib/scan-intake-gate';

test('continuous camera frames cannot overlap while the scan callback is in progress', () => {
  const gate = new ScanIntakeGate();
  assert.equal(gate.begin(), true);
  assert.equal(gate.begin(), false, 'a second camera frame must not run concurrently');
  gate.finish();
  assert.equal(gate.begin(), true);
  gate.finish();
});

test('new Data Matrix cannot replace a batch waiting for manual LOT/expiry review', () => {
  const gate = new ScanIntakeGate();
  assert.equal(gate.begin(), true);
  gate.requireReview();
  gate.finish();
  assert.equal(gate.hasPendingReview, true);
  assert.equal(gate.begin(), false, 'new barcode must not overwrite pending reviewed fields');
  assert.equal(gate.beginReviewedCommit(), true);
  assert.equal(gate.beginReviewedCommit(), false, 'double tap on confirm must not double-add');
  gate.finish();
  assert.equal(gate.begin(), false, 'failed review retains the original candidate');
  gate.completeReview();
  assert.equal(gate.begin(), true, 'explicit confirm or cancel permits the next scan');
  gate.finish();
});

test('severe parse warning must preserve safety lock until user cancels the candidate', () => {
  const gate = new ScanIntakeGate();
  assert.equal(gate.begin(), true);
  gate.requireReview();
  gate.finish();
  assert.equal(gate.begin(), false);
  gate.completeReview();
  assert.equal(gate.hasPendingReview, false);
  assert.equal(gate.begin(), true);
  gate.finish();
});
