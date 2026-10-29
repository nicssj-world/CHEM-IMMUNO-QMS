# Approved initial Product Master source and owner resolutions

The only initial Product Master and relationship source is
`NEW Summary_72 items + FOC_Chonburi_revised 2026_20092026.xlsx`. The tracked
CI fixture is byte-identical to the supplied file (SHA-256
`5DC4FEA985E8A262177E96F317BB56D1A0E0F5DDFE660EB2E75005DE355B788C`). The
importer rejects any other filename or content hash. Excel `No.` remains raw
provenance only; physical sheet row order determines import order.

The source-only parser audit remains 90 Product → Product edges, 27 platform
assertion rows, and 12 `Used with` review rows. The resolution-aware payload has
PostgreSQL `md5(payload::jsonb::text)` value
`1ae84724264bc1e621aac722083732f2`; forward migration
`20260923122232_ci_owner_approved_product_resolutions.sql` pins this complete
payload fingerprint. The earlier source-only payload fingerprint
`bfa324897a22a374013ee6323eed0bf7` is historical and remains in the original
migration.

Run `npm run import:audit -- "tests/import/fixtures/NEW Summary_72 items + FOC_Chonburi_revised 2026_20092026.xlsx"`
to reproduce the audit. `--json` prints the full preview and `--out
<new-path>` writes a payload without overwriting an existing file. The command
never connects to a database.

| Evidence | Workbook source | Approved active import |
|---|---:|---:|
| Products | 162 | 162 |
| Chemistry | 90 | 90 |
| Immunology | 72 | 72 |
| Reagent | 72 | 72 |
| Calibrator | 32 | 34 |
| Control | 23 | 23 |
| Consumable | 35 | 33 |
| Unique current REF / manufacturer barcode | 162 / 162 | 162 / 162 |
| Legacy REF aliases | 29 | 29 |
| Current REF with a leading zero | 138 | 138 |
| Product → Product relations | 90 source-confirmed | 10 owner-resolved; 100 active total |
| Product → Platform | 27 source rows | 1 product override; 28 active mappings |
| `Used with` review rows | 12 source rows | 10 explicit relationships, 2 explicitly unassigned |
| Review evidence | 20 rows retained | 20 decisions recorded; 0 critical open |

Source type counts by warehouse are Chemistry 42 reagent, 11 calibrator,
10 control, 27 consumable; Immunology 30 reagent, 21 calibrator, 13 control,
8 consumable. Active approved counts are Chemistry 42 reagent, 13 calibrator,
10 control, 25 consumable; Immunology is unchanged.

The 27 source platform assertions contain 20 references to the source group
`c503/c703/ISE`, 2 to `ISE neo`, 1 to `c703`, and 4 to `e801`. Group assertions
remain source evidence and are never expanded. The owner override for Reaction
Cell REF `07700814001` creates only `c503` and `c513` mappings; the original
`cobas pro c503 / c703 / ISE` Used-with text remains in the source snapshot and
active mapping provenance.

The verified resolution manifest contains REL-01 through REL-12 and PM-01
through PM-08, each keyed to the workbook hash, sheet, physical row, source
Product REF, raw value, decision, and resolution type. REL-03 and REL-04 remain
unassigned by explicit decision. REL-10 is an owner-manual relationship because
its workbook Used-with cell is blank. PM-01 through PM-04 retain original blank
or truncated Packing Size values alongside approved current values; PM-06 and
PM-07 retain source Type `Consumable` alongside approved active type
`calibrator`. PM-08 records the confirmed reagent classification without an
override.

## Source anomaly register

These values remain visible in `npm run import:audit` output and in each raw
import snapshot. Approved active values are separate resolution evidence; the
source row is never rewritten.

| Source anomaly | Workbook evidence retained |
|---|---|
| Non-unique Excel `No.` | Numbering overlaps between reagent and FOC sheets. Chemistry and Immunology FOC `No.` 47 and 48 also repeat across the two FOC sheets. Physical sheet and row, not `No.`, identify a record. |
| Non-sequential Excel `No.` | Immunology FOC `No. 71` occurs after `No. 75`; import order follows physical row order. |
| Blank Packing Size | Chemistry FOC 15 `PRECISET TDM I CALIBRATOR`; Chemistry FOC 42 `RD STANDARD FALSE BOTTOM TUBE`; Immunology FOC 33 `ELECSYS PROGESTERONE DILUENT`. |
| Possibly truncated Packing Size | Immunology FOC 38 `HCV Duo PC`: `10 x 1.0 mL, 5 x 2.0 m`. |
| Platform name conflict | Chemistry FOC 39 source Product `Reaction Cell c 503 / c513`; source `Used with` says `c503 / c703 / ISE`. The owner-approved active override maps only `c503` and `c513`; raw values remain unchanged. |
| Source type questions | `STANDARDS HIGH/LOW` is source type `Consumable`; `ISE INTERNAL STANDARD GEN.2` is on the reagent sheet. Active corrections/confirmations remain separately identified as PM resolutions. |
| Unresolved source wording | All 12 original `Used with` rows remain review evidence. Exact sheets, physical rows, source values, and decisions are indexed in `docs/CHEM-IMMUNO-CBH-PLAN-CLOSURE-MATRIX.md` under SRC-12-01..12. |

The audit JSON `notes` field also calls out the reagent/FOC numbering overlap,
duplicate FOC `No.` 47/48, and the out-of-order Immunology `No. 71` so the
numbering risks appear in the reproducible import report rather than only in
phase notes.

Staging preserves the entire raw row and writes an immutable resolution event
with the authenticated recorder and database timestamp. Review rows keep their
original critical-source marker but receive their resolved state and decision;
unresolved critical count is calculated from critical rows still open. Apply
creates Products, identifiers, the 90 source relations, 10 owner relations,
and platform mappings in one transaction. Exact REF/type/warehouse validation
is required; fuzzy linking is not used.
