import { HttpClient, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import {
  AiChatOptions,
  AiConversationDetail,
  AiConversationSummary,
  AiGisOperation,
  AiInstruction,
  AiQueryLogEntry,
  GisAiHealth,
  GisChatResponse,
} from '../models/gis-ai.model';

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
    conversationId?: string | null,
    options: AiChatOptions = {},
  ): Observable<GisChatResponse> {
    return this.http.post<GisChatResponse>(`${this.baseUrl}/chat`, {
      message,
      history,
      activeLayerId: activeLayerId ?? undefined,
      previousOperation,
      resolvedOperation,
      conversationId: conversationId ?? undefined,
      ...options,
    });
  }

  /** LLM wording of an answer the backend already computed; `text` is
   *  null when the model failed or strayed from the numbers. */
  narrate(
    question: string,
    facts: Record<string, unknown>,
    language?: 'en' | 'mr' | 'hi',
  ): Observable<{ text: string | null }> {
    return this.http.post<{ text: string | null }>(`${this.baseUrl}/narrate`, { question, facts, language });
  }

  /** The features an answer matched, as a CSV or GeoJSON file. */
  export(operation: AiGisOperation, format: 'csv' | 'geojson'): Observable<HttpResponse<Blob>> {
    return this.http.post(`${this.baseUrl}/export`, { operation, format }, { observe: 'response', responseType: 'blob' });
  }

  /** The features an answer matched, saved as a new layer. */
  saveAsLayer(operation: AiGisOperation, name: string): Observable<{ id: string; name: string }> {
    return this.http.post<{ id: string; name: string }>(`${this.baseUrl}/save-layer`, { operation, name });
  }

  /** An answer as a Dashboard tile. */
  pinToDashboard(tile: { title: string; value: string; detail?: string; layerId?: string }): Observable<unknown> {
    return this.http.post(`${this.baseUrl}/pin`, tile);
  }

  /** "Delete all my chats". */
  deleteAllConversations(): Observable<{ deleted: number }> {
    return this.http.delete<{ deleted: number }>(`${this.baseUrl}/conversations`);
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

  conversations(): Observable<AiConversationSummary[]> {
    return this.http.get<AiConversationSummary[]>(`${this.baseUrl}/conversations`);
  }

  conversation(id: string): Observable<AiConversationDetail> {
    return this.http.get<AiConversationDetail>(`${this.baseUrl}/conversations/${id}`);
  }

  deleteConversation(id: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`${this.baseUrl}/conversations/${id}`);
  }

  pinConversation(id: string, pinned: boolean): Observable<{ ok: true }> {
    return this.http.patch<{ ok: true }>(`${this.baseUrl}/conversations/${id}`, { pinned });
  }

  removeInstruction(id: string, index: number): Observable<{ instructions: AiInstruction[] }> {
    return this.http.delete<{ instructions: AiInstruction[] }>(`${this.baseUrl}/conversations/${id}/instructions/${index}`);
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
