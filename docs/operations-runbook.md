# CHEM-IMMUNO CBH Operations Runbook

Last reviewed: 2026-09-24

## Production identity and baseline

- Supabase project ref: `nivlnbaveanoawfbrmzz` (`https://nivlnbaveanoawfbrmzz.supabase.co`). Confirm the ref in Supabase CLI/dashboard before any hosted operation.
- Product baseline, verified with read-only aggregates: 162 active Products (90 CHE, 72 IMM); types 72 reagent, 34 calibrator, 23 control, 33 consumable; 162 current REF, 162 manufacturer barcode, 29 legacy REF (all attached to the current Product), including 138 leading-zero current REF values.
- Approved links: 90 source-confirmed plus 10 owner-approved Product relations; 26 source-confirmed plus 2 owner-approved Product-to-platform links. All 20 import review records have an immutable resolution event tied to its source row and workbook hash; 2 were explicitly left unassigned; critical open reviews: 0.
- Active Admin accounts: 1. Stock transactions: 0. Invoice evidence bucket: private, 10 MiB limit, JPEG/PNG/HEIC/PDF only.
- Verified account: Chrome profile `LabchemCBH`; Supabase organization `ChemImmuno-CBH`; project `CHEM-IMMUNO Stock`; Vercel team `nics-s-world`; project `chem-immuno-qms`; repository `nicssj-world/CHEM-IMMUNO-QMS`; Production domain `chem-immuno-cbh.vercel.app`.
- The current Production deployment is `Ready` on `main` at source commit `4e3fc3910402ceaef324bba289679f6c1713049e`. The Vercel project has Supabase variables scoped to Production only. The Supabase organization has one Production project, no Preview branches, and reports no database backup.
- Production currently reports 8 applied migrations through `ci_phase3_reporting_search`. Local source includes the additional migration `20260924133953_ci_private_rpc_dispatchers.sql`; it passed disposable PostgreSQL tests but has not been applied to Preview or Production.
- No Production database writes, import, bootstrap, stock transaction, or migration were performed during this audit. Production checks were read-only SQL queries, public HTTP GETs, and authenticated UI route reads; forms, uploads, mapping decisions, and transactions were not submitted.

## Release and verification

Last local verification: lint and typecheck passed; unit 35/35, import 4/4, disposable PostgreSQL 25/25, local Auth 17/17, local Storage 1/1, and authenticated browser E2E 1/1 passed. `npm audit --omit=dev` found zero vulnerabilities. The isolated production build passed earlier in this audit.

1. Run unit/import/Auth/Storage/PostgreSQL/E2E suites and the production build against disposable/local services. Keep real iPhone camera and Add to Home Screen checks as owner acceptance.
2. Before any hosted deployment, configure and verify a separate Preview Supabase target and Preview-scoped Vercel variables; take/confirm a provider backup; apply and verify migrations in Preview; and complete the plan's Preview smoke gate. Those prerequisites are currently absent.
3. After that gate passes, deploy through the connected Git integration to the verified `nics-s-world/chem-immuno-qms` project, confirm Production domain/region, and wait for the exact commit to reach `Ready`.
4. Verify only safe HTTP GETs after deployment: `/login`, `/manifest.webmanifest`, favicon, PWA icons, and other non-mutating pages. Do not confirm a receipt or create issue, transfer, adjustment, count, disposal, or mapping decisions in Production.
5. Reconcile Product, identifier, relation, platform, review, Admin, and transaction aggregates with read-only SQL. Confirm the Supabase target again before any query.
6. Inspect Vercel deployment/function logs for 5xx/runtime errors and verify the function region. Inspect Supabase Auth, PostgREST, Storage, and database logs for failed login/RPC/storage calls and elevated latency. Avoid copying log payloads or credentials into chat.

## Rollback and database changes

- Application-only rollback: use the prior known-good `Ready` Vercel deployment through the Vercel dashboard. Record the source commit and deployment before switching traffic.
- Database changes are forward-only. Before a future schema/data change, verify the exact project ref, backup availability, migration list, and local plus Preview checks. Reconcile the baseline again after deployment.
- No backup was created for this application-only audit because no Production database operation was planned or performed. Confirm provider backup status in the Supabase dashboard before any later database rollout.
- Stock corrections after confirmation use the authorized reversal/adjustment workflows and audit trail; never edit movement history directly.

## Current release gate and provider findings

- The correct LabchemCBH profile and exact Vercel/Supabase projects are confirmed. A previous `Siriwat` Chrome profile showed unrelated Vercel/Supabase projects; those observations are invalid for this audit.
- The Supabase dashboard reports project health `Healthy`, region `ap-southeast-1`, and no current advisor issues. This is the existing Production state, before the pending local security-dispatcher migration.
- On 2026-09-24, the correct LabchemCBH profile had an existing authenticated Admin session. Read-only Production UI checks loaded both warehouse dashboards (90 CHE Products, 72 IMM Products; zero stock transactions), stock, REF search, Product detail, scan, receive, reorder, attention, vendor, and monthly report without visible errors. The CHE-0077 Reaction Cell detail and a read-only SQL SELECT confirmed REF `07700814001` maps only to `c503` and `c513`; original `Used with` text remains visible as provenance. No Production forms were submitted, no attachment was uploaded, and no stock or mapping write was performed. The session was left signed in.
- Vercel's Production `/` and `/login` returned HTTP 200 with private `no-store` caching. `/manifest.webmanifest` and `/icon-192.png` returned HTTP 200 with public `max-age=0`. The current Production response had no Content-Security-Policy header; the local code change that adds CSP has not been deployed.
- The existing Vercel Preview deployment on `codex/phase1-inventory` is `Ready`, but no Preview-scoped Supabase variables are configured. It cannot validate authenticated database workflows or the migration gate.
- Supabase currently has no Preview database branch and no backup. Do not push `main`, apply the pending migration, or trigger a Production deployment until the Preview target and backup gate are satisfied.
- Vercel/Supabase secrets were not opened or copied. No Production transaction, import, bootstrap, schema change, or other data write occurred.
