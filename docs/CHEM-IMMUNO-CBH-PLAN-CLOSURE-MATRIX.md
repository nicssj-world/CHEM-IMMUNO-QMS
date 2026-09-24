# CHEM-IMMUNO CBH Plan Closure Traceability Matrix

## Audit baseline

This is the **initial** matrix, recorded before application source changes. The authoritative requirement source is the user's attached `PLAN CI.md` (SHA-256 `43C2F38C4B7A24962A4E8476F0830E799809D8D7402D4ABECA8270C3F475A74E`). The repository plan at `docs/CHEM-IMMUNO-CBH-INVENTORY-IMPLEMENTATION-PLAN.md` has SHA-256 `219B7B2910F25230C8E1659839CD2306A35C05FBB3EB8D3129FB12401A5B2EBC`. Starting Git state: clean `main`, `4e3fc3910402ceaef324bba289679f6c1713049e`.

The comparison found these differences; the attached plan governs this matrix:

| Source lines | Attached plan | Repository plan | Treatment in this audit |
|---|---|---|---|
| 4 | Describes the plan as text not yet written because an earlier run was in Plan mode. | Labels the document the approved Phase 1 plan. | Administrative wording only; no requirement change. |
| 36, 53, 124 | Keeps all 12 `Used with` rows and the packing, HCV, Reaction Cell, and `STANDARD` questions as owner holds; asks for an import approver. | Says REL-01..12 and PM-01..08 have owner decisions, with only Ephis provisioning/vendor scoring still held. | The attached hold list remains the trace baseline. The repository manifest is considered decision evidence only for rows it explicitly records and tests; it does not erase source evidence or unrecorded anomalies. |
| 53 | Calls out duplicated Excel `No.` values 47/48 across FOC sheets and the other source anomalies as review/report evidence. | Omits the 47/48 duplicate detail and records approved active corrections separately from raw source. | Keep every source anomaly, including 47/48, in the traceability and import audit. |
| 106 | Requires the review queue, dry run/preview, responsible-party approval of pending mapping/packing, and no Production activation before all critical rows are decided; report source counts 90/27/12. | Requires a row-keyed resolution manifest, distinguishes source/active counts, and reports 20 decisions with critical-open 0. | Retain the original hard gate and source counts, and also report the manifest and active counts. |
| 108 | Requires versioned migrations tested on disposable local PostgreSQL **and Preview** before Production. | Explicitly says no Preview Supabase/Vercel environment and local-only pre-production checks. | Preview remains required by the authoritative plan. Vercel Git Preview will be used; any missing Preview Supabase capability must be recorded as a gate/limitation, not silently waived. |
| 120 | Lists source classifications 90/27/12 and two-session concurrency requirements. | Adds owner-resolved 90+10 and 27/28 counts and 20 manifest entries. | Test both original source facts and resolution-aware active facts. |
| 122 | Describes transactional Production acceptance, Preview/permission checks, backup and monitoring; recommends Vercel CLI. | Adds target identity/backup and local testing, removes Preview and the CLI recommendation. | The user's execution instructions explicitly prohibit fake Production stock transactions and require non-destructive Production smoke. Record the authorized deviation; verify Production without writes. |

**Status meaning:** Initial-table statuses preserve the pre-fix audit. Final closure rows use only `PASS`, `OWNER ACCEPTANCE REQUIRED`, or `APPROVED DEVIATION`; `BLOCKED`, `PARTIAL`, and `MISSING` remain historical initial-audit states only. Owner-required evidence is listed separately and is never presented as a technical pass.

## Initial traceability

### Source, scope, and Product Master

| ID | Original requirement | Phase | Current code | Database | UI | Automated tests | Production evidence | Initial status | Gap | Required action |
|---|---|---|---|---|---|---|---|---|---|---|
| SRC-01 | Use the attached original plan as the source of truth; compare the repository plan first. | All | Read-only comparison completed. | — | — | — | Hashes recorded above. | PASS | Material differences are recorded above. | Keep this matrix based on the attachment. |
| SRC-02 | Build CHEM-IMMUNO CBH with Next.js 16, React 19, TypeScript, Supabase, and Vercel. | 1–3 | Present in app/package/config. | Supabase project linked/configured. | App routes present. | Typecheck/build suites available; typecheck passed. | Production URL and project mapping known; deployment pending. | PARTIAL | Final deploy and Ready evidence pending. | Build, push through existing Git integration, verify Ready. |
| SRC-03 | Use one inventory engine for CLINICAL CHEMISTRY and IMMUNOLOGY, isolated through the database. | 1 | Warehouse-aware actions/query helpers. | `warehouse_id`, composite constraints, role checks, RLS. | Warehouse switch and scoped pages. | PostgreSQL isolation tests passed. | User supplied target baseline; live read-only reconciliation pending. | PARTIAL | Production target/count evidence not yet rechecked. | Perform read-only target and count verification. |
| SRC-04 | Scope includes Product Master, relations, receiving, LOT/expiry, issue, ledger, counts, reorder, vendor, reports, and late PWA/icon work. | 1–3 | Corresponding modules/routes exist. | Corresponding `ci_*` tables/RPCs exist. | Corresponding workflows exist. | Unit/DB coverage exists; E2E route coverage incomplete. | Full non-destructive Production smoke pending. | PARTIAL | Test/evidence coverage incomplete. | Close E2E and Production smoke gaps. |
| SRC-05 | Keep IQC, EQA, calibration management, method verification/validation, CAPA, equipment PM, document control, patient/test-result workflows out of scope; QC/Calibration are issue purposes only. | All | No unrelated modules identified. | No unrelated QMS schema identified. | Issue-purpose UI only. | Scope reviewed in current tree. | — | PASS | None found. | Preserve scope. |
| SRC-06 | Use Stock-BM only as read-only conceptual reference; do not copy its schema, identities, permissions, or business rules. | 1 | CHEM-IMMUNO implementation uses `ci_*`. | Independent schema/RPCs. | CHEM-IMMUNO roles/flows. | Local suites. | No Stock-BM changes authorized. | PASS | None found. | Do not modify Stock-BM. |
| SRC-07 | Import only the approved workbook hash; count true product rows, derive reagent from sheet and FOC type from row, preserve physical row provenance. | 1 | Approved importer validates filename/hash and captures provenance. | Staging/apply routines retain raw rows. | Import review UI. | Fixture/hash/provenance tests passed. | User reports approved 162-product baseline; live check pending. | PARTIAL | Production source reconciliation pending. | Verify read-only; never reimport. |
| SRC-08 | Reconcile source warehouse/type totals: CHE 42/11/10/27 = 90; IMM 30/21/13/8 = 72; reagent/calibrator/control/consumable totals 72/32/23/35 = 162. | 1 | Import audit derives counts. | Applied master expected 162. | Import report. | Import tests passed. | User-provided baseline only so far. | PARTIAL | Production counts not independently checked. | Reconcile without writes. |
| SRC-09 | Preserve 162 unique current REF and manufacturer barcodes as text, all 138 leading-zero REFs, and report duplicate/name/legacy collision checks. | 1 | Identifier parser/import types use text. | Unique typed identifiers. | Product identifier display/edit UI. | Approved workbook tests passed. | User baseline says 353 identifiers; live check pending. | PARTIAL | Production verification pending. | Reconcile exact counts read-only. |
| SRC-10 | Preserve 90 source Product→Product pairs (60 CHE, 30 IMM) and 27 source platform assertions (20 `c503/c703/ISE`, 2 `ISE neo`, 1 `c703`, 4 `e801`); do not expand group-level compatibility to inferred edges. | 1 | Source parser separates product/platform links. | Relation/platform tables and provenance. | Separate relation/platform sections. | Import fixture tests passed. | User baseline says 100/28 active after decisions; not yet checked. | PARTIAL | Need verify source and active counts independently. | Report source breakdown and 90/27 source vs 100/28 active. |
| SRC-11 | Store each of the 29 old REFs as an identifier on the same Product; do not create products or `replacement_for` edges. | 1 | Legacy identifier import. | Typed unique `REF_LEGACY`. | Identifier UI. | Tests cover 29 aliases. | User baseline says 29; live check pending. | PARTIAL | Production reconciliation pending. | Verify same-product alias counts read-only. |
| SRC-12 | Retain all 12 specific unresolved `Used with` source rows and exact reasons as a review queue; do not silently fuzzy-link. | 1 | Review rows and resolution-aware parser exist. | 12 source review items; immutable resolution event design. | Import review UI. | Tests assert 12 source rows, decisions, no silent links. | No live decision-event query performed. | PARTIAL | Need verify approved decisions are attributable and every source row remains represented. | Check manifest/DB evidence and preserve the 12 source rows in final audit. |
| SRC-13 | Report source anomalies: three blank packings, HCV truncated text, duplicate `No.` values including 47/48 across FOC sheets, IMM No.71 order, Reaction Cell conflict, and `STANDARD`/ISE type questions; never infer corrections. | 1 | Raw snapshots and resolutions exist. | Source raw rows retained. | Import review surfaces. | Import tests cover 20 review rows/corrections. | No live evidence checked. | PARTIAL | Existing audit omits duplicate 47/48 detail; exact anomaly report needs completion. | Add every original anomaly to import/closure evidence without changing raw values. |
| SRC-14 | Keep owner resolution manifest keyed by workbook hash, sheet, physical row, REF, raw value, decision, and type; retain unresolved items as explicit unassigned when decided so. | 1 | `approved-resolutions.ts`. | Resolution rows and audit. | Import review. | Manifest/DB tests passed. | User baseline says 0 critical open; attribution not checked live. | PARTIAL | Live approval evidence unverified. | Verify locally/Production read-only; don't infer new mappings. |
| PM-01 | Product Master records warehouse, immutable source name, editable display name, Product Code, type, packing text, stock unit, active state, and batch/sheet/row/raw provenance. | 1 | Product actions/types implement fields. | `ci_products` and constraints. | Product create/detail/edit screens. | Import/product tests passed. | Production record evidence pending. | PARTIAL | Live master audit pending. | Verify read-only. |
| PM-02 | Keep REF, legacy REF, manufacturer barcode, GTIN, HIBC PCN, AI 240, and OTHER as typed evidence; never treat workbook 9-digit barcode as GTIN. | 1–2 | Identifier kinds and resolver. | Typed identifiers/uniqueness. | Product detail and mapping review. | Parser/import/DB conflict tests passed. | No Production mapping audit yet. | PARTIAL | Live evidence pending. | Verify types and conflicts read-only. |
| PM-03 | Never guess a numeric stock conversion from packing text; preserve packing/provenance and use pack units as initial stock unit. | 1 | Import preserves pack text; unit explicit. | Quantity constraints. | Product/receive forms. | Import and receipt tests passed. | — | PASS | None found. | Preserve. |
| PM-04 | Deactivate products with LOT/invoice/ledger history; hard-delete only with no operational reference, checking dependencies and auditing. | 1 | Product actions expose lifecycle behavior. | Delete/dependency/audit checks in RPC. | Product admin controls. | DB/product lifecycle coverage exists; focused case not separately rerun. | — | PARTIAL | Confirm tests cover both referenced and unreferenced cases. | Add or extend focused DB assertion if absent. |
| PM-05 | Allocate `CHE-0001..0090` and `IMM-0001..0072` in selected reagent-then-FOC row order using locked DB counters; no client code, `MAX+1`, mutation after commit, or reuse after deletion. | 1 | No client sequence generation. | Locked counters and immutable code. | Import creates codes. | Two-session allocation test passed. | User says codes exist; live sequence audit pending. | PARTIAL | Need confirm Production sequence/read-only nonreuse evidence. | Verify prefix ranges and counter values read-only. |

