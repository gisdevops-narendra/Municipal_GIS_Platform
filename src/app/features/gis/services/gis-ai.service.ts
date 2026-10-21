import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { AiGisOperation, AiQueryLogEntry, GisAiHealth, GisChatResponse } from '../models/gis-ai.model';

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
    previousOperation?: AiGisOperation,
    resolvedOperation?: AiGisOperation,
  ): Observable<GisChatResponse> {
    return this.http.post<GisChatResponse>(`${this.baseUrl}/chat`, {
      message,
      history,
      activeLayerId: activeLayerId ?? undefined,
      previousOperation,
      resolvedOperation,
    });
  }

  /** LLM wording of an answer the backend already computed; `text` is
   *  null when the model failed or strayed from the numbers. */
  narrate(question: string, facts: Record<string, unknown>): Observable<{ text: string | null }> {
    return this.http.post<{ text: string | null }>(`${this.baseUrl}/narrate`, { question, facts });
  }

  /** Plain-language explanation of a Raster Analysis result. */
  explain(
    title: string,
    facts: { label: string; value: string }[],
    rows?: Record<string, unknown>[],
  ): Observable<{ text: string | null }> {
    return this.http.post<{ text: string | null }>(`${this.baseUrl}/explain`, { title, facts, rows });
  }

  /** Primes the assistant's model cache so the first question is fast. */
  warm(): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`${this.baseUrl}/warm`, {});
  }

  /** Example questions built from the user's real layers (each one works). */
  suggestions(): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/suggestions`);
  }

  /** 👍/👎 on one of the user's own answers. */
  feedback(logId: string, helpful: boolean): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`${this.baseUrl}/feedback`, { logId, helpful });
  }

  /** Owner: the municipality's recent questions (problems = 👎/errors/unanswered). */
  logs(problemsOnly = false): Observable<AiQueryLogEntry[]> {
    return this.http.get<AiQueryLogEntry[]>(`${this.baseUrl}/logs`, {
      params: { problems: String(problemsOnly), limit: '100' },
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
