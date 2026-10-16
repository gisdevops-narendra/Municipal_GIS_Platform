import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { GisLayer } from '../../../core/models/gis-layer.model';
import { FieldRule, FieldRules } from './vector-tools.service';

/** Module Access catalog ids (seed-modules.ts). */
export const DATA_TOOLS_MODULE_ID = 1010;
export const FIELD_CALCULATOR_MODULE_ID = 1011;
export const TABLE_JOIN_MODULE_ID = 1012;
export const GEOCODE_MODULE_ID = 1013;
export const TOPOLOGY_MODULE_ID = 1014;
export const FIELD_RULES_MODULE_ID = 1015;
export const VERSIONS_MODULE_ID = 1016;
export const DATA_TOOL_MODULE_IDS = [1011, 1012, 1013, 1014, 1015, 1016];

export type NewFieldType = 'text' | 'double precision' | 'integer' | 'date' | 'boolean';

export interface TopologyIssue {
  check: 'invalid' | 'empty' | 'duplicate' | 'overlap' | 'gap' | 'dangle' | 'rule' | 'outlier';
  featureIds: number[];
  detail: string;
  geometry: Record<string, unknown> | null;
}

export interface LayerSnapshot {
  id: string;
  name: string;
  featureCount: number;
  createdAt: string;
}

export interface ChangeSet {
  count: number;
  features: { key: string; geometry: Record<string, unknown> | null; geometryChanged: boolean; changedFields: string[] }[];
}

export interface SnapshotComparison {
  snapshot: { id: string; name: string; createdAt: string };
  key: string;
  /** Columns added / dropped since the snapshot (not compared per feature). */
  fields: { added: string[]; removed: string[] };
  added: ChangeSet;
  removed: ChangeSet;
  modified: ChangeSet;
}

export interface GeocodeResult {
  layer: GisLayer;
  matched: number;
  unmatchedCount: number;
  unmatched: { row: number; address: string }[];
}

/** GIS Data Tools (DataToolsController). Permissions are enforced server-side. */
@Injectable({ providedIn: 'root' })
export class DataToolsService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/gis`;

  fieldCalculate(
    layerId: string,
    body: { field: string; expression: string; newFieldType?: NewFieldType; preview?: boolean }
  ): Observable<{ field?: string; changed?: number; preview?: { id: number; value: string | null }[] }> {
    return this.http.post<{ field?: string; changed?: number; preview?: { id: number; value: string | null }[] }>(
      `${this.baseUrl}/layers/${layerId}/field-calculator`,
      body
    );
  }

  joinTable(
    layerId: string,
    file: File,
    layerKey: string,
    tableKey: string,
    columns: string[]
  ): Observable<{ matchedFeatures: number; changedFeatures: number; csvRows: number; fields: string[] }> {
    const form = new FormData();
    form.append('file', file);
    form.append('layerKey', layerKey);
    form.append('tableKey', tableKey);
    if (columns.length) form.append('columns', columns.join(','));
    return this.http.post<{ matchedFeatures: number; changedFeatures: number; csvRows: number; fields: string[] }>(
      `${this.baseUrl}/layers/${layerId}/join-table`,
      form
    );
  }

  geocode(
    file: File,
    body: { addressColumn: string; referenceLayerId: string; referenceField: string; outputName: string; minScore: number }
  ): Observable<GeocodeResult> {
    const form = new FormData();
    form.append('file', file);
    Object.entries(body).forEach(([k, v]) => form.append(k, String(v)));
    return this.http.post<GeocodeResult>(`${this.baseUrl}/geocode`, form);
  }

  validate(
    layerId: string,
    maxGapArea: number,
    outliers: { enabled: boolean; groupField: string | null } = { enabled: true, groupField: null }
  ): Observable<{ issues: TopologyIssue[]; counts: Record<string, number>; truncated: boolean }> {
    return this.http.post<{ issues: TopologyIssue[]; counts: Record<string, number>; truncated: boolean }>(
      `${this.baseUrl}/layers/${layerId}/validate`,
      { maxGapArea, outliers: outliers.enabled, outlierGroupField: outliers.groupField ?? undefined }
    );
  }

  fix(layerId: string, kind: 'invalid' | 'duplicates' | 'empty'): Observable<{ fixed: number }> {
    return this.http.post<{ fixed: number }>(`${this.baseUrl}/layers/${layerId}/validate/fix`, { kind });
  }

  fieldRules(layerId: string): Observable<{ rules: FieldRules; fields: { name: string; type: string }[] }> {
    return this.http.get<{ rules: FieldRules; fields: { name: string; type: string }[] }>(`${this.baseUrl}/layers/${layerId}/field-rules`);
  }

  setFieldRules(layerId: string, rules: (FieldRule & { field: string })[]): Observable<{ rules: FieldRules }> {
    return this.http.put<{ rules: FieldRules }>(`${this.baseUrl}/layers/${layerId}/field-rules`, { rules });
  }

  snapshots(layerId: string): Observable<LayerSnapshot[]> {
    return this.http.get<LayerSnapshot[]>(`${this.baseUrl}/layers/${layerId}/snapshots`);
  }

  createSnapshot(layerId: string, name: string): Observable<LayerSnapshot> {
    return this.http.post<LayerSnapshot>(`${this.baseUrl}/layers/${layerId}/snapshots`, { name });
  }

  compare(layerId: string, snapshotId: string, key?: string): Observable<SnapshotComparison> {
    const params: Record<string, string> = key ? { key } : {};
    return this.http.get<SnapshotComparison>(`${this.baseUrl}/layers/${layerId}/snapshots/${snapshotId}/compare`, { params });
  }

  restore(layerId: string, snapshotId: string): Observable<{ success: true }> {
    return this.http.post<{ success: true }>(`${this.baseUrl}/layers/${layerId}/snapshots/${snapshotId}/restore`, {});
  }

  deleteSnapshot(layerId: string, snapshotId: string): Observable<{ success: true }> {
    return this.http.delete<{ success: true }>(`${this.baseUrl}/layers/${layerId}/snapshots/${snapshotId}`);
  }
}
