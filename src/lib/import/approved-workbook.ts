import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import type {
  ImportPreview,
  ImportProduct,
  ImportProductRelation,
  ImportReviewItem,
  ImportPlatformRelation,
  ProductType,
  SourcePlatformKey,
  WarehouseCode,
  WorkbookAudit,
} from "./types";

export const APPROVED_WORKBOOK_FILENAME =
  "NEW Summary_72 items + FOC_Chonburi_revised 2026_20092026.xlsx";
export const APPROVED_WORKBOOK_SHA256 =
  "5DC4FEA985E8A262177E96F317BB56D1A0E0F5DDFE660EB2E75005DE355B788C";

const REAGENT_SHEET = "Reagent list";
const CHEMISTRY_FOC_SHEET = "FOC item_chem c503 c703 ISE";
const IMMUNOLOGY_FOC_SHEET = "FOC item_Imm e801";

const EXPECTED_TYPES: Record<WarehouseCode, Record<ProductType, number>> = {
  CHE: { reagent: 42, calibrator: 11, control: 10, consumable: 27 },
  IMM: { reagent: 30, calibrator: 21, control: 13, consumable: 8 },
};

const PLATFORM_SOURCE_KEYS: Record<string, SourcePlatformKey> = {
  "cobas pro c503 / c703 / ISE": "c503_c703_ise",
  "cobas pro ISE neo": "ise_neo",
  "cobas pro c703": "c703",
  "cobas e801 system": "e801",
};

export class WorkbookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbookValidationError";
  }
}

function fail(message: string): never {
  throw new WorkbookValidationError(message);
}

function textCell(row: ExcelJS.Row, column: number, required: boolean, context: string): string | null {
  const value = row.getCell(column).value;
  if (value == null || value === "") {
    if (required) fail(`${context}: column ${column} is missing`);
    return null;
  }
  if (typeof value !== "string") {
    fail(`${context}: column ${column} must be stored as text to preserve leading zeroes`);
  }
  return value.trim();
}

function packingCell(row: ExcelJS.Row, context: string): string | null {
  const value = row.getCell(5).value;
  if (value == null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") {
    fail(`${context}: unsupported packing cell type`);
  }
  return String(value).trim();
}

function rawCell(row: ExcelJS.Row, column: number): string | number | null {
  const value = row.getCell(column).value;
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  fail(`${row.worksheet.name}!${row.number}: unsupported raw cell type at column ${column}`);
}

function sourceSnapshot(row: ExcelJS.Row, isReagent: boolean): Record<string, string | number | null> {
  return {
    no: rawCell(row, 1),
    manufacturer_barcode: rawCell(row, 2),
    ref_code: rawCell(row, 3),
    name: rawCell(row, 4),
    packing_size: rawCell(row, 5),
    ...(isReagent
      ? { remark: rawCell(row, 6) }
      : { type: rawCell(row, 6), used_with: rawCell(row, 7) }),
  };
}

function parseProduct(row: ExcelJS.Row, warehouse: WarehouseCode, type: ProductType, isReagent: boolean): ImportProduct {
  const context = `${row.worksheet.name}!${row.number}`;
  const sourceNo = row.getCell(1).value;
  if (!Number.isInteger(sourceNo) || Number(sourceNo) <= 0) fail(`${context}: invalid source No.`);
  const barcode = textCell(row, 2, true, context)!;
  const ref = textCell(row, 3, true, context)!;
  const name = textCell(row, 4, true, context)!;
  if (!/^\d+$/.test(ref) || !/^\d+$/.test(barcode)) fail(`${context}: REF/barcode must be digit text`);
  const product: ImportProduct = {
    warehouse_code: warehouse,
    product_type: type,
    source_name: name,
    packing_size_raw: packingCell(row, context),
    source_sheet: row.worksheet.name,
    source_row: row.number,
    raw_source: sourceSnapshot(row, isReagent),
    ref_current: ref,
    manufacturer_barcode: barcode,
  };
  if (isReagent) {
    const remark = textCell(row, 6, false, context);
    if (remark) {
      const match = /^Revised: replaces (\d+)$/.exec(remark);
      if (!match) fail(`${context}: unrecognized legacy REF remark`);
      product.legacy_ref = match[1];
    }
  }
  return product;
}