### Relationships, identity, warehouses, and authorization

| ID | Original requirement | Phase | Current code | Database | UI | Automated tests | Production evidence | Initial status | Gap | Required action |
|---|---|---|---|---|---|---|---|---|---|---|
| REL-01 | Support `uses_calibrator`, `uses_control`, `uses_consumable`, `compatible_with`, `replacement_for`, `other`, plus notes; enforce target type, no self-link, no cross-warehouse. | 1 | Relation action/editor. | RPC + trigger validation. | Searchable selector and type controls. | DB relationship tests passed. | No live query. | PARTIAL | Need confirm edit/type change and warehouse cases all covered. | Review/add focused tests for CRUD contract. |
| REL-02 | Add, edit, change type, and hard-delete current relation while retaining audit; filter selector by target type/warehouse. | 1 | Editor supports CRUD. | Delete audit trigger and checks. | Searchable filtered target picker. | DB tests cover relation constraints; full UI flow not covered. | — | PARTIAL | UI workflow E2E evidence missing. | Add E2E CRUD or source-focused component coverage. |
| REL-03 | Keep platforms/analyzers separate from Product relations; retain approved special mappings and source text, without fuzzy matching or expanding group assertions. | 1 | Separate mapping path and manifest. | Separate platform tables/provenance. | Platform section in detail/import review. | Import/DB tests pass 27 source/28 active. | User baseline only. | PARTIAL | Live special mapping evidence pending. | Verify c503/c513 override and source provenance read-only. |
| WH-01 | Scope Products, locations, LOTs, receipts, movements, counts, and calculations by warehouse; one invoice may hold both warehouses while receipt lines remain warehouse-correct. | 1 | Scoped queries/actions. | Composite warehouse FKs and validation. | Warehouse selector. | Cross-warehouse PostgreSQL tests passed. | Production isolation not rechecked. | PARTIAL | Production isolation evidence pending. | Run non-destructive authorization checks. |
| AUTH-01 | Bind Supabase Auth UUID to Ephis ID/status/per-warehouse role; Supabase Auth authenticates, with no assumed Stock-BM identity reuse. | 1 | Auth identity/provision helpers. | `ci_user_access`, auth-bound actor. | Login/account/users. | Auth identity/bootstrap tests passed. | One active Admin is user-provided; login not yet tested. | PARTIAL | Provision policy and actual account linkage need gate evidence. | Verify current Production access read-only; do not bootstrap users. |
| AUTH-02 | Enforce Admin: users/master/import/adjust/reverse/audit; Supervisor: scoped master/mapping/count/adjust/reverse/vendor; Staff: receive/issue/transfer/count/propose mapping; Viewer: read-only dashboard/stock/reports. Check UI, server, and DB. | 1–2 | `requireAccess` and role-filtered navigation/actions. | `require_role`, per-warehouse RLS/RPC checks. | Role-specific controls. | Local auth and PostgreSQL escalation suites passed; no full role-matrix UI E2E. | No Production role test with live users. | PARTIAL | Missing matrix-wide role-route evidence. | Add disposable role fixtures and test UI/server/DB allow/deny cases. |

### Ledger, receiving, barcode, and stock controls

| ID | Original requirement | Phase | Current code | Database | UI | Automated tests | Production evidence | Initial status | Gap | Required action |
|---|---|---|---|---|---|---|---|---|---|---|
| LED-01 | Balance is the signed sum of LOT×location movement lines; no editable balance; confirmed transactions/lines are immutable; audit is separate from ledger. | 1 | Balance derived from stock RPC/views. | Append-only trigger/grants and audit tables. | Workflows expose operations, not direct balances. | PostgreSQL immutability/reconciliation tests passed. | Production ledger is reported empty; not queried. | PARTIAL | Read-only Production confirmation pending. | Verify no operational transactions and no balance mutation surface. |
| LED-02 | Receive/issue/transfer/adjustment/reversal/expired disposal carry actor, time, reason, idempotency; lock LOTs deterministically, reject negative balances, and commit transaction/lines/audit atomically. | 1 | Server actions submit idempotency keys. | Transaction RPCs enforce locks and atomic checks. | Operation forms. | DB concurrency and atomicity tests passed for covered cases. | No Production writes by instruction. | PASS | Remaining deployment smoke is read-only. | Preserve; exercise locally only. |
| REC-01 | Invoice/receipt are distinct; support partial receiving and mixed CHE/IMM invoice without duplicate invoice. | 1 | Invoice and receiving actions. | Invoice/receipt tables and scoped line RPCs. | Invoice/receive workflow. | Partial and cross-warehouse DB tests passed. | Production transactional test prohibited. | PASS | None in software evidence. | Use disposable DB for further acceptance. |
| REC-02 | Invoice has vendor, number/date, optional PO, private image evidence, and lines; each receipt line requires Product, quantity, LOT, expiry, location; accumulated receive cannot exceed invoice quantity without assessed discrepancy. | 1–2 | Validated receiving form. | Receipt assessment/quantity guard. | Mixed lines, LOT/expiry/location and discrepancy UI. | DB receive/assessment tests passed. | UI smoke pending. | PARTIAL | Need test receipt UI fields and draft/photo lifecycle. | Extend E2E coverage. |
| REC-03 | Scan/photo data are draft proposals only; review before confirmation; confirmation writes the ledger atomically and duplicate confirm is idempotent. | 2 | Browser draft + assessed-confirm action. | Atomic assessed receipt RPC/idempotency. | Reviewable draft and explicit confirm. | DB idempotency and local draft E2E passed, though E2E currently has server-lock issue. | Production writes prohibited. | PARTIAL | Re-run expanded browser E2E with existing server. | Keep Production non-destructive. |
| PHOTO-01 | Mobile camera capture and file fallback; preview; replace/remove; private Storage; short-lived signed upload/read; warehouse authorization; MIME/10MB restrictions; invoice link and uploader/timestamp; public access denied. | 2 | Upload/register/read/delete routes. | Private bucket/policies and attachment metadata. | Capture/file selection and evidence list; preview behavior needs audit. | Local Storage signed URL, isolation, public-denial test passed. | Production bucket/config not yet checked. | PARTIAL | Existing UI may not preview/replacement-test; live bucket policy unverified. | Add UI validation/preview/replace/remove E2E and inspect Production bucket non-destructively. |
| BAR-01 | Parse GS1-128/DataMatrix and HIBC DataMatrix/Code 128; preserve raw payload/symbology/warnings and GS1 AI 01/10/17/21/240, FNC1/GS, HIBC primary/secondary/PCN/quantity/LOT/expiry/serial/Mod43. | 2 | Parser and ZXing scanner. | Scan evidence RPC stores raw/symbology. | Camera, manual input, parsed review. | Barcode parser tests passed. | Physical camera not verified. | PARTIAL | Test all named symbologies on device remains owner-only; DB evidence checks passed locally. | Keep device acceptance separate; expand synthetic fixtures as gaps are found. |
| BAR-02 | Never silently map AI 240 or HIBC PCN to current REF; approved identifiers only; conflicting/unknown scan must not auto-link. | 2 | Resolver checks approved kinds/conflicts. | Conflict validation and approval state. | Unknown scan message and mapping workflow. | Parser/conflicting identifier tests passed. | Production state not queried. | PARTIAL | Production smoke/read-only mapping state pending. | Verify without approving mappings. |
| BAR-03 | Unknown scan → manual Product search/use in current draft → Staff proposes permanent mapping → Supervisor/Admin approves/rejects with audit; proposal only resolves future scans after approval. | 2 | Scanner actions. | Proposal/decision RPCs. | Manual search and review controls. | DB role/conflict/audit tests passed; full UI flow missing. | Live mapping queue not queried. | PARTIAL | Need full UI approval/rejection E2E on disposable fixtures. | Add tests. |
| SCAN-01 | Scan resolves Product and auto-fills LOT/expiry/source indication into editable draft; missing values remain manual; conflict holds for review; never auto-confirms. | 2 | Scan workbench + draft helper. | `ci_record_scan`; receipt conflict checks. | Draft field labels/review/confirm separation. | Local receiving E2E tests LOT/expiry and leaves confirm unused. | Production scan draft not yet verified. | PARTIAL | Re-run E2E and verify provenance/conflict/missing-value cases. | Add focused E2E assertions. |
| SCAN-02 | Repeated packages use Scan again without leaving flow; preserve duplicate behavior, quantity, location, Product, LOT/expiry review and roughly 44px targets. | 2 | Scanner reset/repeat control. | Draft only until confirm. | Mobile scan/receive controls. | One synthetic scan flow exists; repeat/duplicate coverage incomplete. | Physical iPhone pending. | PARTIAL | Need repeated-scan browser tests and physical owner check. | Add repeated scan E2E; classify physical item separately. |
| ISSUE-01 | FEFO recommends non-expired LOTs by expiry and actual balance; selecting another LOT requires persisted reason; revalidate in transaction; reject insufficient stock/negative inventory. | 1 | Issue form and server action. | Issue RPC rechecks balance/expiry/reason under lock. | FEFO issue UI. | DB FEFO, override, insufficient stock tests passed. | Production issue test prohibited. | PASS | None for software. | Use local tests only. |
| ISSUE-02 | Persist purposes Routine, QC, Calibration, Verification/Validation, Repeat/Troubleshooting, Waste, Other; only actual-use purposes count toward ROP. | 1–2 | Purpose choices. | Enum/check and consumption filter. | Issue purpose control. | DB ROP purpose tests passed. | No Production movement test. | PASS | None. | Preserve. |
| MOVE-01 | Transfer uses paired movements, same warehouse, atomic/idempotent; adjustment is signed, reasoned, Supervisor/Admin-only and audited. | 1 | Transfer/adjust actions. | RPC constraints and paired movements. | Forms and restricted nav. | PostgreSQL transfer/adjust/role tests passed. | Production write tests prohibited. | PASS | None for software. | Keep all verification disposable. |
| MOVE-02 | Reversal is authorized, reasoned, allowed once per source, creates opposite movements, preserves original transaction, and cannot cause negative stock. | 1 | Reversal action. | Unique source, immutable ledger and balance checks. | Reversal flow. | PostgreSQL tests passed. | Production write test prohibited. | PASS | None. | Preserve. |
| COUNT-01 | Count snapshots LOT/location, enters actual, shows variance, requires Supervisor/Admin approval, creates adjustment batch, audits, and blocks if ledger changed since snapshot. | 1 | Count pages/actions. | Snapshot/version check and approval RPC. | Count workflow. | DB count/stale snapshot tests passed. | Production count test prohibited. | PASS | None for software. | Keep disposable. |
| DISP-01 | Expired disposal has dedicated type, LOT, quantity, date, reason, authorization, signed movement, and audit. | 1 | Disposal action/form. | Disposal RPC and transaction constraints. | Disposal page. | DB disposal tests passed. | Production disposal prohibited. | PASS | None. | Preserve. |

