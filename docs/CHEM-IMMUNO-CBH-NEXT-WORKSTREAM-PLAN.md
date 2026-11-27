# Execution note (for this planning run)

**Context:** The user asked for a planning-only deliverable for the next CHEM-IMMUNO CBH workstream: navigation consolidation, a Location Master, Morning Talk, and Temperature/Humidity QR monitoring. The previous inventory plan (143-item baseline) is closed and stays untouched.

**The only action after approval:** write the document below, verbatim, to `D:\Claude workspace\CHEM-IMMUNO-QMS\docs\CHEM-IMMUNO-CBH-NEXT-WORKSTREAM-PLAN.md`.
- No source edits.
- No migrations.
- No commit, push or deploy.
- No Production access.

**Verification:** re-read the file and confirm that all 23 required sections are present. `git status` in CHEM-IMMUNO-QMS should show only the one new untracked doc.

---

# CHEM-IMMUNO CBH — Next Workstream Plan

**Scope:** Navigation consolidation · Location Master · Morning Talk · Temperature / Humidity (QR)

| | |
|---|---|
| Status | PLAN — not implemented |
| Date | 2026-09-26 |
| Repository | `nicssj-world/CHEM-IMMUNO-QMS`, branch `main` (audited at HEAD `9d3ed83`, clean tree) |
| Production | Supabase `nivlnbaveanoawfbrmzz` (ap-southeast-1) · Vercel `chem-immuno-qms` → https://chem-immuno-cbh.vercel.app/ (sin1) |
| Pipeline | Local/disposable tests → Production Supabase → Production Vercel. There is no Staging or Preview. |
| Baseline | The previous inventory plan (`CHEM-IMMUNO-CBH-INVENTORY-IMPLEMENTATION-PLAN.md`, 143-item closure matrix: PASS 141, APPROVED DEVIATION 2) is **closed and is not reopened by this document**. |

---

## 1. Executive summary

The work is delivered in **exactly three phases**. Each phase is shipped to Production separately.

| Phase | Delivers | New migration(s) |
|---|---|---|
| **1. Navigation + Location Foundation** | Sidebar reduced from 19 links + Scan to **7 workspaces + Scan quick action**. Workspace secondary tabs. The mobile bottom nav is kept. A real Location Master with type, container parent (fridge → shelf), room, storage condition, **monitoring ranges only** (temperature/humidity enabled + min/max, versioned; no schedule), the **monitored-container resolution rule** (`environment_monitor_location_id`), Portal equipment link, stable QR token, edit/deactivate, Location Detail with live stock, and a printable QR label sheet. | 1 |
| **2. Morning Talk** | Scoped (ALL/CHE/IMM) daily briefings: attendees with self-acknowledgement, a shared checklist, action items, Today/History/Open-actions views, a printable summary, and Attention integration. `ALL` talks can be managed only by users with supervisory authority in **both** CHE and IMM. | 1 |
| **3. Temperature / Humidity + QR Workflow** | Readings on **monitored container locations** (manual/QR), range evaluation against the versioned location config, **check scheduling** (`check_times`, schedule editor, pause, rounds, Asia/Bangkok), due/missed detection, a lightweight excursion workflow, immutable corrections, a monthly printable report, and Dashboard/Attention integration. | 1 |

**Key design decisions:**
1. **Workspaces are a navigation layer only.** No existing URL changes and no permission rule changes.
2. **Location stays a ledger dimension.** Stock is still derived only from `ci_stock_movement_lines`.
3. **Environment monitoring config lives in an append-only, versioned table**, so historical readings and missed-check reports are always evaluated against the config that was in force at the time. Phase 1 stores ranges only; Phase 3 adds the schedule to the same table.
4. **Monitoring belongs to a monitored container location** (room, refrigerator, freezer, cabinet when appropriate). Shelf/rack child locations are inventory sub-locations that *inherit* the parent's environment status for display. A reading is only ever stored against the location that owns the config, resolved deterministically by `environment_monitor_location_id` (§15.0). There is no separate Environment Unit entity.
5. **The QR code is a stable app URL (`/q/{token}`) that is resolved under RLS.** It never bypasses authorization.
6. **The Portal integration is a validated external link only.**
7. **Every multi-row write is a single `ci_private` RPC** (atomic, audited). This is the pattern already enforced by `tests/db/security-boundary.test.ts`.
8. **`ALL`-scope Morning Talk management requires admin/supervisor in both CHE and IMM**, computed from the existing per-warehouse `ci_user_access` rows. The warehouses are resolved **by `ci_warehouses.code`, never by numeric id**. There is no global role.

---

## 2. Evidence / current-state audit (read-only, HEAD `9d3ed83`)

### 2.1 Navigation

**Single source of truth: `src/lib/nav.ts`.**
- `navGroups` has 5 groups and 19 items. `scanItem` (`/scan`) is separate.
- Items are gated by `need: 'work' | 'supervise' | 'adminBoth'`, computed across all of the user's warehouses in `navPermissions()`:
  - `work` = any non-viewer role
  - `supervise` = admin or supervisor anywhere
  - `adminBoth` = admin in both CHE and IMM
- Active state: `isActivePath()` uses exact match for `/`, and prefix match (`href` or `href/`) for everything else.

**Current menu:**

| Group | Items |
|---|---|
| ภาพรวม | `/`, `/attention` |
| งานประจำวัน | `/receive` (ungated), `/issue` (work), `/transfer` (work) |
| ตรวจสอบและปรับปรุง | `/counts` (work), `/adjust` (supervise), `/dispose` (supervise) |
| ข้อมูลและรายงาน | `/products`, `/stock`, `/reorder`, `/vendors`, `/reports/monthly`, `/movements` |
| ผู้ดูแลระบบ | `/scan/review` (supervise), `/locations` (supervise), `/import` (adminBoth), `/audit` (supervise), `/admin/users` (adminBoth) |

**Rendering:**
- **Desktop** — `src/components/side-nav.tsx`: the Scan button (`.side-scan`) sits on top, then the groups (`.side-heading`, `.side-link`, `aria-current`).
- **Mobile** — `src/components/bottom-nav.tsx`: 4 hardcoded tabs (`/`, `/stock`, `/scan`, `/receive`) plus `/more`. The More tab lights up for every other path.
- **`/more`** — `src/app/(app)/more/page.tsx` renders the same `visibleNavGroups()` as cards, plus the Account link.
- **Breakpoint:** 800 px, CSS-only (`globals.css:128-142`).
- **Warehouse selection** is page-level: `?warehouse=CHE|IMM` via `src/components/warehouse-switch.tsx`, and `selectedWarehouse()` in `src/lib/warehouse.ts`.

### 2.2 Roles and auth

- **Roles are per warehouse.** `ci_user_access(user_id, warehouse_id, role ∈ admin|supervisor|staff|viewer, active)`. There is no global role.
- **App side:**
  - `AppAccess.warehouses[]` (`src/lib/auth-identity.ts`)
  - `canMutateRole` = not viewer
  - `canSuperviseRole` = admin or supervisor
  - `requireAccess()` (`src/lib/auth.ts`) redirects to `/login?next=<x-return-to>`
  - `safeReturnPath()` (`src/lib/return-path.ts`) sanitises `next`
  - `src/proxy.ts` sets the CSP nonce and `x-return-to`, and refreshes the session. It does not authorize.
- **DB helpers (`ci_private`, security definer):**
  - `require_role(wh, roles[])` raises `CI_ACCESS_DENIED`
  - `can_read(wh)`
  - `has_role(wh, roles[])`
  - `can_admin_any()`
  - `require_any_role(roles[])`
  - `has_any_access()`
  - `require_import_admin()`
- **RPC exposure pattern:** the implementation lives in `ci_private`, and a public invoker wrapper is created via `ci_private.publish_rpc(regprocedure)` (from `20260925100000_ci_vendor_master.sql`). `security-boundary.test.ts` asserts that there is no SECURITY DEFINER function in `public`.
- **search_path handling:**
  - Every existing function already declares **function-level** `set search_path = ''` and schema-qualifies its references. This is the security hardening to keep.
  - Several recent migration files also begin with a **top-level** `set local search_path = '';`. During an earlier Production migration that statement produced the warning `SET LOCAL can only be used in transaction blocks`. **New migrations must not copy that header** (§11).
- **Other users' profiles:** `ci_user_profiles` rows are readable only for your own row, or by an admin of any warehouse. Pages that show other actors' names (`/audit`, `/vendors/[id]`) therefore only resolve names for admins.

### 2.3 Location today

**Table `ci_locations`** (`202609230001_ci_phase1_schema.sql:173-182`), never altered since:

| Column | Definition |
|---|---|
| `id` | uuid, PK |
| `warehouse_id` | smallint, FK → `ci_warehouses` |
| `code` | text |
| `name` | text |
| `active` | boolean |
| `created_at` | timestamptz |

- Unique constraints: `(id, warehouse_id)` and `(warehouse_id, code)`.
- There are **no CHECKs, no `updated_at`, and no audit trigger**.
- RLS: select only, `can_read(warehouse_id)`.

**Writes:**
- The only write path is `ci_create_location(wh, code, name)` (admin or supervisor), which writes an explicit `audit(... 'CREATE' ...)` row with no old/new values.
- There is **no update, deactivate or delete path**. `/locations` states: "การแก้ไขหรือปิดใช้งานตำแหน่งยังไม่รองรับในระบบ".

**UI:**
- `src/app/(app)/locations/page.tsx`: a list plus a create form. The form is visible to supervisors; everyone can view.
- The page supports `?return=` from `/receive` (quick add while receiving).
- There is **no `/locations/[id]` detail page.**

**Referenced by** (composite FK `(location_id, warehouse_id)`):
- `ci_receipt_lines`
- `ci_stock_movement_lines`
- `ci_stock_count_lines`

**Read by:** stock-options, receive, issue, transfer, adjust, dispose, counts, attention, reports/monthly, products/[id], and `ci_search_stock`.

**Active flag behaviour in the RPCs:**
- Receive, issue, transfer and adjust **require an active location**.
- `ci_dispose_expired_stock` and `ci_create_stock_count` do **not** check `active`.
- **Implication:** deactivating a location that still holds stock would strand that stock for issue/transfer. Deactivation must therefore be blocked while the balance is non-zero.

### 2.4 Inventory ledger (must not change)

- Transaction headers: `ci_stock_transactions`, with kind `receive | issue | transfer | adjustment | reversal | expired_disposal`, idempotency key and request hash.
- Movement lines: `ci_stock_movement_lines`, with a **signed** `quantity_delta` per `(lot_id, location_id)`.
- Both are append-only (`guard_immutable`).
- Negative stock is blocked by the `check_movement_balance` trigger.
- Balances are **derived** through the `ci_stock_balances` view (security invoker). They are never stored.
- FEFO: `ci_fefo_candidates`, using the Bangkok date.

### 2.5 Audit

- Table `ci_audit_logs` (immutable) has columns: actor, `warehouse_id` (nullable), action, entity_table, entity_id, old/new jsonb, reason.
- There are two write paths:
  1. The trigger `ci_private.audit_change()` — full old/new row. It derives `warehouse_id` from the row's `warehouse_id` column.
  2. The explicit `ci_private.audit(wh, action, table, id, reason)`.
- Read policies:
  - Rows with a warehouse are readable by admin/supervisor of that warehouse.
  - Rows with a null warehouse are readable only for vendor/policy/signature tables.
- `/audit` page: supervise only, latest 200 rows.

### 2.6 Attention and Dashboard

- **Computed in TypeScript server components** (`src/app/(app)/attention/page.tsx`, `src/app/(app)/page.tsx`), using the helpers in `src/lib/inventory-insights.ts` (`bangkokToday`, `expiryBucket`, …).
- **Attention categories (9):** stockout, below ROP, expired, ≤30 / 31–60 / 61–90 days to expiry, barcode mapping, receipt discrepancy, open vendor issue.
- **Dashboard:** 10 KPI cards plus recent movements.

### 2.7 Scanning and QR

- **Scanner:** `src/components/barcode-scanner.tsx` uses `@zxing/browser` with hints **only for DATA_MATRIX and CODE_128**, so **QR codes are not decoded by the camera today**. Manual and hardware-scanner input also works.
- **Parser:** `src/lib/barcode.ts` (GS1/HIBC).
- **Resolver:** `src/app/actions/scanner.ts`. It logs every scan to `ci_scan_events`. An unknown payload produces "ไม่พบสินค้าที่ตรงกับ Barcode" and, on receive, a mapping proposal.
- **No QR generation library is installed.**
- **Headers:** `Permissions-Policy: camera=(self)`, `X-Frame-Options: DENY`.
- **CSP:** `img-src 'self' blob: data:`.

### 2.8 Existing modules and gaps relevant to this workstream

- No morning talk, humidity, environment, equipment or Portal code exists.
- "Temperature" exists only as the receiving cold-chain assessment (`ci_receipt_assessments.temperature_required/ok`) and the vendor issue type `temperature_out_of_range`. **These are unrelated to location monitoring and must stay untouched.**
- **Timezone:**
  - TypeScript: `bangkokToday()`, and `formatDate*`/`formatDateTime*` in `src/lib/format.ts` (Asia/Bangkok, with BE variants).
  - SQL: `(now() at time zone 'Asia/Bangkok')::date`.
- **UI:**
  - Tailwind v4 plus semantic classes in `globals.css` (`.surface`, `.button`, `.badge`, `.kpi`, `.notice`, `.error`, `.data-table`, `.mobile-card-list`, …) and CSS variables (`--ink`, `--teal`, …).
  - `lucide-react` icons, IBM Plex Sans Thai, light theme only.
  - **There is no Tabs/SubNav component and no `role="tablist"` anywhere.**
- **Tests:**
  - `node:test` + `tsx` for unit tests (`npm test`).
  - `tests/db/*.test.ts` run on a disposable Docker Postgres 17 (`scripts/db/test.ps1`, port 55442; `bootstrap.sql` stubs Supabase roles and `auth.uid()`). RLS tests use `asUser()` / `rpc()`.
  - Local Supabase auth/storage tests.
  - Playwright: `tests/e2e/mobile-workflows.spec.ts` runs a route loop at 375/768/1280 px, asserting no horizontal overflow and labelled inputs.
  - Also `typecheck` and `lint`.
- **Runbook:** `docs/operations-runbook.md` defines the rollout gates: backup, `db push --dry-run --linked`, forward-only migrations, push `main` for the Git-integrated deploy, read-only smoke, and rollback to the previous Ready deployment.
  - **Note:** its "current state" lines (`:13`, `:55`) are stale compared with the closure matrix. Refresh them in Phase 1, docs-only.

### 2.9 Portal (link target, verified read-only in `lab-management-portal`)

- The equipment detail route exists: `app/(protected)/staff/equipment/[id]/page.tsx`, i.e. `https://lab-management-cbh.vercel.app/staff/equipment/{uuid}`.
- Portal login preserves deep links (`?next=`).
- CHEM stores the link. It does not call the Portal.

