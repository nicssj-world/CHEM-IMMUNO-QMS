/** Per-tab handoff for scanned invoice lines. Retain until receipt succeeds, so refresh / a failed validation does not erase the handoff. */
export type ScannedDraftLine = { productId: string; quantity: string; lot: string; expiry: string; raw?: string };

const key = (invoiceId: string) => `ci-receive-draft:${invoiceId}`;

export function saveReceiveDraft(invoiceId: string, lines: ScannedDraftLine[]) {
  try { if (lines.length) sessionStorage.setItem(key(invoiceId), JSON.stringify(lines)); } catch { /* storage unavailable: lines are simply scanned again */ }
}

export function readReceiveDraft(invoiceId: string): ScannedDraftLine[] {
  try {
    const stored = sessionStorage.getItem(key(invoiceId));
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((item): item is ScannedDraftLine => !!item && typeof item.productId === 'string' && typeof item.lot === 'string' && typeof item.expiry === 'string' && typeof item.quantity === 'string') : [];
  } catch { return []; }
}

export function clearReceiveDraft(invoiceId: string) {
  try { sessionStorage.removeItem(key(invoiceId)); } catch { /* storage unavailable */ }
}
