# CHEM-IMMUNO CBH Operations Runbook

Last reviewed: 2026-09-24

## Approved release architecture

The owner-approved path is disposable local PostgreSQL and application verification → Production Supabase → Production Vercel through the existing Git integration. There is intentionally no persistent Supabase Preview/Staging project and no separate Vercel Preview environment required for release. Do not create those projects or put Production credentials in a Preview environment. This decision supersedes the original plan's Preview-only gate; record it as an approved architecture deviation.

## Production identity and current state

- Supabase: project `CHEM-IMMUNO Stock`, ref `nivlnbaveanoawfbrmzz`, region `ap-southeast-1`, API host `nivlnbaveanoawfbrmzz.supabase.co`. Verify the exact ref before every hosted operation.
- Vercel: team `nics-s-world`, project `chem-immuno-qms`, repository `nicssj-world/CHEM-IMMUNO-QMS`, Production branch `main`, canonical URL `https://chem-immuno-cbh.vercel.app/`, function region `sin1`.
- Current deployed application remains commit `4e3fc3910402ceaef324bba289679f6c1713049e`. Closure source based on `21e0877` remains local and has not been pushed or deployed. The current Production response was previously observed without the CSP header added in the local release code.
- The forward-only migration `20260924133953_ci_private_rpc_dispatchers.sql` has been applied to the verified Production ref. Before applying it, `supabase migration list --linked` showed eight applied migrations and this one pending; `supabase db push --dry-run --linked` showed only this migration. The apply command printed `SET LOCAL can only be used in transaction blocks`; a subsequent read-only Management API query confirmed the migration ledger row and checked the live grants. Do not hide that CLI warning.
- Read-only post-migration checks found 39 private `ci_private` SECURITY DEFINER implementations and 39 matching public wrappers; zero public `ci_*` SECURITY DEFINER implementations remain; wrappers are executable by `authenticated` and not by `anon`; private functions grant no `anon` execute. Product, identifier, relation, mapping, review, Admin, and stock-transaction aggregates were unchanged. A later CLI migration-list connection and advisor scan hit the Supabase pooler authentication circuit breaker, so no clean post-migration advisor result is claimed.
- The pre-migration advisor scan returned 105 notices (64 INFO, 41 WARN), including three `auth_rls_initplan` policy warnings and one `auth_leaked_password_protection` warning; it also reported unindexed foreign keys, unused indexes, and one RLS-enabled table without a policy. These are pre-migration findings, not evidence of post-migration health. Re-run a read-only advisor scan when the confirmed Production connection is available; do not retry through alternate accounts.
- Current verified database baseline: 162 active Products (90 CHE, 72 IMM); product types 72 reagent, 34 calibrator, 23 control, 33 consumable; 162 current REF, 162 manufacturer barcode, 29 same-Product legacy REF, 138 leading-zero current REF; 100 Product relations; 28 Product-to-platform mappings; 20 resolved import reviews, two explicitly unassigned, zero critical open; one active Admin; zero stock transactions. Private invoice evidence bucket is limited to 10 MiB and JPEG/PNG/HEIC/PDF.
- An authenticated read-only smoke through the user-selected Chrome profile `LabchemCBH` previously loaded both warehouse dashboards, stock, REF search, Product detail, scan, receive, reorder, attention, vendor, and monthly report without visible errors. That smoke predates the latest code and migration; it is not post-deployment acceptance. No current-deployment login/logout, full smoke, or log review is recorded.

## Logical backup evidence

The original plan requires backup and reconciliation before cutover; it does not require a Supabase-managed backup product. The verified logical dumps satisfy that backup-evidence requirement. Supabase-managed backup availability is a separate operational limitation and must not be reported as “no backup exists.”

The backups are outside Git at `D:\Claude workspace\CHEM-IMMUNO-QMS-backups` and both manifests identify Production ref `nivlnbaveanoawfbrmzz`:

| Snapshot | Created UTC | Manifest SHA-256 | Artifacts |
|---|---|---|---|
| `phase23-pre-20260924-041806` | 2026-09-23 21:20:33 | `7B3D747626D16ACE278559C2DD92C3BA070F570F8BA31B92B7D1B553E51BA249` | 6 files; 1,175,019 bytes |
| `phase23-post-20260924-042927` | 2026-09-23 21:30:33 | `916F8877897307C931BE5AE8898BF412CF8F8F0E19E8F87B4898482644DBB9B1` | 6 files; 1,231,104 bytes |

