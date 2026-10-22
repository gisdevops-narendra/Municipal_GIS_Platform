import { GeoJsonGeometry } from './attribute-table.model';

/** Mirrors the NestJS `GisChatResponse` (backend/src/gis-ai). */

export type AiAnswerKind =
  | 'gis_operation'
  | 'clarification'
  | 'answer'
  | 'unsupported';

export interface AiAttributeFilter {
  field: string;
  op: string;
  value?: string | number | boolean | null;
  value2?: string | number | boolean | null;
  values?: (string | number | boolean)[] | null;
}

export interface AiSpatialFilter {
  relation: string;
  reference_layer: string;
  distance_meters?: number | null;
  reference_filters?: AiAttributeFilter[];
}

export type AiOperationKind =
  | 'select'
  | 'aggregate'
  | 'nearest'
  | 'buffer'
  | 'route'
  | 'service_area';

export type AiAggregateMetric = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface AiGisOperation {
  kind: AiOperationKind;
  target_layer: string;
  attribute_filters?: AiAttributeFilter[];
  spatial_filter?: AiSpatialFilter | null;
  spatial_filters?: AiSpatialFilter[];
  limit?: number | null;
  metric?: AiAggregateMetric | null;
  metric_field?: string | null;
  group_by?: string | null;
  group_by_layer?: string | null;
  group_by_layer_field?: string | null;
  reference_layer?: string | null;
  reference_filters?: AiAttributeFilter[];
  count?: number | null;
  distance_meters?: number | null;
  to_layer?: string | null;
  to_filters?: AiAttributeFilter[];
  network_layer?: string | null;
}

export interface AiChatResult {
  layerId: string;
  layerCode: string;
  layerName: string;
  geometryType: string | null;
  matched: number;
  truncated: boolean;
  cql: string | null;
  geometries: GeoJsonGeometry[];
  /** true: `cql` is the question's own conditions — GeoServer filters the
   *  layer itself, so every match shows and no geometries are sent. */
  exact?: boolean;
  /** EPSG:4326 [minX, minY, maxX, maxY] of every match. */
  bbox?: [number, number, number, number] | null;
}

/** "From now on only show working signals" -> a rule for the chat. */
export interface AiInstruction {
  text: string;
  layer?: string | null;
  near_m?: number | null;
}

/** One saved chat (history panel). */
/** Assistant settings sent with each question (see `GisChatDto`). */
export interface AiChatOptions {
  layerIds?: string[];
  instantOnly?: boolean;
  saveHistory?: boolean;
  nearMeters?: number;
  format?: {
    numberLocale?: string;
    distanceUnit?: 'auto' | 'm' | 'km';
    areaUnit?: 'auto' | 'sqm' | 'ha' | 'acre';
  };
}

export interface AiConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  pinned?: boolean;
}

export interface AiConversationDetail {
  id: string;
  title: string;
  instructions: AiInstruction[];
  turns: { question: string; response: GisChatResponse; logId: string; feedback: 1 | -1 | null }[];
}

/** A clickable choice: re-ask with `message`, or run `operation` as is. */
export interface AiClarifyOption {
  label: string;
  message?: string | null;
  operation?: AiGisOperation | null;
}

export interface GisChatResponse {
  answerKind: AiAnswerKind;
  explanation: string;
  /** Question-log row — sent back with 👍/👎. */
  logId?: string;
  /** "fast" = answered without the language model; "choice" = a clicked option. */
  planner?: 'fast' | 'model' | 'choice' | null;
  /** Clickable choices (clarification, "Did you mean …"). */
  options?: AiClarifyOption[];
  /** How the question was read, e.g. a corrected spelling. */
  notes?: string[];
  /** Suggested next questions shown under the answer. */
  followUps?: string[];
  /** Server-side chat this answer belongs to. */
  conversationId?: string;
  /** Standing instructions in force in that chat. */
  instructions?: AiInstruction[];
  clarification?: string;
  usedContext: string[];
  operation?: AiGisOperation;
  compiledSql?: string;
  compiledSummary?: string;
  /** The answer in a sentence, computed from the real numbers. */
  answer?: string;
  /** The verified numbers behind `answer` (sent to /narrate). */
  facts?: Record<string, unknown>;
  result?: AiChatResult;
  aggregate?: {
    metric: AiAggregateMetric;
    metricLabel: string | null;
    groupLabel: string | null;
    rows: { group: string | null; value: number | null; count: number }[];
    truncated: boolean;
  };
  nearest?: {
    referenceLayer: string;
    referenceLabel: string | null;
    referenceCount: number;
    items: { id: number | string; label: string | null; distanceM: number }[];
  };
  buffer?: { distanceM: number; sources: number; areaM2: number | null };
  route?: {
    networkLayer: string;
    from: { label: string; layer: string; matches: number };
    to: { label: string; layer: string; matches: number };
    lengthM: number;
  };
  serviceArea?: {
    networkLayer: string;
    origin: { label: string; layer: string; matches: number };
    distanceM: number;
    roadLengthM: number;
  };
  /** Extra shapes to draw: buffer, route, service area, reference. */
  overlays?: GeoJsonGeometry[];
}

export interface GisAiHealth {
  status: string;
  database?: boolean;
  llm_provider?: string;
  llm_model?: string;
  llm_reachable?: boolean;
  llm_model_ready?: boolean;
  embedding_model?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** assistant-only rich payload */
  response?: GisChatResponse;
  /** The LLM's wording of `response.answer`, once it arrives. */
  narration?: string;
  /** Waiting for the LLM wording (the computed answer already shows). */
  narrating?: boolean;
  pending?: boolean;
  error?: boolean;
  /** The user's rating of this answer: 1 helpful, -1 not helpful. */
  feedback?: 1 | -1;
}

/** One row of GET /api/gis/ai/logs (Owner). */
export interface AiQueryLogEntry {
  id: string;
  createdAt: string;
  user: string | null;
  question: string;
  answerKind: string;
  planner: 'fast' | 'model' | null;
  matched: number | null;
  durationMs: number;
  explanation: string | null;
  error: string | null;
  feedback: 1 | -1 | null;
}
