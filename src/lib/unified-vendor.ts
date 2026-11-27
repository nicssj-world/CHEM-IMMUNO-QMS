import type { Snapshot } from '@/lib/vendor-evaluation';

/** Combines read-only vendor evidence from both signed ledgers.
 * A shared Invoice is counted once using the distinct count provided by the caller.
 * Never calculate an official annual score by averaging previously signed reports.
 */
export function combineVendorSnapshots(rows: readonly Snapshot[], distinctInvoiceCount: number): Snapshot | null {
  if (!rows.length) return null;
  const first = rows[0];
  const completed = rows.reduce((n, row) => n + row.coverage.completed, 0);
  const pending = rows.reduce((n, row) => n + row.coverage.pending, 0);
  const criteria = new Map<string, Snapshot['criteria'][number]>();
  for (const row of rows) for (const criterion of row.criteria) {
    const prior = criteria.get(criterion.criterionCode);
    const numerator = (prior?.numerator ?? 0) + Number(criterion.numerator);
    const denominator = (prior?.denominator ?? 0) + Number(criterion.denominator);
    criteria.set(criterion.criterionCode, {
      criterionCode: criterion.criterionCode,
      displayOrder: criterion.displayOrder,
      numerator, denominator,
      applicable: denominator > 0,
      percentage: denominator > 0 ? (numerator / denominator) * 100 : null,
      supplementaryCount: (prior?.supplementaryCount ?? 0) + (criterion.supplementaryCount ?? 0),
    });
  }
  return {
    ...first,
    warehouse: { id: 0, code: 'ALL', name: 'CHEM-IMMUNO' },
    coverage: {
      startDate: rows.reduce((acc, row) => acc < row.coverage.startDate ? acc : row.coverage.startDate, first.coverage.startDate),
      endDate: rows.reduce((acc, row) => acc > row.coverage.endDate ? acc : row.coverage.endDate, first.coverage.endDate),
      assessmentRequiredFrom: rows.reduce((acc, row) => acc < row.coverage.assessmentRequiredFrom ? acc : row.coverage.assessmentRequiredFrom, first.coverage.assessmentRequiredFrom),
      completed, pending,
      percentage: completed + pending ? (completed / (completed + pending)) * 100 : null,
    },
    activity: {
      invoices: distinctInvoiceCount,
      receipts: rows.reduce((n, row) => n + row.activity.receipts, 0),
      completedAssessments: rows.reduce((n, row) => n + row.activity.completedAssessments, 0),
      pendingAssessments: rows.reduce((n, row) => n + row.activity.pendingAssessments, 0),
      openIssues: rows.reduce((n, row) => n + row.activity.openIssues, 0),
      resolvedIssues: rows.reduce((n, row) => n + row.activity.resolvedIssues, 0),
    },
    criteria: [...criteria.values()].sort((a, b) => a.displayOrder - b.displayOrder),
    issues: rows.flatMap(row => row.issues ?? []),
    receipts: rows.flatMap(row => row.receipts ?? []),
    assessments: rows.flatMap(row => row.assessments ?? []),
  };
}