### Reorder, vendor, dashboard, reporting, and PWA

| ID | Original requirement | Phase | Current code | Database | UI | Automated tests | Production evidence | Initial status | Gap | Required action |
|---|---|---|---|---|---|---|---|---|---|---|
| ROP-01 | Automatic ROP = 90-day average daily net issue × lead time + safety stock; include actual-use purposes and issue reversals; exclude transfer, generic adjustment, Waste, disposal. | 2 | `inventory-insights` calculations. | Reorder view/RPC uses signed issues. | Reorder page. | Exact 90-day/reversal/exclusion tests passed. | Live settings not checked. | PARTIAL | Production read-only verification pending. | Verify formula/current configuration without writing. |
| ROP-02 | Manual ROP in packs; automatic mode requires lead time/safety/target coverage/pack and full history; missing config displays `ต้องตั้งค่า` with reason, never zero. | 2 | Manual/auto status helper. | Reorder settings/status view. | Missing-config reason shown. | Unit/DB missing ROP tests passed. | Live settings not checked. | PARTIAL | Read-only live check pending. | Verify no zero fallback. |
| ROP-03 | Suggested order = target coverage demand − usable unexpired stock, rounded up to pack; do not subtract open incoming orders. | 2 | Suggested order helper. | Uses current unexpired stock and order pack. | Reorder suggestion. | Insight tests passed. | Live suggestion not checked. | PARTIAL | Need evidence through UI/Production smoke. | Verify read-only. |
| EXP-01 | Classify expiry at LOT/location with Asia/Bangkok date: expired, ≤30, 31–60, 61–90, >90 days. | 2 | Bangkok date helper. | LOT/location stock view. | Expiry/attention pages. | Exact date-boundary tests passed. | Live expiry view pending. | PARTIAL | Non-destructive smoke pending. | Verify display and warehouse scope. |
| VEND-01 | Vendor Master, receipt assessment, issues, objective metrics, annual evaluation, and FY Oct 1–Sep 30. | 2 | Vendor routes/actions/metrics. | Vendor/evaluation/approval tables and FY view. | Vendor pages/forms. | Vendor metrics/FY tests exist. | Production read-only smoke pending. | PARTIAL | End-to-end vendor UI not yet tested. | Add route and key UI assertions. |
| VEND-02 | Store evaluator, reviewer, approver, and metric snapshot; score/decision stay nullable until approved policy; invent no weights, thresholds, or labels. | 2 | Evaluation state workflow. | Snapshot/approval rows, nullable score/decision. | Explicit unscored state. | DB/vendor tests passed. | Live policy/evaluations not checked. | PARTIAL | Need live no-write verification/document policy hold. | Verify score remains null; do not define policy. |
| ATT-01 | Attention includes stockout, below ROP, expired/≤30/31–60/61–90, receiving discrepancy, pending barcode mapping, and vendor issue; warehouse scoped and no repeated disruptive modal. | 2 | `inventory-insights`/attention page. | Warehouse-scoped view. | Attention list. | Insight tests passed; modal/visual behavior lacks browser evidence. | Production attention pending. | PARTIAL | E2E/UI scope and live read-only view missing. | Add responsive Attention route checks. |
| ATT-02 | Implement acknowledgment only if a defined plan behavior requires it; do not invent policy. | 2 | No acknowledgment control identified. | No unnecessary acknowledgment state. | None. | No defined behavior to test. | — | PASS | Original plan leaves acknowledgment optional/only as needed; no specific rule exists. | Do not add speculative behavior. |
| DASH-01 | Visible warehouse switch changes Products, stockout/low stock, consumption, ROP/order, expiry, movements, Attention, and vendor metrics together. | 3 | Warehouse-scoped parallel query groups. | RLS and warehouse filters. | Dashboard switch. | Source/unit checks and local dashboard E2E for counts/switch. | Production dashboard/switch not smoke-tested. | PARTIAL | Existing E2E tests only limited dashboard KPIs. | Expand all-query switch assertions and live smoke. |
| SEARCH-01 | Search Product Code, REF, barcode/identifier, name; filters warehouse, type, platform, low/out, expiry; bounded server-side pagination. | 3 | Search/report RPC caller. | Security-invoker paginated functions. | Product and stock filters/results. | DB search tests passed. | Production stock/search pending. | PARTIAL | E2E does not cover stock search filters. | Add route/filter E2E and live read-only smoke. |
| DETAIL-01 | Product detail shows code, source/display names, warehouse, type, packing, identifiers, relations, platforms, LOT/location, expiry, reorder, provenance, and recent movements. | 1–3 | Product detail page queries. | Warehouse-scoped source tables/views. | Detail page and editors. | DB/unit coverage; E2E detail route absent. | Production detail pending. | PARTIAL | Need full detail-page browser coverage. | Add synthetic detail E2E and live read-only smoke. |
| UX-01 | Mobile presents cards/summaries rather than squeezed desktop tables; nav is Home/Stock/Scan/Receive/More with prominent Scan/Receive and ~44px targets. | 3 | App shell and responsive CSS. | — | Five-item bottom nav and cards. | Some 375px E2E; not all planned pages/controls. | iPhone not physically checked. | PARTIAL | Need all route/target browser checks. | Expand responsive E2E; retain owner-only physical status. |
| REPORT-01 | Monthly report uses signed ledger and reconciles Opening + Received − Issued ± Adjustments − Disposal ± Reversals = Closing, with warehouse/month controls, expiry, reorder, and vendor/receiving evidence. | 3 | Report helper/page. | `ci_monthly_inventory_report`. | Monthly controls, sections, row checks. | Report reconciliation tests passed. | Production report pending. | PARTIAL | Read-only live report smoke pending. | Verify report without writes. |
| REPORT-02 | Print/PDF is A4 landscape, Thai-capable, sensible page breaks, no clipped tables, browser Print-to-PDF compatible. | 3 | Print CSS/button. | — | Report print layout. | E2E can produce PDF (>1KB), but no visual inspection recorded. | No production PDF inspected. | PARTIAL | PDF layout has not been visually inspected. | Generate PDF, render pages and inspect; fix clipping if present. |
| PWA-01 | Final approved visual identity covers Chemistry+Immunology, flask, molecular nodes, subtle reliability cue, blue/teal; legible at small size, no tiny text; use the supplied owner artwork. | 3 | Existing icon artwork differs from user's supplied icon. | — | Icon references still use old outputs. | PWA size/manifest tests passed for old outputs. | Live assets not checked. | PARTIAL | User supplied `ChatGPT Image Sep 23, 2026, 02_12_30 PM.png`; current outputs are not derived from it. | Create exact raster derivatives from supplied artwork and update every icon reference. |
| PWA-02 | Provide favicon ICO/browser icon, Apple 180, PWA 192/512, maskable 512; check at 16/32/64/180/192/512 for clipping, white box and safe zone. | 3 | Existing files/manifest present. | — | Metadata and manifest. | Tests verify dimensions/URLs only. | Production icon visuals not checked. | PARTIAL | Assets not the user-selected art; no size-by-size visual test. | Replace, inspect all sizes, add asset provenance and tests. |
| PWA-03 | Manifest name `CHEM-IMMUNO CBH`, short name, standalone, theme; HTTPS Production install; no authoritative authenticated data cache/service worker. | 3 | Manifest/layout and no service worker found. | Auth data served dynamically. | PWA metadata. | Manifest tests passed. | Live manifest/cache headers not checked. | PARTIAL | Production headers/cache behavior pending. | Verify after deploy and add cache assertion. |

