import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { GisGeometryType, GisLayer } from '../../../core/models/gis-layer.model';

/** Module Access catalog ids (seed-modules.ts). */
export const EDIT_PANEL_MODULE_ID = 55;
export const EDIT_HISTORY_MODULE_ID = 1001;
export const GEOPROCESSING_MODULE_ID = 1002;
export const IMPACT_REPORT_MODULE_ID = 1003;
export const ATTACHMENTS_MODULE_ID = 1005;
export const PARCEL_TOOLS_MODULE_ID = 1006;
export const FIELD_COLLECTION_MODULE_ID = 1007;

export interface FieldRule {
  required?: boolean;
  values?: string[];
  min?: number;
  max?: number;
}
export type FieldRules = Record<string, FieldRule>;

export interface FeatureAttachment {
  id: string;
  featureId: number;
  fileName: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface EditSchema {
  layerId: string;
  geometryType: GisGeometryType | null;
  fields: { name: string; type: string }[];
  rules: FieldRules;
}

export interface EditableFeature {
  id: number;
  /** GeoJSON, EPSG:4326. */
  geometry: Record<string, unknown> | null;
  properties: Record<string, unknown>;
}

export interface FeatureHistoryEntry {
  id: string;
  featureId: number;
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  oldData: { properties: Record<string, unknown>; geometry: unknown } | null;
  newData: { properties: Record<string, unknown>; geometry: unknown } | null;
  userName: string | null;
  createdAt: string;
}

export type GeoprocessOperation =
  | 'buffer' | 'dissolve' | 'intersect' | 'clip' | 'erase' | 'join'
  | 'centroids' | 'convexhull' | 'envelope' | 'simplify' | 'explode' | 'polygonstolines'
  | 'linestopolygons' | 'pointsalonglines' | 'voronoi' | 'squaregrid' | 'hexgrid'
  | 'merge' | 'symdifference' | 'nearest' | 'selectbylocation';

export interface GeoprocessRequest {
  operation: GeoprocessOperation;
  inputLayerId: string;
  overlayLayerId?: string;
  outputName: string;
  distance?: number;
  dissolve?: boolean;
  dissolveField?: string;
  joinMode?: 'attributes' | 'count';
}

/** Feature Editing, Edit History, Geoprocessing and Impact Report
 *  (VectorToolsController). Permissions are enforced server-side. */
/** Field types a new Draw & Mark layer can have. */
export type BlankFieldType = 'text' | 'integer' | 'decimal' | 'date' | 'boolean';

export interface BlankLayerRequest {
  name: string;
  geometryType: GisGeometryType;
  /** EPSG:n — the workspace default when omitted. */
  crs?: string;
  fields: { name: string; type: BlankFieldType }[];
}

@Injectable({ providedIn: 'root' })
export class VectorToolsService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/gis`;

  /** Creates and publishes an empty, editable vector layer. */
  createBlankLayer(request: BlankLayerRequest): Observable<GisLayer> {
    return this.http.post<GisLayer>(`${this.baseUrl}/layers/blank`, request);
  }

  editSchema(layerId: string): Observable<EditSchema> {
    return this.http.get<EditSchema>(`${this.baseUrl}/layers/${layerId}/edit-schema`);
  }

  featureAt(layerId: string, lonLat: [number, number], toleranceM: number): Observable<{ feature: EditableFeature | null }> {
    return this.http.get<{ feature: EditableFeature | null }>(`${this.baseUrl}/layers/${layerId}/features/at`, {
      params: { lon: lonLat[0], lat: lonLat[1], tolerance: toleranceM }
    });
  }

  createFeature(layerId: string, geometry: Record<string, unknown>, properties: Record<string, unknown>): Observable<EditableFeature> {
    return this.http.post<EditableFeature>(`${this.baseUrl}/layers/${layerId}/features`, { geometry, properties });
  }

  updateFeature(
    layerId: string,
    featureId: number,
    change: { geometry?: Record<string, unknown>; properties?: Record<string, unknown> }
  ): Observable<EditableFeature> {
    return this.http.patch<EditableFeature>(`${this.baseUrl}/layers/${layerId}/features/${featureId}`, change);
  }

  deleteFeature(layerId: string, featureId: number): Observable<{ success: true }> {
    return this.http.delete<{ success: true }>(`${this.baseUrl}/layers/${layerId}/features/${featureId}`);
  }

  splitFeature(layerId: string, featureId: number, line: Record<string, unknown>): Observable<{ features: EditableFeature[] }> {
    return this.http.post<{ features: EditableFeature[] }>(`${this.baseUrl}/layers/${layerId}/features/${featureId}/split`, { line });
  }

  mergeFeatures(layerId: string, keepId: number, featureIds: number[]): Observable<EditableFeature> {
    return this.http.post<EditableFeature>(`${this.baseUrl}/layers/${layerId}/features/merge`, { keepId, featureIds });
  }

  attachments(layerId: string, featureId: number): Observable<FeatureAttachment[]> {
    return this.http.get<FeatureAttachment[]>(`${this.baseUrl}/layers/${layerId}/features/${featureId}/attachments`);
  }

  addAttachment(layerId: string, featureId: number, file: Blob, fileName: string): Observable<FeatureAttachment> {
    const form = new FormData();
    form.append('file', file, fileName);
    return this.http.post<FeatureAttachment>(`${this.baseUrl}/layers/${layerId}/features/${featureId}/attachments`, form);
  }

  attachmentBlob(layerId: string, attachmentId: string): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/layers/${layerId}/attachments/${attachmentId}`, { responseType: 'blob' });
  }

  deleteAttachment(layerId: string, attachmentId: string): Observable<{ success: true }> {
    return this.http.delete<{ success: true }>(`${this.baseUrl}/layers/${layerId}/attachments/${attachmentId}`);
  }

  history(layerId: string, featureId?: number): Observable<FeatureHistoryEntry[]> {
    const params: Record<string, number> = featureId !== undefined ? { featureId } : {};
    return this.http.get<FeatureHistoryEntry[]>(`${this.baseUrl}/layers/${layerId}/history`, { params });
  }

  /** Save selection as layer: the chosen features published as a new layer. */
  saveSelection(layerId: string, featureIds: number[], name: string): Observable<GisLayer> {
    return this.http.post<GisLayer>(`${this.baseUrl}/layers/${layerId}/save-selection`, { featureIds, name });
  }

  geoprocess(request: GeoprocessRequest): Observable<GisLayer> {
    return this.http.post<GisLayer>(`${this.baseUrl}/geoprocessing`, request);
  }

  impactCsv(layerId: string, geometry: Record<string, unknown>, distance = 0): Observable<Blob> {
    return this.http.post(`${this.baseUrl}/layers/${layerId}/impact`, { geometry, distance }, { responseType: 'blob' });
  }
}
