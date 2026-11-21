import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { GisSearchResult } from '../models/gis-dashboard.model';

/** Layer search for the map (/api/gis/dashboard/search). Tenant scoping AND Task 8 permission
 *  enforcement happen entirely server-side — this service never
 *  replicates that logic. */
@Injectable({ providedIn: 'root' })
export class GisDashboardService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/gis/dashboard`;

  search(query: string): Observable<GisSearchResult> {
    const params = new HttpParams().set('q', query);
    return this.http.get<GisSearchResult>(`${this.baseUrl}/search`, { params });
  }
}
