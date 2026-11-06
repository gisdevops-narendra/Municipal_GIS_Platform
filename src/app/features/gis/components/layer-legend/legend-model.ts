/**
 * Turns GeoServer's JSON legend (`GetLegendGraphic&format=application/json`)
 * into a small model the app draws natively (SVG swatches, colour ramps)
 * instead of GeoServer's white PNG. Works for any style: nothing here
 * knows about specific layers.
 */

export interface FillSymbol {
  kind: 'fill';
  fill: string | null;
  fillOpacity: number;
  stroke: string | null;
  strokeWidth: number;
  strokeOpacity: number;
  dash: string | null;
}

export interface LineSymbol {
  kind: 'line';
  stroke: string;
  strokeWidth: number;
  strokeOpacity: number;
  dash: string | null;
  linecap: string;
}

export interface PointSymbol {
  kind: 'point';
  mark: string;
  size: number;
  fill: string | null;
  fillOpacity: number;
  stroke: string | null;
  strokeWidth: number;
  image: string | null;
}

/** `rule`: index of the style rule it came from (vector tiles look up
 *  that rule's scale range). */
export type LegendSymbol = (FillSymbol | LineSymbol | PointSymbol) & { rule?: number };

export interface LegendEntry {
  label: string;
  /** The rule's filter as GeoServer reports it ("[type = 'Temple']"),
   *  'ELSE' for an else-rule, null for none (vector tiles evaluate it). */
  filter?: string | null;
  /** Drawn on top of each other, in rule order (e.g. halo band + dashed line). */
  symbols: LegendSymbol[];
}

export interface LegendLabels {
  field: string;
  color: string;
  halo: string | null;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  /** Index of the style rule holding the labels. */
  rule?: number;
}

export interface RampStop {
  color: string;
  opacity: number;
  quantity: number;
  label: string;
}

export interface LegendRamp {
  type: 'ramp' | 'intervals' | 'values';
  stops: RampStop[];
}

export interface LegendModel {
  /** One combined symbol (single-symbol style) vs one row per category. */
  single: boolean;
  entries: LegendEntry[];
  labels: LegendLabels | null;
  ramp: LegendRamp | null;
  raster: boolean;
}

