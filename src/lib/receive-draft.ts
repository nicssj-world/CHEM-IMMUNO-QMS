/** Scanned lines handed from the new-invoice form to the receiving workbench of that invoice (per tab, never persisted longer). */
export type ScannedDraftLine = { productId: string; quantity: string; lot: string; expiry: string; raw?: string };

const key = (invoiceId: string) => `ci-receive-draft:${invoiceId}`;

export function saveReceiveDraft(invoiceId: string, lines: ScannedDraftLine[]) {
  try { if (lines.length) sessionStorage.setItem(key(invoiceId), JSON.stringify(lines)); } catch { /* storage unavailable: lines are simply scanned again */ }
}

export function takeReceiveDraft(invoiceId: string): ScannedDraftLine[] {
  try {
    const stored = sessionStorage.getItem(key(invoiceId));
    if (!stored) return [];
    sessionStorage.removeItem(key(invoiceId));
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((item): item is ScannedDraftLine => !!item && typeof item.productId === 'string' && typeof item.lot === 'string' && typeof item.expiry === 'string' && typeof item.quantity === 'string') : [];
  } catch { return []; }
}