---

## 3. Stock-BM reference findings (read-only)

| Area | Worth adopting | Do NOT copy / lessons |
|---|---|---|
| **Morning Talk** (`lib/server/morning-talk.ts`, `components/morning-talk-view.tsx`, migrations `202607240002`, `202609030001`) | Attendee table with `assigned_at` / `acknowledged_at`. **Self-only, idempotent acknowledgement** (first acknowledgement kept, audited once). One shared checklist per talk with a `completed_at`/`completed_by` pair CHECK. Action items `todo`/`in-progress`/`done` with owner, due date, note, first-completion kept, and a `(status='done') = (completed_at is not null)` CHECK. Partial index on open due dates. Overdue = not done and `due_date < todayBangkok()`. | Writes are **not atomic** (talk, then attendees, then checklist, then actions as separate calls). Removing an attendee **deletes their acknowledgement**. No scope, no search, loads 120 talks plus all child rows. Checklist template hardcoded. Tests are source-string greps only. Writes go through the service role with TypeScript checks and no RLS writes. Admin-only create. `nipt_users` / `bm_*` / `current_bm_role()`. |
| **Location QR** (`components/location-qr-sheet.tsx`, `inventory/locations/qr/page.tsx`) | npm `qrcode` → inline SVG (`QRCode.toString({type:'svg'})`). The origin appears in the printed URL. Label = QR + code + name + storage condition. `break-inside-avoid`, `window.print()`. | Payload is the raw location UUID (no revocable token). No mm label sizing. The resolver shows a card but does not route. |
| **Environment** (`env_monitored_units`, `env_readings`, `env_corrective_actions`, `env_monthly_reviews`; `components/env-quick-log.tsx`; `/environment/u/[token]`) | QR deep link straight to a one-location mobile quick-log (`inputMode="decimal"` plus a "+/−" button, because iOS decimal pads have no minus sign). Humidity required only when tracked. Status computed server-side at insert. Out-of-range → inline corrective note pre-filled with which bound was broken. Cards sorted by attention. Rounds per day (1–3) using the Bangkok hour. | **Disconnected "unit" entity** duplicating location (location name overrides unit name). **Voided readings still occupy the unique slot**, so a void blocks re-entry. Client uses **browser-local date/hour**. Loads all readings unbounded. Past missed days are not tracked except in report gaps. Limits are not versioned (a changed range is not re-evaluated, and history loses its context). Anonymous constraint names. Migration drift. |
| **Equipment ↔ location** | Nullable FK from the equipment/unit to the location, with no join table. | A full equipment registry in the stock app. CHEM keeps equipment in the Portal: **link only**. |
| **App shell** | `stock-module-shell.tsx`: **one sidebar entry per domain plus in-page module tabs** (the workspace pattern). | Mobile chip-row sidebar; bottom nav without More. CHEM's accepted bottom nav plus `/more` stays. |
| **Scanner** | One resolver for inventory payloads. **Environment QR codes use a separate deep-link route**, not the product resolver. | Ambiguous-result UI gap. |

---

## 4. Design principles

1. **Navigation ≠ permission.** Consolidation changes only where links are shown. Every page, server action and RPC keeps its current role check; RLS is still the enforcement layer.
2. **No URL churn.** Every existing route keeps working at its current URL. New workspaces are a sidebar/tab layer over existing routes, plus new routes for new features.
3. **One nav source of truth.** `src/lib/nav.ts` drives the sidebar, workspace tabs and `/more`, as it does today.
4. **The ledger is sacred.** No stock balance on locations. No change to movement semantics, RPC business rules, FEFO, reversal, counts or disposal.
5. **Location-centric environment.** Every monitored point is a `ci_locations` row. There is no parallel "unit" entity.
6. **Immutable records, explicit corrections.** Readings, config versions, acknowledgements and completions are never silently rewritten.
7. **Atomic, audited writes.** Each user action is one `ci_private` RPC (published via `publish_rpc`) that checks the role, validates, writes and audits in one transaction. Idempotency and optimistic locking live in the DB, not in button state.
8. **Warehouse isolation everywhere.** New tables carry `warehouse_id` (nullable only for Morning Talk `ALL`) and use `can_read()`-based RLS. The QR code resolves under RLS.
9. **Mobile-first, CHEM visual language.** Reuse `.surface`, `.button`, `.badge`, `.kpi`, `.notice`, `.data-table`/`.mobile-card-list`. Targets are ≥ 44 px. Status is never shown by colour alone (icon + text). No horizontal page overflow at 375 px.
10. **Proportionality.** No IoT, scheduler daemon, CAPA, template engine or notification service.
11. **Migration hygiene.**
    - No top-level `SET LOCAL` in migration files.
    - Every object reference in DDL is schema-qualified (`public.`, `ci_private.`, `auth.`).
    - Every new function declares `set search_path = ''` in its own definition.

---

## 5. Final desktop navigation

```
[ ⊡ สแกน Barcode ]                       ← quick-action button (unchanged position/style)
ภาพรวม            /                       tabs: ภาพรวม · รายการที่ต้องติดตาม
Morning Talk      /morning-talk           (Phase 2)
คลังสินค้า         /stock                  tabs: คงคลัง · สินค้า · ตำแหน่งจัดเก็บ · ROP/สั่งซื้อ · ผู้ขาย
ปฏิบัติงาน         /receive (first visible) tabs: รับเข้า · เบิกใช้ · ย้ายที่เก็บ · ตรวจนับ · ปรับยอด · กำจัดหมดอายุ
อุณหภูมิ/ความชื้น   /environment            (Phase 3) tabs: ภาพรวม · ตรวจด้วย QR · ประวัติ · นอกช่วง
รายงาน            /reports/monthly        tabs: รายงานรายเดือน · ประวัติเคลื่อนไหว · บันทึกการตรวจสอบ* · (P2) Morning Talk · (P3) อุณหภูมิ/ความชื้น
จัดการระบบ         first visible tab        tabs: คิวอนุมัติ Barcode* · นำเข้าสินค้า** · ผู้ใช้**
```
`*` = supervise, `**` = adminBoth. The menu goes from 19 links + Scan to **7 workspaces + Scan**. Items appear as their phase ships.

**Rules:**
- A workspace is shown only if at least one of its tabs is visible. Its sidebar `href` is the **first visible tab**, which keeps role-specific landing pages correct.
- Every tab keeps its current `need` gate, **except `/locations`**.
  - `/locations` becomes visible to all roles in the Inventory workspace. The page is already readable by all roles and RLS already allows reads, so this is a **visibility change, not a permission change**.
  - Create, edit, deactivate and QR printing stay supervisor-only. Staff need Location Detail for stock lookup and environment checks.
- `/attention` moves under the Dashboard workspace (tab 2). Its URL is unchanged.
- `/audit` moves into Reports, still gated by supervise. Its URL is unchanged.

---

## 6. Final mobile navigation

- **Bottom nav stays exactly:** ภาพรวม `/` · คงคลัง `/stock` · สแกน `/scan` · รับเข้า `/receive` · เพิ่มเติม `/more`.
  - Only one behavioural tweak: the คงคลัง tab also lights up for the Inventory workspace tabs (`/products`, `/locations`, `/reorder`, `/vendors`), because the workspace tabs are visible on those pages.
- **Workspace tabs render on mobile too.** They appear under the topbar as a contained, horizontally scrollable link strip (≥ 44 px, `overflow-x:auto` on the strip only).
- **`/more` is regenerated from the same workspace config.** Each section is one workspace, and its cards are that workspace's visible tabs:
  - Dashboard
  - Morning Talk
  - Inventory
  - Operations
  - Temperature/Humidity
  - Reports
  - Admin (when authorized)
  - Account (unchanged)
- **Phase 3 adds a prominent "ตรวจอุณหภูมิ/ความชื้น (สแกน QR)" card** at the top of `/more` for users with `work` permission. The bottom nav is not changed.

---

## 7. Route map

| Route | Kind | Phase | Notes |
|---|---|---|---|
| `/`, `/attention` | unchanged | – | Dashboard workspace |
| `/scan`, `/scan/review` | unchanged | – | Scan stays a quick action. Review → Admin workspace |
| `/stock`, `/products`, `/products/new`, `/products/[id]`, `/reorder`, `/vendors/**` | unchanged | – | Inventory workspace |
| `/locations` | unchanged URL, enhanced list | 1 | Filter by type/active/search. `?return=` flow from receive preserved |
| `/locations/new` | **new** canonical | 1 | Full create form (supervise). `/locations` keeps a quick-add for the receive return flow |
| `/locations/[id]` | **new** canonical, deep-linkable | 1 | Location Detail. 404 when missing or not readable (no existence leak) |
| `/locations/[id]/edit` | **new** | 1 | Supervise |
| `/locations/qr` | **new** | 1 | Printable label sheet. `?warehouse=&ids=` (supervise) |
| `/q/[token]` | **new** stable QR entry | 1 | Server-resolves and redirects (§13) |
| `/receive`, `/issue`, `/transfer`, `/counts`, `/counts/[id]`, `/adjust`, `/dispose` | unchanged | – | Operations workspace |
| `/reports/monthly`, `/movements`, `/audit` | unchanged | – | Reports workspace |
| `/import`, `/admin/users` | unchanged | – | Admin workspace |
| `/morning-talk` | **new**: Today (default) | 2 | |
| `/morning-talk/history` | **new** | 2 | `?q=&scope=&from=&to=` |
| `/morning-talk/actions` | **new**: open actions | 2 | `?mine=1&overdue=1&scope=` |
| `/morning-talk/new`, `/morning-talk/[id]`, `/morning-talk/[id]/edit` | **new** | 2 | `[id]` is the deep link used by Attention |
| `/reports/morning-talk` | **new**, printable | 2 | `?month=YYYY-MM&scope=` |
| `/environment` | **new**: overview | 3 | `?warehouse=` |
| `/environment/check` | **new**: in-app QR scanner | 3 | |
| `/environment/check/[locationId]` | **new**: one-location entry | 3 | Target of `/q/[token]` |
| `/environment/history` | **new** | 3 | `?warehouse=&location=&from=&to=&status=` |
| `/environment/excursions`, `/environment/excursions/[id]` | **new** | 3 | |
| `/reports/environment` | **new**, printable | 3 | `?warehouse=&month=&location=` |
| `/more`, `/account`, `/login` | unchanged | – | `/more` content regenerated |

- **No legacy redirects are needed**, because no URL is retired.
- Query parameters are used only for filters and warehouse selection. Views with distinct purposes get stable nested routes.

---

## 8. Phase 1 — Navigation + Location Foundation

### Step 1.1 — Workspace nav model

- **Objective:** Replace `navGroups` with `workspaces` while keeping the `need` gates.
- **Files:**
  - `src/lib/nav.ts` (rewrite the data; keep `navPermissions` and `isActivePath`)
  - new `tests/nav/workspaces.test.ts`
  - add the test to the `npm test` glob in `package.json`
- **Model:**
  ```ts
  type WorkspaceTab = NavItem & { match?: string[] };
  type Workspace = { key: 'dashboard'|'morning-talk'|'inventory'|'operations'|'environment'|'reports'|'admin'; label: string; icon: LucideIcon; tabs: WorkspaceTab[] };
  ```
  - `match` holds extra path prefixes that activate a tab, e.g. `/products/new` → Products, `/locations/*` → Locations, `/vendors/*` → Vendors, `/counts/*` → Count.
- **Functions:**
  - `visibleWorkspaces(perms)`: filters tabs, then drops empty workspaces.
  - `workspaceHref(ws)`: the first visible tab.
  - `activeWorkspace(pathname)`: the **longest matching** prefix across all tabs, with `/` exact.
  - `activeTab(pathname)`.
  - Phase flags: a `phase` array is not needed. Just add the workspace entries when their phase ships.
- **Tests (unit):**
  - Visibility matrix for these users: viewer-only; staff CHE; supervisor IMM + viewer CHE; admin CHE only; adminBoth.
  - Longest match: `/scan/review` → Admin, **not** the Scan quick action; `/reports/monthly` vs `/reports/morning-talk`.
  - The `/` exact rule.
  - The first-visible-href rule.
- **Acceptance:** Every current route maps to exactly one workspace/tab, asserted by iterating the page list in the test.
- **Risk:** Low. It is a pure-function change.

### Step 1.2 — Sidebar, WorkspaceTabs, More, BottomNav

- **Files:**
  - `src/components/side-nav.tsx`: the Scan button, then one `.side-link` per visible workspace. `aria-current="page"` on the active workspace.
  - new `src/components/workspace-tabs.tsx`: a client component using `usePathname` and `useSearchParams`.
    - Renders `<nav aria-label="{workspace} เมนูย่อย">` with `<Link>`s and `aria-current="page"`. Links, not `role="tablist"`, because these are routes.
    - Preserves **only** `?warehouse=`.
    - Browser back/forward works natively because these are normal pushes.
  - `src/components/app-shell.tsx`: renders `<WorkspaceTabs permissions=…/>` above `{children}`, so pages need no edits.
  - `src/app/(app)/more/page.tsx`: iterates workspaces.
  - `src/components/bottom-nav.tsx`: the คงคลัง tab matches the Inventory workspace paths.
  - `globals.css`: `.workspace-tabs` class with a contained horizontal scroll, a 44 px min-height, `:focus-visible` outline, `prefers-reduced-motion`, and hidden in print.
- **Tests:**
  - Unit: tab href building preserves `warehouse` and drops other parameters.
  - E2E: add assertions to `tests/e2e/mobile-workflows.spec.ts` that the sidebar has ≤ 8 links, the workspace tabs are visible, there is no overflow at 375 px, and the bottom nav still has 5 links.
- **Acceptance:**
  - Every existing route renders with correct active workspace and tab.
  - A viewer sees no write tabs they couldn't see before.
  - Print output has no tabs.
- **Rollback:** Revert the commit. There is no DB dependency.

### Step 1.3 — Location Master migration (`<ts>_ci_location_master.sql`)

**Changes to `ci_locations`:**

| Column | Type | Rule |
|---|---|---|
| `location_type` | text not null default `'other'` | CHECK in (`room`, `refrigerator`, `freezer`, `cabinet`, `shelf`, `rack`, `bench`, `other`). The backfill sets existing rows to `other`. |
| `parent_location_id` | uuid null | FK `(parent_location_id, warehouse_id)` → `ci_locations(id, warehouse_id)`, reusing the existing `unique(id, warehouse_id)`. **Same warehouse by construction.** |
| `room` | text null | ≤ 120 |
| `description` | text null | ≤ 1000 |
| `storage_condition` | text null | ≤ 120, free text for the label, e.g. "2–8 °C, ป้องกันแสง" |
| `portal_equipment_url` | text null | CHECK `~ '^https://[^\s]+$'` and length ≤ 500 |
| `portal_equipment_label` | text null | ≤ 120; CHECK that it is null when the URL is null |
| `qr_token` | text not null unique | Default `replace(gen_random_uuid()::text,'-','')`: 32 hex characters, 122 random bits. The backfill fills existing rows. |
| `qr_token_rotated_at` | timestamptz null | |
| `updated_at` | timestamptz not null default now() | |
| `updated_by` | uuid null | |

