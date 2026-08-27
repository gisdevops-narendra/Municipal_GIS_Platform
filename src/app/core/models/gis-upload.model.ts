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
