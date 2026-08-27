/**
 * Attribute table domain types. Kept independent of any UI framework so the
 * table component, and later GIS tools (export, field statistics, spatial
 * queries) can share the same shapes and the same `AttributeTableService`.
 */

export type AttributeFieldType = 'text' | 'integer' | 'number' | 'date' | 'boolean' | 'id';

/** GeoJSON geometry object (EPSG:4326) — kept loose on purpose. */
export type GeoJsonGeometry = Record<string, unknown>;

export interface AttributeField {
  /** raw feature-property key as GeoServer returns it */
  name: string;
  /** human-readable column header */
  label: string;
  type: AttributeFieldType;
  nullable: boolean;
}

export interface AttributeRow {
  /** stable WFS feature id, e.g. "wards.5" — the table's dataKey */
  featureId: string;
  values: Record<string, unknown>;
  /** feature geometry in EPSG:4326 for map highlight / zoom-to */
  geometry: GeoJsonGeometry | null;
}

export interface AttributeQuery {
  /** 0-based page index */
  page: number;
  pageSize: number;
  sortField: string | null;
  sortDir: 'asc' | 'desc';
  /** free-text search applied across the layer's text fields */
  search: string;
}

export interface AttributePage {
  rows: AttributeRow[];
  /** total features matching the current filter (ignores paging) */
  total: number;
  fields: AttributeField[];
}

export const DEFAULT_ATTRIBUTE_QUERY: AttributeQuery = {
  page: 0,
  pageSize: 50,
  sortField: null,
  sortDir: 'asc',
  search: ''
};

export const ATTRIBUTE_PAGE_SIZES = [25, 50, 100, 200];

/** Feature properties GeoServer exposes that are internal plumbing, never
 *  shown as attribute columns. */
export const HIDDEN_ATTRIBUTE_FIELDS = new Set(['gis_workspace_id']);
