export type WarehouseCode = "CHE" | "IMM";
export type ProductType = "reagent" | "calibrator" | "control" | "consumable";
export type RelationType = "uses_calibrator" | "uses_control" | "uses_consumable";
export type ImportResolutionType =
  | "source-confirmed"
  | "owner-confirmed-candidate"
  | "owner-manual-relationship"
  | "owner-unassigned"
  | "owner-data-correction"
  | "owner-type-override"
  | "owner-platform-override";

export type ApprovedImportDecision =
  | {
      kind: "product_relationship";
      source_ref_current: string;
      target_ref_current: string;
      relation_type: RelationType;
    }
  | { kind: "unassigned" }
  | {
      kind: "product_data_correction";
      field: "packing_size_raw";
      source_value: string | null;
      approved_value: string;
    }
  | {
      kind: "product_type_override";
      source_value: string;
      approved_value: ProductType;
    }
  | {
      kind: "product_platform_override";
      product_ref_current: string;
      source_platform_text: string;
      source_platform_key: string;
      target_platform_keys: string[];
    }
  | {
      kind: "source_confirmed";
      field: "product_type";
      source_value: string;
      approved_value: ProductType;
    };

export interface ImportProduct {
  warehouse_code: WarehouseCode;
  product_type: ProductType;
  source_product_type: ProductType;
  source_name: string;
  packing_size_raw: string | null;
  source_sheet: string;
  source_row: number;
  raw_source: Record<string, string | number | null>;
  ref_current: string;
  manufacturer_barcode: string;
  legacy_ref?: string;
}

export interface ImportProductRelation {
  source_ref_current: string;
  target_ref_current: string;
  relation_type: RelationType;
  source_sheet: string;
  source_row: number;
  source_text: string;
}

/** A key represents exactly one source assertion, including a source group. */
export type SourcePlatformKey = "c503_c703_ise" | "ise_neo" | "c703" | "e801";

export interface ImportPlatformRelation {
  product_ref_current: string;
  platform_key: SourcePlatformKey;
  source_sheet: string;
  source_row: number;
  source_text: string;
}

export type ImportReviewKind =
  | "used_with"
  | "missing_packing"
  | "truncated_packing"
  | "platform_name_conflict"
  | "source_type_question";

export interface ImportReviewDraft {
  warehouse_code: WarehouseCode;
  source_sheet: string;
  source_row: number;
  kind: ImportReviewKind;
  source_text: string;
  details: string;
  critical: true;
}

export interface ImportReviewItem extends ImportReviewDraft {
  review_id: string;
  source_product_ref: string;
  raw_source_value: string | number | null;
}

export interface ImportResolutionEntry {
  review_id: string;
  source_sha256: string;
  source_sheet: string;
  source_row: number;
  source_product_ref: string;
  source_field: string;
  raw_source_value: string | number | null;
  approved_decision: ApprovedImportDecision;
  target_refs: string[];
  platform_keys: string[];
  resolution_type: ImportResolutionType;
  approval_source: string;
  resolution_note: string;
}

export interface ImportResolutionManifest {
  format_version: 1;
  source_sha256: string;
  approval_source: string;
  entries: ImportResolutionEntry[];
}

export interface ImportStagePayload {
  source_filename: string;
  source_sha256: string;
  products: ImportProduct[];
  product_relations: ImportProductRelation[];
  platform_relations: ImportPlatformRelation[];
  review_items: ImportReviewItem[];
  resolution_manifest: ImportResolutionManifest;
}

export interface WorkbookAudit {
  source_filename: string;
  source_sha256: string;
  product_count: number;
  warehouse_counts: Record<WarehouseCode, number>;
  type_counts: Record<ProductType, number>;
  source_type_counts: Record<ProductType, number>;
  approved_type_counts: Record<ProductType, number>;
  warehouse_type_counts: Record<WarehouseCode, Record<ProductType, number>>;
  approved_warehouse_type_counts: Record<WarehouseCode, Record<ProductType, number>>;
  ref_current_unique_count: number;
  manufacturer_barcode_unique_count: number;
  legacy_ref_count: number;
  leading_zero_ref_count: number;
  product_relation_count: number;
  source_product_relation_count: number;
  owner_approved_product_relation_count: number;
  active_product_relation_count: number;
  platform_source_row_count: number;
  owner_platform_override_count: number;
  active_product_platform_mapping_count: number;
  used_with_review_row_count: number;
  source_anomaly_review_count: number;
  resolved_review_count: number;
  informational_review_count: number;
  unresolved_critical_review_count: number;
  activation_blocked: boolean;
  notes: string[];
}

export interface ImportPreview {
  audit: WorkbookAudit;
  payload: ImportStagePayload;
}