- **CHECK:** `parent_location_id <> id`.
- **Name/code CHECKs:** trimmed and non-empty, code ≤ 40, name ≤ 120. Add them `NOT VALID`, then `VALIDATE` after a pre-check query, run in the dry-run review, confirms that existing rows comply.
- **Trigger `ci_private.guard_location_hierarchy`** (before insert/update):
  - The parent must have `parent_location_id is null`.
  - A row with children cannot get a parent.
  - This gives a **maximum depth of 2**, which makes cycles impossible.
- **Trigger `ci_private.guard_location_code`:** the code is immutable once any `ci_stock_movement_lines`, `ci_receipt_lines` or `ci_stock_count_lines` row references the location, because historical reports display the current code.
- **Attach `ci_private.audit_change()`** (insert/update) to `ci_locations`. This gives full old/new audit for create/update/deactivate/Portal-link/QR rotation.

**New table `ci_location_env_configs`** (append-only, versioned):

| Column | Type / rule |
|---|---|
| `id` | uuid PK |
| `warehouse_id` | smallint |
| `location_id` | uuid; FK `(location_id, warehouse_id)` → `ci_locations(id, warehouse_id)` |
| `effective_from` | timestamptz not null default now() |
| `temperature_monitored` | bool not null |
| `temp_min_c`, `temp_max_c` | numeric(5,2) null |
| `humidity_monitored` | bool not null |
| `rh_min_pct`, `rh_max_pct` | numeric(5,2) null |
| `created_by` | uuid not null |
| `created_at` | timestamptz |

Phase 1 holds **ranges only**. The schedule and pause columns (`check_times`, `monitoring_state`, `pause_reason`) are added in Phase 3 (Step 3.1). Phase 1 therefore exposes no check-time or pause UI.

CHECKs:
- If temperature is not monitored, both temperature bounds are null. If monitored, at least one bound is not null, bounds lie within −100..100, and `min < max` when both are set. One-sided ranges are allowed for freezers, e.g. "≤ −20 °C".
- Humidity: the same rules within 0..100.

Other rules:
- Unique `(location_id, effective_from)`. Index `(location_id, effective_from desc)`.
- `guard_immutable` trigger (no update/delete). `audit_change` on insert.
- **The current config is the row with the latest `effective_from`.** No row, or a current row with both parameters unmonitored, means the location has **no own monitoring**.
- Units are fixed: °C and %RH. There is no unit column, because it would have no operational value.
- RLS: select `can_read(warehouse_id)`.
- **Which locations may have a config:** any location type, at the DB level.
  - The UI offers monitoring directly for room, refrigerator, freezer and cabinet.
  - For shelf, rack, bench and other it is behind an explicit "ตั้งค่าเฝ้าระวังแยกสำหรับตำแหน่งนี้" toggle, with the note that the parent covers it.
  - This keeps the normal fridge → shelf case monitored at the fridge.

**Monitored-container resolution** — new function `ci_private.environment_monitor_location_id(p_location_id uuid) → uuid`:
- Declared `stable security definer set search_path = ''`.
- Exposed through `publish_rpc` like every other `ci_private` function.
- Mirrored by the pure TypeScript helper `resolveEnvironmentMonitor()` in `src/lib/environment-monitor.ts`. The TypeScript helper only ever receives rows the page has already read under RLS.

**Security mode: SECURITY DEFINER, with an explicit authorization check.**

Why this choice:
1. It matches the existing `ci_private` + `publish_rpc` architecture. `security-boundary.test.ts` expects private implementations to be definer functions behind invoker wrappers.
2. The function is also called **inside** other SECURITY DEFINER RPCs (`ci_record_environment_reading`, the `/q` routing RPC path, the day-status and report functions). There RLS never applies, so an RLS-reliant invoker function would silently lose its protection.

Because it is definer, it **does not rely on RLS at all**. The body is, in order:
1. Look up the target: `select warehouse_id, parent_location_id from public.ci_locations where id = p_location_id`.
2. **Authorize before revealing anything:** if no row is found, **or** `not ci_private.can_read(target.warehouse_id)` (the existing warehouse-access helper, using `auth.uid()`), return **null**.
   - "Not found" and "not permitted" are indistinguishable.
   - No exception text, id, code, parent or config detail is ever emitted for a location outside the caller's warehouses.
3. If the target has **own monitoring** (its current `ci_location_env_configs` version monitors ≥ 1 parameter), return the target id.
4. Else, if it has a parent **and the parent has own monitoring**, return the parent id.
   - The parent is in the same warehouse by the composite FK `(parent_location_id, warehouse_id)`, so the step-2 authorization covers it.
   - As defence in depth, the query also asserts `parent.warehouse_id = target.warehouse_id`.
5. Else return null.

Other rules:
- The result is deterministic: depth ≤ 2 means at most one step up.
- A child with its own config wins over its parent's.
- Inactive locations still resolve (for authorized callers), for display. Recording is rejected separately (Step 3.2).
- **A null result is the only answer an unauthorized caller can get.** Callers treat null as "no monitor / no access" and never as proof that the location exists.

**RPCs** (in `ci_private`, published):

| RPC | Roles | Behaviour |
|---|---|---|
| `ci_create_location_v2(p jsonb) → uuid` | admin, supervisor | Creates the location with all Phase 1 fields. |
| `ci_update_location(p_id uuid, p jsonb, p_expected_updated_at timestamptz) → void` | admin, supervisor | Optimistic lock raises `CI_STALE_UPDATE`. |
| `ci_set_location_active(p_id, p_active bool, p_reason text)` | admin, supervisor | Deactivation raises `CI_LOCATION_HAS_STOCK` if the `ci_stock_balances` sum for the location ≠ 0. It raises `CI_LOCATION_HAS_ACTIVE_CHILDREN` if any child is active. Reactivating a child requires an active parent. |
| `ci_rotate_location_qr_token(p_id, p_reason)` | admin, supervisor | Sets a new token. Old labels stop resolving. |
| `ci_set_location_env_config(p_location_id, p jsonb)` | admin, supervisor | Phase 1 payload: `temperature_monitored`, temperature min/max, `humidity_monitored`, RH min/max. Inserts a new version **only if it differs** from the current one. Phase 3 redefines it in its own migration to also carry the schedule and pause, copying forward any fields the caller omits. |

- Keep `ci_create_location(wh, code, name)` unchanged for compatibility. The existing `createLocation` action may switch to v2.
- Portal URL host/path validation is done in the app (§14). The DB only enforces `https://` and length.
- **DB tests** (`tests/db/locations.test.ts`):
  - RLS: CHE staff cannot read IMM locations or their configs.
  - Viewer and staff RPC calls raise `CI_ACCESS_DENIED`.
  - Hierarchy: depth 3 rejected, cross-warehouse parent rejected, self-parent rejected, and a location with children cannot get a parent.
  - The code is immutable after movement history exists.
  - Deactivation is blocked while stock is held and allowed at zero balance.
  - Env config CHECK boundaries.
  - A config update with no change inserts nothing.
  - `environment_monitor_location_id`:
    - a monitored fridge resolves to itself
    - an unconfigured shelf in that fridge resolves to the fridge
    - a shelf with its own config resolves to itself
    - a shelf under an unmonitored parent resolves to null
    - a parent whose latest version turns monitoring off → the child resolves to null
    - **Authorization (definer function, no RLS reliance):**
      - A CHE-only user calling it for an IMM monitored fridge, for an IMM shelf under a monitored IMM fridge, and for a random non-existent uuid gets **null in all three cases**, with no exception and no id.
      - The same calls by an IMM user return the expected ids.
      - A user with no active profile or grant gets null.
      - Called from inside another definer RPC (`ci_record_environment_reading`) by a CHE-only user on an IMM location → the outer RPC fails with `CI_ACCESS_DENIED`, and nothing about the location leaks through the error.
      - The catalog shows the function has `prosecdef = true` and `proconfig` containing `search_path=""`.
  - TypeScript `resolveEnvironmentMonitor()` matches the SQL on the same fixtures.
  - Audit rows are present with old/new values.
  - QR rotation changes the token and is audited.
  - `security-boundary.test.ts` still passes.
- **Rollback/risk:**
  - The migration is additive. Backfill writes only default values.
  - Forward fix only. Never edit the applied migration.
  - Pre-check existing codes/names against the new CHECKs during the dry-run.

### Step 1.4 — Location list, create, edit and deactivate UI

- **Files:**
  - `src/app/(app)/locations/page.tsx`:
    - List with type icon, parent breadcrumb (`CHE-FR-01 › S1`), room, active badge, and monitoring badge.
    - Search and filter via `?q=&type=&active=`.
    - Keep the quick-add plus the `?return=` behaviour.
    - Remove the "ยังไม่รองรับ" line.
  - New pages: `locations/new/page.tsx` and `locations/[id]/edit/page.tsx`.
  - New component: `components/location-form.tsx`, a controlled client form.
    - Monitoring sections are shown only when their toggle is on; for shelf/rack/bench/other they sit behind the explicit own-monitoring toggle described in Step 1.3.
    - Range inputs use `inputMode="decimal"` with a ± button.
    - **No check-time or pause fields in Phase 1.**
  - `src/app/actions/locations.ts`: new, with zod validation. Move `createLocation` out of `actions/inventory.ts`, keeping the export name via re-export.
  - `src/lib/locations.ts`: type labels (Thai), `formatRange()`, `locationBreadcrumb()`, and parent-option filtering (same warehouse, no parent, not self).
  - `src/lib/stock-options.ts` and pickers in receive/transfer/count: show `parent › code · name`. Selection logic is unchanged.
- **Authorization:**
  - Supervise in the location's warehouse, for every button and action.
  - Viewer and staff see read-only views.
- **Tests:**
  - Unit: zod schemas (min < max, one-sided, disabled ⇒ null bounds, name/code limits).
  - E2E: the create/edit route loop.

### Step 1.5 — Location Detail `/locations/[id]`

- **Server component:** `requireAccess()`, then a user-client select of the location under RLS. `notFound()` if the row is missing or not readable; do not distinguish the two.
- **Sections:**
  1. **Header:** code, name, type, warehouse, room, breadcrumb to the parent, storage condition, active state (an inactive banner if inactive).
  2. **Stock:**
     - Rows from `ci_stock_balances` with `location_id in (self + children)` and `balance <> 0`, joined in TypeScript to products.
     - Columns: product code · name · LOT · expiry (with the expiry bucket badge from `expiryBucket`) · quantity + unit · sub-location.
     - Mobile: card list. Empty state: "ไม่มีสินค้าคงเหลือในตำแหน่งนี้".
  3. **Contained locations:** the children list.
  4. **Environment:** driven by `M = environment_monitor_location_id(L)`, where L is this location.
     - **M = L:** "ตำแหน่งนี้มีการเฝ้าระวัง" plus the ranges.
     - **M = parent:** "สภาพแวดล้อมควบคุมโดย CHE-FR-01" plus the parent's ranges and a link to the parent.
     - **M = null:** "ไม่ได้ตั้งค่าการเฝ้าระวัง".
     - Phase 1 shows the config only. Phase 3 adds M's latest reading and today's rounds.
  5. **Actions:**
     - Edit (supervise)
     - พิมพ์ QR (supervise) → `/locations/qr?ids=`
     - Deactivate/Reactivate (supervise, with a reason)
     - **เปิดเครื่องมือใน Portal ↗** when a URL is set. For a child, the parent's Portal link is also shown, labelled with the parent's code.
     - Phase 3: "บันทึกอุณหภูมิ/ความชื้น **ของ {M.code}**" → `/environment/check/{M}`. It always targets M, never a shelf without its own config, and is hidden when M is null. Also "ดูประวัติ" → `/environment/history?location={M}`.
- **Tests:**
  - DB/RLS: a detail read for another warehouse returns 0 rows, and the page 404s (E2E).
  - Unit: the stock grouping helper.
  - E2E: the detail route at 375 px has no overflow.
- **Acceptance:** Stock totals equal the `/stock` rows for the same location.

### Step 1.6 — QR foundation

- **Dependency:** `qrcode` + `@types/qrcode`, used server-side only.
- **`src/lib/qr.ts`:**
  - `locationQrUrl(token)` = `${APP_ORIGIN}/q/${token}`.
  - `APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'https://chem-immuno-cbh.vercel.app'`. It is never derived from the request host, so labels printed from localhost still point at Production.
  - `qrSvg(text)` returns an SVG string with error-correction `M` and margin 2.
- **`/locations/qr`** (supervise):
  - A grid of labels, **50 × 30 mm**, sized in `@page`/mm CSS on A4.
  - Each label shows: the QR (≥ 22 mm), code (large, monospace), name, warehouse code, and the storage condition or range.
  - Footer text depends on the monitor resolution:
    - M = L: "สแกนเพื่อบันทึกอุณหภูมิ/ความชื้น"
    - otherwise: "สแกนเพื่อดูตำแหน่ง"
    - For a child under a monitored parent: "ควบคุมสภาพแวดล้อมโดย {parent code}"
  - `break-inside:avoid`, and the existing `PrintButton`.
  - A warning appears when some selected locations are inactive; inactive ones are excluded by default.
- **`/q/[token]`** (in the `(app)` group, so `requireAccess()` redirects to login with `next` preserved):
  1. Validate `^[0-9a-f]{32}$`; otherwise show a generic not-found page.
  2. Select from `ci_locations` by `qr_token` **with the user client (RLS)**.
  3. No row → one generic page: "ไม่พบตำแหน่งนี้ หรือคุณไม่มีสิทธิ์เข้าถึง / QR อาจถูกยกเลิก". **It never reveals the warehouse or whether the location exists.**
  4. Row found → `redirect('/locations/{id}?warehouse={code}')`.
  5. Phase 3 changes step 4 only for self-monitored locations (see §13).
- **Product-scanner guard:** in `src/app/actions/scanner.ts` `resolveScan`/`resolveProductScan`, detect `…/q/<32hex>` **before** barcode parsing.
  - Return a distinct result, "นี่คือ QR ตำแหน่งจัดเก็บ", with a link to `/q/<token>`.
  - Do **not** record a mapping proposal. Recording in `ci_scan_events` with `symbology='location_qr'` is optional.
  - The camera hints stay DataMatrix + Code128, so this guard covers typed or hardware-scanner input.
- **Tests:**
  - Unit: token regex; the location-QR detector (full URL, other host, trailing slash, uppercase rejected).
  - DB: token lookup under RLS for another warehouse returns 0 rows.
  - E2E: `/q/<valid token>` logged in → detail; logged out → login → back to detail; a token from another warehouse → generic page.
  - Unit: the scanner guard does not produce a product match or mapping proposal.