// GeoServer JSON is loosely shaped; every read below is guarded.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** A GeoServer colour: '#RRGGBB', or a serialised java.awt.Color object. */
function color(v: unknown): string | null {
  if (typeof v === 'string') return /^#[0-9a-f]{3,8}$/i.test(v.trim()) ? v.trim() : null;
  if (v && typeof v === 'object' && 'red' in v) {
    const c = v as { red: number; green: number; blue: number };
    return '#' + [c.red, c.green, c.blue].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  }
  return null;
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

function dash(v: unknown): string | null {
  if (Array.isArray(v) && v.length) return v.map((x) => num(x, 1)).join(' ');
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

function parseSymbolizer(s: Json): LegendSymbol | null {
  if (s['Polygon']) {
    const p = s['Polygon'];
    const fill = color(p.fill) ?? (p['graphic-fill'] ? '#9e9e9e' : null);
    return {
      kind: 'fill',
      fill,
      fillOpacity: fill ? num(p['fill-opacity'], 1) : 0,
      stroke: color(p.stroke),
      strokeWidth: num(p['stroke-width'], 1),
      strokeOpacity: num(p['stroke-opacity'], 1),
      dash: dash(p['stroke-dasharray'])
    };
  }
  if (s['Line']) {
    const l = s['Line'];
    return {
      kind: 'line',
      stroke: color(l.stroke) ?? '#808080',
      strokeWidth: num(l['stroke-width'], 1),
      strokeOpacity: num(l['stroke-opacity'], 1),
      dash: dash(l['stroke-dasharray']),
      linecap: typeof l['stroke-linecap'] === 'string' ? l['stroke-linecap'] : 'butt'
    };
  }
  if (s['Point']) {
    const p = s['Point'];
    const g: Json = (Array.isArray(p.graphics) && p.graphics[0]) || {};
    const image = typeof g['external-graphic-url'] === 'string' ? g['external-graphic-url'] : null;
    return {
      kind: 'point',
      mark: String(g.mark ?? 'circle').replace(/^shape:\/\//, ''),
      size: num(p.size, 8),
      fill: color(g.fill) ?? (g.mark || image ? null : '#808080'),
      fillOpacity: num(g['fill-opacity'], 1),
      stroke: color(g.stroke),
      strokeWidth: num(g['stroke-width'], 1),
      image
    };
  }
  return null;
}

/** "[strToUpperCase(state_name)]" → "state_name"; "[village]" → "village". */
function labelField(expr: unknown): string {
  const s = String(expr ?? '').replace(/^\[|\]$/g, '');
  const ids = [...s.matchAll(/[A-Za-z_][\w]*(?![\w(])/g)].map((m) => m[0]);
  return ids[0] ?? s;
}

function parseLabels(t: Json): LegendLabels {
  const font: Json = (Array.isArray(t.fonts) && t.fonts[0]) || {};
  const family = Array.isArray(font['font-family']) ? font['font-family'][0] : font['font-family'];
  return {
    field: labelField(t.label),
    color: color(t.fill) ?? '#333333',
    halo: t.halo ? color(t.halo.fill) ?? '#ffffff' : null,
    fontFamily: family ? `${family}, sans-serif` : 'inherit',
    bold: String(font['font-weight'] ?? '').toLowerCase() === 'bold',
    italic: String(font['font-style'] ?? '').toLowerCase() === 'italic'
  };
}

function parseRamp(cm: Json): LegendRamp | null {
  const entries: Json[] = Array.isArray(cm?.entries) ? cm.entries : [];
  const stops = entries
    .map((e) => ({
      color: color(e.color) ?? '#000000',
      opacity: num(e.opacity, 1),
      quantity: num(e.quantity, 0),
      label: e.label != null ? String(e.label) : ''
    }))
    .filter((s) => s.opacity > 0);
  if (!stops.length) return null;
  const type = String(cm.type ?? 'ramp').toLowerCase();
  return { type: type === 'intervals' || type === 'values' ? type : 'ramp', stops };
}

/** Plain-language summary of a single-symbol style, e.g. "Dashed line". */
export function describeSymbols(symbols: LegendSymbol[]): string {
  const top = symbols[symbols.length - 1];
  if (!top) return '';
  if (top.kind === 'line') return top.dash ? 'Dashed line' : 'Solid line';
  if (top.kind === 'fill') return top.fill ? 'Filled area' : 'Outline';
  if (top.image) return 'Icon';
  return `${top.mark.charAt(0).toUpperCase()}${top.mark.slice(1)} marker`;
}

export function parseLegend(json: unknown): LegendModel | null {
  const legend: Json | undefined = (json as Json)?.['Legend']?.[0];
  const rules: Json[] = Array.isArray(legend?.['rules']) ? legend!['rules'] : [];
  if (!rules.length) return null;

  let labels: LegendLabels | null = null;
  let ramp: LegendRamp | null = null;
  let raster = false;
  const ruleSymbols: { rule: Json; symbols: LegendSymbol[] }[] = [];

  rules.forEach((rule, index) => {
    const symbols: LegendSymbol[] = [];
    for (const s of (rule['symbolizers'] ?? []) as Json[]) {
      if (s['Text']) labels ??= { ...parseLabels(s['Text']), rule: index };
      else if (s['Raster']) {
        raster = true;
        ramp ??= parseRamp(s['Raster'].colormap);
      } else {
        const sym = parseSymbolizer(s);
        if (sym) symbols.push({ ...sym, rule: index });
      }
    }
    if (symbols.length) ruleSymbols.push({ rule, symbols });
  });

  // Filtered rules are categories; unfiltered rules are layers of one symbol.
  // GeoServer's JSON legend marks an else-rule as "ElseFilter": "true".
  const isElse = (rule: Json) => !!rule['else'] || String(rule['ElseFilter'] ?? '') === 'true';
  const categorised = ruleSymbols.some(({ rule }) => rule['filter'] || isElse(rule));
  let entries: LegendEntry[];
  if (categorised) {
    entries = ruleSymbols.map(({ rule, symbols }) => ({
      label: String(rule['title'] ?? rule['name'] ?? (isElse(rule) ? 'Other' : '')),
      filter: isElse(rule) ? 'ELSE' : typeof rule['filter'] === 'string' ? rule['filter'] : null,
      symbols
    }));
  } else if (ruleSymbols.length) {
    const symbols = ruleSymbols.flatMap((r) => r.symbols);
    entries = [{ label: describeSymbols(symbols), symbols }];
  } else {
    entries = [];
  }

  return { single: !categorised, entries, labels, ramp, raster };
}
