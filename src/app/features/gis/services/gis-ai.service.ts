import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { GisAiHealth, GisChatResponse } from '../models/gis-ai.model';

/**
 * Client for the natural-language GIS assistant (`/api/gis/ai/*`). The
 * NestJS backend proxies to the Python AI/RAG service, validates the
 * structured plan it returns, and executes it as one read-only PostGIS
 * query — so this service only ever exchanges plain JSON.
 */
@Injectable({ providedIn: 'root' })
export class GisAiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/gis/ai`;

  chat(
    message: string,
    history: { role: 'user' | 'assistant'; content: string }[] = [],
    activeLayerId?: string | null,
  ): Observable<GisChatResponse> {
    return this.http.post<GisChatResponse>(`${this.baseUrl}/chat`, {
      message,
      history,
      activeLayerId: activeLayerId ?? undefined,
    });
  }

  health(): Observable<GisAiHealth> {
    return this.http.get<GisAiHealth>(`${this.baseUrl}/health`);
  }

  reindex(): Observable<Record<string, unknown>> {
    return this.http.post<Record<string, unknown>>(
      `${this.baseUrl}/reindex`,
      {},
    );
  }
}
