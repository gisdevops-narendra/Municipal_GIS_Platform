/** Shape of GET /api/gis/dashboard/summary — municipality-scoped counts
 *  only, server-side permission-filtered (Task 9 §1/§13). */
export interface GisDashboardSummary {
  totalLayers: number;
  publishedLayers: number;
  draftLayers: number;
  departments: number;
  dataSources: number;
}

/** Shape of one entry from GET /api/gis/dashboard/departments — a
 *  department plus how many GIS layers the caller may VIEW in it. */
export interface GisDepartmentSummary {
  departmentId: string;
  departmentName: string;
  layerCount: number;
}

export interface GisSearchLayerMatch {
  id: string;
  name: string;
  code: string;
  ownershipType: 'CANONICAL' | 'DEPARTMENT';
  departmentName: string | null;
}

export interface GisSearchFeatureMatch {
  layerId: string;
  layerName: string;
  layerCode: string;
  attributes: Record<string, unknown>;
  bbox: [number, number, number, number] | null;
}

/** Shape of GET /api/gis/dashboard/search?q= — layer name/code matches
 *  plus a bounded set of feature-attribute matches. Not a property/
 *  cadastral search system (Task 9 §5). */
export interface GisSearchResult {
  layers: GisSearchLayerMatch[];
  features: GisSearchFeatureMatch[];
}
