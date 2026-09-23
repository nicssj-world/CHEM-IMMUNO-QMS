# CHEM-IMMUNO CBH

Clinical Chemistry and Immunology inventory system. The approved design is in [the implementation plan](docs/CHEM-IMMUNO-CBH-INVENTORY-IMPLEMENTATION-PLAN.md).

## Local development

1. `npm ci`
2. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `.env.local` for a disposable Supabase environment.
3. Apply versioned `supabase/migrations` to that disposable environment only.
4. `npm run dev`

## Database verification

Run `./scripts/db/test.ps1` in PowerShell. It starts or reuses the named loopback-only `postgres:17` disposable container, creates isolated databases per test suite, applies all Phase 1 migrations, runs the import/ledger/concurrency checks, then drops the per-run databases. The test database uses the local-only password `ci_test`; never reuse these settings for a hosted project. Stop the container with `docker stop chem-immuno-phase1-test` when finished.

Never point `DATABASE_URL` tests at Production. Initial workbook import requires an explicit review and approval; unresolved source rows remain held.
