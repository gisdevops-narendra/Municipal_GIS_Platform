/** Types + presets for the GIS Layer Styling editor. Mirrors the backend
 *  DTO in backend/src/gis/dto/layer-style.dto.ts — the backend turns the
 *  spec into YSLD, GeoServer stores it, and the WMS layer re-renders. */

export type StyleGeometry = 'point' | 'line' | 'polygon' | 'raster';
export type StyleMode = 'single' | 'categorized' | 'graduated';
export type MarkShape =
  | 'circle'
  | 'square'
  | 'triangle'
  | 'star'
  | 'cross'
  | 'x';
export type ClassificationMethod = 'equalInterval' | 'quantile' | 'manual';
export type FieldKind =
  | 'string'
  | 'number'
  | 'date'
  | 'boolean'
  | 'geometry'
  | 'other';

export type IconMime = 'image/svg+xml' | 'image/png';

/** A point icon (ExternalGraphic). `builtin` → `name` is a bundled
 *  marker-icon id; `custom` → `name` is the GeoServer style-resource
 *  filename an upload produced. */
export interface IconRef {
  source: 'builtin' | 'custom';
  name: string;
  mime: IconMime;
}

/** One entry in the built-in marker-icon gallery (from the backend). */
export interface BuiltinIcon {
  id: string;
  label: string;
  category: string;
  anchor: [number, number];
}

export interface SymbolSpec {
  markShape?: MarkShape;
  markSize?: number;
  markRotation?: number;
  /** When set, the point renders as this icon instead of a vector mark. */
  icon?: IconRef;
  iconOpacity?: number;
  iconAnchorX?: number;
  iconAnchorY?: number;
  fillColor?: string;
  fillOpacity?: number;
  strokeColor?: string;
  strokeWidth?: number;
  strokeOpacity?: number;
  strokeDash?: number[];
  strokeCap?: 'butt' | 'round' | 'square';
  strokeJoin?: 'miter' | 'round' | 'bevel';
}

export interface StyleCategory {
  value: string | number;
  label?: string;
  symbol: SymbolSpec;
}

export interface LabelSpec {
  enabled: boolean;
  field: string;
  font: string;
  size: number;
  color: string;
  haloColor: string;
  haloWidth: number;
  rotation: number;
  offsetX: number;
  offsetY: number;
  placement: 'point' | 'line';
}

export interface ColorMapEntry {
  quantity: number;
  color: string;
  opacity?: number;
}

export interface LayerStyleSpec {
  version: 1;
  geometry: StyleGeometry;
  mode: StyleMode;
  symbol: SymbolSpec;
  categorize?: {
    field: string;
    categories: StyleCategory[];
    includeOther: boolean;
  };
  graduate?: {
    field: string;
    method: ClassificationMethod;
    classCount: number;
    breaks: number[];
    ramp: string[];
  };
  labels?: LabelSpec;
  scale?: { minDenominator?: number; maxDenominator?: number };
  raster?: { opacity: number; colorMap: ColorMapEntry[] };
}

export interface StyleAttribute {
  name: string;
  type: string;
  kind: FieldKind;
}

export interface FieldStats {
  field: string;
  kind: FieldKind;
  distinct?: (string | number)[];
  distinctTruncated?: boolean;
  numeric?: { min: number; max: number; count: number; breaks: number[] };
}

/** `{ kind, id }` — a published layer or an in-progress upload. */
export interface StyleTargetRef {
  kind: 'layer' | 'upload';
  id: string;
}

// ---- presets -------------------------------------------------------

export const MARK_SHAPES: { label: string; value: MarkShape }[] = [
  { label: 'Circle', value: 'circle' },
  { label: 'Square', value: 'square' },
  { label: 'Triangle', value: 'triangle' },
  { label: 'Star', value: 'star' },
  { label: 'Cross', value: 'cross' },
  { label: 'X', value: 'x' },
];

export const FONT_FAMILIES: { label: string; value: string }[] = [
  { label: 'Sans-serif', value: 'SansSerif' },
  { label: 'Serif', value: 'Serif' },
  { label: 'Monospace', value: 'Monospaced' },
];

export const CLASSIFICATION_METHODS: {
  label: string;
  value: ClassificationMethod;
}[] = [
  { label: 'Quantile (equal count)', value: 'quantile' },
  { label: 'Equal interval', value: 'equalInterval' },
  { label: 'Manual breaks', value: 'manual' },
];

