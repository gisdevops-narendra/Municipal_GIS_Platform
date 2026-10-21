import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiPlanResult } from './ai-plan.types';

export interface AiLayerField {
  name: string;
  type: string;
  sample_values: string[];
}

export interface AiLayerInfo {
  id: string;
  code: string;
  name: string;
  geometry_type: string | null;
  description: string | null;
  fields: AiLayerField[];
}

export interface AiPlanRequest {
  message: string;
  municipality_id: string;
  municipality_name?: string;
  layers: AiLayerInfo[];
  history: { role: 'user' | 'assistant'; content: string }[];
  previous_operation?: Record<string, unknown>;
}

export interface AiNarrateRequest {
  kind: 'query' | 'raster';
  question: string;
  /** Backend-computed, verified numbers — the model only rephrases them. */
  facts: Record<string, unknown>;
  municipality_name?: string;
}

export interface AiNarrateResult {
  text: string;
  /** False when the model's text was rejected (it introduced a number not
   *  in the facts) — the caller keeps its own deterministic sentence. */
  grounded: boolean;
}

export interface AiSearchHit {
  layer_id: string;
  field: string | null;
  title: string;
  score: number;
}

/**
 * Thin HTTP client for the Python AI/RAG service (`ai/`). The Node backend
 * is the only caller — the browser never talks to it directly.
 */
@Injectable()
export class AiClientService {
  private readonly logger = new Logger(AiClientService.name);
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config
      .get<string>('GIS_AI_URL', 'http://localhost:8000')
      .replace(/\/+$/, '');
  }

  async health(): Promise<Record<string, unknown>> {
    return this.request('GET', '/health', undefined, 5000);
  }

  async plan(body: AiPlanRequest): Promise<AiPlanResult> {
    // A local CPU model can take 30-120 s for a full structured response;
    // the Python side caps itself at GIS_AI_LLM_TIMEOUT_S (default 180).
    const raw = await this.request('POST', '/plan', body, 240000);
    return raw as unknown as AiPlanResult;
  }

  /** Reads the municipality's plan prompt into the model's cache (~40 s on
   *  CPU the first time) so the next /plan is fast. Best effort. */
  async warm(body: AiPlanRequest): Promise<void> {
    await this.request('POST', '/warm', body, 240000, true);
  }

  /** One extra local-LLM call (~10-60 s on CPU) — always optional for the
   *  caller, which already holds a correct deterministic sentence. */
  async narrate(body: AiNarrateRequest, timeoutMs = 150000): Promise<AiNarrateResult> {
    const raw = await this.request('POST', '/narrate', body, timeoutMs);
    return raw as unknown as AiNarrateResult;
  }

  /** Semantic layer search over this municipality's RAG layer/field docs.
   *  Embedding only (no LLM), so it is fast; `[]` on any failure. */
  async searchLayers(municipalityId: string, query: string, timeoutMs = 4000): Promise<AiSearchHit[]> {
    try {
      const raw = await this.request(
        'POST',
        '/search',
        { municipality_id: municipalityId, query, top_k: 12 },
        timeoutMs,
        true,
      );
      return Array.isArray(raw) ? (raw as unknown as AiSearchHit[]) : [];
    } catch {
      return [];
    }
  }

  async reindex(municipalityId: string): Promise<Record<string, unknown>> {
    return this.request(
      'POST',
      '/reindex',
      { municipality_id: municipalityId },
      120000,
    );
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
    quiet = false,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : {};
      if (!response.ok) {
        const detail =
          (parsed as { detail?: string }).detail ??
          `AI service returned HTTP ${response.status}`;
        throw new ServiceUnavailableException(detail);
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      if (!quiet) this.logger.error(
        `AI service call ${method} ${path} failed: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'The AI assistant service is unavailable.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