### Database, API, import, operations, and acceptance gates

| ID | Original requirement | Phase | Current code | Database | UI | Automated tests | Production evidence | Initial status | Gap | Required action |
|---|---|---|---|---|---|---|---|---|---|---|
| DB-01 | Implement the described identity/master, receiving/stock, and control/evidence `ci_*` table groups; attention may be computed and only necessary acknowledgment state stored. | 1–2 | Query/actions present. | Eight versioned migrations define expected groups. | Corresponding module pages. | DB migrations/integration suite passed locally. | Production migration ledger not yet checked this run. | PARTIAL | Need read-only migration parity check. | Compare local/Preview/Production migration histories; don't alter applied migrations. |
| DB-02 | Enforce composite warehouse FKs, unique resolvable identifiers/codes, positive quantity, LOT expiry conflict hold, relation target trigger, immutable codes/ledger, unique reversal/idempotency; text identifiers and pack-unit quantities. | 1–2 | Actions validate inputs. | Constraints/triggers/RPC checks. | Forms. | DB invariant/concurrency tests passed. | Production schema/advisors not checked. | PARTIAL | Live advisor and schema evidence missing. | Run security advisors/migration inspection read-only. |
| SEC-01 | Mutations go through authenticated Next server actions/routes and explicit transactional RPCs; actor from Auth, role/warehouse/payload/idempotency checked; never accept client actor IDs. | 1–3 | `requireAccess`, service client isolated. | Auth-derived RPC actor and checks. | Authenticated pages/actions. | Auth/RPC tests passed. | Production security behavior not exercised. | PARTIAL | Need security advisor and non-destructive route checks. | Complete local review and Production smoke. |
| SEC-02 | Put privileged function implementations in a schema not exposed through PostgREST; limit grants by role; fix `search_path`; enforce RLS by role+warehouse; keep service-role key out of browser; keep invoice evidence private with scoped signed access. | 1–2 | Server-only admin module. | `ci_private` implementations and RLS/private Storage policies. | Signed evidence route. | Local Auth/RLS/Storage suites passed; private RPC dispatcher test pending. | Disregard prior dashboard observations from Chrome profile `Siriwat`; user screenshots identify `LabchemCBH`, Vercel `nics-s-world/chem-immuno-qms`, and Supabase org `ChemImmuno-CBH` / project `CHEM-IMMUNO Stock`. Live session and exact dashboard project ref still need matching read-only confirmation. | PARTIAL | Verify private dispatcher grants and exact live project ref; then repeat Production advisor/bucket reads from authorized account. | Complete local dispatcher verification; use only the user-selected account for read-only Production checks. |
| AUD-01 | Audit before/after master/identifier/relation, actor/reason for operations/approval/reversal/access; relation delete retained; audit never substitutes for ledger. | 1–2 | Actions pass reasons/actor context. | Audit triggers/logs and immutable resolution evidence. | Audit/review UI. | DB audit assertions passed for covered cases. | Production audit not inspected. | PARTIAL | Read-only production evidence pending. | Verify no writes and retain event history. |
| IMP-01 | Hard-gate import: raw row/checksum, explicit normalization, counts/duplicates/missing/type/warehouse/legacy/relation/platform checks, review queue, dry run, responsible approval, atomic apply and sequence/count reconciliation; no fuzzy links or critical activation. | 1 | Exact workbook gate/manifest. | Atomic apply checks critical rows and expected count. | Staging/review/apply screens. | Import tests passed. | No import/reimport authorized; Production state read-only only. | PARTIAL | Confirm live manifest, 0 critical open and original approval hold provenance. | Verify, never reimport. |
| IMP-02 | Import report displays 162/90/72, types, 29 aliases, 90 confirmed Product links, 27 platform rows, 12 review rows, and all packing/numbering anomalies. | 1 | Audit CLI and report. | Review items stored. | Import report. | CLI/import tests passed; anomaly coverage incomplete for duplicated 47/48. | — | PARTIAL | Report must include every attached-plan anomaly plus active counts. | Update audit docs/report/test. |
| MIG-01 | Use forward-only versioned schema migrations; test on disposable PostgreSQL and Preview before Production; import as separate batch; never touch Stock-BM/use old workbook; app rollback via prior deployment; post-release schema via forward migration; stock corrections via audited reversal/adjustment with backup/reconciliation. | 1–3 | Migrations are versioned; no new DB need identified yet. | Local disposable DB harness exists. | Git Preview possible. | Local 2-session DB suite passed. | Preview is not yet built/verified; no Production migration approved. | PARTIAL | Original Preview gate not met; target/history/backup evidence pending. | Use Preview branch build; do not apply migrations/import absent a necessity and explicit scope. |
| PH-01 | Phase 1 complete core: auth/role/warehouse, master/import/relation/platform, location/LOT/ledger, receive/issue/FEFO/transfer/adjust/reversal/count/disposal/audit; gate with approved mapping + real-PostgreSQL isolation/atomicity/concurrency. | 1 | Features present. | Disposable harness. | Core pages. | Most DB gates passed. | Production approval gate only for permitted non-destructive scope. | PARTIAL | Finish missing targeted regression tests and evidence. | Close test and read-only evidence gaps. |
| PH-02 | Phase 2: iPhone scanning/GS1/HIBC, unknown mapping, invoice photo/assessment, vendor, reorder/expiry/attention; real iPhone gate; conflicts never auto-link; no score absent policy. | 2 | Features present. | RPCs/policies. | Scanner/receiving/vendor/control pages. | Synthetic parser/DB/Storage tests passed. | Real device not tested; no Production writes. | OWNER ACCEPTANCE REQUIRED | Physical camera/receive behavior cannot be automated. | Record pending owner device check; finish all software checks. |
| PH-03 | Phase 3: warehouse dashboard, polished inventory, monthly print/PDF, manifest/icons, performance/accessibility/security, backup/cutover/monitoring; gates report reconcile, Chrome/iPhone install, E2E, Production smoke. | 3 | Features present, icon needs replacement. | Search/report/security. | Responsive app/report/PWA. | Partial E2E; no PDF visual/accessibility/production check yet. | No current deployment evidence. | PARTIAL | Icon, E2E, ops evidence, preview/deploy and Production smoke pending. | Complete local checks, deploy and verify. |
| PH-04 | Each phase delivers migration/API/UI with focused tests and gate evidence; do not fragment into many mini-phases. | 1–3 | Existing phase docs and migrations. | Versioned files. | Routes implemented. | Suites documented. | Release history pending review. | PARTIAL | Need gather final gate evidence. | Document final evidence in closure matrix. |
| TEST-01 | Import tests: exact fixture/hash, totals/types, REF/leading zero/barcode/legacy, 90/27/12 source classification/no fuzzy link, relations/manifest and source anomaly preservation. | 1 | Fixture/parser exists. | Import integration. | Import review. | `npm test`, `npm run test:import` passed. | — | PARTIAL | Duplicated No.47/48 report assertion missing. | Add test/assertion. |
| TEST-02 | Test relation type/self/cross-warehouse/add/edit/type-change/hard-delete/audit. | 1 | CRUD exists. | Constraints/audit. | Relation editor. | Core DB tests passed for constraints; exact CRUD lifecycle audit needs verification. | — | PARTIAL | Confirm add/edit/type/delete UI/DB test coverage. | Add narrow tests for uncovered cases. |
| TEST-03 | Barcode cases include all formats, AI 240, LOT/expiry/serial, malformed warnings, conflicting identifier, Mod43, quantity and preservation. | 2 | Parser. | Scan evidence and identifiers. | Scanner/manual fallback. | Parser tests passed. | Physical scan pending. | PARTIAL | Synthetic coverage and device remain distinct. | Expand fixtures for any absent encoded fields. |
| TEST-04 | Test partial/mixed receipt, FEFO override/insufficient stock, transfer, adjustment/reversal, count/disposal, ROP reversals/exclusions, RLS/role escalation/Storage, and report reconciliation. | 1–3 | Corresponding feature modules. | Disposable Postgres/Auth/Storage. | Workflow forms. | 23 DB, 17 Auth, 1 Storage, report tests passed in prior baseline. | Production write tests prohibited. | PARTIAL | Need verify simultaneous receive and full UI coverage; local tests can close. | Add two-session receipt test and rerun. |
| TEST-05 | Responsive acceptance at 375/768/desktop for login, dashboard, stock, Product detail, scan, receive, Attention, report, and users/admin; no unusable overflow. | 3 | Responsive CSS. | — | All routes exist. | E2E covers only subset; initial run hit existing `.next/dev` lock (PID 25200) before assertions. | — | PARTIAL | Missing routes and valid E2E run. | Point test at existing repo server on port 3000 without stopping it; expand routes. |
| TEST-06 | Repeated-scan automated path plus physical iPhone camera/scan/receive acceptance. | 2–3 | Repeat control exists. | Draft only. | Scan/receive. | Single synthetic path; no physical device test. | — | PARTIAL | Browser repeat test missing; physical test is separate owner task. | Add repeat test; mark physical owner item pending. |
| TEST-07 | Every phase has focused tests; run npm test/import/Auth/barcode/receiving/ROP/expiry/report/PWA/Storage/RLS/Postgres/two-session, typecheck, lint, production build, audit and `git diff --check`; do not weaken tests. | 1–3 | Scripts exist. | Disposable services. | E2E. | Baseline: `npm test`, import, DB wrapper, Auth, Storage, typecheck, lint and production dependency audit passed; build/final diff pending. | — | PARTIAL | E2E/build/current final diff pending. | Run all applicable suites after fixes. |
| TEST-08 | Two real PostgreSQL sessions must interleave simultaneous issue, receive, Product Code allocation, and double submit; prove atomicity/no lost update/no negative stock. | 1–2 | DB harness. | Separate session concurrency tests. | — | `tests/db/core.test.ts` explicitly interleaves two sessions for code allocation, over-issue, same-key receipt submission, and over-receipt with different keys. | — | PASS | None in these required concurrency cases. | Re-run the complete DB suite after changes; preserve genuine two-session barriers/assertions. |
| A11Y-01 | Authenticated app accessibility: contrast, visible focus, keyboard, labels, validation, loading/disabled states, scanner labels, touch targets; run appropriate audit. | 3 | CSS/components include semantic labels/focus styles. | — | Authenticated screens. | No Lighthouse/accessibility audit recorded. | — | PARTIAL | Need automated keyboard/accessibility/contrast evidence on authenticated routes. | Run axe/Lighthouse or focused browser audit and fix findings. |
| PERF-01 | Measure login/session/profile/warehouse access/auth shell/dashboard in sin1/Singapore context; inspect duplicate auth requests, sequential queries, N+1, unbounded fetch, missing pagination; optimize only with evidence. | 3 | Proxy + server auth reads; bounded page/report queries. | Indexed/scoped queries. | Dashboard/query behavior. | No performance measurements recorded. | Production function region known as sin1; latency unmeasured. | PARTIAL | No measured baselines or request trace. | Measure with safe Preview/Production GETs; optimize only demonstrated issues. |
| SEC-03 | Audit RLS, warehouse isolation, role escalation, actor derivation, service-role isolation, private signed evidence, approval permissions, immutable ledger, grants, fixed search path, and CSP/security headers. | 1–3 | Auth/headers exist; CSP not found. | RLS/grants/RPC protections. | Security-sensitive flows. | Local Auth/RLS/Storage tests pass. | Security advisor not run; live target identity/advisors pending. | PARTIAL | CSP/advisor/Production config evidence incomplete. | Read current Next guide before any CSP change; run advisors on confirmed refs; set appropriate headers if safe. |
| OPS-01 | Minimal visibility for Vercel errors/5xx, failed RPCs, Supabase errors/latency, and backup evidence; avoid oversized observability. | 3 | No compact operational runbook/evidence found. | Provider logs/advisors available by environment. | Existing error states. | No operational acceptance test. | Current error/backup review not performed. | MISSING | No recorded monitor/log/backup/rollback evidence. | Add minimal runbook/checklist and collect deployment/error/backup evidence; do not build a new platform. |
| OPS-02 | Before Production changes verify exact Supabase ref, backup, migration list/history, dry run; afterward reconcile 162/90/72, type counts 72/34/23/33, 353 identifiers, 100/28 links, 0 unresolved; never reimport, recreate master/admin, reset Production or edit old migrations. | 1–3 | Guard scripts; no code changes needed unless new migration. | Target ref/user baseline `nivlnbaveanoawfbrmzz`. | Read-only verification. | Migration/local tests. | Baseline is user-provided; independently confirmed values/backup evidence pending. | PARTIAL | Production backup/current-schema evidence unavailable so far. | Keep Production read-only; confirm actual target and collect available metadata without secrets/writes. |
| PROD-01 | Production verification originally lists invoice/scan/confirm/issue/count/adjust/reversal end-to-end, backup, Preview, monitoring, rollback. | 3 | Workflows implemented locally. | Writes would alter append-only Production ledger. | User explicitly requires non-destructive smoke only. | Full transaction path runs on disposable/local PostgreSQL. | No Production writes permitted. | APPROVED DEVIATION | Production transactional E2E would contaminate the live ledger. | Use local two-session transaction tests plus authenticated/read-only Production smoke. |
| PROD-02 | Non-destructive Production smoke: login, dashboard/switch, stock/search, Product detail, scan draft/manual fallback, receive draft/attachment UI, ROP, expiry, Attention, vendor, report, PWA assets, logout; do not confirm transactions. | 3 | App surfaces exist. | Production data only read. | Smoke list. | Browser harness needs expansion. | Not yet run in this audit. | MISSING | Live smoke evidence pending; owner session may be required. | After Git deploy, check every accessible surface without writes; log inaccessible authenticated checks as owner acceptance. |
| PROD-03 | Confirm Production target/ref/region, Vercel project/`main`/sin1 integration; deploy only through existing Git integration, wait for Ready, no duplicate `vercel --prod`; inspect final deployment. | 3 | `.vercel` maps existing project; Git branch `main`. | Supabase ref in user prompt. | Existing Production URL. | Build not yet run. | Ready deployment observed before edits; final deploy not done. | PARTIAL | Final commit/push/deploy/Ready evidence pending. | Commit only after all suites pass; push `main`; wait for Git-triggered Ready deployment. |
| PROD-04 | Preserve rollback path: prior Vercel deployment and forward-only DB correction policy; backup/reconciliation evidence before any cutover. | 3 | Git history and Vercel history. | No migration planned currently. | — | — | Previous Ready deployment identified; backup evidence pending. | PARTIAL | Must capture deployment IDs/status and backup evidence; no DB cutover authorized. | Document rollback pointer and any provider backup evidence. |
| PROD-05 | User-provided starting state: 162 Products (90 CHE/72 IMM), types 72/34/23/33, 353 identifiers (162 current REF, 162 manufacturer barcodes, 29 legacy; 138 leading-zero), 100 relations, 28 platforms, zero critical unresolved, one Admin, no operational stock; never import/bootstrap/reset. | 1–3 | Code supports these totals. | User reports existing state. | Read-only inventory views. | Import tests match expected totals. | Exact state not independently reconciled this run. | PARTIAL | Baseline is user-supplied rather than live verified. | Read-only verify counts if target access allows; do not write. |
| GIT-01 | Start from clean `main`, create only logical non-empty commits, push only after tests pass; retain unrelated changes. | All | Starting tree clean at recorded SHA. | — | — | `git diff --check` pending. | Push/deployment not yet done. | PARTIAL | Final commit/push pending. | Keep changes focused; verify status and diff before commits. |
| OWNER-01 | Real iPhone camera acceptance: GS1-128, GS1 DataMatrix, HIBC DataMatrix/Code128, Product resolution, LOT/expiry autofill, Scan again, Receive flow. | 2 | Scanner code exists. | Local scanner evidence. | Device-only flow. | Cannot be proven by desktop automation. | Not tested physically. | OWNER ACCEPTANCE REQUIRED | Requires owner's physical iPhone. | Final state: `REAL IPHONE CAMERA ACCEPTANCE: PENDING OWNER TEST`. |
| OWNER-02 | Real iPhone PWA Add to Home Screen and icon appearance acceptance. | 3 | PWA configuration exists; supplied logo derivatives pending. | — | Install flow requires device. | Desktop manifest tests only. | Not tested physically. | OWNER ACCEPTANCE REQUIRED | Requires owner's iPhone/iOS Home Screen. | Final state: `REAL IPHONE PWA/ICON ACCEPTANCE: PENDING OWNER TEST`. |
| OWNER-03 | If print PDF cannot be generated and visually inspected in browser automation, record `OWNER ACCEPTANCE REQUIRED — PRINT PDF VISUAL`. | 3 | PDF path exists. | — | A4 print page. | PDF generation works; visual inspection absent. | — | PARTIAL | Visual inspect is feasible and still pending. | Generate PDF and inspect rendered pages; only then decide whether owner review remains. |
| DONE-01 | Definition of Done: reconciled 162 products/approved relations with no silent mapping; unique/nonreused codes; two isolated warehouses; append-only nonnegative ledger under concurrency; receive→issue→report; role/RLS/storage; mobile, vendor/report, Chrome/iPhone install, Production verification and rollback evidence. | 1–3 | Features mostly present. | Local DB gates pass. | Main flows present. | Suite gaps and operational gaps remain. | Production smoke/deploy/rollback pending. | PARTIAL | Software and release evidence are incomplete. | Close all software PARTIAL/MISSING rows; leave only owner-only device acceptance and approved deviation. |

