import { scanBatchFields, type ParsedBarcode } from './barcode';

/** Single source for Step 2 scanned LOT/expiry defaults.
 * Parsed fields are always shown as-is; only clean, known, located Products
 * are eligible for a one-step append to the receiving draft.
 */
export function scannedReceivingDefaults(
  parsed: ParsedBarcode,
  productResolved: boolean,
  locationResolved: boolean,
): { lot: string; expiry: string; requiresReview: boolean } {
  const batch = scanBatchFields(parsed);
  return {
    lot: batch.lot,
    expiry: batch.expiry,
    requiresReview: batch.requiresReview ||
      !productResolved || !locationResolved || !batch.lot || !batch.expiry,
  };
}
