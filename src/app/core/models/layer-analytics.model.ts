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

/** Module Access catalog ids (seed-modules.ts). */
export const ANALYTICS_MODULE_ID = 186;
export const DATA_VISUALISATION_MODULE_ID = 229;
