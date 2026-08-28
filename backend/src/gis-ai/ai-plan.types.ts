/**
 * The structured plan the Python AI service returns. This is the ONLY
 * artefact accepted back from the LLM side — every field is re-validated
 * against the caller's real, authorised layer catalog in
 * `GisQueryCompilerService` before any SQL is built. The LLM never sees or
 * writes SQL.
 */

export type AttrOp =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'in'
  | 'not_in'
  | 'like'
  | 'ilike'
  | 'between'
  | 'is_null'
  | 'is_not_null';

export type SpatialRelation =
  | 'within_distance'
  | 'intersects'
  | 'within'
  | 'contains'
  | 'disjoint';

export type AnswerKind =
  | 'gis_operation'
  | 'clarification'
  | 'answer'
  | 'unsupported';

export interface AiAttributeFilter {
  field: string;
  op: AttrOp;
  value?: string | number | boolean | null;
  value2?: string | number | boolean | null;
  values?: (string | number | boolean)[] | null;
}

export interface AiSpatialFilter {
  relation: SpatialRelation;
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

export interface AiPlanResult {
  answer_kind: AnswerKind;
  explanation: string;
  operation?: AiGisOperation | null;
  clarification?: string | null;
  used_context?: string[];
}
