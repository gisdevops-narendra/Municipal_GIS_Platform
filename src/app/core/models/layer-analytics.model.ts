/** GET /api/gis/layers/:id/analytics/* — mirrors the backend FieldStatsService
 *  `AttributeInfo` / `FieldSummary`. */
export type AnalyticsFieldKind = 'string' | 'number' | 'date' | 'boolean' | 'geometry' | 'other';

export interface AnalyticsField {
  name: string;
  type: string;
  kind: AnalyticsFieldKind;
}

export interface HistogramBin {
  from: number;
  to: number;
  count: number;
}

export interface FieldSummary {
  field: string;
  kind: AnalyticsFieldKind;
  total: number;
  nonNull: number;
  numeric?: {
    min: number;
    max: number;
    mean: number;
    sum: number;
    median: number;
    histogram: HistogramBin[];
  };
  categories?: { value: string; count: number }[];
  distinctCount?: number;
  otherCount?: number;
}

/** What a field is good for in the overview — inferred server-side from
 *  its values, never from layer / field names. */
export type FieldRole = 'id' | 'category' | 'measure' | 'date' | 'text' | 'constant' | 'empty';

export interface FieldProfile {
  name: string;
  kind: AnalyticsFieldKind;
  role: FieldRole;
  nonNull: number;
  distinct: number;
  numeric?: { min: number; max: number; sum: number; mean: number };
}

/** GET /api/gis/layers/:id/analytics/profile */
export interface LayerProfile {
  total: number;
  geometry: { kind: 'point' | 'line' | 'polygon' | 'mixed' | null; lengthKm?: number; areaHa?: number };
  fields: FieldProfile[];
  categories: { field: string; distinct: number; values: { value: string; count: number }[]; otherCount: number }[];
  timelines: { field: string; unit: 'month' | 'year'; points: { period: string; count: number }[] }[];
}

export type GroupMeasure = 'count' | 'sum' | 'avg' | 'length' | 'area';

/** GET /api/gis/layers/:id/analytics/group — null key = no value, or
 *  outside every area when grouped by an area layer. */
export interface GroupResult {
  measure: GroupMeasure;
  groups: { key: string | null; count: number; value: number }[];
  other?: { groups: number; count: number; value: number };
  /** Area outlines (EPSG:4326 GeoJSON) — area grouping with `shapes`. */
  shapes?: { key: string | null; geometry: Record<string, unknown> }[];
}

export interface GroupRequest {
  by?: string;
  areaLayer?: string;
  areaField?: string;
  measure: GroupMeasure;
  measureField?: string;
  shapes?: 'true';
}

/** Module Access catalog ids (seed-modules.ts). */
export const ANALYTICS_MODULE_ID = 186;
export const DATA_VISUALISATION_MODULE_ID = 229;