### Step 1.7 — Portal link

- **`src/lib/portal-link.ts`:** `validatePortalEquipmentUrl(input)`:
  - `new URL()`.
  - Protocol must be `https:`.
  - Host must be in `PORTAL_ALLOWED_HOSTS` (env, comma-separated; default `lab-management-cbh.vercel.app`).
  - Pathname must match `^/staff/equipment/[0-9a-f-]{36}(/.*)?$`.
  - No credentials. Length ≤ 500.
  - Returns the normalized `url.href`.
- **Component `PortalLink`:**
  ```tsx
  <a href target="_blank" rel="noopener noreferrer">
  ```
  - Shows the `ExternalLink` icon plus the visible text "เปิดใน Lab Management Portal".
  - Uses `aria-label` with "(เปิดหน้าต่างใหม่)".
  - The URL is re-validated at render. A stored value that fails validation is **not rendered as a link** (shown as a disabled notice).
- **Tests:** unit tests covering `javascript:`, `data:`, `http:`, another host, userinfo, IDN look-alike, missing path and valid cases.

### Step 1.8 — Docs and runbook

- Refresh the stale "current state" lines in `docs/operations-runbook.md`.
- Add a Location Master section to the README module list.
- Add `NEXT_PUBLIC_APP_ORIGIN` and `PORTAL_ALLOWED_HOSTS` to `.env.example`, and set them in Vercel Production before deploy.

### Phase 1 migration(s)

- `supabase/migrations/<YYYYMMDDHHMMSS>_ci_location_master.sql`: one forward-only file containing:
  - the `ci_locations` changes and triggers
  - `ci_location_env_configs` (ranges only)
  - `environment_monitor_location_id`
  - RPCs and grants
- It follows §11 migration hygiene: no top-level `SET LOCAL`, schema-qualified DDL, and function-level `set search_path = ''`.

---

## 9. Phase 2 — Morning Talk

### Step 2.1 — Schema (`<ts>_ci_morning_talk.sql`)

**`ci_morning_talks`**

| Column | Type / rule |
|---|---|
| `id` | uuid PK |
| `scope` | text not null, CHECK in (`ALL`, `CHE`, `IMM`) |
| `warehouse_id` | smallint null |
| `talk_date` | date not null default `(now() at time zone 'Asia/Bangkok')::date` |
| `title` | text not null, trimmed, 1..200 |
| `agenda` | text null, ≤ 5000 |
| `status` | text not null default `'active'`, CHECK in (`active`, `cancelled`) |
| `cancelled_at`, `cancelled_by`, `cancel_reason` | CHECK: all set iff status is `cancelled` |
| `created_by` | uuid not null |
| `created_at` | timestamptz |
| `updated_by` | uuid null |
| `updated_at` | timestamptz |

- CHECK `(scope = 'ALL') = (warehouse_id is null)`.
- FK `(warehouse_id, scope)` → `ci_warehouses(id, code)` (the existing `unique(id, code)`; MATCH SIMPLE skips it for `ALL`).
- **Several talks per day are allowed.**
- Indexes: `(talk_date desc, created_at desc)` and `(warehouse_id, talk_date desc)`.
- **Hard delete is not supported.** Talks are cancelled with a reason.

**`ci_morning_talk_attendees`**

| Column | Type / rule |
|---|---|
| `talk_id` | FK cascade |
| `warehouse_id` | smallint null; denormalized and equal to the talk's (trigger); used for RLS and audit |
| `user_id` | FK → `ci_user_profiles` |
| `assigned_at` | timestamptz not null default now() |
| `assigned_by` | uuid not null |
| `acknowledged_at` | timestamptz null; CHECK ≥ `assigned_at` |

- PK `(talk_id, user_id)`. Index `(user_id, acknowledged_at)`.

**`ci_morning_talk_checklist_items`**

| Column | Type / rule |
|---|---|
| `id` | uuid PK |
| `talk_id` | uuid |
| `warehouse_id` | smallint null |
| `sort_order` | int ≥ 0 |
| `title` | text, 1..240 |
| `completed_at`, `completed_by` | CHECK: both null or both set |
| `created_at`, `updated_at` | timestamptz |

- Index `(talk_id, sort_order)`.

**`ci_morning_talk_actions`**

| Column | Type / rule |
|---|---|
| `id` | uuid PK |
| `talk_id` | uuid |
| `warehouse_id` | smallint null |
| `title` | text, 1..240 |
| `owner_id` | uuid not null |
| `due_date` | date null |
| `status` | text not null default `'todo'`, CHECK in (`todo`, `in_progress`, `done`, `cancelled`) |
| `note` | text, ≤ 1000 |
| `completed_at`, `completed_by` | CHECK `(status = 'done') = (completed_at is not null)`, and both null or both set |
| `created_by`, `created_at`, `updated_by`, `updated_at` | |

- Snake-case `in_progress` matches CHEM enums such as `expired_disposal`.
- Partial index `(due_date) where status in ('todo','in_progress')`, and index `(owner_id, status)`.

**Shared rules:**
- **Audit:** `audit_change` on all four tables (insert/update/delete).
- **New audit read policy:** `ci_audit_morning_talk_read` covers `warehouse_id is null` rows (`ALL` talks) of the morning-talk tables and requires `can_manage_scope(null)`, i.e. supervisory authority in both warehouses. This matches who can manage those talks. CHE/IMM talk audit rows already carry a `warehouse_id` and use the existing policy.
- **Scope helpers** (in `ci_private`, security definer, each with `set search_path = ''`). All are built only on the existing per-warehouse `ci_user_access` via `can_read` / `has_role`; there is no global role.
  - `can_read_scope(p_warehouse_id smallint)` =
    `case when p_warehouse_id is null then has_any_access() else can_read(p_warehouse_id) end`
  - `warehouse_id_by_code(p_code text) → smallint`: a new stable helper that returns `ci_warehouses.id` for the given code (`'CHE'` or `'IMM'`). It raises `CI_WAREHOUSE_NOT_FOUND` if the code is missing, so the check fails closed instead of evaluating against null.
    - **Warehouse codes are authoritative.** No helper, RLS policy, RPC or test assumes numeric ids (e.g. CHE = 1, IMM = 2).
    - The existing `require_import_admin()` hardcodes ids 1/2. It is left untouched (out of scope) and must not be copied.
  - `has_role_code(p_code text, p_roles text[]) → boolean` = `has_role(warehouse_id_by_code(p_code), p_roles)`.
  - `can_manage_scope(p_warehouse_id smallint)`:
    ```sql
    case when p_warehouse_id is null
      then ci_private.has_role_code('CHE', array['admin','supervisor'])
       and ci_private.has_role_code('IMM', array['admin','supervisor'])
      else ci_private.has_role(p_warehouse_id, array['admin','supervisor'])
    end
    ```
    - Admin in one warehouse plus supervisor in the other qualifies for `ALL`.
    - Supervisor in CHE only does **not** qualify.
  - `can_work_scope(p_warehouse_id smallint)`, **for the current actor (`auth.uid()`) only**:
    ```sql
    case when p_warehouse_id is null
      then ci_private.has_role_code('CHE', array['admin','supervisor','staff'])
        or ci_private.has_role_code('IMM', array['admin','supervisor','staff'])
      else ci_private.has_role(p_warehouse_id, array['admin','supervisor','staff'])
    end
    ```
    - Used only to authorize the **caller's own** actions: an attendee ticking the checklist, and an owner updating their own action.
    - **Never** used to judge another user.
  - `require_manage_scope(p_warehouse_id)` raises `CI_ACCESS_DENIED` when `can_manage_scope` is false.

- **Candidate-user eligibility helpers** (in `ci_private`, security definer, `set search_path = ''`, **not published**; they are called only inside the morning-talk RPCs after the caller has been authorized). These judge a **given user id** and never read `auth.uid()`, so the caller's own role can never make someone else eligible.
  - `user_has_role_code(p_user_id uuid, p_code text, p_roles text[]) → boolean`: true iff the candidate has an **active** `ci_user_profiles` row **and** an active `ci_user_access` row for `warehouse_id_by_code(p_code)` with `role = any(p_roles)`.
  - `user_has_role(p_user_id uuid, p_warehouse_id smallint, p_roles text[]) → boolean`: the same check, by warehouse id. Used when the talk already carries its `warehouse_id`.
  - `user_in_scope(p_user_id uuid, p_warehouse_id smallint) → boolean`: attendee eligibility. Any active role, including `viewer`.
    ```sql
    case when p_warehouse_id is null
      then ci_private.user_has_role_code(p_user_id, 'CHE', array['admin','supervisor','staff','viewer'])
        or ci_private.user_has_role_code(p_user_id, 'IMM', array['admin','supervisor','staff','viewer'])
      else ci_private.user_has_role(p_user_id, p_warehouse_id, array['admin','supervisor','staff','viewer'])
    end
    ```
  - `user_can_work_scope(p_user_id uuid, p_warehouse_id smallint) → boolean`: action-owner eligibility.
    ```sql
    case when p_warehouse_id is null
      then ci_private.user_has_role_code(p_user_id, 'CHE', array['admin','supervisor','staff'])
        or ci_private.user_has_role_code(p_user_id, 'IMM', array['admin','supervisor','staff'])
      else ci_private.user_has_role(p_user_id, p_warehouse_id, array['admin','supervisor','staff'])
    end
    ```
    - CHE scope: candidate has active admin/supervisor/staff in CHE.
    - IMM scope: the same, in IMM.
    - `ALL` scope: active admin/supervisor/staff in at least one of CHE or IMM.
    - **Viewer-only users can be attendees but never action owners.**
- **RLS:** select via `can_read_scope(warehouse_id)`. Writes go through RPCs only.

### Step 2.2 — RPCs (`ci_private`, published)

| RPC | Rules |
|---|---|
| `ci_list_scope_members(p_warehouse_id smallint null)` → `(user_id, display_name, position_title, active, attendee_eligible bool, owner_eligible bool)` | Caller must `can_read_scope`. Returns users with active access to that warehouse, or to either warehouse for `ALL`. Per row: `attendee_eligible = user_in_scope(user_id, scope)` and `owner_eligible = user_can_work_scope(user_id, scope)`, both computed for **that user**. The picker offers attendees from `attendee_eligible` and owners from `owner_eligible`. This is a UI convenience only; `ci_save_morning_talk` re-validates every id. Per-warehouse raw roles are not returned (not needed). This fixes the "names visible only to admins" gap for this module without widening `ci_user_profiles` RLS. |
| `ci_manageable_scopes()` → `text[]` | Returns the subset of {`ALL`, `CHE`, `IMM`} for which the caller passes `can_manage_scope`. It drives the "สร้าง" button and the scope selector. UI only; every write RPC re-checks. |
| `ci_save_morning_talk(p jsonb) → uuid` | `require_manage_scope(scope)` for both create and update, **re-evaluated at execution time**, so a role revoked after the page loaded is refused. **One transaction** for create or update: talk, attendee diff, checklist diff, action upserts. Update requires `expected_updated_at`, otherwise `CI_STALE_UPDATE`. **Scope is immutable after create.** **The DB is authoritative, whatever the picker showed:**
- every attendee id must pass `user_in_scope(attendee_id, scope)`; otherwise `CI_ATTENDEE_NOT_ELIGIBLE`
- every action `owner_id` must pass `user_can_work_scope(owner_id, scope)`, evaluated for the **candidate**, never `auth.uid()`; otherwise `CI_OWNER_NOT_ELIGIBLE`

The whole save rolls back on any failure. **Removing an acknowledged attendee raises `CI_ATTENDEE_ACKNOWLEDGED`.** Checklist items can be removed only if not completed. **Actions are never deleted**; they are set to `cancelled` instead. Limits: attendees ≤ 100, checklist ≤ 30, actions ≤ 50. |
| `ci_cancel_morning_talk(p_id, p_reason)` | `require_manage_scope`. Reason is required. |
| `ci_acknowledge_morning_talk(p_id)` | `auth.uid()` only. It updates only its own attendee row: `update … set acknowledged_at = now() where talk_id = p_id and user_id = auth.uid() and acknowledged_at is null`. If not assigned → `CI_NOT_ATTENDEE`; if the talk is cancelled → `CI_TALK_CANCELLED`. **Idempotent:** it returns the existing timestamp, and a repeat call writes no audit row. |
| `ci_set_morning_talk_checklist_item(p_item_id, p_completed bool)` | `can_manage_scope`, or an assigned attendee passing `can_work_scope`. Completing sets `completed_at`/`completed_by`; un-completing clears both. Audited through the trigger. |
| `ci_update_morning_talk_action(p_id, p_status, p_note, p_expected_updated_at)` | The owner (`auth.uid() = owner_id` **and** the caller still passes `can_work_scope`) for status/note, or `can_manage_scope` for status/note of any action in the talk. Title, owner and due-date changes go through `ci_save_morning_talk` (`require_manage_scope`). Moving to `done` keeps the **first** `completed_at`; moving away clears it. |

### Step 2.3 — Morning Talk role and scope matrix

**Management authority by scope:**

| Scope | Who may create / edit / cancel, manage any action, and read `ALL`-talk audit |
|---|---|
| `CHE` | Admin or Supervisor **of CHE** |
| `IMM` | Admin or Supervisor **of IMM** |
| `ALL` | Admin or Supervisor in **both CHE and IMM** (any combination, e.g. Admin CHE + Supervisor IMM); warehouses resolved by `ci_warehouses.code` |

- A supervisor in only one warehouse can read and take part in `ALL` talks but cannot manage them.

**Participation**, where "scope role" is the user's role in the talk's warehouse (for `ALL`, any warehouse):

| Action | Admin | Supervisor | Staff | Viewer |
|---|---|---|---|---|
| View talks in scope | ✓ | ✓ | ✓ | ✓ |
| Manage (create / edit / cancel) | per table above | per table above | – | – |
| Be assigned as attendee | ✓ | ✓ | ✓ | ✓ |
| Acknowledge **self** (when assigned) | ✓ | ✓ | ✓ | ✓ (self-attestation only; not an inventory write) |
| Acknowledge for another user | ✗ | ✗ | ✗ | ✗ |
| Tick checklist | ✓ if manager or attendee | ✓ if manager or attendee | ✓ if attendee | – |
| Be action owner (candidate check `user_can_work_scope`, independent of who assigns) | ✓ | ✓ | ✓ | – |
| Update own action status/note | ✓ | ✓ | ✓ | – |
| Update any action in the talk | if manager of scope | if manager of scope | – | – |

- **No admin override for acknowledgement.** Acknowledgement is evidence that *the person* received the briefing, and a proxy acknowledgement would destroy that meaning.
- An absent person stays unacknowledged. The supervisor may record the absence in the agenda or notes (audited).
- **Acknowledgement is not an electronic signature.** The UI wording is "รับทราบ", not "ลงนาม".

### Step 2.4 — UI

