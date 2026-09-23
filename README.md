# CHEM-IMMUNO CBH

Clinical Chemistry and Immunology inventory system. The approved design is in [the implementation plan](docs/CHEM-IMMUNO-CBH-INVENTORY-IMPLEMENTATION-PLAN.md).

## Local development

Use only local Supabase for development and tests:

1. `npm ci`
2. Start Docker Desktop, then run `supabase start` (or use the local Auth test command, which starts the local Supabase stack and suppresses its development keys in command output).
3. Copy `.env.example` to `.env.local` and set the local URL, publishable key, and service-role key shown by `supabase status`. Keep `.env.local` private; never copy Production values into it.
4. Run `supabase db reset` to apply migrations to the local Supabase database.
5. Run `npm run dev`.

Local Auth disables self-service sign-up. Accounts are created only through the Admin provisioning screen or the bootstrap CLI. Ephis IDs map to a private deterministic Supabase Auth email (`ephis.<normalized-id>@chem-immuno.internal`); users sign in with Ephis ID and password.

### Bootstrap the first local Admin

The CLI requires the explicit `--allow-local` flag for loopback Supabase URLs. It refuses the protected Production project ref and requires `CI_EXPECTED_SUPABASE_PROJECT_REF` to match any hosted project URL. Hosted use is for a separately approved Preview project only.

For local disposable testing:

```powershell
$securePassword = Read-Host 'Initial local test password' -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $env:CI_BOOTSTRAP_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  npm run bootstrap:admin -- --allow-local --ephis localadmin --name "Local Test Admin"
} finally {
  Remove-Item Env:CI_BOOTSTRAP_PASSWORD -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}
```

The CLI refuses a `--password` argument because npm can echo command arguments. It reads `CI_BOOTSTRAP_PASSWORD` or `--password-stdin`, never displays either value, and never displays a service-role key. Before making a hosted Auth request, it prints `Target environment: PREVIEW` and the validated project ref. For a real Preview bootstrap, set `CI_EXPECTED_SUPABASE_PROJECT_REF` and the Preview-only Supabase URL/service-role key, then run the same command without `--allow-local`. If bootstrap stops after creating the Auth account, rerunning with the same Ephis ID safely completes the database step without changing that account's password.

### Admin user provisioning

An Admin with active Admin access to both warehouses can provision a user from **ผู้ใช้**. The form accepts Ephis ID, display name, role, warehouse access, active status, and an initial password for new accounts. Updating an existing Ephis ID never changes its password. The browser never supplies a Supabase Auth UUID; the server creates/resolves the internal Auth account, and the database resolves the target UUID from the normalized Ephis ID.

## Verification

- `npm test` / `npm run test:unit` run the identity, cookie, and approved workbook unit checks.
- `npm run test:db` runs the real PostgreSQL import, RLS, ledger, role, and two-session concurrency tests against the disposable database script.
- `scripts/db/test.ps1` starts/reuses the named loopback-only PostgreSQL test container, creates isolated databases per test suite, applies every migration, runs the tests, then drops the test databases. It never targets a hosted Supabase project.
- `npm run test:auth:local` starts/resets the local Supabase project and runs the real GoTrue/PostgreSQL Auth integration checks. It is destructive to that local Supabase database and must not be pointed at a hosted project.
- `npm run typecheck`, `npm run lint`, `npm run build`, and `npm audit --omit=dev` are the application checks.

Initial workbook import requires an explicit review and approval. Unresolved source rows remain held. Do not use the older workbook.

## Environment boundaries

`SUPABASE_SERVICE_ROLE_KEY` is server-only and must never use a `NEXT_PUBLIC_` prefix. `.env.local` and all `.env*` files are ignored by Git. Production Supabase project `lvddgcogfcvcsaajdqvl` is protected from bootstrap and is not a development or Preview environment.