export const DASH_PRESETS: { label: string; value: number[] }[] = [
  { label: 'Solid', value: [] },
  { label: 'Dashed', value: [8, 6] },
  { label: 'Dotted', value: [2, 4] },
  { label: 'Dash-dot', value: [10, 4, 2, 4] },
];

/** Colour ramps — hex arrays sampled by the editor to `classCount` stops. */
export interface ColorRamp {
  id: string;
  label: string;
  type: 'sequential' | 'diverging' | 'qualitative';
  colors: string[];
}

export const COLOR_RAMPS: ColorRamp[] = [
  {
    id: 'blues',
    label: 'Blues',
    type: 'sequential',
    colors: ['#eff3ff', '#c6dbef', '#9ecae1', '#6baed6', '#3182bd', '#08519c'],
  },
  {
    id: 'greens',
    label: 'Greens',
    type: 'sequential',
    colors: ['#edf8e9', '#c7e9c0', '#a1d99b', '#74c476', '#31a354', '#006d2c'],
  },
  {
    id: 'oranges',
    label: 'Oranges',
    type: 'sequential',
    colors: ['#feedde', '#fdd0a2', '#fdae6b', '#fd8d3c', '#e6550d', '#a63603'],
  },
  {
    id: 'viridis',
    label: 'Viridis',
    type: 'sequential',
    colors: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'],
  },
  {
    id: 'rdylgn',
    label: 'Red–Yellow–Green',
    type: 'diverging',
    colors: ['#d73027', '#fc8d59', '#fee08b', '#d9ef8b', '#91cf60', '#1a9850'],
  },
  {
    id: 'spectral',
    label: 'Spectral',
    type: 'diverging',
    colors: ['#d53e4f', '#fc8d59', '#fee08b', '#e6f598', '#99d594', '#3288bd'],
  },
  {
    id: 'set2',
    label: 'Categorical (Set2)',
    type: 'qualitative',
    colors: [
      '#66c2a5',
      '#fc8d62',
      '#8da0cb',
      '#e78ac3',
      '#a6d854',
      '#ffd92f',
      '#e5c494',
      '#b3b3b3',
    ],
  },
  {
    id: 'paired',
    label: 'Categorical (Paired)',
    type: 'qualitative',
    colors: [
      '#a6cee3',
      '#1f78b4',
      '#b2df8a',
      '#33a02c',
      '#fb9a99',
      '#e31a1c',
      '#fdbf6f',
      '#ff7f00',
      '#cab2d6',
      '#6a3d9a',
    ],
  },
];

/** Sample `ramp` to `n` evenly spaced colours. */
export function sampleRamp(ramp: string[], n: number): string[] {
  if (n <= 0 || ramp.length === 0) return [];
  if (n === 1) return [ramp[Math.floor(ramp.length / 2)]];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(ramp[Math.round((i / (n - 1)) * (ramp.length - 1))]);
  }
  return out;
}

/** A sensible starting spec for a geometry type. */
export function defaultSpec(geometry: StyleGeometry): LayerStyleSpec {
  const base: LayerStyleSpec = { version: 1, geometry, mode: 'single', symbol: {} };
  if (geometry === 'point') {
    base.symbol = {
      markShape: 'circle',
      markSize: 8,
      markRotation: 0,
      fillColor: '#128077',
      fillOpacity: 0.9,
      strokeColor: '#0b4f4a',
      strokeWidth: 1,
      strokeOpacity: 1,
    };
  } else if (geometry === 'line') {
    base.symbol = {
      strokeColor: '#128077',
      strokeWidth: 2,
      strokeOpacity: 1,
      strokeDash: [],
      strokeCap: 'round',
      strokeJoin: 'round',
    };
  } else if (geometry === 'polygon') {
    base.symbol = {
      fillColor: '#128077',
      fillOpacity: 0.45,
      strokeColor: '#0b4f4a',
      strokeWidth: 1,
      strokeOpacity: 1,
    };
  } else {
    base.raster = {
      opacity: 1,
      colorMap: [
        { quantity: 0, color: '#08306b' },
        { quantity: 128, color: '#f7fbff' },
        { quantity: 255, color: '#7f0000' },
      ],
    };
  }
  return base;
}
