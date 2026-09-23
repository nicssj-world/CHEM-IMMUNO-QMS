# Phase 2 receiving and inventory control

The Production target is `nivlnbaveanoawfbrmzz`. Apply `20260923200124_ci_phase2_receiving_control.sql` only after the Production backup, migration history comparison, and dry run. The migration extends the existing `ci_*` model and does not load Product Master or create stock movements.

## Receiving

An invoice may contain lines from both authorized warehouses. A receiving draft is local to the browser until confirmation. A scan records its original payload and parsed evidence, and may fill Product, LOT, and expiry in the draft. The user reviews quantity, location, and assessment before the existing atomic receipt ledger operation. A conflicting Product and LOT expiry holds the draft. Duplicate confirmation uses the existing idempotency key.

GS1 parsing supports AI 01, 10, 17, 21, and 240 with group separator boundaries. HIBC primary and secondary parsing checks the primary Mod43 character. Approved identifiers alone can resolve a Product. HIBC primary is stored as the full primary identity, including labeler and PCN; a bare PCN and GS1 AI 240 never become `REF_CURRENT` automatically. Unknown scans can be used manually for the current draft or submitted for Supervisor/Admin mapping review. Proposed identifiers do not resolve until approved.

## Private invoice evidence

After the migration and local Storage policy checks, create a **private** Supabase Storage bucket named `ci-invoice-evidence`. Its public flag must be false. The browser uploads through a short lived signed upload token, backed by a registered `ci_attachments` row. Reading uses an authenticated server route and a short lived signed object URL. Storage policies require warehouse authorization; removal is allowed only before a receipt has been confirmed for that invoice. Do not upload patient information during rollout verification.

## Reorder and attention

Automatic ROP uses net issue consumption from the last 90 days, including issue reversals, divided by 90, multiplied by lead time, plus safety stock. Waste, transfers, generic adjustments, and expired disposal do not count as consumption. Automatic mode requires configured lead time, safety stock, target coverage, pack quantity, and a full 90 day history window; until then the status explains `ต้องตั้งค่า`. Manual ROP is entered in packs. Suggested order uses target coverage demand less usable unexpired stock, rounded up to the order pack quantity; open purchase orders are not subtracted. Expiry buckets use the Asia/Bangkok date at the LOT and location level.

Vendor metrics show objective receiving evidence. Annual evaluation score and decision remain null because no scoring policy is approved. The fiscal year runs from 1 October through 30 September.

## Local verification

Run `npm test`, `npm run test:import`, `npm run test:db`, `npm run test:auth:local`, `npm run test:storage:local`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm audit --omit=dev`. The Auth and Storage scripts each reset the disposable local Supabase stack; run them sequentially. A physical iPhone camera test still requires the owner's device.
