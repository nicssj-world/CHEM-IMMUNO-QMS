import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  APPROVED_WORKBOOK_FILENAME,
  APPROVED_WORKBOOK_SHA256,
  assertImportReadyForActivation,
  previewApprovedWorkbook,
  WorkbookValidationError,
} from "../../src/lib/import/approved-workbook";

const workbookPath = join(process.cwd(), "tests", "import", "fixtures", APPROVED_WORKBOOK_FILENAME);
const readApproved = () => readFile(workbookPath);

test("approved workbook gives exact product, identifier, and warehouse audit", async () => {
  const { audit, payload } = await previewApprovedWorkbook(await readApproved());
  assert.equal(audit.source_sha256, APPROVED_WORKBOOK_SHA256);
  assert.equal(audit.product_count, 162);
  assert.deepEqual(audit.warehouse_counts, { CHE: 90, IMM: 72 });
  assert.deepEqual(audit.type_counts, { reagent: 72, calibrator: 32, control: 23, consumable: 35 });
  assert.deepEqual(audit.source_type_counts, { reagent: 72, calibrator: 32, control: 23, consumable: 35 });
  assert.deepEqual(audit.approved_type_counts, { reagent: 72, calibrator: 34, control: 23, consumable: 33 });
  assert.deepEqual(audit.warehouse_type_counts, {
    CHE: { reagent: 42, calibrator: 11, control: 10, consumable: 27 },
    IMM: { reagent: 30, calibrator: 21, control: 13, consumable: 8 },
  });
  assert.equal(audit.ref_current_unique_count, 162);
  assert.equal(audit.manufacturer_barcode_unique_count, 162);
  assert.equal(audit.legacy_ref_count, 29);
  assert.equal(audit.leading_zero_ref_count, 138);
  assert.equal(payload.products[0].ref_current, "08056692190");
  assert.equal(payload.products[0].manufacturer_barcode, "101002426");
  assert.equal(payload.products[0].raw_source.no, 1);
  assert.equal(payload.products[42].source_sheet, "FOC item_chem c503 c703 ISE");
  assert.equal(payload.products[90].ref_current, "09315284214");
  assert.equal(payload.products[120].source_sheet, "FOC item_Imm e801");
  assert.equal(payload.products.find((p) => p.ref_current === "08056757214")?.legacy_ref, "08056757190");
  assert.equal(payload.products.find((p) => p.ref_current === "09043284214")?.legacy_ref, "09043284190");
  assert.equal(payload.products.some((p) => p.ref_current === "08056757190"), false);
});

test("source assertions and owner resolutions remain separate and exact", async () => {
  const { audit, payload } = await previewApprovedWorkbook(await readApproved());
  assert.equal(audit.product_relation_count, 90);
  assert.equal(audit.source_product_relation_count, 90);
  assert.equal(audit.owner_approved_product_relation_count, 10);
  assert.equal(audit.active_product_relation_count, 100);
  assert.equal(audit.platform_source_row_count, 27);
  assert.equal(audit.owner_platform_override_count, 1);
  assert.equal(audit.active_product_platform_mapping_count, 28);
  assert.equal(audit.used_with_review_row_count, 12);
  assert.equal(audit.source_anomaly_review_count, 8);
  assert.equal(payload.product_relations.filter((r) => r.source_sheet.startsWith("FOC item_chem")).length, 60);
  assert.equal(payload.product_relations.filter((r) => r.source_sheet.startsWith("FOC item_Imm")).length, 30);
  assert.deepEqual(
    Object.fromEntries(
      ["c503_c703_ise", "ise_neo", "c703", "e801"].map((key) =>
        [key, payload.platform_relations.filter((r) => r.platform_key === key).length],
      ),
    ),
    { c503_c703_ise: 20, ise_neo: 2, c703: 1, e801: 4 },
  );
  const reviewRows = payload.review_items
    .filter((item) => item.kind === "used_with")
    .map((item) => `${item.source_sheet}!${item.source_row}`);
  assert.deepEqual(reviewRows, [
    "FOC item_chem c503 c703 ISE!16",
    "FOC item_chem c503 c703 ISE!17",
    "FOC item_chem c503 c703 ISE!41",
    "FOC item_chem c503 c703 ISE!42",
    "FOC item_Imm e801!5",
    "FOC item_Imm e801!6",
    "FOC item_Imm e801!10",
    "FOC item_Imm e801!26",
    "FOC item_Imm e801!27",
    "FOC item_Imm e801!33",
    "FOC item_Imm e801!34",
    "FOC item_Imm e801!35",
  ]);
  for (const reviewRow of reviewRows) {
    assert.equal(payload.product_relations.some((r) => `${r.source_sheet}!${r.source_row}` === reviewRow), false);
    assert.equal(payload.platform_relations.some((r) => `${r.source_sheet}!${r.source_row}` === reviewRow), false);
  }
  assert.equal(payload.product_relations.some((r) => String(r.relation_type) === "replacement_for"), false);
  assert.equal(payload.products.some((p) => "gtin" in p), false);
  assert.equal(payload.resolution_manifest.entries.length, 20);
  assert.equal(audit.unresolved_critical_review_count, 0);
  assert.equal(audit.activation_blocked, false);

  const relationshipResolutions = payload.resolution_manifest.entries.filter(
    (entry) => entry.approved_decision.kind === "product_relationship",
  );
  assert.equal(relationshipResolutions.length, 10);
  assert.deepEqual(
    relationshipResolutions.find((entry) => entry.review_id === "REL-01")?.approved_decision,
    {
      kind: "product_relationship",
      source_ref_current: "09529713190",
      target_ref_current: "08463107190",
      relation_type: "uses_consumable",
    },
  );
  assert.deepEqual(
    relationshipResolutions.find((entry) => entry.review_id === "REL-10")?.approved_decision,
    {
      kind: "product_relationship",
      source_ref_current: "07027699214",
      target_ref_current: "09762582190",
      relation_type: "uses_consumable",
    },
  );
  for (const reviewId of ["REL-03", "REL-04"]) {
    const unassigned = payload.resolution_manifest.entries.find((entry) => entry.review_id === reviewId);
    assert.equal(unassigned?.resolution_type, "owner-unassigned");
    assert.deepEqual(unassigned?.approved_decision, { kind: "unassigned" });
    assert.equal(relationshipResolutions.some((entry) => entry.review_id === reviewId), false);
  }
  for (const entry of payload.resolution_manifest.entries) {
    assert.equal(entry.source_sha256, APPROVED_WORKBOOK_SHA256);
    assert.ok(entry.source_product_ref);
    assert.ok(Object.hasOwn(entry, "raw_source_value"));
  }
});