**Files:**
- `src/app/(app)/morning-talk/{page,history/page,actions/page,new/page,[id]/page,[id]/edit/page}.tsx`
- `src/components/morning-talk/{talk-card,talk-form,attendee-picker,checklist-panel,action-list,ack-button}.tsx`
- `src/app/actions/morning-talk.ts` (zod validation → RPC)
- `src/lib/morning-talk.ts` (types, status labels, `isOverdue(action, bangkokToday())`, scope labels)

**Today (`/morning-talk`):**
1. **"รับทราบ" card** — shown when the user has an unacknowledged active talk today: one big button, then a confirmed state with the time.
2. **Today's talks visible to the user**, each as a card with:
   - scope badge, title, agenda
   - attendee strip `x/y รับทราบ`, expandable with names and times
   - checklist with large tap targets
   - actions: status select for the owner or supervisor, overdue badge (icon + text)
3. **Managers:** "สร้าง Morning Talk" is shown only when `ci_manageable_scopes()` is non-empty, and the scope selector lists only those scopes. `ALL` appears only for users with supervisory authority in both warehouses. The form offers **"คัดลอกหัวข้อจากครั้งก่อน"**, which copies the checklist and agenda skeleton from the latest talk in the same scope. Edit/cancel buttons appear only when the user can manage that talk's scope.

**Other views:**
- **History:** search on title/agenda (`ilike`), scope filter, date range, paginated 20/page. Cancelled talks show a badge.
- **Open actions:** all `todo`/`in_progress` actions in the readable scope. Filters: "ของฉัน", "เกินกำหนด", scope. Sorted overdue → due soon → no due date. Each row links to its talk.

**Checklist templates are deferred.** Copy-from-previous covers the need without a template table. Revisit only if the owner asks.

**Mobile:** single column; a sticky acknowledge button at the bottom when relevant. All controls ≥ 44 px.

### Step 2.5 — Integration

**Nav:** add the Morning Talk workspace (tabs: วันนี้ · ประวัติ · งานค้าง) and the Reports tab `/reports/morning-talk`.

**Attention** (per selected warehouse; `ALL` talks count in both):
- `mt_unack`: *my* unacknowledged active talks from the last 7 days.
- `mt_overdue`: overdue actions I own. Users who can manage a scope also get all overdue actions in that scope.

**Dashboard:** one compact "วันนี้" line: "Morning Talk: รับทราบแล้ว / ยังไม่รับทราบ", linking to Today. No new KPI grid cards.

**Report `/reports/morning-talk?month=&scope=`:** a printable A4 page with:
- Meetings: date, title, scope, creator, acknowledgement x/y with the missing names, checklist completion
- Actions created in the month with status, overdue flag and completion

### Step 2.6 — Tests

**DB** (`tests/db/morning-talk.test.ts`):
- Scope RLS:
  - A CHE-only user sees `ALL` and `CHE` talks but not `IMM` talks or their child rows.
  - An IMM viewer can read an `ALL` talk.
- Management authority:
  - CHE staff cannot create.
  - A CHE supervisor can create/edit/cancel `CHE` but **not `IMM` and not `ALL`**.
  - A CHE supervisor who is IMM staff cannot manage `ALL`.
  - Admin CHE + Supervisor IMM can manage `ALL`; so can Supervisor CHE + Supervisor IMM.
  - A single-warehouse supervisor cannot edit, cancel, or change actions/owners/due dates of an existing `ALL` talk.
  - A single-warehouse supervisor **can** read an `ALL` talk and self-acknowledge when assigned.
  - `ci_manageable_scopes()` returns the expected set for each combination.
  - The `ALL`-talk audit rows are readable by a dual-warehouse supervisor and **not** by a single-warehouse supervisor.
- Member selection:
  - `ci_list_scope_members(null)` returns users of both warehouses.
  - `ci_list_scope_members(<CHE id looked up by code>)` excludes IMM-only users.
- **Code-based warehouse resolution** (tests never hardcode ids; fixtures look up ids by `code`):
  - `warehouse_id_by_code('CHE')` / `('IMM')` return the ids from `ci_warehouses`.
  - An unknown code raises `CI_WAREHOUSE_NOT_FOUND`.
  - **No numeric assumption.** In a dedicated disposable database, remap the `ci_warehouses` code ↔ id pairing before creating any dependent test rows (e.g. CHE = 2, IMM = 1, if the phase-1 seed and constraints allow it there). Then assert that `can_manage_scope(null)`, `can_work_scope(null)`, `user_can_work_scope(…, null)` and member selection give the same results.
  - If the existing seed makes remapping impractical, add a supplementary catalog assertion: `pg_get_functiondef` of every `ci_private` scope helper contains no numeric warehouse literal. This complements the behaviour tests above; it does not replace them.
- **Candidate eligibility** (actor authorization kept separate from candidate eligibility; every case goes through `ci_save_morning_talk`):
  - The caller is **Supervisor CHE**; selected owner is **Viewer CHE** on a `CHE` talk → **rejected** (`CI_OWNER_NOT_ELIGIBLE`), and nothing is written.
  - The caller is **Supervisor CHE**; selected owner is **Staff CHE** on a `CHE` talk → **accepted**.
  - On an `ALL` talk (the caller is a dual-warehouse manager), an owner who is **Staff IMM only** → **accepted**.
  - On an `ALL` talk, an owner who is **Viewer in both CHE and IMM** → **rejected**.
  - **The caller's own role cannot make someone else eligible:** a caller who is Admin CHE + Admin IMM names a candidate with no staff+ role anywhere (viewer, or an inactive grant) → rejected. And `user_can_work_scope(candidate, …)` returns the same value whether the caller is an admin or a viewer.
  - A candidate with an **inactive** profile, or an inactive staff grant, → rejected as owner.
  - An IMM-only user cannot be added as an attendee to a `CHE` talk (`CI_ATTENDEE_NOT_ELIGIBLE`).
  - A viewer can be added as an attendee.
  - `ci_list_scope_members` returns `attendee_eligible = true` and `owner_eligible = false` for a viewer, and `true`/`true` for staff.
  - Forged picker input: an ineligible `owner_id` posted directly to the RPC is still rejected.
  - An owner downgraded to viewer after assignment can no longer update their action (fails `can_work_scope` as the actor), and a scope manager still can.
- Acknowledgement:
  - Attendee self-acknowledgement works.
  - Acknowledging a talk you are not assigned to fails.
  - **User A cannot acknowledge for B**: there is no parameter for it, and a direct UPDATE is denied by RLS.
  - **Concurrent double acknowledgement** (two connections) → one timestamp and one audit row.
  - Acknowledging a cancelled talk fails.
  - Removing an acknowledged attendee fails.
- Checklist: a non-attendee staff member cannot tick.
- Actions:
  - The owner can move an action to `done`, and the timestamp is kept on a repeat.
  - Viewers cannot own an action (candidate check, above).
  - Overdue query boundary at Bangkok midnight (UTC 17:00).
- Save:
  - Atomicity: an invalid action owner rolls back the whole save (no partial talk).
  - A stale save is rejected. **Concurrency:** two dual-warehouse managers saving the same `ALL` talk from the same `expected_updated_at` → exactly one succeeds and the other gets `CI_STALE_UPDATE`.
  - **Authority is re-checked at execution:** revoking a manager's IMM supervisor row before their save → the `ALL` save fails with `CI_ACCESS_DENIED`.

**Unit:** zod schemas, `isOverdue`, scope label and eligibility helpers.

**E2E:** Today/History/Actions/new/[id] at 375/768/1280. Mobile acknowledgement flow with a seeded local user.

### Phase 2 migration(s)

- `<ts>_ci_morning_talk.sql`: one forward-only file containing:
  - the tables, triggers and policies
  - actor helpers: `warehouse_id_by_code`, `has_role_code`, `can_read_scope`, `can_manage_scope`, `can_work_scope`, `require_manage_scope`
  - candidate helpers (unpublished): `user_has_role_code`, `user_has_role`, `user_in_scope`, `user_can_work_scope`
  - RPCs and grants
- It follows §11 migration hygiene.

---

## 10. Phase 3 — Temperature / Humidity + QR Workflow

### Step 3.1 — Schema (`<ts>_ci_environment_monitoring.sql`)

**Change to `ci_location_env_configs`** (scheduling is introduced here, not in Phase 1):
- Add `check_times time[] not null default '{}'`.
  - CHECK: 0..4 entries, sorted ascending and distinct (validated by an insert trigger function).
- Add `monitoring_state text not null default 'active'` with CHECK in (`active`, `paused`).
- Add `pause_reason text null` with CHECK: `paused` requires `pause_reason`.
- `ALTER TABLE … ADD COLUMN … DEFAULT` fills existing Phase 1 rows without firing the row-level `guard_immutable` trigger, so the append-only rule is not broken.
- Existing configs start as **`active` with empty `check_times`**. That means readings are allowed but no schedule is enforced (state `unscheduled`), and the UI warns about it. Setting real check times is a Phase 3 rollout/owner step (§19).
- **Schedule and pause changes are a new version**, like range changes.
- Redefine `ci_private.set_location_env_config` (`create or replace`, in this new migration) so the payload may also carry `check_times`, `monitoring_state` and `pause_reason`. Omitted fields are copied forward from the current version, so a Phase 1-style range-only edit never wipes the schedule.

**`ci_environment_readings`** (append-only)

| Column | Type / rule |
|---|---|
| `id` | uuid PK |
| `warehouse_id` | smallint |
| `location_id` | uuid; FK `(location_id, warehouse_id)` → `ci_locations` |
| `config_id` | uuid not null, FK → `ci_location_env_configs`; the config in force at the time |
| `observed_at` | timestamptz not null |
| `recorded_at` | timestamptz not null default now() |
| `check_date` | date not null; the Bangkok date of `observed_at` |
| `round_no` | smallint null; the schedule round of `observed_at`, null if no schedule |
| `entry_kind` | text, CHECK in (`original`, `correction`, `void`) |
| `corrects_reading_id` | uuid null, FK to self; **unique**; required iff `entry_kind <> 'original'` |
| `temperature_c`, `humidity_rh` | numeric(5,2) null |
| `temperature_status`, `humidity_status` | text, CHECK in (`in_range`, `out_of_range`, `not_monitored`, `missing`) |
| `overall_status` | text, CHECK in (`in_range`, `out_of_range`, `incomplete`, `void`) |
| `source` | text, CHECK in (`manual`, `qr`) |
| `note` | text, ≤ 1000 |
| `reason` | text; required for correction/void and for late entry |
| `entry_mode` | text, CHECK in (`live`, `late`) |
| `excursion_id` | uuid null |
| `recorded_by` | uuid not null |
| `client_request_id` | uuid not null |

- Unique `(recorded_by, client_request_id)`: an idempotency key.
- Indexes `(location_id, observed_at desc)` and `(warehouse_id, check_date)`.
- `guard_immutable`. No audit trigger: the row itself is the immutable record, with its actor.
- RLS: select `can_read(warehouse_id)`.

**`ci_environment_excursions`** (lightweight; not CAPA)

| Column | Type / rule |
|---|---|
| `id` | uuid PK |
| `warehouse_id` | smallint |
| `location_id` | uuid |
| `opened_reading_id` | uuid |
| `opened_at` | timestamptz |
| `parameters` | text[]; subset of {temperature, humidity} |
| `status` | text, CHECK in (`open`, `acknowledged`, `resolved`) |
| `immediate_action` | text |
| `acknowledged_by`, `acknowledged_at` | |
| `resolution_note` | text |
| `equipment_referred` | bool default false |
| `resolved_by`, `resolved_at` | |
| `updated_at` | timestamptz |

- Pair CHECKs per state.
- **Partial unique `(location_id) where status <> 'resolved'`**: at most one open excursion per location.
- `audit_change` (insert/update). RLS `can_read(warehouse_id)`.

**Effective readings:** view `ci_environment_effective_readings` (security invoker). It shows `original` rows that have no correction, plus the latest correction in each chain, and excludes `void` rows.

### Step 3.2 — Domain RPCs

| RPC | Roles | Rules |
|---|---|---|
| `ci_record_environment_reading(p jsonb) → reading row` | admin, supervisor, staff in the location's warehouse | See the numbered rules below this table. |
| `ci_correct_environment_reading(p jsonb)` | Recorder: own reading, same Bangkok `check_date`, only if it has not already been corrected. Supervise: any reading. | New row with `entry_kind = correction \| void`, `corrects_reading_id` (unique, so a concurrent double correction fails with `CI_ALREADY_CORRECTED`), reason required, `config_id` = the original's config, re-evaluated. Correcting a correction follows the chain. |
| `ci_acknowledge_environment_excursion(p_id, p_immediate_action)` | staff+ | `open` → `acknowledged`. Immediate action required. |
| `ci_resolve_environment_excursion(p_id, p_resolution_note, p_equipment_referred bool)` | admin, supervisor | From `open` or `acknowledged` → `resolved`. Note required. The UI warns if the latest effective reading is still out of range. |
| `ci_environment_day_status(p_warehouse_id, p_date) → (location_id, round_no, due_time, state)` | Readers | **Monitored locations only** (locations owning a config in force that day). Child sub-locations never appear as separate rows. `state` ∈ `satisfied`, `due`, `missed`, `upcoming`, `paused`, `unscheduled`. Uses the config in force on that day (§15). |
| `ci_environment_month_report(p_warehouse_id, p_month, p_location_id null)` | Readers | Per monitored location: day × round grid, effective values, missed rounds, late entries, excursions, and a header listing the contained child locations (e.g. "ครอบคลุม: CHE-FR-01-S1, -S2"). Passing a child id reports its monitored parent. |

**`ci_record_environment_reading` rules:**
1. **Authorize first:** look up the location's `warehouse_id`, then `require_role(warehouse_id, array['admin','supervisor','staff'])`.
   - A missing location and a forbidden location both raise the same `CI_ACCESS_DENIED`, with no location detail.
   - Then lock the location row `FOR UPDATE`. This serialises excursion creation per location.
2. **Target rule:** require `environment_monitor_location_id(p_location_id) = p_location_id`, i.e. the target location owns its monitoring config.
   - A child shelf without its own config is **rejected** with `CI_ENV_NOT_MONITORED_LOCATION`. Its detail carries the resolved monitor id so the UI can offer "บันทึกให้ {parent}". This is safe because step 1 already proved the caller can read this warehouse, and the parent is in the same warehouse.
   - **The RPC never silently re-targets a reading.** The client must call it again with the monitored location's id.
   - Also require the location to be active (`CI_LOCATION_INACTIVE`) and its current config `monitoring_state = 'active'` (`CI_ENV_PAUSED`).
3. **Idempotency:** the same `(recorded_by, client_request_id)` with the same payload returns the existing row. A different payload raises `CI_IDEMPOTENCY_CONFLICT`.
4. `observed_at` defaults to `now()`.
   - A value differing by more than 15 minutes requires supervise, a reason, and falls within the last 72 h. It is then marked `entry_mode = late`.
   - A future value is rejected.
