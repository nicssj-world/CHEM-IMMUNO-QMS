# Approved initial Product Master workbook

The only initial Product Master and relationship source is
`NEW Summary_72 items + FOC_Chonburi_revised 2026_20092026.xlsx`.
The CI fixture at `tests/import/fixtures/` is byte-identical to the supplied
file (SHA-256 `5DC4FEA985E8A262177E96F317BB56D1A0E0F5DDFE660EB2E75005DE355B788C`).
The importer rejects any other filename or content hash. Excel `No.` is kept
only in the raw row snapshot; physical row order determines import order.
The approved parser payload has PostgreSQL `md5(payload::jsonb::text)` value
`bfa324897a22a374013ee6323eed0bf7`; the stage RPC pins this versioned
fingerprint as an additional check against altered product/review content.

Run `npm run import:audit -- "tests/import/fixtures/NEW Summary_72 items + FOC_Chonburi_revised 2026_20092026.xlsx"`
to reproduce the audit. `--json` prints the full stage preview and `--out
<new-path>` writes the stage RPC payload without overwriting an existing file.
The command never connects to a database.

| Evidence | Confirmed value |
|---|---:|
| Products | 162 |
| Chemistry | 90 (42 reagent, 11 calibrator, 10 control, 27 consumable) |
| Immunology | 72 (30 reagent, 21 calibrator, 13 control, 8 consumable) |
| Unique current REF / manufacturer barcode | 162 / 162 |
| Legacy REF aliases | 29 |
| Current REF with a leading zero | 138 |
| Exact Product → Product relations | 90 (60 Chemistry, 30 Immunology) |
| Product → Platform source rows | 27 |
| Unresolved `Used with` rows | 12 |
| Other source anomaly review items | 8 |

The 27 platform assertions contain 20 group references to `c503/c703/ISE`,
2 to `ISE neo`, 1 to `c703`, and 4 to `e801`. A group reference stays one
source assertion. It is not expanded into individual analyzer compatibility.

All 12 `Used with` review rows remain unlinked: Chemistry FOC physical rows
16, 17, 41, 42 and Immunology FOC rows 5, 6, 10, 26, 27, 33, 34, 35.
The eight further review items are three blank packing sizes, the truncated
HCV Duo PC packing text, the Reaction Cell c503/c513 versus `Used with`
conflict, two `STANDARDS` typed consumable, and ISE INTERNAL STANDARD typed
reagent. Source values remain unchanged while those questions are reviewed.

The parser returns a `ci_stage_import_batch` payload with product row snapshots,
identifier text, exact product relations, platform source assertions, and
review items. Staging can store this preview. `ci_apply_import_batch` must
require every critical review item to be resolved with actor, notes, and
explicit mapping data as applicable; unresolved rows never become relations
by approximate matching. Apply performs one database transaction and
reconciles source counts before any Product Master becomes active.
