import assert from 'node:assert/strict';
import test from 'node:test';
import { combineVendorSnapshots } from '../../src/lib/unified-vendor';
import type { Snapshot } from '../../src/lib/vendor-evaluation';

const fixture = (code: string, count: number, numerator: number, denominator: number): Snapshot => ({
  vendor: { id: 'vendor', vendorCode: 'V-0001', name: 'Test vendor', legalName: null,
    taxId: null, taxBranchCode: '00000', address: null },
  warehouse: { id: code === 'CHE' ? 1 : 2, code, name: code }, fiscalYear: 2570,
  coverage: { startDate: '2026-10-01', endDate: '2027-09-30', assessmentRequiredFrom: '2026-10-01',
    completed: count, pending: 1, percentage: count / (count + 1) * 100 },
  activity: { invoices: 1, receipts: count, completedAssessments: count, pendingAssessments: 1,
    openIssues: 1, resolvedIssues: 0 },
  criteria: [{ criterionCode: 'delivery_completeness', displayOrder: 1, numerator, denominator,
    applicable: true, percentage: numerator / denominator * 100 }],
  capturedAt: '2026-10-09T00:00:00Z',
});

test('unified supplier evidence counts a mixed Invoice once and weights criteria by sample size', () => {
  const summary = combineVendorSnapshots([fixture('CHE', 1, 1, 1), fixture('IMM', 4, 2, 4)], 1);
  assert.ok(summary);
  assert.equal(summary.activity.invoices, 1);
  assert.equal(summary.activity.receipts, 5);
  assert.equal(summary.coverage.completed, 5);
  assert.equal(summary.coverage.pending, 2);
  assert.equal(summary.criteria[0].numerator, 3);
  assert.equal(summary.criteria[0].denominator, 5);
  assert.equal(summary.criteria[0].percentage, 60);
  assert.equal(summary.warehouse.code, 'ALL');
});

test('unified supplier evidence is unavailable without any authorized snapshots', () => {
  assert.equal(combineVendorSnapshots([], 0), null);
});