## Attached-plan source detail register

These exact source records are included so the aggregate Product Master rows above cannot obscure a row-level decision. They remain tied to the approved workbook SHA in `SRC-07` and are not permission to infer or rewrite source values.

### The 12 original `Used with` review rows (attached plan lines 36–51)

| Trace ID | Sheet / physical row (`No.`) | Product | Original source issue | Initial status | Evidence/action |
|---|---|---|---|---|---|
| SRC-12-01 | Chemistry FOC 16 (`12`) | A1CD | `A1CX4 (hemolysing reagent)` adds descriptive text. | PARTIAL | Verify explicit recorded resolution; preserve raw text. |
| SRC-12-02 | Chemistry FOC 17 (`13`) | START | `ALBT2 (start reagent)` adds descriptive text. | PARTIAL | Verify explicit recorded resolution; preserve raw text. |
| SRC-12-03 | Immunology FOC 5 (`47`) | proBNP II CS | `Used with` adds `(485)` to reagent name. | PARTIAL | Verify explicit recorded resolution; preserve raw text. |
| SRC-12-04 | Immunology FOC 6 (`48`) | Troponin T hs CS | `Used with` adds `(164)` to reagent name. | PARTIAL | Verify explicit recorded resolution; preserve raw text. |
| SRC-12-05 | Immunology FOC 10 (`52`) | FT4 IV CALSET | `FT4 IV E801 (300 TESTS)` differs from reagent name. | PARTIAL | Verify explicit recorded resolution; preserve raw text. |
| SRC-12-06 | Immunology FOC 26 (`68`) | DILUENT UNIVERSAL | proBNP reference adds `(485)`. | PARTIAL | Verify explicit recorded resolution; preserve raw text. |
| SRC-12-07 | Immunology FOC 27 (`69`) | DILUENT MULTI ASSAY | Troponin reference adds `(164)`. | PARTIAL | Verify explicit recorded resolution; preserve raw text. |
| SRC-12-08 | Immunology FOC 34 (`76`) | PRECICONTROL CARDIAC | proBNP reference adds `(485)`. | PARTIAL | Verify explicit recorded resolution; preserve raw text. |
| SRC-12-09 | Immunology FOC 35 (`77`) | PRECICONTROL TROPONIN | Troponin reference adds `(164)`. | PARTIAL | Verify explicit recorded resolution; preserve raw text. |
| SRC-12-10 | Chemistry FOC 41 (`37`) | COBAS SAMPLE CUP | `Used with` is blank. | PARTIAL | Must remain unassigned unless an explicit owner decision exists. |
| SRC-12-11 | Chemistry FOC 42 (`38`) | RD STANDARD FALSE BOTTOM TUBE | `Used with` is blank. | PARTIAL | Must remain unassigned unless an explicit owner decision exists. |
| SRC-12-12 | Immunology FOC 33 (`71`) | PROGESTERONE DILUENT | `Used with` is blank. | PARTIAL | Must remain unassigned unless an explicit owner decision exists. |

