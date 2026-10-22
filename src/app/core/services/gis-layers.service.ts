import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { GisLayer } from '../models/gis-layer.model';
import { LayerExportFormat } from '../models/layer-export.model';
import { AnalyticsField, FieldSummary, GroupRequest, GroupResult, LayerProfile } from '../models/layer-analytics.model';
import { GisLayerPermissionMatrix, GisPermission } from '../models/gis-layer-permission.model';
import { ManagedRole } from '../models/municipality-user.model';

/** Body of POST /api/gis/layers/:id/report (a PDF layer data report). */
export interface LayerReportRequest {
  title?: string;
  fields: string[];
  scope: 'layer' | 'query' | 'selection';
  cqlFilter?: string;
  scopeLabel?: string;
  featureIds?: string[];
}

/** Talks to /api/gis/layers*. Tenant scoping AND Task 8 permission
 *  enforcement happen entirely server-side — this service never
 *  replicates that logic. */
@Injectable({ providedIn: 'root' })
export class GisLayersService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/gis/layers`;

  /** Server-side permission-filtered — the response only ever contains
   *  layers the caller has VIEW permission for (Task 8 §8). */
  list(): Observable<GisLayer[]> {
    return this.http.get<GisLayer[]>(this.baseUrl);
  }

  getById(id: string): Observable<GisLayer> {
    return this.http.get<GisLayer>(`${this.baseUrl}/${id}`);
  }

  /** Gated by EXPORT permission server-side. Returns the file as a Blob
   *  (binary-safe for zipped shapefiles) — the backend fetches it from
   *  GeoServer itself and streams it back, never a GeoServer URL handed to
   *  the browser, which would bypass this permission check entirely. */
  /** `filter` exports only matching features (built safely server-side). */
  export(id: string, format: LayerExportFormat = 'geojson', filter?: { field: string; op: string; value: string }): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/${id}/export`, {
      params: filter ? { format, field: filter.field, op: filter.op, value: filter.value } : { format },
      responseType: 'blob'
    });
  }

  /** Analytics (VIEW-gated server-side): the layer's attribute fields. */
  analyticsFields(id: string): Observable<AnalyticsField[]> {
    return this.http.get<AnalyticsField[]>(`${this.baseUrl}/${id}/analytics/fields`);
  }

  /** Analytics: whole-layer profile behind the auto-built overview. */
  analyticsProfile(id: string): Observable<LayerProfile> {
    return this.http.get<LayerProfile>(`${this.baseUrl}/${id}/analytics/profile`);
  }

  /** Analytics: a measure per attribute value or per area of another layer. */
  analyticsGroup(id: string, request: GroupRequest): Observable<GroupResult> {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(request)) {
      if (value) params[key] = value;
    }
    return this.http.get<GroupResult>(`${this.baseUrl}/${id}/analytics/group`, { params });
  }

  /** Analytics: one area's outline (EPSG:4326 WKT) for a map filter. */
  analyticsAreaShape(id: string, field: string, value: string): Observable<{ wkt: string | null }> {
    return this.http.get<{ wkt: string | null }>(`${this.baseUrl}/${id}/analytics/area-shape`, { params: { field, value } });
  }

  /** Analytics: whole-layer summary of one field. */
  analyticsSummary(id: string, field: string): Observable<FieldSummary> {
    return this.http.get<FieldSummary>(`${this.baseUrl}/${id}/analytics/summary`, { params: { field } });
  }

  /** Report Generation (VIEW-gated server-side) — the PDF as a Blob. */
  report(id: string, request: LayerReportRequest): Observable<Blob> {
    return this.http.post(`${this.baseUrl}/${id}/report`, request, { responseType: 'blob' });
  }

  /** Hard-deletes a layer — unpublishes it from GeoServer and drops its
   *  data. Owner-only, enforced server-side. */
  /** Display name only (Owner). */
  rename(id: string, name: string): Observable<{ id: string; name: string }> {
    return this.http.patch<{ id: string; name: string }>(`${this.baseUrl}/${id}`, { name });
  }

  delete(id: string): Observable<{ success: true }> {
    return this.http.delete<{ success: true }>(`${this.baseUrl}/${id}`);
  }

  /** Gated by MANAGE permission server-side. */
  getPermissions(id: string): Observable<GisLayerPermissionMatrix> {
    return this.http.get<GisLayerPermissionMatrix>(`${this.baseUrl}/${id}/permissions`);
  }

  /** One checkbox toggle per call — gated by MANAGE and the self-grant
   *  guard, both enforced server-side. */
  setPermission(
    id: string,
    departmentId: string,
    role: ManagedRole,
    permission: GisPermission,
    granted: boolean
  ): Observable<GisLayerPermissionMatrix> {
    return this.http.put<GisLayerPermissionMatrix>(`${this.baseUrl}/${id}/permissions`, {
      departmentId,
      role,
      permission,
      granted
    });
  }
}
