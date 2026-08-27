import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { GisLayer } from '../models/gis-layer.model';
import { GisLayerPermissionMatrix, GisPermission } from '../models/gis-layer-permission.model';
import { ManagedRole } from '../models/municipality-user.model';

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

  /** Gated by EXPORT permission server-side. Returns the raw GeoJSON text
   *  (the backend fetches it from GeoServer itself and streams it back —
   *  never a GeoServer URL handed to the browser, which would bypass this
   *  permission check entirely). */
  export(id: string): Observable<string> {
    return this.http.get(`${this.baseUrl}/${id}/export`, { responseType: 'text' });
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