### The 29 legacy REF pairs (attached plan lines 28–34)

Each mapping is `current REF ← legacy REF`; the legacy REF identifies the same Product and must not create a new Product or `replacement_for` edge.

| Trace ID | Warehouse / workbook `No.` | Current REF ← legacy REF | Initial status | Evidence/action |
|---|---|---|---|---|
| SRC-11-01 | CHE / 3 | `08056757214 ← 08056757190` | PASS | Verify imported alias points to same Product. |
| SRC-11-02 | CHE / 4 | `08104697214 ← 08104697190` | PASS | Verify imported alias points to same Product. |
| SRC-11-03 | CHE / 5 | `08104719214 ← 08104719190` | PASS | Verify imported alias points to same Product. |
| SRC-11-04 | CHE / 6 | `08058652214 ← 08058652190` | PASS | Verify imported alias points to same Product. |
| SRC-11-05 | CHE / 7 | `08056951214 ← 08056951190` | PASS | Verify imported alias points to same Product. |
| SRC-11-06 | CHE / 8 | `10421436190 ← 08056960190` | PASS | Verify imported alias points to same Product. |
| SRC-11-07 | CHE / 9 | `08057800214 ← 08057800190` | PASS | Verify imported alias points to same Product. |
| SRC-11-08 | CHE / 10 | `08058806214 ← 08058806190` | PASS | Verify imported alias points to same Product. |
| SRC-11-09 | CHE / 11 | `08057524214 ← 08057524190` | PASS | Verify imported alias points to same Product. |
| SRC-11-10 | CHE / 12 | `08057443214 ← 08057443190` | PASS | Verify imported alias points to same Product. |
| SRC-11-11 | CHE / 13 | `08058687214 ← 08058687190` | PASS | Verify imported alias points to same Product. |
| SRC-11-12 | CHE / 14 | `08057877214 ← 08057877190` | PASS | Verify imported alias points to same Product. |
| SRC-11-13 | CHE / 15 | `08057966214 ← 08057966190` | PASS | Verify imported alias points to same Product. |
| SRC-11-14 | CHE / 16 | `04880455214 ← 04880455190` | PASS | Verify imported alias points to same Product. |
| SRC-11-15 | CHE / 17 | `08057494214 ← 08057494190` | PASS | Verify imported alias points to same Product. |
| SRC-11-16 | CHE / 19 | `08056811214 ← 08056811190` | PASS | Verify imported alias points to same Product. |
| SRC-11-17 | CHE / 20 | `08057958214 ← 08057958190` | PASS | Verify imported alias points to same Product. |
| SRC-11-18 | CHE / 21 | `08057460214 ← 08057460190` | PASS | Verify imported alias points to same Product. |
| SRC-11-19 | CHE / 22 | `08057796214 ← 08057796190` | PASS | Verify imported alias points to same Product. |
| SRC-11-20 | CHE / 23 | `08057931214 ← 08057931190` | PASS | Verify imported alias points to same Product. |
| SRC-11-21 | CHE / 24 | `08058776214 ← 08058776190` | PASS | Verify imported alias points to same Product. |
| SRC-11-22 | CHE / 25 | `08058750214 ← 08058750190` | PASS | Verify imported alias points to same Product. |
| SRC-11-23 | CHE / 26 | `08057427214 ← 08057427190` | PASS | Verify imported alias points to same Product. |
| SRC-11-24 | CHE / 27 | `08058016214 ← 08058016190` | PASS | Verify imported alias points to same Product. |
| SRC-11-25 | CHE / 28 | `08058610214 ← 08058610190` | PASS | Verify imported alias points to same Product. |
| SRC-11-26 | CHE / 38 | `09529713190 ← 08056668190` | PASS | Verify imported alias points to same Product. |
| SRC-11-27 | IMM / 48 | `09043284214 ← 09043284190` | PASS | Verify imported alias points to same Product. |
| SRC-11-28 | IMM / 61 | `09015124214 ← 09015124190` | PASS | Verify imported alias points to same Product. |
| SRC-11-29 | IMM / 69 | `07251025214 ← 07251025190` | PASS | Verify imported alias points to same Product. |

### Other explicit workbook evidence to preserve

| Trace ID | Original requirement/evidence | Initial status | Evidence/action |
|---|---|---|---|
| SRC-13-01 | Blank Packing Size: Chemistry FOC 15 `PRECISET TDM I CALIBRATOR`. | PARTIAL | Preserve blank source; separately record any approved active value. |
| SRC-13-02 | Blank Packing Size: Chemistry FOC 42 `RD STANDARD FALSE BOTTOM TUBE`. | PARTIAL | Preserve blank source; separately record any approved active value. |
| SRC-13-03 | Blank Packing Size: Immunology FOC 33 `ELECSYS PROGESTERONE DILUENT`. | PARTIAL | Preserve blank source; separately record any approved active value. |
| SRC-13-04 | HCV Duo PC (Immunology FOC 38) source reads `10 x 1.0 mL, 5 x 2.0 m` and may be truncated. | PARTIAL | Preserve exact source; any accepted value must be an explicit separate decision. |
| SRC-13-05 | Excel `No.` is not a key: numbers overlap between reagent and FOC; 47 and 48 also overlap between FOC sheets. | PARTIAL | Keep physical sheet/row as identity; add explicit duplicate-row report. |
| SRC-13-06 | Immunology No.71 occurs after No.75 in physical order. | PARTIAL | Preserve sheet-row import order; never sort by `No.`. |
| SRC-13-07 | Chemistry FOC 39 name `Reaction Cell c 503 / c513` conflicts with `Used with` `c503 / c703 / ISE`. | PARTIAL | Preserve raw; apply only separately approved exact platform mappings. |
| SRC-13-08 | `STANDARDS HIGH/LOW` is typed Consumable and `ISE INTERNAL STANDARD GEN.2` is on the reagent sheet. | PARTIAL | Preserve source type/sheet; any active correction must retain owner decision evidence. |

## Initial status count

Initial trace entries: 143 (94 grouped software/operational requirements plus 49 exact workbook source records). Initial status counts: `PASS = 43`, `PARTIAL = 94`, `MISSING = 2`, `OWNER ACCEPTANCE REQUIRED = 3`, `APPROVED DEVIATION = 1`. These counts are preserved as the pre-fix audit baseline. Final implementation, tests, Production read-only evidence, external release gates, and owner-only acceptance are recorded in the final closure traceability below.
## Final closure traceability (updated 2026-09-25)

All 143 original trace IDs are repeated below with their closure disposition. The full original requirement text remains in the initial traceability tables above. The owner's no-Preview architecture and the non-destructive Production transaction boundary are explicit approved deviations. Current counts: **PASS = 132; BLOCKED = 0; OWNER ACCEPTANCE REQUIRED = 9; APPROVED DEVIATION = 2; PARTIAL = 0; MISSING = 0.** The 9 gates were individually reclassified below; Production-only evidence is now treated as post-deployment evidence, and unresolved human evidence remains `OWNER ACCEPTANCE REQUIRED`.

### Evidence register

