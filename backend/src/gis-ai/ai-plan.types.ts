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

export type OperationKind =
  | 'select'
  | 'aggregate'
  | 'nearest'
  | 'buffer'
  | 'route'
  | 'service_area';

export type AggregateMetric = 'count' | 'sum' | 'avg' | 'min' | 'max';

/**
 * One flat shape for every kind (a small model fills a flat object far more
 * reliably than a discriminated union); each kind reads only its fields.
 * `target_layer` + `attribute_filters` + `spatial_filter` always pick the
 * features the operation starts from.
 */
export interface AiGisOperation {
  kind: OperationKind;
  target_layer: string;
  attribute_filters?: AiAttributeFilter[];
  spatial_filter?: AiSpatialFilter | null;
  limit?: number | null;
  /** select: sort by this column (with `limit` = "the 10 tallest"). */
  order_by?: string | null;
  order_desc?: boolean | null;
  // aggregate
  metric?: AggregateMetric | null;
  metric_field?: string | null;
  group_by?: string | null;
  group_by_layer?: string | null;
  group_by_layer_field?: string | null;
  // nearest
  reference_layer?: string | null;
  reference_filters?: AiAttributeFilter[];
  count?: number | null;
  // buffer / service_area
  distance_meters?: number | null;
  // route
  to_layer?: string | null;
  to_filters?: AiAttributeFilter[];
  network_layer?: string | null;
}

export interface AiPlanResult {
  answer_kind: AnswerKind;
  explanation: string;
  operation?: AiGisOperation | null;
  clarification?: string | null;
  used_context?: string[];
  /** Which path produced the plan: the no-LLM fast path or the model. */
  planner?: 'fast' | 'model' | null;
}
