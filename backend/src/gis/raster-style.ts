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