5. Evaluate per §15.
6. `out_of_range` → attach to the open excursion, or create one.
7. Return status, bounds and excursion id so the UI can show the result screen.

### Step 3.3 — Configuration UI

- **New in Phase 3:** the Location edit form gains a **schedule editor** for self-monitored locations only.
  - Add up to 4 check times, with preset chips "08:30" and "08:30 + 15:30".
  - A Pause/Resume toggle with a reason.
  - It is hidden for locations that inherit monitoring from a parent.
- Location Detail's Environment section, for its resolved monitor M (Step 1.5), now shows:
  - M's latest effective reading (value, time, recorder, status)
  - M's rounds for today with their states
  - for a child: the same data headed "สภาพแวดล้อมของ {M.code} (ตู้/ห้องที่ตำแหน่งนี้อยู่)"
  - buttons: "บันทึกอุณหภูมิ/ความชื้นของ {M.code}" → `/environment/check/{M}`, and "ดูประวัติ" → `/environment/history?location={M}`
  - the Portal link of M, when set, next to open excursions ("ตรวจสอบเครื่องใน Portal ↗")

### Step 3.4 — QR check flow (mobile-first)

- **`/q/[token]` routing** (deterministic; L = the scanned location, M = `environment_monitor_location_id(L)`):
  - L active **and** M = L **and** L's config `active` **and** the user can mutate in L's warehouse → `/environment/check/{L}`.
  - Every other case → `/locations/{L}`. This includes a shelf under a monitored fridge, a paused config, a viewer, and an inactive location.
  - A shelf label therefore stays an inventory label. Its detail page shows the fridge's state and the "บันทึกของ {M.code}" action.
- **`/environment/check/[locationId]`** (server loads via RLS; 404 if not readable):
  - If the id is not self-monitored, redirect to `/environment/check/{M}?from={id}` (with the notice "{id code} อยู่ใน {M code} — บันทึกให้ {M code}"), or to `/locations/{id}` if M is null.
  - The page never renders a form for an unconfigured shelf.
  - **Header card:** code · name · warehouse; acceptable ranges ("2.00 – 8.00 °C", "≤ −20.00 °C", "30 – 60 %RH"); latest effective reading with relative time; today's rounds (e.g. "รอบ 08:30 ✓ · รอบ 15:30 ยังไม่ตรวจ").
  - **Inputs:** only the monitored parameters. Large `inputMode="decimal"` field plus a **±** toggle, autofocus on the first. Live range hint as you type (icon + text).
  - **Primary button:** "บันทึก".
    - If out of range → a confirmation sheet: "ค่าอยู่นอกช่วง 2–8 °C — ยืนยันบันทึก?", with an optional immediate-action note.
    - If a monitored parameter is missing → a "บันทึกไม่ครบ" reason field is required.
  - **Result screen:** a big ✓ อยู่ในช่วง / ⚠ นอกช่วง, plus buttons "สแกนตำแหน่งถัดไป" (→ `/environment/check`, camera auto-starts) and "ตำแหน่งที่ยังไม่ตรวจวันนี้" (list).
- **`client_request_id`** is generated when the page loads and reused on retry. A double-tap or network retry therefore cannot create two readings. The button also disables while pending.
- **`/environment/check`** (the scanner page):
  - Reuses `barcode-scanner.tsx` with a new optional `formats` prop (default unchanged), set to `['QR_CODE']` here.
  - Accepts only `/q/<32hex>` payloads on the configured `APP_ORIGIN` (or its path form). Anything else shows "QR นี้ไม่ใช่ QR ตำแหน่งจัดเก็บ" and **is never passed to the product resolver**.
  - The scan intent here is "check", so a valid token resolves L → M server-side:
    - M = L → check page.
    - M = parent → the parent's check page with the "from" notice.
    - M null → "ตำแหน่งนี้ไม่มีการเฝ้าระวังอุณหภูมิ/ความชื้น" plus a link to its detail.
  - Below the camera: a list of today's due or missed **monitored** locations for the selected warehouse, tappable as a fallback when a label is damaged.
- **Target tap count:** scan (native camera or in-app) → type value → บันทึก → สแกนตำแหน่งถัดไป. That is **3 taps plus typing** per location when in range.
- **Recommended scanner UX: option B, a separate Environment entry point.** The product scanner's decoding rules, logging and mapping-proposal workflow stay untouched, which removes any chance of a location QR being treated as a product barcode. The Phase 1 guard in the product resolver is a second line of defence.

### Step 3.5 — Main module pages

**`/environment` (overview, `?warehouse=`):**
- KPIs: rounds due now, missed today, open excursions, locations checked today x/y.
- Location table/cards (**monitored locations only**), **sorted by attention**: out of range → missed → due → unscheduled → upcoming → OK → paused. Columns: location, expected range, latest value(s), time, status.

**Other pages:**
- **`/environment/history`:** filters (location, date range, status); rows show date/time, location, temperature, humidity, recorder, status, and badges for late/corrected/void. Corrections link to the original ("แก้ไขจาก …").
- **`/environment/excursions`:** open/acknowledged first; detail page with readings in the window, immediate action, resolution, Portal link.
- **`/reports/environment`:** printable monthly A4 per location, containing:
  - header with location, range(s) and schedule, including any config versions that changed during the month
  - a day × round grid with values and recorder initials, where missed shows "ขาด", late is flagged and corrected is marked
  - an excursion list, summary counts, and blank reviewer signature lines

### Step 3.6 — Dashboard and Attention

**Attention categories:**
- `env_missed`: missed rounds today, plus yesterday's still-unexplained missed rounds.
- `env_due`: rounds due now.
- `env_excursion`: open or acknowledged excursions.

**Dashboard:** extend the "วันนี้" line: "อุณหภูมิ/ความชื้น: ตรวจแล้ว x/y · นอกช่วง n", linking to `/environment`. At most one new KPI card ("นอกช่วงที่ยังไม่ปิด"); everything else lives on `/environment`.

### Step 3.7 — Tests

**Unit** (`tests/environment/*.test.ts`), shared fixture table with the DB tests:
- **Range boundaries** (inclusive): 2.00 and 8.00 are in range; 1.99 and 8.01 are out.
- **One-sided** freezer: −20.00 is in range, −19.99 is out.
- **RH:** 0 and 100 are valid; −0.01 and 100.01 are rejected.
- **Monitoring combinations:** temperature only, humidity only, both, with one missing (→ `incomplete`, reason required), and a value supplied for an unmonitored parameter (rejected).
- **Round assignment in Bangkok:**
  - 00:00 +07 falls in round 1 of the new date.
  - 23:59:59 falls in the last round.
  - The UTC 16:59/17:00 boundary.
- **Day status:** `upcoming`, `due`, `missed` and `satisfied`, driven by an injected "now".
- **Scanner:** the QR payload parser accepts only valid location QR codes.

**DB** (`tests/db/environment.test.ts`):
- RLS isolation: an IMM reading is invisible to a CHE-only user; a CHE viewer cannot record.
- **Idempotency:** the same `client_request_id` twice gives one row; a different payload gives a conflict.
- **Concurrent QR double-submit** (two connections) gives one row.
- **Concurrent out-of-range readings** create exactly one open excursion.
- Correction chain; concurrent double correction → one success. A staff member cannot correct another user's reading or one from a previous day; a supervisor can.
- **Immutability:** UPDATE/DELETE on readings fails.
- A config change mid-day: earlier readings keep their config and status, and the missed evaluation uses the correct version.
- A paused config excludes missed checks.
- Late entry rules.
- Month report totals.
- **Monitored-container rules:**
  - Recording against an unconfigured shelf under a monitored fridge fails with `CI_ENV_NOT_MONITORED_LOCATION`, and no row is written.
  - Recording against the fridge succeeds.
  - A shelf with its own config accepts its own readings.
  - `day_status` and the month report list the fridge only, never the shelf. A report request for the shelf returns the fridge.
  - After the Phase 3 migration, existing Phase 1 configs report `unscheduled` (not `missed`).
  - A range-only config edit keeps the existing `check_times`.

**E2E** (Playwright, 375 px):
- Logged-in `/q/<token>` → check page → enter 4.1 → in range → "next" → scanner page.
- Enter 9.0 → confirm sheet → out of range → excursion visible.
- An unauthorized user's QR → generic page.
- Logged-out QR → login → back to the check page.
- A shelf QR (via `/q`) → shelf Location Detail showing the fridge's status plus a "บันทึกของ CHE-FR-01" action → the fridge's check page.
- A shelf QR scanned in `/environment/check` → the fridge's check page with the "from" notice.
- A direct URL `/environment/check/{shelfId}` → redirect to the fridge; no form is rendered for the shelf.
- A viewer's `/q` of a monitored fridge → Location Detail, no form.
- No horizontal overflow on any Phase 3 route.
- **Camera decoding is not E2E-tested** (hardware). Covered by owner acceptance.

### Phase 3 migration(s)

- `<ts>_ci_environment_monitoring.sql`: one forward-only file containing:
  - the `check_times`, `monitoring_state` and `pause_reason` columns
  - the redefined `set_location_env_config`
  - readings, excursions and the effective-readings view
  - RPCs, day-status and report functions, and grants
- It follows §11 migration hygiene.

---

## 11. Proposed DB schema changes (summary)

| Object | Phase | PK / key constraints | Warehouse | Users | Immutability | RLS intent |
|---|---|---|---|---|---|---|
| `ci_locations` (+ columns) | 1 | existing PK; `qr_token` unique; parent FK `(parent, wh)`; CHECKs above | `warehouse_id` (existing) | `updated_by` | Mutable via RPC; full audit trigger; code frozen after history | select `can_read(wh)` |
| `ci_location_env_configs` | 1 (ranges) + 3 (`check_times`, `monitoring_state`, `pause_reason`) | PK `id`; unique `(location_id, effective_from)`; range CHECKs; Phase 3 schedule/pause CHECKs | `warehouse_id` + composite FK | `created_by` | **Append-only** (`guard_immutable`) | select `can_read(wh)` |
| `environment_monitor_location_id()` (function) | 1 | – | same warehouse by FK (plus an in-query assertion) | – | – | **SECURITY DEFINER, no RLS reliance**: an explicit `can_read(target.warehouse_id)` check before any lookup result is returned; null for not-found and not-permitted alike; `set search_path = ''` |
| Morning-talk candidate helpers `user_has_role_code`, `user_has_role`, `user_in_scope`, `user_can_work_scope` | 2 | – | by `ci_warehouses.code` / talk `warehouse_id` | judge `p_user_id`, never `auth.uid()` | – | security definer, **unpublished**, called only inside authorized RPCs |
| `ci_morning_talks` | 2 | PK; scope/warehouse CHECK and FK | nullable (`ALL`) | created/updated/cancelled_by | Mutable via RPC; audited; cancel, not delete | `can_read_scope` |
| `ci_morning_talk_attendees` | 2 | PK `(talk_id, user_id)` | denormalized | user, assigned_by | Acknowledgement set once; acknowledged rows cannot be removed | `can_read_scope` |
| `ci_morning_talk_checklist_items` | 2 | PK; completion pair CHECK | denormalized | completed_by | Audited | `can_read_scope` |
| `ci_morning_talk_actions` | 2 | PK; status/completion CHECKs | denormalized | owner, created/updated/completed_by | Audited; no delete | `can_read_scope` |
| `ci_environment_readings` | 3 | PK; unique `(recorded_by, client_request_id)`; unique `corrects_reading_id`; `location_id` must be self-monitored (RPC rule) | `warehouse_id` + composite FK | `recorded_by` | **Append-only**; corrections are new rows | `can_read(wh)` |
| `ci_environment_excursions` | 3 | PK; partial unique open per location | `warehouse_id` | ack/resolved_by | State machine via RPC; audited | `can_read(wh)` |
| `ci_environment_effective_readings` (view) | 3 | – | – | – | – | security invoker |
| `ci_audit_logs` (new policy) | 2 | – | null for `ALL` | – | existing | + morning-talk null-warehouse policy requiring `can_manage_scope(null)` |

**Constraints and naming:**
- Every table: `revoke all from anon, authenticated; grant select to authenticated`. All writes are published `ci_private` RPCs.
- All constraints are **named** (lesson from Stock-BM).
- Error codes follow `CI_*`.
- **Never** edit an applied migration. Every change is a new file using the 14-digit `YYYYMMDDHHMMSS_ci_<topic>.sql` convention.

**search_path — two separate concerns:**
1. **Migration/session level: no `SET LOCAL` at the top of a migration.** The earlier Production run showed it raises `SET LOCAL can only be used in transaction blocks`, and it gives no protection to the functions being created. New migration files instead **schema-qualify every reference** (`public.ci_locations`, `ci_private.require_role`, `auth.uid()`, `pg_catalog` where relevant). They therefore do not depend on the session search_path at all. Do not add a session-level `SET search_path` either.
2. **Function level (security hardening): required.** Every new or redefined function, `SECURITY DEFINER` or not, and every trigger function declares `set search_path = ''` in its `CREATE FUNCTION … SET search_path = ''` clause and uses fully qualified names in its body. This is the existing CHEM pattern, and `tests/db/security-boundary.test.ts` should gain an assertion that every `ci_private` function has `proconfig` containing `search_path=""`.
- **Review gate:** every migration diff is checked for `SET LOCAL` before the dry run (§19).

---

## 12. RLS / role matrix (consolidated)

"Role" means the role in the relevant warehouse.
- Morning Talk `ALL` **reading** needs access to either warehouse.
- `ALL` **management** needs admin/supervisor in both warehouses (§9 Step 2.3).

| Capability | Admin | Supervisor | Staff | Viewer |
|---|---|---|---|---|
| See workspaces/tabs | all | all except adminBoth tabs | work tabs | read tabs |
| Location: view list/detail/stock | ✓ | ✓ | ✓ | ✓ |
| Location: create/edit/deactivate/rotate QR/print labels/set Portal link | ✓ | ✓ | – | – |
| Location: set monitoring ranges (Phase 1) | ✓ | ✓ | – | – |
| Location: set check schedule, pause (Phase 3) | ✓ | ✓ | – | – |
| Morning Talk | see §9 Step 2.3; `ALL` management needs admin/supervisor in **both** warehouses | | | |
| Env: view overview/history/excursions/reports | ✓ | ✓ | ✓ | ✓ |
| Env: record reading (QR/manual), **only on the self-monitored location** | ✓ | ✓ | ✓ | – |
| Env: late entry (≤ 72 h, reason) | ✓ | ✓ | – | – |
| Env: correct/void own reading (same day) | ✓ | ✓ | ✓ | – |
| Env: correct/void any reading | ✓ | ✓ | – | – |
| Env: acknowledge excursion + immediate action | ✓ | ✓ | ✓ | – |
| Env: resolve excursion | ✓ | ✓ | – | – |
| Audit view (`/audit`) | ✓ | ✓ | – | – |

