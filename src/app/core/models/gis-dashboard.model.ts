export interface GisSearchLayerMatch {
  id: string;
  name: string;
  code: string;
  ownershipType: 'CANONICAL' | 'DEPARTMENT';
  /** `semantic`: related by meaning ("drainage" → Storm Water Lines), not
   *  by name — found through the AI assistant's index. */
  match?: 'name' | 'semantic';
  matchedField?: string | null;
}

export interface GisSearchFeatureMatch {
  layerId: string;
  layerName: string;
  layerCode: string;
  attributes: Record<string, unknown>;
  bbox: [number, number, number, number] | null;
  /** The feature's shape (GeoJSON, EPSG:4326) and a point inside it. */
  geometry?: Record<string, unknown> | null;
  anchor?: [number, number] | null;
  /** Fuzzy search: the field / value that matched — the result's title. */
  matchedField?: string;
  label?: string;
}

/** Shape of GET /api/gis/dashboard/search?q= — layer name/code matches
 *  plus a bounded set of feature-attribute matches. Not a property/
 *  cadastral search system (Task 9 §5). */
export interface GisSearchResult {
  layers: GisSearchLayerMatch[];
  features: GisSearchFeatureMatch[];
}
