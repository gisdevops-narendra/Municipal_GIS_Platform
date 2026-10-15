/** A user drawing (Draw module) or labelled pin (Marking Tool module) kept
 *  on the map. Geometry is GeoJSON in EPSG:4326. */
export type SketchKind = 'Marker' | 'Point' | 'Line' | 'Polygon' | 'Rectangle' | 'Circle' | 'Freehand';

export interface Sketch {
  id: string;
  kind: SketchKind;
  label: string;
  color: string;
  geometry: Record<string, unknown>;
  createdAt: string;
}

export const SKETCH_COLORS = ['#d9480f', '#1971c2', '#2f9e44', '#e8590c', '#ae3ec9', '#212529'];

/** Module Access catalog ids (seed-modules.ts). */
export const DRAW_MODULE_ID = 32;
export const MARKING_TOOL_MODULE_ID = 73;