- **E0 — Authoritative baseline:** attached PLAN CI.md was read in full and compared with the repository plan; both hashes and every material difference are recorded at the top of this document. The attached plan controls the closure baseline.
- **E1 — Local implementation and verification:** final closure-source verification in an isolated worktree: `npm test` 35/35; `npm run test:import` 4/4; disposable PostgreSQL 25/25; local Auth 17/17; local Storage 1/1; authenticated E2E 1/1; typecheck and lint passed; `npm audit --omit=dev` 0 vulnerabilities; production build passed; `git diff --check` passed. The current attachment-upload change has a red/green E2E regression: before the fix the new assertion failed on a real duplicate GoTrue warning; after the singleton fix it passed. The generated two-page report PDF was opened in Chrome's PDF viewer and visually inspected; content, Thai glyphs, table widths, and page breaks were legible without clipping.
- **E2 — Correct Production target and read-only checks:** Chrome profile LabchemCBH; Supabase project nivlnbaveanoawfbrmzz, region ap-southeast-1; Vercel team nics-s-world, project chem-immuno-qms, domain chem-immuno-cbh.vercel.app. Existing deployment was Ready on main at 4e3fc3910402ceaef324bba289679f6c1713049e. Earlier authenticated read-only UI checks covered CHE/IMM dashboards (90/72 Products), stock, REF search, Product detail, scan, receive, reorder, attention, vendors, and monthly report without visible errors. Read-only aggregates before and after the dispatcher migration confirmed 162 active Products; type counts 72/34/23/33; 162 current REF, 162 manufacturer barcodes, 29 same-Product legacy REF, 138 leading-zero current REF; 100 relations, 28 platform mappings; 20 resolved review rows, two explicitly unassigned, zero critical open; one active Admin; zero stock transactions. Private invoice evidence bucket: 10 MiB, JPEG/PNG/HEIC/PDF. These are not post-deployment checks for the current source.
- **E3 — Workbook/source decisions:** docs/import-audit.md, approved workbook fixture/hash tests, immutable Production resolution rows, and source-level trace rows SRC-11-*, SRC-12-*, SRC-13-*. The 12 original Used with rows remain represented; ten have explicit owner decisions and two remain explicitly unassigned. Production SELECT for Reaction Cell REF 07700814001 returned only c503 and c513, retaining source text cobas pro c503 / c703 / ISE as provenance. No fuzzy mapping or source rewrite occurred.
- **E4 — Approved visual identity:** user-provided icon is the master artwork; generated favicon, Apple touch icon, PWA and maskable assets are covered by PWA tests and visual inspection.
- **E5 — Production migration and logical backups:** exact target ref `nivlnbaveanoawfbrmzz`; one pending migration appeared in the linked dry run and was applied after backup/target checks. The read-only migration-ledger and function-grant query confirmed it applied; read-only aggregates remained unchanged. Both external pre/post snapshot manifests and all 12 artifact hashes/byte sizes verified. See `docs/operations-runbook.md` for paths, hashes, coverage, limitations, and the untested restore procedure. The plan requires backup/reconciliation, not a Supabase-managed backup service; logical-backup evidence passes that requirement. Supabase-managed backup status, separate cluster-role dump, Storage object bytes, and restore rehearsal are recorded as limitations.
- **G1 — Historical pre-deployment snapshot (2026-09-24):** this records the state before the continuation audit. Its nine `BLOCKED — EXTERNAL RELEASE GATE` rows are superseded by G2, G3, and the reclassification table below; they are not current dispositions.
- **G2 — Production deployment and public response verification (2026-09-24/25):** Vercel account `labchemcbh-2058`, team `nics-s-world`, project `chem-immuno-qms`; deployment `dpl_8tZRxRWrxNczUGdgU87sjt9p8XFt` is `READY`, target `production`, aliases include `chem-immuno-cbh.vercel.app`, and function region includes `sin1`. GitHub's Vercel status for commit `a70f73b149919d5c00c197bf780689cd191d177a` completed successfully. Production returned HTTP 200 for the login page, manifest, favicon, Apple Touch Icon, 192, 512, and maskable icon. All six downloaded branding assets have SHA-256 values matching the current repository files. Manifest name/short name are `CHEM-IMMUNO CBH`, display is `standalone`, and it lists the required `192x192`, `512x512`, and `maskable` icons. CSP includes only the confirmed Supabase origin; HSTS, X-Frame-Options, nosniff, Referrer-Policy, and Permissions-Policy are present. A headless Chrome GET of the login page produced no CSP violations, failed resources, console errors, or page errors; all page scripts and CSS returned 200. Vercel runtime logs for this deployment showed 0 error-level entries and 0 5xx in the queried one-hour window. Five anonymous login GETs measured 158–265 ms (median 171 ms); the cold headless login render measured DCL/load/FCP at about 1.98/1.98/2.03 s. These are anonymous login measurements only; authenticated shell/dashboard timings were not collected.
- **G3 — Production database and direct security verification (2026-09-25):** linked read-only queries ran against project `nivlnbaveanoawfbrmzz`, PostgreSQL 17.6. Inventory reconciled to 162 active Products (warehouse 1/CHE 90, warehouse 2/IMM 72), product types 72/34/23/33, 353 identifiers, 100 Product relations, 28 platform mappings, 0 critical unresolved reviews, and 0 stock transactions. All 32 `public.ci_*` tables had RLS enabled; no `ci_*` table was missing RLS, and 31 authenticated read policies were present with warehouse/role predicates. Production catalog checks found 39 `ci_private` SECURITY DEFINER implementations, all with `search_path=""`, and 39 contract-matched public SECURITY INVOKER wrappers, all with empty search paths; authenticated/service-role/anon grants matched across all 39 pairs, and anon had no execution. The 42 public `ci_*` routines were all invokers with empty search paths and no anon execution; the three additional report/search routines were also invokers with the same protection. `anon` had no `ci_private` schema USAGE; `authenticated` and `service_role` did. The authenticated USAGE grant supports RLS helper calls and invoker dispatch; it makes the Production Data API Exposed Schemas setting material. The application reads `SUPABASE_SERVICE_ROLE_KEY` only in `src/lib/supabase/admin.ts`, which imports `server-only`; no client module references the service-role key. The repository's explicit API allowlist and regression test exclude `ci_private`, while the hosted `pgrst.db_schemas` value is not surfaced by PostgreSQL (`current_setting` and role overrides were empty). The account UI bridge failed, so the hosted Dashboard Exposed Schemas value still requires owner confirmation that `ci_private` is absent. No security defect was observed in the direct catalog/RLS checks. Supabase Advisor remained unavailable from the connected tooling after the reported pooler/circuit-breaker issue; this is recorded as **advisor observability unavailable**, not as a security defect or a positive Advisor result.
- **G4 — Fresh local verification (2026-09-25):** `npm test` 35/35; `npm run test:import` 4/4; disposable PostgreSQL `scripts/db/test.ps1` 25/25; local Auth 17/17; local Storage 1/1; local authenticated E2E 1/1; typecheck, lint, `npm audit --omit=dev` (0 vulnerabilities), and production build passed. A direct `npm run test:db` without its required disposable DB runner failed before tests because `CI_TEST_DATABASE_URL` was unset; the documented runner then passed all 25 DB tests.
- **M1 — Production migration warning:** `supabase/migrations/20260924133953_ci_private_rpc_dispatchers.sql:1` contains the migration's only `SET LOCAL`, `set local search_path = '';`. The reported warning therefore came from that statement. PostgreSQL documents `SET LOCAL` as transaction-scoped; outside a transaction block it warns and has no effect ([PostgreSQL SET](https://www.postgresql.org/docs/current/sql-set.html)). The migration's runtime RPC protections do not depend on that session setting: each of the 39 moved Production implementations has a function-level empty `search_path`, each of the 39 public wrappers is `SECURITY INVOKER` with its own empty `search_path`, and all role grants match across pairs (G3). The migration uses schema-qualified catalog/implementation references and an explicitly temporary table. No corrective migration is required; the already-applied migration was not edited. Supabase's guidance also recommends empty function search paths and schema-qualified names for definer routines ([Supabase Database Functions](https://supabase.com/docs/guides/database/functions)).
- **O1 — Owner device acceptance:** physical iPhone camera scanning (GS1/HIBC, LOT/expiry, repeat scan, receive) and iPhone Add to Home Screen/icon appearance remain pending owner testing.
- **O2 — Owner authenticated Production evidence:** the Windows native browser helper returned `native pipe is unavailable: The system cannot find the file specified` after retry/reset; the managed Chrome tab connector returned an internal error; and a fresh computer-use reconnection timed out after 30 seconds. No credentials were read or entered. Owner evidence is still required for the Production Data API Exposed Schemas value (`ci_private` must be absent), current authenticated non-destructive smoke/logout/warehouse switch, and authenticated shell/dashboard timing. These are not marked PASS.
- **D2 — Approved architecture deviation:** the owner explicitly chose disposable local PostgreSQL → Production Supabase → Production Vercel, with no persistent Preview/Staging. Preview-only wording is superseded; no Preview credentials or project are to be created. Local tests/build plus guarded Production verification replace that environment gate.
- **D1 — Approved deviation:** the attached plan's Production transaction scenarios were not run because the user explicitly required non-destructive Production verification. No Production invoice/receipt/issue/count/adjustment/reversal/disposal or stock mutation was created.

### Release-gate timing and current disposition

Each of the nine gates below requires or includes evidence generated by an active Production deployment. None was used as a reason to prevent the deployment that generates that evidence. A pending owner-evidence row is not recorded as a software defect or silently marked PASS.