- This mirrors the existing split: `canMutate` = not viewer, `canSupervise` = admin or supervisor.
- A user with IMM access only has no path, whether route, QR or RPC, to CHE rows. Every read is RLS-filtered, and every RPC calls `require_role(location.warehouse_id, …)`.

**SECURITY DEFINER rule (applies to every new `ci_private` function):** a definer function bypasses RLS, so it must **never rely on RLS implicitly**.
- Each one either authorizes the caller explicitly (`require_role`, `can_read`, `can_read_scope`, `require_manage_scope`) **before** reading or returning any row, or is unpublished and called only after such a check.
- Specifically:
  - `environment_monitor_location_id`: explicit `can_read(target.warehouse_id)`; null on failure. Never reveals the existence, parent, config, code or monitor id of a foreign-warehouse location.
  - `ci_list_scope_members`: explicit `can_read_scope`.
  - The candidate helpers (`user_in_scope`, `user_can_work_scope`, …): unpublished, evaluate only the given user, and are reachable only through RPCs that have already run `require_manage_scope`.

**Actor vs candidate:**
- Actor authorization (`has_role`, `can_*`, `require_*`) always uses `auth.uid()`.
- Candidate eligibility (`user_*`) always uses an explicit `p_user_id`.
- The two are never interchangeable.

---

## 13. QR architecture

**Token and payload:**
- **Token:** `ci_locations.qr_token`, 32 random hex characters (122 bits), unique, not derived from the id or code.
  - The QR contains no internal data beyond an opaque token.
  - It is a stable URL, not a signed or expiring one.
- **Payload:** `https://chem-immuno-cbh.vercel.app/q/{token}` (from `NEXT_PUBLIC_APP_ORIGIN`). It is scannable by the iPhone Camera app and by the in-app scanner.

**Resolution:**
1. `(app)` layout → `requireAccess()`. No session → `/login?next=/q/{token}` → back after login (the existing `x-return-to` + `safeReturnPath` flow; `/q/...` passes `safeReturnPath`).
2. User-client select by token → RLS decides.
3. Not found or not permitted → an identical generic page.
4. Phase 1: → Location Detail. Phase 3, with M = `environment_monitor_location_id(L)`:
   - → `/environment/check/{L}` only when **M = L**, L is active, its config is `active`, and the user can mutate in L's warehouse.
   - Otherwise → `/locations/{L}`.
   - A child shelf label always opens the shelf's detail, which shows its monitored parent's environment state and a check action **targeting the parent**.
   - In the Environment scanner (`/environment/check`), where the intent is to check, a child label goes to the parent's check page with a "from" notice.
   - **No route or RPC ever records a reading against an unconfigured child.**
   - The resolver runs **after** the token has been resolved under RLS and enforces its own `can_read` check (definer, §12). An unauthorized caller therefore gets null and falls through to the identical generic page. The shelf → parent step never exposes a parent in another warehouse.
5. **An inactive location** resolves to its detail page with an "ปิดใช้งาน" banner; no check form.

**Lifecycle:**
- **Rotation:** supervisor with a reason. The old token stops resolving immediately (generic page), and the rotation is audited. The labels must then be reprinted; the UI links straight to the print sheet.
- **Printing:** `/locations/qr`, supervise, 50 × 30 mm labels. See Step 1.6.

**Separation from product scanning:**
- The product scanner never decodes QR codes with the camera.
- The typed/hardware path detects the location-URL pattern and routes away from product resolution.
- The Environment scanner accepts only location QR codes.

**iOS caveat** (owner acceptance): a Home-Screen web app has **separate cookie storage from Safari**. A QR opened from the native Camera opens Safari, which may require a separate login once. The in-app scanner (`/environment/check`) inside the installed PWA avoids this and is the recommended daily path.

---

## 14. Portal-link architecture

- **Data:** `ci_locations.portal_equipment_url` and `portal_equipment_label` (optional pair). There is no Portal id column, no sync, no API and no DB connection.
- **Validation:**
  - App (authoritative), `validatePortalEquipmentUrl`: HTTPS only, allowlisted host (`PORTAL_ALLOWED_HOSTS`, default `lab-management-cbh.vercel.app`), path `/staff/equipment/{uuid}[/…]`, no userinfo, ≤ 500 characters.
  - DB (defence in depth): HTTPS prefix, no whitespace, length.
  - Rejected: `javascript:`, `data:`, `http:`, other hosts.
- **Rendering:** `target="_blank" rel="noopener noreferrer"`, an external-link icon, visible text "เปิดใน Lab Management Portal", and an `aria-label` stating that a new window opens. The value is re-validated at render; an invalid stored value is not linked.
- **Ownership:**
  - The Portal remains the source of truth for the equipment master, PM, CAL, repair and lifecycle.
  - CHEM owns stock, stock location and environmental checks.
- **Where it appears:** out-of-range excursions show the link as the way to "investigate the equipment". CHEM does not create repair tickets.
- **Audit:** link changes are captured by the `ci_locations` audit trigger (old/new).
- **Domain change:** update the env allowlist. Existing stored URLs on the old host stop rendering as links until they are edited. This is intentional and fail-closed.

---

## 15. Temperature / Humidity domain rules

**0. Monitored-container ownership** (applies to everything below):
- Environment monitoring belongs to the **monitored location**, the one that owns a `ci_location_env_configs` row monitoring ≥ 1 parameter. Typically this is a room, refrigerator, freezer, or cabinet when appropriate.
- Shelf/rack child locations are inventory sub-locations.
- `environment_monitor_location_id(L)` = L if L has own monitoring; else L's parent if the parent has own monitoring; else null (Step 1.3).
- **Readings, rounds, excursions and reports exist only for monitored locations.** A child without its own config:
  - shows its parent's status for display (read-only inheritance)
  - is never listed as a separate monitored point
  - never receives a reading
- A child **may** be given its own config explicitly. It then becomes a monitored location in its own right and takes precedence for itself.

**Range evaluation:**
1. **Config in force:** the monitored location's `ci_location_env_configs` row with the greatest `effective_from ≤ observed_at`. It is stored on the reading as `config_id`, so history never re-evaluates against a later range.
2. **Per-parameter status:**

   | Situation | Status |
   |---|---|
   | Parameter not monitored | `not_monitored`; a supplied value is **rejected** (`CI_ENV_PARAMETER_NOT_MONITORED`) |
   | Monitored, value missing | `missing` |
   | Monitored, value present | `in_range` iff `(min is null or v ≥ min) and (max is null or v ≤ max)` (inclusive, numeric(5,2)); otherwise `out_of_range` |

3. **Overall status:**

   | Condition | `overall_status` |
   |---|---|
   | Any parameter `out_of_range` | `out_of_range` (takes precedence) |
   | Otherwise, any parameter `missing` | `incomplete`; reason required |
   | Otherwise | `in_range` |

   A void row is `void`.
4. **Unconfigured is never "normal":**
   - Monitoring on with no bound is impossible by CHECK.
   - Monitoring off → recording is rejected, and the UI shows "ไม่ได้ตั้งค่าการเฝ้าระวัง".
   - An unconfigured location never contributes "OK" to any KPI.
5. **Value sanity:** temperature −100..100 and RH 0..100 are enforced. At most 2 decimals; the UI rounds to 2 and shows 1–2 as typed.

**Schedule and rounds** (Phase 3 only; Phase 1 configs have no schedule):
6. **Schedule:** `check_times` (0–4 times per day), every day including weekends and holidays. Hospital laboratory storage is 24/7; pause covers exceptions. Configs carried over from Phase 1 start with an empty schedule (`unscheduled`) until a supervisor sets the times.
7. **Round windows** (Bangkok local time), for times t₁ < … < tₙ:
   - round 1 = [00:00, t₂)
   - round k = [tₖ, tₖ₊₁)
   - round n = [tₙ, 24:00)
   - An early reading before t₁ counts for round 1.
8. **Round state for date D, evaluated at "now":**
   - `satisfied` if an effective **complete** reading (`in_range` or `out_of_range`) has `observed_at` in the window.
   - `upcoming` if now < tₖ.
   - `due` if tₖ ≤ now < window end.
   - `missed` if the window ended without a complete reading.
   - `paused` if the config in force for that day is paused.
   - `unscheduled` if `check_times` is empty.
   - Evaluation uses the config version in force at each round's start. There is no evaluation before the location's first config.
9. **No fabrication:** a missed round is never filled with a carried-forward value. A late entry by a supervisor (with reason) can satisfy it, and it is flagged "บันทึกย้อนหลัง" everywhere.

**Out of range:**
10. **Out-of-range workflow** (lightweight):
    - The first out-of-range reading opens an excursion. Later ones join it.
    - Staff acknowledge it and record the immediate action (e.g. "ย้ายน้ำยาไปตู้สำรอง CHE-FR-02, วัดซ้ำ 30 นาที").
    - A supervisor resolves it with a note and an optional "ส่งตรวจเครื่องใน Portal" flag (link shown).
    - An in-range reading never auto-closes it.
    - There is no root-cause/CAPA form, no effectiveness check and no repair ticket.

**Corrections and time:**
11. **Corrections:**
    - The original is never modified. A correction or void is a new row with reason, actor and time, and it supersedes the original in the effective view.
    - History shows both: "แก้ไขจาก 48.0 → 4.8 โดย … เหตุผล …".
    - Voiding **frees** the round, because only effective complete readings satisfy it. This fixes the Stock-BM void-slot bug.
12. **Timezone:**
    - All date and round logic runs **server-side in SQL** with `at time zone 'Asia/Bangkok'`, or in TypeScript with the existing `bangkokToday()`/`Intl` helpers.
    - The browser-local clock is never used for business logic; it is used for display only.

---

## 16. Morning Talk domain rules

1. **Scope:** `ALL` | `CHE` | `IMM`, fixed at creation.
   - **Read** follows the warehouse access (`ALL` = access to either warehouse).
   - **Manage** (create/edit/cancel, change any action) requires admin/supervisor of that warehouse. For `ALL`, it requires admin/supervisor in **both** CHE and IMM (`can_manage_scope`).
   - Self-acknowledgement is open to any assigned attendee who can read the scope.
   - An `ALL` talk exposes attendee **names only** across warehouses. There is no inventory data in talks.
2. **Several talks per day are allowed.** Today = `talk_date = bangkokToday()` and `status = 'active'`.
3. **Attendees:** assigned by a scope manager from `ci_list_scope_members`.
   - `assigned_at` and `assigned_by` are recorded.
   - Adding later is allowed. **Removing is allowed only before acknowledgement.**
4. **Acknowledgement:** self only, once, recorded with a server timestamp. It is not a signature, and there is no proxy.
5. **Checklist:** shared per talk, with one completion state per item (`completed_by`/`completed_at`). Un-ticking is audited. There is no template table; copy-from-previous is used instead.
6. **Actions:**
   - Statuses: `todo` → `in_progress` → `done`, or `cancelled` (UI: รอดำเนินการ / กำลังดำเนินการ / เสร็จแล้ว / ยกเลิก).
   - **Overdue** = status ∈ {todo, in_progress} and `due_date < bangkokToday()`. **Due today** is shown separately.
   - The first completion is kept.
   - Actions survive talk cancellation and remain in Open Actions until done or cancelled.
7. **Cancel, don't delete.** Everything is audited via `audit_change`.

---

## 17. UX flows

**Flow A — Daily Morning Talk (mobile):**
1. A scope manager opens Morning Talk → Today → "สร้าง".
   - A CHE supervisor sees only the `CHE` scope.
   - A user who is admin/supervisor in both warehouses also sees `ALL` and `IMM`.
2. "คัดลอกหัวข้อจากครั้งก่อน" copies the previous checklist and agenda.
3. They pick attendees ("ทุกคนในขอบเขต" preset), add actions and save. This is one RPC.
4. Attendees open Today → the "รับทราบ" card → tap. Done.
5. During the talk, anyone assigned ticks checklist items. Owners update actions later from Open Actions.

**Flow B — Location setup (desktop, Phase 1):**
1. The supervisor opens Inventory → ตำแหน่งจัดเก็บ → "เพิ่มตำแหน่ง".
2. They enter code `CHE-FR-01`, name, type = ตู้เย็น, room, storage condition, temperature monitoring on with 2–8 °C (humidity off), and the Portal URL. Then save. **There is no check-time entry in Phase 1.**
3. They add shelves `CHE-FR-01-S1` and `-S2`, each with type = ชั้นวาง and parent = CHE-FR-01, and no monitoring of their own.
4. Detail → "พิมพ์ QR" → print. The fridge label reads "สแกนเพื่อบันทึกอุณหภูมิ/ความชื้น"; the shelf labels read "สแกนเพื่อดูตำแหน่ง · ควบคุมสภาพแวดล้อมโดย CHE-FR-01". Stick the labels on.

**Flow B2 — Schedule setup (Phase 3):**
1. Location edit for CHE-FR-01 → schedule editor → preset "08:30 + 15:30" → save. This creates a new config version.
2. The schedule editor does not appear on the shelves, because they inherit.

**Flow C — Fridge check round (iPhone PWA):**
1. More → "ตรวจอุณหภูมิ (สแกน QR)". The camera opens.
2. Scan → check page (range, last value) → type `4.1` → บันทึก → ✓ อยู่ในช่วง.
3. "สแกนตำแหน่งถัดไป" → the camera again. Repeat.
4. A location with a damaged label: tap it from the "ยังไม่ตรวจวันนี้" list.
5. A shelf label scanned by mistake → the fridge's check page with "S1 อยู่ใน CHE-FR-01 — บันทึกให้ CHE-FR-01". The reading is stored on the fridge.

**Flow C2 — Shelf label via the iPhone Camera:**
1. The shelf's Location Detail opens, showing its stock and the fridge's latest reading and status.
2. "บันทึกอุณหภูมิ/ความชื้นของ CHE-FR-01" → the fridge's check page.

**Flow D — Out of range:**
1. Type `9.0` → the sheet says "นอกช่วง 2–8 °C" → confirm, with an immediate action.
2. The excursion opens and Attention shows it.
3. The supervisor reviews it, follows the Portal link if the equipment is suspect, records the resolution note, and resolves it.

**Flow E — Typo correction:**
1. History → the reading → "แก้ไขค่า" (own reading, same day) → new value and reason.
2. The original remains visible with a strikethrough and a "แก้ไขแล้ว" badge.

**States:** every list has an empty state (with the next action), a loading skeleton (the existing `.skeleton` and `(app)/loading.tsx`), and an error state using the `.error` role=alert with `logUserMessage`.

---

## 18. Testing matrix

