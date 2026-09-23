import type {
  ApprovedImportDecision,
  ImportProduct,
  ImportResolutionEntry,
  ImportResolutionManifest,
  ImportReviewDraft,
  ImportReviewItem,
  ImportResolutionType,
  ProductType,
  RelationType,
} from "./types";

const SOURCE_SHA256 = "5DC4FEA985E8A262177E96F317BB56D1A0E0F5DDFE660EB2E75005DE355B788C";
const APPROVAL_SOURCE = "Explicit owner decisions in the latest CHEM-IMMUNO CBH task instruction";
const CHEMISTRY_FOC = "FOC item_chem c503 c703 ISE";
const IMMUNOLOGY_FOC = "FOC item_Imm e801";
const REAGENT_SHEET = "Reagent list";

interface ResolutionSpec {
  review_id: string;
  source_sheet: string;
  source_row: number;
  source_product_ref: string;
  source_field: string;
  expected_raw_source_value: string | number | null;
  approved_decision: ApprovedImportDecision;
  resolution_type: ImportResolutionType;
  resolution_note: string;
}

const specs: ResolutionSpec[] = [
  {
    review_id: "REL-01", source_sheet: CHEMISTRY_FOC, source_row: 16, source_product_ref: "08463107190",
    source_field: "used_with", expected_raw_source_value: "A1CX4 (hemolysing reagent)",
    approved_decision: { kind: "product_relationship", source_ref_current: "09529713190", target_ref_current: "08463107190", relation_type: "uses_consumable" },
    resolution_type: "owner-confirmed-candidate", resolution_note: "Owner confirmed A1CX4 → uses_consumable → A1CD.",
  },
  {
    review_id: "REL-02", source_sheet: CHEMISTRY_FOC, source_row: 17, source_product_ref: "08059322190",
    source_field: "used_with", expected_raw_source_value: "ALBT2 (start reagent)",
    approved_decision: { kind: "product_relationship", source_ref_current: "08056722190", target_ref_current: "08059322190", relation_type: "uses_consumable" },
    resolution_type: "owner-confirmed-candidate", resolution_note: "Owner confirmed ALBT2 → uses_consumable → START.",
  },
  {
    review_id: "REL-03", source_sheet: CHEMISTRY_FOC, source_row: 41, source_product_ref: "07361939001",
    source_field: "used_with", expected_raw_source_value: null,
    approved_decision: { kind: "unassigned" }, resolution_type: "owner-unassigned",
    resolution_note: "Owner explicitly left Product and Platform relationships unassigned.",
  },
  {
    review_id: "REL-04", source_sheet: CHEMISTRY_FOC, source_row: 42, source_product_ref: "04740955001",
    source_field: "used_with", expected_raw_source_value: null,
    approved_decision: { kind: "unassigned" }, resolution_type: "owner-unassigned",
    resolution_note: "Owner explicitly left Product and Platform relationships unassigned.",
  },
  {
    review_id: "REL-05", source_sheet: IMMUNOLOGY_FOC, source_row: 5, source_product_ref: "09315314190",
    source_field: "used_with", expected_raw_source_value: "Elecsys proBNP G2 E2G 300 (485)",
    approved_decision: { kind: "product_relationship", source_ref_current: "09315284214", target_ref_current: "09315314190", relation_type: "uses_calibrator" },
    resolution_type: "owner-confirmed-candidate", resolution_note: "Owner confirmed proBNP reagent → uses_calibrator → proBNP II calibrator.",
  },
  {
    review_id: "REL-06", source_sheet: IMMUNOLOGY_FOC, source_row: 6, source_product_ref: "09315373190",
    source_field: "used_with", expected_raw_source_value: "Elecsys Troponin T hs V2.1 E2G 300T (164)",
    approved_decision: { kind: "product_relationship", source_ref_current: "09315357190", target_ref_current: "09315373190", relation_type: "uses_calibrator" },
    resolution_type: "owner-confirmed-candidate", resolution_note: "Owner confirmed Troponin reagent → uses_calibrator → Troponin CS calibrator.",
  },
  {
    review_id: "REL-07", source_sheet: IMMUNOLOGY_FOC, source_row: 10, source_product_ref: "09043292190",
    source_field: "used_with", expected_raw_source_value: "ELECSYS FT4 IV E801 (300 TESTS)",
    approved_decision: { kind: "product_relationship", source_ref_current: "09043284214", target_ref_current: "09043292190", relation_type: "uses_calibrator" },
    resolution_type: "owner-confirmed-candidate", resolution_note: "Owner confirmed FT4 IV reagent → uses_calibrator → FT4 IV CALSET.",
  },
  {
    review_id: "REL-08", source_sheet: IMMUNOLOGY_FOC, source_row: 26, source_product_ref: "07299001190",
    source_field: "used_with", expected_raw_source_value: "Elecsys proBNP G2 E2G 300 (485)",
    approved_decision: { kind: "product_relationship", source_ref_current: "09315284214", target_ref_current: "07299001190", relation_type: "uses_consumable" },
    resolution_type: "owner-confirmed-candidate", resolution_note: "Owner confirmed proBNP reagent → uses_consumable → DILUENT UNIVERSAL E801.",
  },
  {
    review_id: "REL-09", source_sheet: IMMUNOLOGY_FOC, source_row: 27, source_product_ref: "07299010190",
    source_field: "used_with", expected_raw_source_value: "Elecsys Troponin T hs V2.1 E2G 300T (164)",
    approved_decision: { kind: "product_relationship", source_ref_current: "09315357190", target_ref_current: "07299010190", relation_type: "uses_consumable" },
    resolution_type: "owner-confirmed-candidate", resolution_note: "Owner confirmed Troponin reagent → uses_consumable → DILUENT MULTI ASSAY E801.",
  },
  {
    review_id: "REL-10", source_sheet: IMMUNOLOGY_FOC, source_row: 33, source_product_ref: "09762582190",
    source_field: "used_with", expected_raw_source_value: null,
    approved_decision: { kind: "product_relationship", source_ref_current: "07027699214", target_ref_current: "09762582190", relation_type: "uses_consumable" },
    resolution_type: "owner-manual-relationship", resolution_note: "Owner manually approved ELECSYS PROGESTERONE III E801 → uses_consumable → ELECSYS PROGESTERONE DILUENT; workbook Used with was blank.",
  },
  {
    review_id: "REL-11", source_sheet: IMMUNOLOGY_FOC, source_row: 34, source_product_ref: "04917049190",
    source_field: "used_with", expected_raw_source_value: "Elecsys proBNP G2 E2G 300 (485)",
    approved_decision: { kind: "product_relationship", source_ref_current: "09315284214", target_ref_current: "04917049190", relation_type: "uses_control" },
    resolution_type: "owner-confirmed-candidate", resolution_note: "Owner confirmed proBNP reagent → uses_control → PRECICONTROL CARDIAC GEN.2.",
  },
  {
    review_id: "REL-12", source_sheet: IMMUNOLOGY_FOC, source_row: 35, source_product_ref: "05095107190",
    source_field: "used_with", expected_raw_source_value: "Elecsys Troponin T hs V2.1 E2G 300T (164)",
    approved_decision: { kind: "product_relationship", source_ref_current: "09315357190", target_ref_current: "05095107190", relation_type: "uses_control" },
    resolution_type: "owner-confirmed-candidate", resolution_note: "Owner confirmed Troponin reagent → uses_control → PRECICONTROL TROPONIN ELECSYS.",
  },
  {
    review_id: "PM-01", source_sheet: CHEMISTRY_FOC, source_row: 15, source_product_ref: "03375790190",
    source_field: "packing_size", expected_raw_source_value: null,
    approved_decision: { kind: "product_data_correction", field: "packing_size_raw", source_value: null, approved_value: "6 x 5 mL calibrator + 1 x 10 mL diluent" },
    resolution_type: "owner-data-correction", resolution_note: "Workbook packing is blank; owner approved 6 x 5 mL calibrator + 1 x 10 mL diluent.",
  },
  {
    review_id: "PM-02", source_sheet: CHEMISTRY_FOC, source_row: 42, source_product_ref: "04740955001",
    source_field: "packing_size", expected_raw_source_value: null,
    approved_decision: { kind: "product_data_correction", field: "packing_size_raw", source_value: null, approved_value: "2 x 1000 pcs" },
    resolution_type: "owner-data-correction", resolution_note: "Workbook packing is blank; owner approved the pack expression 2 x 1000 pcs.",
  },
  {
    review_id: "PM-03", source_sheet: IMMUNOLOGY_FOC, source_row: 33, source_product_ref: "09762582190",
    source_field: "packing_size", expected_raw_source_value: null,
    approved_decision: { kind: "product_data_correction", field: "packing_size_raw", source_value: null, approved_value: "2 x 22 mL" },
    resolution_type: "owner-data-correction", resolution_note: "Workbook packing is blank; owner approved 2 x 22 mL.",
  },
  {
    review_id: "PM-04", source_sheet: IMMUNOLOGY_FOC, source_row: 38, source_product_ref: "08335923190",
    source_field: "packing_size", expected_raw_source_value: "10  x  1.0  mL,  5  x  2.0  m",
    approved_decision: { kind: "product_data_correction", field: "packing_size_raw", source_value: "10  x  1.0  mL,  5  x  2.0  m", approved_value: "10 x 1.0 mL, 5 x 2.0 mL" },
    resolution_type: "owner-data-correction", resolution_note: "Workbook packing ends with a truncated unit; owner approved 10 x 1.0 mL, 5 x 2.0 mL.",
  },
  {
    review_id: "PM-05", source_sheet: CHEMISTRY_FOC, source_row: 39, source_product_ref: "07700814001",
    source_field: "used_with", expected_raw_source_value: "cobas pro c503 / c703 / ISE",
    approved_decision: { kind: "product_platform_override", product_ref_current: "07700814001", source_platform_text: "cobas pro c503 / c703 / ISE", source_platform_key: "c503_c703_ise", target_platform_keys: ["c503", "c513"] },
    resolution_type: "owner-platform-override", resolution_note: "Workbook Used with is retained as provenance; owner approved c503 and c513 only.",
  },
  {
    review_id: "PM-06", source_sheet: CHEMISTRY_FOC, source_row: 24, source_product_ref: "11183982216",
    source_field: "type", expected_raw_source_value: "Consumable",
    approved_decision: { kind: "product_type_override", source_value: "Consumable", approved_value: "calibrator" },
    resolution_type: "owner-type-override", resolution_note: "Workbook Type is Consumable; owner approved calibrator.",
  },
  {
    review_id: "PM-07", source_sheet: CHEMISTRY_FOC, source_row: 25, source_product_ref: "11183974216",
    source_field: "type", expected_raw_source_value: "Consumable",
    approved_decision: { kind: "product_type_override", source_value: "Consumable", approved_value: "calibrator" },
    resolution_type: "owner-type-override", resolution_note: "Workbook Type is Consumable; owner approved calibrator.",
  },
  {
    review_id: "PM-08", source_sheet: REAGENT_SHEET, source_row: 22, source_product_ref: "04880455214",
    source_field: "name", expected_raw_source_value: "ISE INTERNAL STANDARD GEN.2, 2X2000ML",
    approved_decision: { kind: "source_confirmed", field: "product_type", source_value: "reagent", approved_value: "reagent" },
    resolution_type: "source-confirmed", resolution_note: "Owner confirmed the reagent classification; no catalog override was needed.",
  },
];

