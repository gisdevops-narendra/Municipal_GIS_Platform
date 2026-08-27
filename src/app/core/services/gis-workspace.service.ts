import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { GeoServerHealth, GisWorkspace, UpdateGisWorkspaceRequest } from '../models/gis-workspace.model';

/** Talks to /api/gis/*. Angular never talks to GeoServer directly — this
 *  service, like every other core service, only ever calls our own NestJS
 *  API. Tenant scoping and MUNICIPALITY_OWNER enforcement happen entirely
 *  server-side. */
@Injectable({ providedIn: 'root' })
export class GisWorkspaceService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/gis`;

  getWorkspace(): Observable<GisWorkspace> {
    return this.http.get<GisWorkspace>(`${this.baseUrl}/workspace`);
  }

  updateWorkspace(request: UpdateGisWorkspaceRequest): Observable<GisWorkspace> {
    return this.http.patch<GisWorkspace>(`${this.baseUrl}/workspace`, request);
  }

  retryProvisioning(): Observable<GisWorkspace> {
    return this.http.post<GisWorkspace>(`${this.baseUrl}/workspace/provision`, {});
  }

  getGeoServerHealth(): Observable<GeoServerHealth> {
    return this.http.get<GeoServerHealth>(`${this.baseUrl}/geoserver/health`);
  }
}
