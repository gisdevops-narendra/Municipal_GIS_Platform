/** Colour ramps offered by Raster Styling, low value → high value. */
export const RASTER_RAMPS: Record<string, string[]> = {
  terrain: ['#006837', '#31a354', '#addd8e', '#fed976', '#feb24c', '#bd7a3a', '#8c510a', '#f5f5f5'],
  grayscale: ['#000000', '#ffffff'],
  ndvi: ['#a50026', '#f46d43', '#fee08b', '#d9ef8b', '#66bd63', '#006837'],
  diverging: ['#2166ac', '#67a9cf', '#f7f7f7', '#ef8a62', '#b2182b'],
  water: ['#c6dbef', '#6baed6', '#2171b5', '#08306b'],
  heat: ['#ffffcc', '#fd8d3c', '#e31a1c', '#800026'],
  aspect: ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'],
  spectral: ['#9e0142', '#f46d43', '#fee08b', '#e6f598', '#66c2a5', '#5e4fa2'],
  // Purpose-built ramps — each analysis result gets one that reads at a
  // glance (see RasterToolsService).
  /** Hypsometric tint: lowland green → upland tan → peaks white. */
  elevation: ['#0b6e4f', '#4f9d4a', '#a7c957', '#f2e8a0', '#d4a373', '#9c6644', '#7f5539', '#ece7e2'],
  /** Flat green → steep red. */
  slope: ['#1a9850', '#91cf60', '#d9ef8b', '#fee08b', '#fc8d59', '#d73027'],
  /** Smooth light → rugged dark purple. */
  roughness: ['#f2f0f7', '#cbc9e2', '#9e9ac8', '#756bb1', '#54278f'],
  /** Concave (valleys) blue → flat white → convex (ridges) brown. */
  curvature: ['#2166ac', '#92c5de', '#f7f7f7', '#dfc27d', '#8c510a'],
  /** Upstream area: faint → main channels dark blue. */
  flow: ['#f7fbff', '#c6dbef', '#6baed6', '#2171b5', '#08306b'],
  /** Water depth: shallow light blue → deep navy. */
  depth: ['#deebf7', '#9ecae1', '#4292c6', '#2171b5', '#084594', '#08306b'],
  /** Seen from more observers → darker green. */
  visibility: ['#ffffcc', '#c2e699', '#78c679', '#31a354', '#006837'],
  /** Point density / hotspots: pale yellow → deep red. */
  density: ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'],
  /** Distance: near dark purple → far yellow (viridis). */
  distance: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  /** Continuous surfaces (interpolation, calculator) — perceptually even. */
  viridis: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'],
  /** Land surface temperature: cool blue → hot red. */
  thermal: ['#313695', '#4575b4', '#abd9e9', '#ffffbf', '#fdae61', '#f46d43', '#a50026'],
  /** NDBI: vegetation/water grey-green → built-up red. */
  urban: ['#1a9641', '#a6d96a', '#f7f7f7', '#fdae61', '#d7301f', '#7f0000'],
  /** NDWI: dry land brown → open water teal. */
  ndwi: ['#8c510a', '#d8b365', '#f6e8c3', '#c7eae5', '#5ab4ac', '#01665e'],
  /** Change: decrease red → no change white → increase green. */
  change: ['#d7191c', '#fdae61', '#f7f7f7', '#a6d96a', '#1a9641'],
  /** Suitability score: unsuitable red → highly suitable green. */
  suitability: ['#d7191c', '#fdae61', '#ffffbf', '#a6d96a', '#1a9641'],
  /** Risk / exposure: low yellow → high dark red. */
  risk: ['#fff7bc', '#fec44f', '#fe9929', '#d95f0e', '#993404'],
  /** Air quality: good green → hazardous maroon (AQI colours). */
  aqi: ['#00e400', '#ffff00', '#ff7e00', '#ff0000', '#8f3f97', '#7e0023'],
  /** Population: sparse cream → dense brown. */
  population: ['#fff5eb', '#fdd0a2', '#fd8d3c', '#d94801', '#7f2704'],
  /** Object heights: ground blue → tall yellow (plasma). */
  height: ['#0d0887', '#6a00a8', '#b12a90', '#e16462', '#fca636', '#f0f921'],
};

export const RASTER_STYLE_MODES = ['ramp', 'values', 'rgb'] as const;
export type RasterStyleMode = (typeof RASTER_STYLE_MODES)[number];

export interface RasterStyleSpec {
  /** ramp: one band through a colour ramp; values: one colour per class
   *  value; rgb: three bands as red/green/blue (imagery). */
  mode: RasterStyleMode;
  band?: number;
  ramp?: string;
  min?: number;
  max?: number;
  invert?: boolean;
  classes?: { value: number; color: string; label?: string; opacity?: number }[];
  bands?: [number, number, number];
  /** RGB contrast: min–max (normalize) or histogram equalisation. */
  stretch?: 'normalize' | 'histogram';
  opacity?: number;
}

const q = (text: string) => `'${text.replace(/'/g, "''")}'`;
const num = (n: number) => (Number.isFinite(n) ? String(n) : '0');

/** GeoServer YSLD for a raster style spec. Every value is a number or a
 *  validated hex colour, so nothing user-typed reaches the style verbatim
 *  except class labels, which are quoted. */
export function rasterYsld(name: string, spec: RasterStyleSpec): string {
  const opacity = num(Math.min(Math.max(spec.opacity ?? 1, 0), 1));
  const lines = [
    `name: ${q(name)}`,
    'feature-styles:',
    '- rules:',
    '  - symbolizers:',
    '    - raster:',
    `        opacity: ${opacity}`,
  ];

  if (spec.mode === 'rgb') {
    const [r, g, b] = spec.bands ?? [1, 2, 3];
    lines.push('        channels:');
    for (const [channel, band] of [['red', r], ['green', g], ['blue', b]] as const) {
      lines.push(
        `          ${channel}:`,
        `            name: '${Math.trunc(band)}'`,
        '            contrast-enhancement:',
        `              mode: ${spec.stretch === 'histogram' ? 'histogram' : 'normalize'}`,
      );
    }
    return lines.join('\n') + '\n';
  }

  lines.push(
    '        channels:',
    '          gray:',
    `            name: '${Math.trunc(spec.band ?? 1)}'`,
    '        color-map:',
    `          type: ${spec.mode === 'values' ? 'values' : 'ramp'}`,
    '          entries:',
  );

  if (spec.mode === 'values') {
    for (const c of spec.classes ?? []) {
      lines.push(
        `          - ['${c.color}', ${num(c.opacity ?? 1)}, ${num(c.value)}, ${q(c.label ?? String(c.value))}]`,
      );
    }
    return lines.join('\n') + '\n';
  }

  const colors = [...(RASTER_RAMPS[spec.ramp ?? 'terrain'] ?? RASTER_RAMPS.terrain)];
  if (spec.invert) colors.reverse();
  const min = spec.min ?? 0;
  const max = spec.max === undefined || spec.max <= min ? min + 1 : spec.max;
  colors.forEach((color, i) => {
    const value = min + ((max - min) * i) / (colors.length - 1);
    lines.push(`          - ['${color}', 1.0, ${num(value)}, '${value.toPrecision(4)}']`);
  });
  return lines.join('\n') + '\n';
}