function verifySheetShape(sheet: ExcelJS.Worksheet, expectedLastRow: number): void {
  if (sheet.rowCount !== expectedLastRow) fail(`${sheet.name}: expected ${expectedLastRow} rows, got ${sheet.rowCount}`);
  const header = sheet.getRow(4);
  if (header.getCell(1).value !== "No" || header.getCell(3).value !== "Ref code") {
    fail(`${sheet.name}: header columns changed`);
  }
}

function countByWarehouseAndType(products: ImportProduct[]) {
  const counts: Record<WarehouseCode, Record<ProductType, number>> = {
    CHE: { reagent: 0, calibrator: 0, control: 0, consumable: 0 },
    IMM: { reagent: 0, calibrator: 0, control: 0, consumable: 0 },
  };
  for (const product of products) counts[product.warehouse_code][product.product_type]++;
  return counts;
}

function verifyUnique(products: ImportProduct[], field: "ref_current" | "manufacturer_barcode"): number {
  const seen = new Map<string, string>();
  for (const p of products) {
    const where = `${p.source_sheet}!${p.source_row}`;
    const prior = seen.get(p[field]);
    if (prior) fail(`Duplicate ${field} ${p[field]} at ${prior} and ${where}`);
    seen.set(p[field], where);
  }
  return seen.size;
}

function addKnownSourceAnomalies(products: ImportProduct[], reviewItems: ImportReviewItem[]): void {
  const find = (sheet: string, row: number) => {
    const product = products.find((p) => p.source_sheet === sheet && p.source_row === row);
    if (!product) fail(`Missing expected source anomaly row ${sheet}!${row}`);
    return product;
  };
  for (const [sheet, row] of [
    [CHEMISTRY_FOC_SHEET, 15],
    [CHEMISTRY_FOC_SHEET, 42],
    [IMMUNOLOGY_FOC_SHEET, 33],
  ] as const) {
    const p = find(sheet, row);
    if (p.packing_size_raw !== null) fail(`${sheet}!${row}: expected missing packing size`);
    reviewItems.push({ warehouse_code: p.warehouse_code, source_sheet: sheet, source_row: row, kind: "missing_packing", source_text: "", details: `${p.source_name}: packing size is blank in approved source`, critical: true });
  }
  const hcv = find(IMMUNOLOGY_FOC_SHEET, 38);
  if (hcv.packing_size_raw !== "10  x  1.0  mL,  5  x  2.0  m") fail("HCV Duo PC packing source changed");
  reviewItems.push({ warehouse_code: "IMM", source_sheet: IMMUNOLOGY_FOC_SHEET, source_row: 38, kind: "truncated_packing", source_text: hcv.packing_size_raw, details: "The final unit appears truncated; do not infer the missing text", critical: true });

  const reactionCell = find(CHEMISTRY_FOC_SHEET, 39);
  reviewItems.push({ warehouse_code: "CHE", source_sheet: CHEMISTRY_FOC_SHEET, source_row: 39, kind: "platform_name_conflict", source_text: reactionCell.source_name, details: "Product name says c503/c513 while Used with says c503/c703/ISE; platform compatibility needs confirmation", critical: true });
  for (const row of [24, 25]) {
    const p = find(CHEMISTRY_FOC_SHEET, row);
    reviewItems.push({ warehouse_code: "CHE", source_sheet: CHEMISTRY_FOC_SHEET, source_row: row, kind: "source_type_question", source_text: p.source_name, details: "Source classifies STANDARD as consumable; retain source type until reviewed", critical: true });
  }
  const ise = find(REAGENT_SHEET, 22);
  reviewItems.push({ warehouse_code: "CHE", source_sheet: REAGENT_SHEET, source_row: 22, kind: "source_type_question", source_text: ise.source_name, details: "Source classifies ISE INTERNAL STANDARD GEN.2 as reagent; retain source type until reviewed", critical: true });
}

/**
 * Parses only the byte-identical approved workbook. Returned relations are solely
 * exact source assertions; no fuzzy matching, suffix stripping, or group expansion.
 */