**Release accounting:** `PRE-DEPLOY BLOCKERS = 0`; `KNOWN POST-DEPLOY SOFTWARE BLOCKERS = 0`; `PARTIAL = 0`; `MISSING = 0`. Of the nine post-deploy gates, four have PASS evidence and five remain `OWNER ACCEPTANCE REQUIRED` because authenticated owner-session evidence is unavailable here. These five are open owner verifications, not completed gates; this counter does not convert them to PASS. The separate physical-device acceptances remain pending in O1.

| Gate | Classification | Current evidence / disposition |
|---|---|---|
| PWA-03 | POST-DEPLOY VERIFICATION GATE | PASS — Production manifest and all six icon assets returned 200 and match repository hashes; G2. |
| PH-03 | POST-DEPLOY VERIFICATION GATE | OWNER ACCEPTANCE REQUIRED — deployed software evidence is in G2/G4; physical iPhone install remains O1 and authenticated Production smoke remains O2. |
| PERF-01 | POST-DEPLOY VERIFICATION GATE | OWNER ACCEPTANCE REQUIRED — anonymous login timings are recorded in G2; authenticated shell/dashboard timings require O2. |
| SEC-03 | POST-DEPLOY VERIFICATION GATE | OWNER ACCEPTANCE REQUIRED — Production RLS/RPC/search-path/grants are directly checked in G3; confirm the hosted Exposed Schemas setting omits `ci_private` under O2. Advisor limitation is separate and is not a known defect. |
| OPS-01 | POST-DEPLOY VERIFICATION GATE | PASS — current deployment error-level and 5xx logs were both zero in the one-hour query window; backup artifacts/runbook are E5. |
| PROD-02 | POST-DEPLOY VERIFICATION GATE | OWNER ACCEPTANCE REQUIRED — authenticated Production smoke cannot be completed without the LabchemCBH browser session; see O2. No confirmed stock transaction was created. |
| PROD-03 | POST-DEPLOY VERIFICATION GATE | PASS — exact project/team, Production target, `main` commit status, `READY`, alias, and `sin1` verified in G2. |
| GIT-01 | POST-DEPLOY VERIFICATION GATE | PASS — `main` is pushed without force; the source release SHA and successful Vercel commit status are recorded in G2. |
| DONE-01 | POST-DEPLOY VERIFICATION GATE | OWNER ACCEPTANCE REQUIRED — all software-fixable rows have a disposition; the remaining human evidence is listed in O1/O2. |

### Final status by requirement ID

| Requirement ID | Final status | Evidence |
|---|---|---|
| SRC-01 | PASS | E0 |
| SRC-02 | PASS | E1 / E2 |
| SRC-03 | PASS | E1 / E2 |
| SRC-04 | PASS | E1 / E2 |
| SRC-05 | PASS | E1 |
| SRC-06 | PASS | E1 |
| SRC-07 | PASS | E2 / E3 |
| SRC-08 | PASS | E2 / E3 |
| SRC-09 | PASS | E2 / E3 |
| SRC-10 | PASS | E2 / E3 |
| SRC-11 | PASS | E2 / E3 |
| SRC-12 | PASS | E2 / E3 |
| SRC-13 | PASS | E2 / E3 |
| SRC-14 | PASS | E2 / E3 |
| PM-01 | PASS | E1 / E2 |
| PM-02 | PASS | E1 / E2 |
| PM-03 | PASS | E1 / E2 |
| PM-04 | PASS | E1 / E2 |
| PM-05 | PASS | E1 / E2 |
| REL-01 | PASS | E1 / E2 |
| REL-02 | PASS | E1 / E2 |
| REL-03 | PASS | E1 / E2 |
| WH-01 | PASS | E1 / E2 |
| AUTH-01 | PASS | E1 / E2 |
| AUTH-02 | PASS | E1 / E2 |
| LED-01 | PASS | E1 / E2 |
| LED-02 | PASS | E1 / E2 |
| REC-01 | PASS | E1 / E2 |
| REC-02 | PASS | E1 / E2 |
| REC-03 | PASS | E1 / E2 |
| PHOTO-01 | PASS | E1 / E2 |
| BAR-01 | PASS | E1 / E2 |
| BAR-02 | PASS | E1 / E2 |
| BAR-03 | PASS | E1 / E2 |
| SCAN-01 | PASS | E1 / E2 |
| SCAN-02 | PASS | E1 / E2 |
| ISSUE-01 | PASS | E1 / E2 |
| ISSUE-02 | PASS | E1 / E2 |
| MOVE-01 | PASS | E1 / E2 |
| MOVE-02 | PASS | E1 / E2 |
| COUNT-01 | PASS | E1 / E2 |
| DISP-01 | PASS | E1 / E2 |
| ROP-01 | PASS | E1 / E2 |
| ROP-02 | PASS | E1 / E2 |
| ROP-03 | PASS | E1 / E2 |
| EXP-01 | PASS | E1 / E2 |
| VEND-01 | PASS | E1 / E2 |
| VEND-02 | PASS | E1 / E2 |
| ATT-01 | PASS | E1 / E2 |
| ATT-02 | PASS | E1 / E2 |
| DASH-01 | PASS | E1 / E2 |
| SEARCH-01 | PASS | E1 / E2 |
| DETAIL-01 | PASS | E1 / E2 |
| UX-01 | PASS | E1 / E2 |
| REPORT-01 | PASS | E1 / E2 |
| REPORT-02 | PASS | E1 / E2 |
| PWA-01 | PASS | E1 / E4 |
| PWA-02 | PASS | E1 / E4 |
| PWA-03 | PASS | G2 |
| DB-01 | PASS | E1 |
| DB-02 | PASS | E1 |
| SEC-01 | PASS | E1 |
| SEC-02 | PASS | E1 |
| AUD-01 | PASS | E1 |
| IMP-01 | PASS | E1 |
| IMP-02 | PASS | E1 |
| MIG-01 | APPROVED DEVIATION | D2 / E5 |
| PH-01 | PASS | E1 |
| PH-02 | OWNER ACCEPTANCE REQUIRED | O1 |
| PH-03 | OWNER ACCEPTANCE REQUIRED | G2 / G4 / O1 / O2 |
| PH-04 | PASS | E1 / E5 |
| TEST-01 | PASS | E1 |
| TEST-02 | PASS | E1 |
| TEST-03 | PASS | E1 |
| TEST-04 | PASS | E1 |
| TEST-05 | PASS | E1 |
| TEST-06 | OWNER ACCEPTANCE REQUIRED | O1 |
| TEST-07 | PASS | E1 |
| TEST-08 | PASS | E1 |
| A11Y-01 | PASS | E1 |
| PERF-01 | OWNER ACCEPTANCE REQUIRED | G2 / O2 |
| SEC-03 | OWNER ACCEPTANCE REQUIRED | G3 / O2 |
| OPS-01 | PASS | E5 / G2 |
| OPS-02 | PASS | E5 |
| PROD-01 | APPROVED DEVIATION | D1 |
| PROD-02 | OWNER ACCEPTANCE REQUIRED | G2 / O2 |
| PROD-03 | PASS | G2 |
| PROD-04 | PASS | E2 / E5 |
| PROD-05 | PASS | E1 / E2 |
| GIT-01 | PASS | G2 |
| OWNER-01 | OWNER ACCEPTANCE REQUIRED | O1 |
| OWNER-02 | OWNER ACCEPTANCE REQUIRED | O1 |
| OWNER-03 | PASS | E1 |
| DONE-01 | OWNER ACCEPTANCE REQUIRED | O1 / O2 / G4 |
| SRC-12-01 | PASS | E3 |
| SRC-12-02 | PASS | E3 |
| SRC-12-03 | PASS | E3 |
| SRC-12-04 | PASS | E3 |
| SRC-12-05 | PASS | E3 |
| SRC-12-06 | PASS | E3 |
| SRC-12-07 | PASS | E3 |
| SRC-12-08 | PASS | E3 |
| SRC-12-09 | PASS | E3 |
| SRC-12-10 | PASS | E3 |
| SRC-12-11 | PASS | E3 |
| SRC-12-12 | PASS | E3 |
| SRC-11-01 | PASS | E3 |
| SRC-11-02 | PASS | E3 |
| SRC-11-03 | PASS | E3 |
| SRC-11-04 | PASS | E3 |
| SRC-11-05 | PASS | E3 |
| SRC-11-06 | PASS | E3 |
| SRC-11-07 | PASS | E3 |
| SRC-11-08 | PASS | E3 |
| SRC-11-09 | PASS | E3 |
| SRC-11-10 | PASS | E3 |
| SRC-11-11 | PASS | E3 |
| SRC-11-12 | PASS | E3 |
| SRC-11-13 | PASS | E3 |
| SRC-11-14 | PASS | E3 |
| SRC-11-15 | PASS | E3 |
| SRC-11-16 | PASS | E3 |
| SRC-11-17 | PASS | E3 |
| SRC-11-18 | PASS | E3 |
| SRC-11-19 | PASS | E3 |
| SRC-11-20 | PASS | E3 |
| SRC-11-21 | PASS | E3 |
| SRC-11-22 | PASS | E3 |
| SRC-11-23 | PASS | E3 |
| SRC-11-24 | PASS | E3 |
| SRC-11-25 | PASS | E3 |
| SRC-11-26 | PASS | E3 |
| SRC-11-27 | PASS | E3 |
| SRC-11-28 | PASS | E3 |
| SRC-11-29 | PASS | E3 |
| SRC-13-01 | PASS | E3 |
| SRC-13-02 | PASS | E3 |
| SRC-13-03 | PASS | E3 |
| SRC-13-04 | PASS | E3 |
| SRC-13-05 | PASS | E3 |
| SRC-13-06 | PASS | E3 |
| SRC-13-07 | PASS | E3 |
| SRC-13-08 | PASS | E3 |
