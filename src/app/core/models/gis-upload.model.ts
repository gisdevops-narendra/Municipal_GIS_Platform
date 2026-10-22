import { GisGeometryType, GisLayerOwnershipType } from './gis-layer.model';

export type GisUploadFileFormat = 'SHAPEFILE_ZIP' | 'GEOJSON' | 'CSV';

/** The upload/draft/review/publish lifecycle — see docs/backend.md
 *  "GIS Uploads". A row only ever moves forward, except IN_REVIEW ->
 *  REJECTED and (FAILED|PUBLISH_FAILED) -> retry. */
export type GisUploadStatus =
  | 'UPLOAD_PENDING'
  | 'VALIDATING'
  | 'DRAFT'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'PUBLISHED'
  | 'REJECTED'
  | 'FAILED'
  | 'PUBLISH_FAILED';

export interface GisUploadValidationSummary {
  fileValid: boolean;
  sourceCrs: string | null;
  targetCrs: string;
  geometryType: string | null;
  featureCount: number;
  fields: { name: string; type: string }[];
  warnings: string[];
  errors: string[];
}

/** Shape of every /api/gis/uploads* endpoint response (Task 7 §47). */
export interface GisUpload {
  id: string;
  filename: string;
  fileFormat: GisUploadFileFormat;
  fileSize: number;
  status: GisUploadStatus;
  layer: {
    name: string;
    code: string;
    description: string | null;
    ownershipType: GisLayerOwnershipType;
    departmentId: string | null;
    departmentName: string | null;
  };
  validation: {
    valid: boolean;
    featureCount: number | null;
    geometryType: GisGeometryType | null;
    sourceCrs: string | null;
    targetCrs: string | null;
    summary: GisUploadValidationSummary | null;
  };
  errorMessage: string | null;
  /** Columns step: what the uploader approved (renames, type changes and
   *  what each column means). */
  schema?: {
    confirmedAt: string | null;
    changes: UploadSchemaChange[];
    fieldMetadata: UploadColumnMeaning[];
  };
  review: {
    reviewedById: string | null;
    reviewedAt: string | null;
    rejectionReason: string | null;
  };
  publish: {
    publishedById: string | null;
    publishedAt: string | null;
    layerId: string | null;
  };
  uploadedById: string;
  createdAt: string;
  updatedAt: string;
}

export interface GisUploadPage {
  items: GisUpload[];
  page: number;
  pageSize: number;
  total: number;
}

export interface GisUploadPreview {
  geoserverWorkspace: string;
  geoserverLayer: string;
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

/** Fields accompanying the multipart file for POST /api/gis/uploads —
 *  mirrors the backend's CreateUploadDto. */
export interface CreateGisUploadRequest {
  layerName: string;
  description?: string;
  departmentId?: string;
  ownershipType: GisLayerOwnershipType;
  sourceCrs?: string;
  latitudeField?: string;
  longitudeField?: string;
  xField?: string;
  yField?: string;
}

/** GET /api/gis/uploads/:id/review-check — automated pre-approval checks. */
export interface UploadReviewFinding {
  check: string;
  severity: 'high' | 'medium' | 'low' | 'info';
  title: string;
  detail: string;
}

export interface UploadReviewReport {
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high';
  summary: string;
  findings: UploadReviewFinding[];
  replaces: { id: string; name: string; version: number } | null;
  checkedAt: string;
}

// ---- Columns step (review the imported data before submitting) ----------

export type UploadColumnKind = 'text' | 'integer' | 'number' | 'date' | 'boolean';
export type UploadColumnRole = 'id' | 'name' | 'category' | 'measure' | 'free_text' | 'date' | 'flag' | 'hidden';

export interface UploadColumnMeaning {
  name: string;
  role: UploadColumnRole;
  unit: string | null;
  description: string | null;
  aliases: string[];
}

export interface UploadSchemaChange {
  column: string;
  renamedTo?: string;
  typeFrom?: string;
  typeTo?: string;
  at: string;
}

export interface UploadSchemaColumn {
  name: string;
  dbType: string;
  kind: UploadColumnKind | 'other';
  stats: { rows: number; filled: number; distinct: number; min: string | null; max: string | null };
  samples: { value: string; count: number }[];
  /** Other types, with how many non-empty values would not convert (0 = safe). */
  conversions: Partial<Record<UploadColumnKind, { failing: number; examples: string[] }>>;
  /** What the AI proposes the column means (null if the AI is unavailable). */
  proposal: { role: UploadColumnRole; unit: string | null; description: string; aliases: string[] } | null;
  /** What the uploader approved earlier. */
  approved: { role: UploadColumnRole; unit: string | null; description: string | null; aliases: string[] } | null;
}

export interface UploadSchema {
  table: { rows: number };
  columns: UploadSchemaColumn[];
  /** First records, every value as text. */
  records: Record<string, string | null>[];
  proposalsAvailable: boolean;
  confirmedAt: string | null;
  changes: UploadSchemaChange[];
}

export interface UploadColumnChange {
  name: string;
  newName?: string;
  type?: UploadColumnKind;
  role?: UploadColumnRole;
  unit?: string;
  description?: string;
  aliases?: string[];
}