Each snapshot contains non-empty `public-schema.sql`, `public-data.sql`, `auth-schema.sql`, `auth-data.sql`, `storage-schema.sql`, and `storage-data.sql`. Every artifact's current byte length and SHA-256 matched its manifest during this closure audit. The post snapshot manifest records phase `post-phase2-3` and source commit `5935fc569077d8118a68334f2a800251d8f88b70`. These SQL dumps include public, Auth, and Storage schema/data coverage. There is no separate cluster-roles dump. `storage-data.sql` contains bucket metadata, not `storage.objects` rows or object bytes; do not claim it backs up uploaded files.

The intended use is point-in-time reconciliation and a future recovery rehearsal against a fresh, isolated, compatible local Supabase/PostgreSQL target. Auth data is sensitive and remains outside Git. No restore rehearsal has been run, so these are hash-verified logical backups, not a demonstrated restorable backup. If a rehearsal is needed, first verify the target is disposable and empty, validate the manifest and all hashes, restore schemas before data in dependency order using `psql` with stop-on-error behavior, then reconcile the recorded Product/relation/review/transaction counts. Never test restoration against Production.

## Release gates and safe verification

1. Use the isolated local Supabase/PostgreSQL environment for import, Auth/RLS/Storage, workflow, concurrency, and E2E tests. Keep the iPhone camera and Add to Home Screen checks as owner acceptance.
2. Before a Production schema change, verify the exact Supabase ref, inspect the migration list, take or confirm a verified logical backup, run the linked dry run, and review the exact forward-only migration. Never edit an applied migration, reset Production, reimport the workbook, bootstrap another Admin, or touch Stock-BM.
3. Push `main` only after the final traceability matrix has `BLOCKED = 0`, `PARTIAL = 0`, `MISSING = 0`, all required suites and the Production build pass, and the final diff is clean and justified. The existing Git integration performs the Vercel Production deployment; do not run a redundant `vercel --prod`.
4. Wait for the exact commit to reach `Ready`; record its SHA, URL, project, branch, and region. Verify the canonical URL, login/logout, manifest, favicon, Apple Touch Icon, 192/512/maskable icons, authenticated dashboard and warehouse switch, Product search/detail, stock, scan draft, receive draft/attachment UI, ROP, expiry, Attention, vendor, and report. Do not confirm a Production receipt or create any inventory, mapping, count, adjustment, transfer, disposal, or reversal transaction.
5. Read-only reconcile the baseline above. Inspect Vercel function logs for unexpected 5xx/runtime errors and Supabase Auth/PostgREST/Storage/database logs for failed login/RPC/storage calls and latency. Record unavailable log/advisor queries as unverified, not clean.

## Rollback and recovery

- Application rollback uses the previous known-good `Ready` Vercel deployment at `4e3fc3910402ceaef324bba289679f6c1713049e`. Confirm the deployment in the correct Vercel project before switching traffic; the deployment ID was not captured in this audit.
- Database migrations are forward-only. Roll back application traffic only when the older application remains compatible with the new schema. Correct schema forward with a reviewed migration; do not restore a logical snapshot over live Production as an application rollback.
- Stock corrections after confirmation use the authorized reversal/adjustment workflows and audit trail; never edit movement history directly.
- The hash-verified SQL snapshots support reconciliation and isolated recovery planning. Platform-managed backup/PITR status, cluster roles, Storage object bytes, and an actual restore rehearsal remain separate limitations.

## Current closure state

- The owner-approved no-Preview architecture is recorded above. No Preview projects, Preview credentials, or extra infrastructure were created.
- Production migration `20260924133953_ci_private_rpc_dispatchers.sql` is applied and the read-only post-migration ledger/grant/data checks are recorded above.
- Local verification includes unit, import, disposable PostgreSQL, Auth, Storage, and authenticated browser E2E; the E2E now asserts that repeated attachment uploads do not create duplicate GoTrue clients. Final full-suite/build evidence belongs in the closure matrix.
- No current-code push, Vercel deployment, post-deploy browser smoke, or current-deployment log inspection has occurred. These remain release gates until directly verified.