test("approved corrections keep source values, resolve every review, and do not block activation", async () => {
  const { audit, payload } = await previewApprovedWorkbook(await readApproved());
  assert.equal(payload.review_items.length, 20);
  assert.ok(payload.review_items.every((item) => item.critical));
  assert.equal(payload.review_items.filter((item) => item.kind === "missing_packing").length, 3);
  assert.equal(payload.review_items.filter((item) => item.kind === "truncated_packing").length, 1);
  assert.equal(payload.review_items.filter((item) => item.kind === "platform_name_conflict").length, 1);
  assert.equal(payload.review_items.filter((item) => item.kind === "source_type_question").length, 3);
  const hcv = payload.products.find((p) => p.ref_current === "08335923190");
  assert.equal(hcv?.packing_size_raw,
    "10 x 1.0 mL, 5 x 2.0 mL");
  assert.equal(hcv?.raw_source.packing_size,
    "10  x  1.0  mL,  5  x  2.0  m");
  assert.equal(payload.products.find((p) => p.ref_current === "03375790190")?.packing_size_raw,
    "6 x 5 mL calibrator + 1 x 10 mL diluent");
  assert.equal(payload.products.find((p) => p.ref_current === "04740955001")?.packing_size_raw,
    "2 x 1000 pcs");
  assert.equal(payload.products.find((p) => p.ref_current === "09762582190")?.packing_size_raw,
    "2 x 22 mL");
  assert.equal(payload.products.find((p) => p.ref_current === "11183982216")?.product_type, "calibrator");
  assert.equal(payload.products.find((p) => p.ref_current === "11183974216")?.product_type, "calibrator");
  assert.equal(payload.products.find((p) => p.ref_current === "11183982216")?.source_product_type, "consumable");
  assert.equal(payload.products.find((p) => p.ref_current === "11183982216")?.raw_source.type, "Consumable");
  assert.equal(payload.products.find((p) => p.ref_current === "04880455214")?.product_type, "reagent");
  const reactionCell = payload.resolution_manifest.entries.find((entry) => entry.review_id === "PM-05");
  assert.equal(reactionCell?.raw_source_value, "cobas pro c503 / c703 / ISE");
  assert.deepEqual(reactionCell?.platform_keys, ["c503", "c513"]);
  assert.equal(audit.activation_blocked, false);
  assert.doesNotThrow(() => assertImportReadyForActivation(audit));
});

test("changed bytes and wrong filename fail before parsing or staging", async () => {
  const bytes = await readApproved();
  await assert.rejects(previewApprovedWorkbook(bytes, "older.xlsx"), WorkbookValidationError);
  const changed = Buffer.from(bytes);
  changed[100] ^= 0x01;
  await assert.rejects(previewApprovedWorkbook(changed), /SHA-256 mismatch/);
});
