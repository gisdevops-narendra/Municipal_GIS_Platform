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

export interface AiGisOperation {
  kind: 'select';
  target_layer: string;
  attribute_filters?: AiAttributeFilter[];
  spatial_filter?: AiSpatialFilter | null;
  limit?: number | null;
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
}

export interface GisChatResponse {
  answerKind: AiAnswerKind;
  explanation: string;
  clarification?: string;
  usedContext: string[];
  operation?: AiGisOperation;
  compiledSql?: string;
  compiledSummary?: string;
  result?: AiChatResult;
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
  pending?: boolean;
  error?: boolean;
}
