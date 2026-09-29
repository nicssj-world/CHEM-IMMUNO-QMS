import type { SupabaseClient } from '@supabase/supabase-js';
import { ASSESSMENT_COLUMNS, type AssessmentRow } from '@/lib/receipt-assessment';

export type ReceiptEvent = {
  id: string; warehouse_id: number; received_at: string; invoice_id: string;
  invoice: { invoice_number: string; vendor_id: string; po_number: string | null } | null;
  event_number: string | null; assessment: AssessmentRow | null; revisions: { revision_number: number; changed_at: string; changed_by: string }[];
};

type Raw = {
  id: string; warehouse_id: number; received_at: string; invoice_id: string;
  ci_invoices: { invoice_number: string; vendor_id: string; po_number: string | null } | null;
  ci_receipt_event_numbers: { event_number: string } | { event_number: string }[] | null;
  ci_receipt_assessments: AssessmentRow | AssessmentRow[] | null;
};
const one = <T,>(value: T | T[] | null): T | null => (Array.isArray(value) ? value[0] ?? null : value);

/** Receipts with their event number, five-criteria assessment and revision trail; RLS limits rows to warehouses the user can read. */
export async function loadReceiptEvents(client: SupabaseClient, filter: { vendorId?: string; invoiceId?: string; warehouseId?: number; limit?: number }) {
  let query = client.from('ci_receipts')
    .select(`id,warehouse_id,received_at,invoice_id,ci_invoices!inner(invoice_number,vendor_id,po_number),ci_receipt_event_numbers(event_number),ci_receipt_assessments(${ASSESSMENT_COLUMNS})`)
    .order('received_at', { ascending: false }).limit(filter.limit ?? 100);
  if (filter.vendorId) query = query.eq('ci_invoices.vendor_id', filter.vendorId);
  if (filter.invoiceId) query = query.eq('invoice_id', filter.invoiceId);
  if (filter.warehouseId) query = query.eq('warehouse_id', filter.warehouseId);
  const { data, error } = await query;
  if (error) return { events: [] as ReceiptEvent[], error };
  const rows = (data ?? []) as unknown as Raw[];
  const assessmentIds = rows.map(r => one(r.ci_receipt_assessments)?.id).filter((id): id is string => Boolean(id));
  const { data: revisionData, error: revisionError } = assessmentIds.length
    ? await client.from('ci_receipt_assessment_revisions').select('assessment_id,revision_number,changed_at,changed_by').in('assessment_id', assessmentIds).order('revision_number')
    : { data: [], error: null };
  const revisions = new Map<string, ReceiptEvent['revisions']>();
  for (const r of (revisionData ?? []) as { assessment_id: string; revision_number: number; changed_at: string; changed_by: string }[]) {
    revisions.set(r.assessment_id, [...(revisions.get(r.assessment_id) ?? []), { revision_number: r.revision_number, changed_at: r.changed_at, changed_by: r.changed_by }]);
  }
  const events = rows.map(r => {
    const assessment = one(r.ci_receipt_assessments);
    return { id: r.id, warehouse_id: r.warehouse_id, received_at: r.received_at, invoice_id: r.invoice_id, invoice: r.ci_invoices, event_number: one(r.ci_receipt_event_numbers)?.event_number ?? null, assessment, revisions: assessment ? revisions.get(assessment.id) ?? [] : [] };
  });
  return { events, error: revisionError };
}
