import assert from 'node:assert/strict';
import test from 'node:test';
import { apparentOutOfRange, bangkokDate, EXCURSION_STATUS_LABEL, excursionCompletionView, parseEnvironmentQr } from '../../src/lib/environment';

test('Environment QR accepts only the configured app origin or exact path', () => {
  const token = 'a'.repeat(32);
  const origin = 'https://chem-immuno-cbh.vercel.app';
  assert.equal(parseEnvironmentQr(`${origin}/q/${token}`, origin), token);
  assert.equal(parseEnvironmentQr(`/q/${token}`, origin), token);
  for (const text of [`https://other.example/q/${token}`, `${origin}/q/${token}?next=/scan`, `${origin}/q/${token}#x`, `${origin}/scan`, '0101234567890128', `/q/${'A'.repeat(32)}`]) {
    assert.equal(parseEnvironmentQr(text, origin), null, text);
  }
});

test('range hint is inclusive and does not accept wrong parameter semantics', () => {
  assert.equal(apparentOutOfRange('2.00', true, 2, 8), false);
  assert.equal(apparentOutOfRange('8.00', true, 2, 8), false);
  assert.equal(apparentOutOfRange('1.99', true, 2, 8), true);
  assert.equal(apparentOutOfRange('8.01', true, 2, 8), true);
  assert.equal(apparentOutOfRange('−20', true, null, -20), false);
  assert.equal(apparentOutOfRange('-19.99', true, null, -20), true);
  assert.equal(apparentOutOfRange('20', false, null, null), false);
});

test('Bangkok business date changes at 17:00 UTC', () => {
  assert.equal(bangkokDate(new Date('2026-09-26T16:59:00Z')), '2026-09-26');
  assert.equal(bangkokDate(new Date('2026-09-26T17:00:00Z')), '2026-09-27');
});

// Excursion completion is a single step: Staff/Supervisor/Admin ("canWork") see one form for an open excursion, asking
// for both the corrective action and the resolution together; a Viewer only ever sees the read-only detail; a resolved
// excursion never shows a form again; and a legacy 'acknowledged' excursion (from the old two-step flow) asks only for
// the resolution, since its corrective action is already on file. There is never a separate acknowledge-then-close pair
// of stages for the same excursion.
test('excursion completion view: one form for open, resolution-only for a legacy acknowledged event, hidden otherwise', () => {
  assert.equal(excursionCompletionView('open', true), 'complete');
  assert.equal(excursionCompletionView('open', false), 'hidden', 'a Viewer gets the read-only detail, never a form');
  assert.equal(excursionCompletionView('acknowledged', true), 'legacy-complete');
  assert.equal(excursionCompletionView('acknowledged', false), 'hidden');
  assert.equal(excursionCompletionView('resolved', true), 'hidden', 'a resolved excursion never shows a completion form again, for anyone');
  assert.equal(excursionCompletionView('resolved', false), 'hidden');
});

test('excursion status labels never use the old two-step wording', () => {
  assert.deepEqual(EXCURSION_STATUS_LABEL, { open: 'รอดำเนินการ', acknowledged: 'รับทราบแล้ว', resolved: 'ดำเนินการแล้ว' });
});