| Area | Unit (`node:test`) | DB/RLS (`tests/db`, Docker PG17) | E2E (Playwright 375/768/1280) | Other |
|---|---|---|---|---|
| **P1 nav** | workspace visibility per role combo, longest match, first-visible href, warehouse param preservation | – | sidebar ≤ 8 links, tabs render, bottom nav 5, no overflow, every legacy route 200 | typecheck, lint, build |
| **P1 location** | zod schemas (ranges only; no schedule fields), range CHECK parity, breadcrumb, stock grouping, `resolveEnvironmentMonitor` fixtures | CRUD RPC roles, hierarchy rules, code freeze, deactivate-with-stock blocked, env config versioning, `environment_monitor_location_id` (self / inherit / own-config override / null; **explicit `can_read` check: a foreign-warehouse or non-existent id both → null, nothing leaked, including when called inside another definer RPC**), SQL↔TS parity, audit old/new, cross-warehouse isolation | create/edit/detail routes, child detail shows parent's config, 404 for foreign id | security-boundary suite + `proconfig search_path=""` assertion; migration grep: no `SET LOCAL` |
| **P1 QR/Portal** | token regex, location-QR detector, Portal URL validator (unsafe schemes/hosts) | token lookup under RLS, rotation audit | `/q` logged in/out/foreign, label sheet renders | – |
| **P2 Morning Talk** | schemas, isOverdue (Bangkok), eligibility, manageable-scope helper | read isolation ALL/CHE/IMM; **management authority: single-warehouse supervisor cannot manage `ALL`, dual-warehouse can**; code-based warehouse resolution (`warehouse_id_by_code`, fail-closed, code↔id remapping); `ci_manageable_scopes`; member selection per scope with `attendee_eligible`/`owner_eligible`; **candidate owner eligibility judged on the candidate, not the caller** (viewer CHE rejected, staff CHE accepted, `ALL` staff-IMM-only accepted, `ALL` viewer-both rejected, caller's role never confers eligibility, forged ids rejected); self acknowledgement; cross-user acknowledgement impossible; **concurrent acknowledgement**; remove-acknowledged blocked; checklist rights; action ownership (`can_work_scope`); first completion kept; atomic save rollback; stale save incl. **concurrent `ALL` saves**; authority re-checked at execution; `ALL` audit readability | Today/History/Actions/new/detail, scope selector shows only manageable scopes, mobile acknowledgement | – |
| **P3 Environment** | range boundaries (temp/RH/one-sided), monitoring combos, round windows & Bangkok boundaries, day status with injected now, QR payload parser, QR routing decision (L vs M) | recording roles, **reading on unconfigured child rejected / on monitor accepted / on child with own config accepted**, **idempotency & concurrent double submit**, one open excursion under concurrency, correction chain and concurrency, immutability, config change mid-day, schedule added by migration → `unscheduled`, range-only edit keeps schedule, paused, late-entry rules, month report (monitor rows only), isolation | QR → check → in/out of range → next; shelf QR → detail → parent check; env-scanner shelf → parent; direct shelf check URL redirects; unauthorized QR; login round-trip; no overflow | migration grep: no `SET LOCAL` |
| **Regression (every phase)** | full existing `npm test` | full existing `npm run test:db` (inventory ledger, FEFO, reversal, counts, disposal, vendor, import) | existing `mobile-workflows.spec.ts` route loop | `test:auth:local`, `test:storage:local`, `npm run build` |

Database behaviour is asserted **against Postgres**, never by source-string greps.

---

## 19. Production rollout (per phase; same sequence each time)

1. **Local:** `npm run typecheck && npm run lint && npm test && npm run test:db && npm run test:auth:local && npm run test:storage:local && npm run test:e2e:local && npm run build`. All must be green.
2. **Backup:** a hash-verified logical dump into `D:\Claude workspace\CHEM-IMMUNO-QMS-backups`, following the runbook.
3. **Verify the target:** ref `nivlnbaveanoawfbrmzz`; `supabase migration list --linked` matches the repo history.
4. **Migration review:** confirm that the new file contains **no `SET LOCAL`** (and no session-level `SET search_path`), that every DDL reference is schema-qualified, and that every function has `set search_path = ''` (§11).
   - **Dry run:** `supabase db push --dry-run --linked`. Review that only the new forward-only file applies.
   - Phase 1 extra: run the pre-check query showing that existing `ci_locations` codes and names satisfy the new CHECKs.
5. **Apply:** `supabase db push --linked`. Confirm the output shows **no `SET LOCAL` warning**. Then verify read-only:
   - Phase 1: new columns and backfill (`count(*) where qr_token is null` = 0; all `location_type = 'other'`) and grants.
   - Phase 3: existing config rows have `check_times = '{}'` and `monitoring_state = 'active'`.
6. **Env vars (Phase 1):** set `NEXT_PUBLIC_APP_ORIGIN` and `PORTAL_ALLOWED_HOSTS` in Vercel Production.
7. **Deploy:** push `main`, which triggers the Git-integration deploy. Do **not** also run `vercel --prod`. Wait for Ready and record the SHA, URL and region.
8. **Non-destructive smoke:**
   - Login; every existing route opens (runbook list)
   - New routes open
   - Warehouse switch
   - The product scan draft still works
   - Attention counts are unchanged versus before the deploy
9. **Creating real master data or records is owner acceptance, not smoke.**
   - Phase 1: configure *real* locations: monitored containers with ranges, and shelves as children.
   - Phase 2: hold the first *real* talk.
   - Phase 3: set the *real* check times on each monitored location (until then those locations show `unscheduled`), then record the first *real* reading.
   - **No fake stock transactions, test locations, test talks or test readings in Production.**
   - **No re-import** of the Product Master.
10. **Rollback:** promote the previous Ready deployment. Schema changes are additive and stay (forward-fix only). Stock is never "fixed" outside the reversal/adjustment workflows.

---

## 20. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Nav regression hides a page from a role that used it | Unit visibility matrix, plus an E2E check that every legacy route is still reachable. URLs are unchanged. |
| R2 | Location deactivation strands stock | `CI_LOCATION_HAS_STOCK` guard, tested. |
| R3 | Existing location codes violate the new CHECKs | `NOT VALID` then `VALIDATE` after a dry-run pre-check. The CHECKs are minimal (trim, length). |
| R4 | QR leaks cross-warehouse data | RLS-only resolution, a generic not-found page, and tests. |
| R5 | iOS Camera → Safari session is separate from the Home-Screen PWA | Recommend the in-app scanner; owner acceptance verifies both paths. |
| R6 | Labels unreadable, fading, or misprinting on the fridge (condensation) | Owner acceptance; ≥ 22 mm QR at EC level M; laminated or waterproof label stock. |
| R7 | Double readings from double-tap or poor Wi-Fi | `client_request_id` unique key plus a location row lock. |
| R8 | Changing a range or schedule rewrites history | Versioned append-only config; `config_id` on each reading. |
| R9 | Audit rows for `ALL` talks invisible (null warehouse) | New audit read policy for morning-talk tables. |
| R10 | Portal domain changes | Env allowlist; fail-closed rendering. |
| R11 | Production-only pipeline, with no staging for migration rehearsal | Disposable PG17 applies the full migration chain; backup plus dry run; additive migrations. |
| R12 | Scope creep toward CAPA, IoT or an equipment module | Explicit non-goals (§21). The excursion stays a 3-state record. |
| R13 | The camera scanner has trouble reading QR codes via zxing on older iPhones | Manual list fallback on `/environment/check`; owner acceptance. |
| R14 | Top-level `SET LOCAL search_path` in a migration raises `SET LOCAL can only be used in transaction blocks` (seen before in Production) | Not used (§11). Schema-qualified DDL plus function-level `set search_path = ''`. Pre-dry-run grep. |
| R15 | A reading is recorded against a shelf instead of its fridge, splitting history | Monitor resolution rule, the RPC target rule (`CI_ENV_NOT_MONITORED_LOCATION`, no silent re-target), route redirects, and DB + E2E tests. |
| R16 | A single-warehouse supervisor manages an `ALL` talk affecting both warehouses; or the check silently depends on numeric warehouse ids | `can_manage_scope(null)` requires both warehouses, resolved by code via `warehouse_id_by_code` (fails closed on a missing code). Re-checked in every RPC. DB tests include code↔id remapping. |
| R17 | Phase 1 configs have no schedule, so Phase 3 could flag everything as missed on day 1 | Empty schedule means `unscheduled`, never `missed`. Setting real check times is an explicit Phase 3 rollout step. |
| R18 | A SECURITY DEFINER helper leaks cross-warehouse location data because RLS does not apply inside it | Explicit `can_read` check in `environment_monitor_location_id` before any result, null for not-found and forbidden alike, and the §12 rule for every definer function. DB tests call it directly and via another definer RPC. |
| R19 | The caller's role is mistakenly used to decide another user's eligibility (e.g. a supervisor makes a viewer an action owner) | Candidate helpers (`user_can_work_scope`, `user_in_scope`) judge `p_user_id` only; `ci_save_morning_talk` validates every id server-side; DB tests cover the listed cases, including forged ids. |

**Decisions fixed by the owner** (no longer open):
- Hierarchy: one-level container parent (fridge → shelf, maximum depth 2). Room stays a text field. Environment monitoring belongs to the monitored container.
- `ALL` Morning Talk management requires admin/supervisor in both warehouses.
- Check scheduling is Phase 3 only.

**Open decisions (owner):** each has a recommended default used by this plan.
1. **Viewer may self-acknowledge Morning Talk:** yes.
2. **Default check times** per location type, e.g. fridges 08:30 + 15:30, rooms 08:30; checks every day, including weekends and holidays. Set in Phase 3.
3. **Staff correction window:** own reading, same Bangkok day.
4. **Excursion resolution:** supervisor or admin only.
5. **Label stock/printer and size:** 50 × 30 mm on A4 sheets.
6. **Portal allowlist:** `lab-management-cbh.vercel.app` only.

---

## 21. Explicit non-goals

- IoT sensors, Bluetooth thermometers, data-logger ingestion, any automated reading source
- Portal API, Portal DB connection, equipment sync or import
- Duplicating PM, CAL or repair; equipment lifecycle in CHEM
- Full CAPA, IQC, EQA, calibration management, method verification/validation, other QMS modules
- Push, email or LINE notifications; background schedulers or crons
- Checklist template management (copy-from-previous instead)
- Changing any inventory business rule, the ledger, FEFO, reversal, counts, disposal, ROP, receiving, barcode parsing, vendor or Auth
- Changing the mobile bottom-nav composition
- Stock-BM schema, Auth (`nipt_users`), roles or permissions

---

## 22. Phase exit criteria

**Phase 1 is complete only when all of these hold:**
- The desktop sidebar shows ≤ 7 workspaces plus the Scan quick action.
- Every legacy route works, with the correct active workspace and tab.
- The role visibility matrix passes.
- The mobile bottom nav is unchanged and usable, and `/more` lists the workspaces.
- Location create, edit and deactivate work with role enforcement and audit.
- Hierarchy, code-freeze and stock-deactivation guards pass DB tests.
- Monitoring ranges (temperature/humidity enabled + min/max) are configurable and versioned. **No schedule UI exists yet.**
- `environment_monitor_location_id` works, matches the TypeScript helper, and enforces its own `can_read` check: a foreign-warehouse caller gets null with nothing leaked.
- Location Detail shows correct stock (reconciled against `/stock`) and its own or its inherited (parent) config.
- Phase 1 migration applied with no `SET LOCAL` warning.
- The Portal link validates and opens externally and safely.
- The QR label prints, `/q/{token}` resolves under RLS, rotation works, and the product scanner ignores location QR codes.
- All existing suites pass (inventory behaviour unchanged).
- It is deployed via the §19 gates.

**Phase 2 is complete only when all of these hold:**
- Today/History/Open Actions work on mobile and desktop.
- Create, edit and cancel are atomic.
- Self acknowledgement works and cross-user acknowledgement is impossible (DB-tested, including concurrency).
- The checklist and action rights, ownership, overdue logic and first completion work.
- ALL/CHE/IMM read isolation passes.
- Management authority passes: CHE/IMM by the warehouse's admin/supervisor; `ALL` only with admin/supervisor in both.
- Candidate eligibility is enforced server-side on the candidate user: viewers are attendees only, never owners, and the caller's role never confers eligibility.
- Attention and Dashboard entries appear.
- The report prints.
- Audit is readable.
- It is deployed via §19.

**Phase 3 is complete only when all of these hold:**
- Configuration works: schedule (`check_times`) and pause added and versioned. A range-only edit preserves the schedule.
- Readings are only ever stored on monitored locations. Child shelves inherit display and route checks to the monitored parent.
- The QR check works end to end: scan, check page, save, result, next.
- Range validation passes the boundary suite.
- Missed and due rounds are correct across Bangkok boundaries.
- History, corrections and voids behave immutably.
- The excursion workflow works.
- The monthly report prints.
- Dashboard and Attention are integrated.
- Isolation passes.
- It is deployed via §19.
- The owner has completed the real mobile workflow acceptance (§23).

---

## 23. Owner acceptance checklist (physical; not software gaps)

**Phase 1:**
- [ ] Print QR labels on the chosen stock. Scan each with a real iPhone from 20–30 cm, and in fridge lighting or condensation.
- [ ] Scanning with the iPhone Camera app opens the correct Location, both logged out (login, then back) and logged in.
- [ ] A user without IMM access scans an IMM label and sees only the generic page.
- [ ] The Portal link opens the correct equipment page on iPhone (new tab, Portal login if needed).
- [ ] Add-to-Home-Screen still installs and opens; the bottom nav works; More shows the workspaces.
- [ ] Real locations are configured with correct ranges and types (fridge/freezer/room monitored; shelves as children without their own monitoring), and stock appears under them as expected.
- [ ] A shelf's Location Detail shows "สภาพแวดล้อมควบคุมโดย {fridge}" with the fridge's ranges.

**Phase 2:**
- [ ] Run one real Morning Talk: create it on a phone, every attendee acknowledges on their own phone, tick the checklist, assign an action, and the owner updates it the next day.
- [ ] A supervisor of only one warehouse sees no `ALL` option in the create form; a user who is supervisor/admin in both does.
- [ ] The printed monthly summary is acceptable as a record.

**Phase 3:**
- [ ] Set the real check times on every monitored location.
- [ ] Scan and record temperature at ≥ 5 real monitored locations in one round, including a room with humidity, on the iPhone PWA via the in-app scanner.
- [ ] Scan a **shelf** label: the iPhone Camera opens the shelf detail with the fridge's status and a "record for the fridge" action. The in-app scanner goes to the fridge's check page. In both cases the reading appears under the fridge, never the shelf.
- [ ] The same round works via the native Camera app (Safari path).
- [ ] Deliberately enter an out-of-range value on a real reading only if a genuine excursion occurs. Otherwise verify on local/disposable data. **Do not fabricate Production excursions.**
- [ ] A missed round appears the next morning in Attention.
- [ ] Correct a typo on your own reading; the history shows both values.
- [ ] The monthly environment report prints legibly on A4 and is acceptable as the QMS record.
- [ ] The damaged-label fallback (select from the list) works.
