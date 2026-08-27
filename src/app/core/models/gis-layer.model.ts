export type GisLayerType = 'VECTOR' | 'RASTER';
export type GisGeometryType = 'POINT' | 'LINE' | 'POLYGON';
export type GisLayerOwnershipType = 'CANONICAL' | 'DEPARTMENT';

export interface GisLayerBoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Shape of GET /api/gis/layers entries — the caller's own municipality's
 *  ACTIVE GIS layers. Always tenant-scoped server-side; never accepts a
 *  workspace/municipality id from the client. */
export interface GisLayer {
  id: string;
  name: string;
  code: string;
  description: string | null;
  layerType: GisLayerType;
  /** GeoServer workspace this layer is published in — combine with
   *  geoserverLayer for the qualified OGC layer name "{workspace}:{layer}". */
  geoserverWorkspace: string;
  geoserverLayer: string;
  geometryType: GisGeometryType | null;
  visibleByDefault: boolean;
  displayOrder: number;
  /** Task 7: CANONICAL (municipality-wide reference data — the Task 6 demo
   *  layers, or anything the Owner publishes without a department) vs
   *  DEPARTMENT (operational data belonging to one department). Drives the
   *  layer panel's "Municipal GIS" / "Department Layers" grouping. */
  ownershipType: GisLayerOwnershipType;
  departmentId: string | null;
  departmentName: string | null;
  /** Bumped every time an uploaded layer is replaced by a newer version
   *  (Task 7) — 1 for every Task 6 demo layer. */
  version: number;
  /** EPSG:4326 (lon/lat) extent captured from GeoServer at publish time, or
   *  null if unavailable (e.g. a layer with zero features yet). */
  bbox: GisLayerBoundingBox | null;
}