function rawValue(product: ImportProduct, field: string): string | number | null {
  const value = product.raw_source[field];
  return value === undefined ? null : value;
}

function reviewKindFor(reviewId: string): ImportReviewDraft["kind"] {
  if (reviewId.startsWith("REL-")) return "used_with";
  if (["PM-01", "PM-02", "PM-03"].includes(reviewId)) return "missing_packing";
  if (reviewId === "PM-04") return "truncated_packing";
  if (reviewId === "PM-05") return "platform_name_conflict";
  return "source_type_question";
}

export function applyApprovedProductOverrides(products: ImportProduct[], entries: ImportResolutionEntry[]): void {
  for (const entry of entries) {
    const product = products.find((candidate) => candidate.ref_current === entry.source_product_ref);
    if (!product) throw new Error(`Approved resolution ${entry.review_id} references a missing product`);
    const decision = entry.approved_decision;
    if (decision.kind === "product_data_correction") {
      if (product.packing_size_raw !== decision.source_value) {
        throw new Error(`Approved packing source differs for ${entry.review_id}`);
      }
      product.packing_size_raw = decision.approved_value;
    } else if (decision.kind === "product_type_override") {
      if (product.source_product_type !== decision.source_value.toLowerCase()) {
        throw new Error(`Approved source type differs for ${entry.review_id}`);
      }
      product.product_type = decision.approved_value;
    } else if (decision.kind === "source_confirmed") {
      if (product.source_product_type !== decision.approved_value) {
        throw new Error(`Confirmed catalog value differs for ${entry.review_id}`);
      }
    }
  }
}

