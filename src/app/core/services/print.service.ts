import { HttpClient, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { PrintCapabilities, PrintReportRequest } from '../models/print.model';

/** Talks to /api/gis/print*. The backend owns the MapFish Print spec,
 *  tenant scoping and GeoServer URL rewriting — this service just carries
 *  the request and streams the resulting PDF/PNG back as a Blob. */
@Injectable({ providedIn: 'root' })
export class PrintService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/gis/print`;

  /** MapFish's capabilities — the panel uses it to confirm the DPI list
   *  and available formats. */
  capabilities(): Observable<PrintCapabilities> {
    return this.http.get<PrintCapabilities>(`${this.baseUrl}/capabilities`);
  }

  /** Generates one report. `observe: 'response'` so the caller can read the
   *  `Content-Disposition` filename and `Content-Type`. */
  report(request: PrintReportRequest): Observable<HttpResponse<Blob>> {
    return this.http.post(`${this.baseUrl}/report`, request, {
      responseType: 'blob',
      observe: 'response'
    });
  }
}
