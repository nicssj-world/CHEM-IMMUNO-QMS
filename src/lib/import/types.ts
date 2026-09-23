export type WarehouseCode = "CHE" | "IMM";
export type ProductType = "reagent" | "calibrator" | "control" | "consumable";
export type RelationType = "uses_calibrator" | "uses_control" | "uses_consumable";

export interface ImportProduct {
  warehouse_code: WarehouseCode;
  product_type: ProductType;
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

export interface ImportReviewItem {
  warehouse_code: WarehouseCode;
  source_sheet: string;
  source_row: number;
  kind: ImportReviewKind;
  source_text: string;
  details: string;
  critical: true;
}

export interface ImportStagePayload {
  source_filename: string;
  source_sha256: string;
  products: ImportProduct[];
  product_relations: ImportProductRelation[];
  platform_relations: ImportPlatformRelation[];
  review_items: ImportReviewItem[];
}

export interface WorkbookAudit {
  source_filename: string;
  source_sha256: string;
  product_count: number;
  warehouse_counts: Record<WarehouseCode, number>;
  type_counts: Record<ProductType, number>;
  warehouse_type_counts: Record<WarehouseCode, Record<ProductType, number>>;
  ref_current_unique_count: number;
  manufacturer_barcode_unique_count: number;
  legacy_ref_count: number;
  leading_zero_ref_count: number;
  product_relation_count: number;
  platform_source_row_count: number;
  used_with_review_row_count: number;
  source_anomaly_review_count: number;
  activation_blocked: boolean;
  notes: string[];
}

export interface ImportPreview {
  audit: WorkbookAudit;
  payload: ImportStagePayload;
}
