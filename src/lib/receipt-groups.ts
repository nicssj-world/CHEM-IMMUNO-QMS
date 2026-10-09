/**
 * One confirmation can write separate signed receipts for CHE and IMM.
 * Group only receipt rows that belong to the same Invoice and carry the
 * same idempotency key from their original RECEIVE transactions.
 *
 * Never group by invoice number or receipt date: partial deliveries,
 * cancelled/re-created invoices and repeated receiving sessions must remain
 * distinct. No ledger rows or official historical event numbers are changed.
 */
export type ReceiptGroupable = {
  id: string;
  invoice_id: string;
  received_at: string;
  event_number: string | null;
};
export type ReceiptTransactionLink = {
  id: string;
  receipt_id: string;
  idempotency_key: string | null;
};
export type ReceiptGroup<T extends ReceiptGroupable> = {
  key: string;
  events: T[];
  /** Earliest historical event number in this confirmation, for the card title. */
  displayNumber: string | null;
  /** All immutable event numbers, including the second ledger's identifier. */
  referenceNumbers: string[];
};

export function groupReceiptEvents<T extends ReceiptGroupable>(
  events: readonly T[],
  transactions: readonly ReceiptTransactionLink[],
): ReceiptGroup<T>[] {
  const txByReceipt = new Map<string, ReceiptTransactionLink>();
  for (const tx of transactions) if (!txByReceipt.has(tx.receipt_id)) txByReceipt.set(tx.receipt_id, tx);
  const grouped = new Map<string, T[]>();
  for (const event of events) {
    const idempotencyKey = txByReceipt.get(event.id)?.idempotency_key?.trim();
    // An event without visible transaction evidence stays a standalone card.
    const key = idempotencyKey
      ? `invoice:${event.invoice_id}:confirmation:${idempotencyKey}`
      : `receipt:${event.id}`;
    const members = grouped.get(key);
    if (members) {
      if (!members.some(member => member.id === event.id)) members.push(event);
    } else {
      grouped.set(key, [event]);
    }
  }
  return [...grouped].map(([key, members]) => {
    const sorted = [...members].sort((a, b) =>
      (a.event_number ?? '').localeCompare(b.event_number ?? '', undefined, { numeric: true }) ||
      a.received_at.localeCompare(b.received_at) || a.id.localeCompare(b.id));
    const referenceNumbers = sorted.flatMap(event => event.event_number ? [event.event_number] : []);
    return { key, events: sorted, displayNumber: referenceNumbers[0] ?? null, referenceNumbers };
  });
}