export function buildApprovedResolutionManifest(
  products: ImportProduct[],
  drafts: ImportReviewDraft[],
): { manifest: ImportResolutionManifest; reviewItems: ImportReviewItem[] } {
  const productByLocation = new Map(products.map((product) => [`${product.source_sheet}|${product.source_row}`, product]));
  const draftByLocation = new Map(drafts.map((draft) => [`${draft.source_sheet}|${draft.source_row}|${draft.kind}`, draft]));
  if (productByLocation.size !== products.length || draftByLocation.size !== drafts.length) {
    throw new Error("Duplicate source location and review kind in workbook import preview");
  }

  const entries = specs.map((spec): ImportResolutionEntry => {
    const location = `${spec.source_sheet}|${spec.source_row}`;
    const product = productByLocation.get(location);
    const draft = draftByLocation.get(`${location}|${reviewKindFor(spec.review_id)}`);
    if (!product || !draft || product.ref_current !== spec.source_product_ref) {
      throw new Error(`Approved resolution ${spec.review_id} no longer identifies its exact workbook row`);
    }
    const value = rawValue(product, spec.source_field);
    if (!Object.is(value, spec.expected_raw_source_value)) {
      throw new Error(`Approved raw source value differs for ${spec.review_id}`);
    }
    const decision = spec.approved_decision;
    if (decision.kind === "product_relationship") {
      const source = products.find((candidate) => candidate.ref_current === decision.source_ref_current);
      const target = products.find((candidate) => candidate.ref_current === decision.target_ref_current);
      const expectedType: RelationType | null = target?.product_type === "reagent" ? null : target?.product_type === "calibrator" || target?.product_type === "control" || target?.product_type === "consumable" ? `uses_${target.product_type}` : null;
      if (!source || !target || source.warehouse_code !== target.warehouse_code || source.product_type !== "reagent" ||
        expectedType !== decision.relation_type || target.ref_current !== spec.source_product_ref) {
        throw new Error(`Approved relationship ${spec.review_id} violates exact target, type, or warehouse checks`);
      }
    }
    return {
      review_id: spec.review_id,
      source_sha256: SOURCE_SHA256,
      source_sheet: spec.source_sheet,
      source_row: spec.source_row,
      source_product_ref: spec.source_product_ref,
      source_field: spec.source_field,
      raw_source_value: value,
      approved_decision: decision,
      target_refs: decision.kind === "product_relationship"
        ? [decision.source_ref_current, decision.target_ref_current]
        : [],
      platform_keys: decision.kind === "product_platform_override"
        ? [...decision.target_platform_keys]
        : [],
      resolution_type: spec.resolution_type,
      approval_source: APPROVAL_SOURCE,
      resolution_note: spec.resolution_note,
    };
  });

  if (entries.length !== drafts.length || new Set(entries.map((entry) => entry.review_id)).size !== entries.length) {
    throw new Error("Approved resolution manifest does not cover each review item exactly once");
  }
  const entryByLocation = new Map(entries.map((entry) => [
    `${entry.source_sheet}|${entry.source_row}|${reviewKindFor(entry.review_id)}`, entry,
  ]));
  const reviewItems = drafts.map((draft): ImportReviewItem => {
    const product = productByLocation.get(`${draft.source_sheet}|${draft.source_row}`)!;
    const entry = entryByLocation.get(`${draft.source_sheet}|${draft.source_row}|${draft.kind}`);
    if (!entry) throw new Error(`No explicit owner decision for ${draft.source_sheet}!${draft.source_row}`);
    return {
      ...draft,
      review_id: entry.review_id,
      source_product_ref: product.ref_current,
      raw_source_value: entry.raw_source_value,
    };
  });

  return {
    manifest: {
      format_version: 1,
      source_sha256: SOURCE_SHA256,
      approval_source: APPROVAL_SOURCE,
      entries,
    },
    reviewItems,
  };
}

export function countResolutionsByType(entries: ImportResolutionEntry[]): Record<ImportResolutionType, number> {
  const counts: Record<ImportResolutionType, number> = {
    "source-confirmed": 0,
    "owner-confirmed-candidate": 0,
    "owner-manual-relationship": 0,
    "owner-unassigned": 0,
    "owner-data-correction": 0,
    "owner-type-override": 0,
    "owner-platform-override": 0,
  };
  for (const entry of entries) counts[entry.resolution_type]++;
  return counts;
}

export function isApprovedProductType(value: string): value is ProductType {
  return value === "reagent" || value === "calibrator" || value === "control" || value === "consumable";
}
