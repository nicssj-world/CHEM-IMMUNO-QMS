import type { ReceiptPackage } from './receipt-workbench';

/** Auto-save is local to this browser AND the logged-in user; it is not a server or cross-device draft. */
export type WorkbenchDraft = {
  packages: ReceiptPackage[];
  idempotencyKey: string;
  updatedAt: number;
};

export const workbenchDraftKey = (invoiceId: string, userId: string) => `ci-receiving-v1:${userId}:${invoiceId}`;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function readWorkbenchDraft(invoiceId: string, userId: string): WorkbenchDraft | null {
  try {
    const raw = localStorage.getItem(workbenchDraftKey(invoiceId,userId));
    if (!raw) return null;
    const record: unknown = JSON.parse(raw);
    if (!record || typeof record !== 'object') return null;
    const item = record as Record<string,unknown>;
    if (typeof item.updatedAt !== 'number' || Date.now() - item.updatedAt > MAX_AGE_MS || item.updatedAt > Date.now() + 60000
        || typeof item.idempotencyKey !== 'string' || !item.idempotencyKey
        || !Array.isArray(item.packages)) return null;
    const packages = item.packages.filter((p: unknown): p is ReceiptPackage => {
      if (!p || typeof p !== 'object') return false;
      const x = p as Record<string,unknown>;
      return ['id','invoiceLineId','quantity','lot','expiry','locationId'].every(k => typeof x[k] === 'string');
    });
    return { packages, updatedAt: item.updatedAt, idempotencyKey: item.idempotencyKey };
  } catch { return null; }
}

export function saveWorkbenchDraft(invoiceId: string, userId: string, packages: ReceiptPackage[], idempotencyKey: string): boolean {
  try {
    const key = workbenchDraftKey(invoiceId,userId);
    if (!packages.length) { localStorage.removeItem(key); return true; }
    localStorage.setItem(key, JSON.stringify({packages,idempotencyKey,updatedAt:Date.now()} satisfies WorkbenchDraft));
    return true;
  } catch { return false; }
}

export function clearWorkbenchDraft(invoiceId: string, userId: string): void {
  try { localStorage.removeItem(workbenchDraftKey(invoiceId,userId)); } catch { /* storage unavailable */ }
}
