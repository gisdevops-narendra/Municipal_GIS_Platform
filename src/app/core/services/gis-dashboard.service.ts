import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { GisDashboardSummary, GisDepartmentSummary, GisSearchResult } from '../models/gis-dashboard.model';

/** Talks to /api/gis/dashboard/*. Tenant scoping AND Task 8 permission
 *  enforcement happen entirely server-side — this service never
 *  replicates that logic. */
@Injectable({ providedIn: 'root' })
export class GisDashboardService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/gis/dashboard`;

  getSummary(): Observable<GisDashboardSummary> {
    return this.http.get<GisDashboardSummary>(`${this.baseUrl}/summary`);
  }

  getDepartments(): Observable<GisDepartmentSummary[]> {
    return this.http.get<GisDepartmentSummary[]>(`${this.baseUrl}/departments`);
  }

  search(query: string): Observable<GisSearchResult> {
    const params = new HttpParams().set('q', query);
    return this.http.get<GisSearchResult>(`${this.baseUrl}/search`, { params });
  }
}