export async function previewApprovedWorkbook(bytes: Buffer, sourceFilename = APPROVED_WORKBOOK_FILENAME): Promise<ImportPreview> {
  if (sourceFilename !== APPROVED_WORKBOOK_FILENAME) fail(`Unexpected workbook filename: ${sourceFilename}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  if (sha256 !== APPROVED_WORKBOOK_SHA256) fail(`Workbook SHA-256 mismatch: ${sha256}`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  if (workbook.worksheets.length !== 3 ||
    workbook.worksheets.map((sheet) => sheet.name).join("|") !==
      [REAGENT_SHEET, CHEMISTRY_FOC_SHEET, IMMUNOLOGY_FOC_SHEET].join("|")) {
    fail("Workbook sheets differ from approved source");
  }
  const reagentSheet = workbook.getWorksheet(REAGENT_SHEET)!;
  const chemistryFoc = workbook.getWorksheet(CHEMISTRY_FOC_SHEET)!;
  const immunologyFoc = workbook.getWorksheet(IMMUNOLOGY_FOC_SHEET)!;
  verifySheetShape(reagentSheet, 78);
  verifySheetShape(chemistryFoc, 53);
  verifySheetShape(immunologyFoc, 47);
  if (!String(reagentSheet.getRow(5).getCell(1).value).startsWith("CLINICAL CHEMISTRY") ||
      !String(reagentSheet.getRow(48).getCell(1).value).startsWith("IMMUNOLOGY")) {
    fail("Reagent warehouse section headings changed");
  }

  const products: ImportProduct[] = [];
  for (let row = 6; row <= 47; row++) products.push(parseProduct(reagentSheet.getRow(row), "CHE", "reagent", true));
  for (let row = 5; row <= 52; row++) {
    const source = chemistryFoc.getRow(row);
    const type = textCell(source, 6, true, `${chemistryFoc.name}!${row}`)?.toLowerCase() as ProductType;
    if (!(["calibrator", "control", "consumable"] as string[]).includes(type)) fail(`${chemistryFoc.name}!${row}: invalid FOC type`);
    products.push(parseProduct(source, "CHE", type, false));
  }
  for (let row = 49; row <= 78; row++) products.push(parseProduct(reagentSheet.getRow(row), "IMM", "reagent", true));
  for (let row = 5; row <= 46; row++) {
    const source = immunologyFoc.getRow(row);
    const type = textCell(source, 6, true, `${immunologyFoc.name}!${row}`)?.toLowerCase() as ProductType;
    if (!(["calibrator", "control", "consumable"] as string[]).includes(type)) fail(`${immunologyFoc.name}!${row}: invalid FOC type`);
    products.push(parseProduct(source, "IMM", type, false));
  }

  const chemistryReagentByCode = new Map<string, ImportProduct>();
  const immunologyReagentByName = new Map<string, ImportProduct>();
  for (const product of products.filter((p) => p.product_type === "reagent")) {
    if (product.warehouse_code === "CHE") {
      const code = product.source_name.split(",", 1)[0].trim();
      if (chemistryReagentByCode.has(code)) fail(`Duplicate Chemistry reagent code ${code}`);
      chemistryReagentByCode.set(code, product);
    } else {
      if (immunologyReagentByName.has(product.source_name)) fail(`Duplicate Immunology reagent name ${product.source_name}`);
      immunologyReagentByName.set(product.source_name, product);
    }
  }

  const productRelations: ImportProductRelation[] = [];
  const platformRelations: ImportPlatformRelation[] = [];
  const reviewItems: ImportReviewItem[] = [];
  for (const product of products.filter((p) => p.product_type !== "reagent")) {
    const sourceSheet = product.warehouse_code === "CHE" ? chemistryFoc : immunologyFoc;
    const usedWith = textCell(sourceSheet.getRow(product.source_row), 7, false, `${sourceSheet.name}!${product.source_row}`);
    if (!usedWith) {
      reviewItems.push({ warehouse_code: product.warehouse_code, source_sheet: sourceSheet.name, source_row: product.source_row, kind: "used_with", source_text: "", details: `${product.source_name}: Used with is blank; no target inferred`, critical: true });
      continue;
    }
    const platformKey = PLATFORM_SOURCE_KEYS[usedWith];
    if (platformKey) {
      platformRelations.push({ product_ref_current: product.ref_current, platform_key: platformKey, source_sheet: sourceSheet.name, source_row: product.source_row, source_text: usedWith });
      continue;
    }
    const targets = product.warehouse_code === "CHE"
      ? usedWith.split(",").map((token) => token.trim())
      : [usedWith];
    const mapped = targets.map((token) => ({ token, target: product.warehouse_code === "CHE" ? chemistryReagentByCode.get(token) : immunologyReagentByName.get(token) }));
    if (mapped.some(({ token, target }) => !token || !target)) {
      const unmatched = mapped.filter(({ token, target }) => !token || !target).map(({ token }) => token || "(empty)");
      reviewItems.push({ warehouse_code: product.warehouse_code, source_sheet: sourceSheet.name, source_row: product.source_row, kind: "used_with", source_text: usedWith, details: `No exact reagent match for: ${unmatched.join(", ")}; no partial links created`, critical: true });
      continue;
    }
    const relationType = `uses_${product.product_type}` as ImportProductRelation["relation_type"];
    for (const { target } of mapped) {
      productRelations.push({ source_ref_current: target!.ref_current, target_ref_current: product.ref_current, relation_type: relationType, source_sheet: sourceSheet.name, source_row: product.source_row, source_text: usedWith });
    }
  }
  addKnownSourceAnomalies(products, reviewItems);

  const counts = countByWarehouseAndType(products);
  for (const warehouse of ["CHE", "IMM"] as const) {
    for (const type of ["reagent", "calibrator", "control", "consumable"] as const) {
      if (counts[warehouse][type] !== EXPECTED_TYPES[warehouse][type]) {
        fail(`Unexpected ${warehouse} ${type} count ${counts[warehouse][type]}`);
      }
    }
  }
  const uniqueRefs = verifyUnique(products, "ref_current");
  const uniqueBarcodes = verifyUnique(products, "manufacturer_barcode");
  const legacyRefs = products.flatMap((p) => p.legacy_ref ? [p.legacy_ref] : []);
  if (new Set(legacyRefs).size !== legacyRefs.length || legacyRefs.some((ref) => products.some((p) => p.ref_current === ref))) {
    fail("Legacy REF collides with a current or another legacy REF");
  }
  const usedWithReviewRows = reviewItems.filter((item) => item.kind === "used_with").length;
  if (products.length !== 162 || uniqueRefs !== 162 || uniqueBarcodes !== 162 ||
      legacyRefs.length !== 29 || productRelations.length !== 90 || platformRelations.length !== 27 || usedWithReviewRows !== 12) {
    fail("Approved workbook audit totals do not reconcile");
  }
  const typeCounts: Record<ProductType, number> = { reagent: 0, calibrator: 0, control: 0, consumable: 0 };
  for (const product of products) typeCounts[product.product_type]++;
  const audit: WorkbookAudit = {
    source_filename: sourceFilename,
    source_sha256: sha256,
    product_count: products.length,
    warehouse_counts: { CHE: 90, IMM: 72 },
    type_counts: typeCounts,
    warehouse_type_counts: counts,
    ref_current_unique_count: uniqueRefs,
    manufacturer_barcode_unique_count: uniqueBarcodes,
    legacy_ref_count: legacyRefs.length,
    leading_zero_ref_count: products.filter((p) => p.ref_current.startsWith("0")).length,
    product_relation_count: productRelations.length,
    platform_source_row_count: platformRelations.length,
    used_with_review_row_count: usedWithReviewRows,
    source_anomaly_review_count: reviewItems.length - usedWithReviewRows,
    activation_blocked: reviewItems.some((item) => item.critical),
    notes: [
      "Excel No. is source provenance only; it is duplicated across sheets and is not a key.",
      "Immunology FOC No. 71 appears after No. 75; physical row order is preserved.",
      "Platform source groups are retained as one source assertion each, not expanded into compatibility edges.",
      "No GTIN is inferred from nine-digit manufacturer barcodes.",
      "All unresolved and anomalous source rows require explicit review before active import.",
    ],
  };
  return {
    audit,
    payload: {
      source_filename: sourceFilename,
      source_sha256: sha256,
      products,
      product_relations: productRelations,
      platform_relations: platformRelations,
      review_items: reviewItems,
    },
  };
}

/** The stage RPC accepts previews; the apply RPC must fail closed until reviews are resolved. */
export function assertImportReadyForActivation(audit: WorkbookAudit): void {
  if (audit.activation_blocked) fail("Import activation blocked: critical review items remain unresolved");
}
