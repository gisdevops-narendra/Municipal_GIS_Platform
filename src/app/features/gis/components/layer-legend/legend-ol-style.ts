import type { FeatureLike } from 'ol/Feature';
import { Circle as CircleStyle, Fill, RegularShape, Stroke, Style, Text } from 'ol/style';
import type { LegendLabels, LegendModel, LegendSymbol } from './legend-model';

/**
 * OpenLayers styles for vector tiles (MVT), built from the layer's own
 * GeoServer style (its JSON legend), so the browser draws what WMS would:
 * symbols, simple category filters and labels. Returns null when the style
 * uses something the browser cannot reproduce (complex filters, rasters) —
 * the map then renders that layer as WMS instead.
 */

type Feature = FeatureLike;
type Test = (f: Feature) => boolean;

const rgba = (hex: string | null, opacity: number): string | undefined => {
  if (!hex) return undefined;
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, opacity))})`;
};

const dash = (d: string | null): number[] | undefined =>
  d ? d.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n)) : undefined;

function symbolStyle(s: LegendSymbol, z: number): Style {
  if (s.kind === 'fill') {
    return new Style({
      zIndex: z,
      fill: s.fill ? new Fill({ color: rgba(s.fill, s.fillOpacity) }) : undefined,
      stroke: s.stroke
        ? new Stroke({ color: rgba(s.stroke, s.strokeOpacity), width: s.strokeWidth, lineDash: dash(s.dash) })
        : undefined
    });
  }
  if (s.kind === 'line') {
    return new Style({
      zIndex: z,
      stroke: new Stroke({
        color: rgba(s.stroke, s.strokeOpacity),
        width: s.strokeWidth,
        lineDash: dash(s.dash),
        lineCap: (s.linecap as CanvasLineCap) || 'butt'
      })
    });
  }
  const r = Math.max(2, s.size / 2);
  const fill = s.fill ? new Fill({ color: rgba(s.fill, s.fillOpacity) }) : undefined;
  const stroke = s.stroke ? new Stroke({ color: rgba(s.stroke, 1), width: s.strokeWidth }) : undefined;
  const shape = (points: number, radius2?: number, angle = 0) =>
    new RegularShape({ points, radius: r, radius2, angle, fill, stroke });
  const image =
    s.mark === 'square'
      ? shape(4, undefined, Math.PI / 4)
      : s.mark === 'triangle'
        ? shape(3)
        : s.mark === 'star'
          ? shape(5, r * 0.45)
          : s.mark === 'cross'
            ? shape(4, 0)
            : s.mark === 'x'
              ? shape(4, 0, Math.PI / 4)
              : new CircleStyle({ radius: r, fill: fill ?? (stroke ? undefined : new Fill({ color: '#808080' })), stroke });
  return new Style({ zIndex: z, image });
}

/** "[field = 'value']", "[n >= 10]", "[field <> 'x']" — anything else: null. */
function compileFilter(raw: string | null | undefined): Test | null | 'unsupported' {
  if (!raw) return null;
  const m = /^\s*\[?\s*"?([A-Za-z_][\w]*)"?\s*(=|==|<>|!=|>=|<=|>|<)\s*(?:'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?))\s*\]?\s*$/.exec(raw);
  if (!m) return 'unsupported';
  const [, field, op, str, num] = m;
  const want: string | number = num !== undefined ? Number(num) : (str ?? '').replace(/''/g, "'");
  return (f) => {
    const v = f.get(field);
    if (v === undefined || v === null) return false;
    const a = typeof want === 'number' ? Number(v) : String(v);
    switch (op) {
      case '=':
      case '==':
        return a === want;
      case '<>':
      case '!=':
        return a !== want;
      case '>':
        return a > want;
      case '>=':
        return a >= want;
      case '<':
        return a < want;
      default:
        return a <= want;
    }
  };
}

/** "[village]" -> village; expressions (functions) are not supported. */
function labelFieldOf(labels: LegendLabels): string | null {
  return /^[A-Za-z_]\w*$/.test(labels.field) ? labels.field : null;
}

function labelStyle(labels: LegendLabels, field: string): (f: Feature) => Style | null {
  const family = labels.fontFamily === 'inherit' ? 'sans-serif' : labels.fontFamily;
  const font = `${labels.italic ? 'italic ' : ''}${labels.bold ? 'bold ' : ''}12px ${family}`;
  // Along the line for line features; centred on areas and points (as WMS).
  const make = (placement: 'line' | 'point') => {
    const text = new Text({
      font,
      fill: new Fill({ color: labels.color }),
      stroke: labels.halo ? new Stroke({ color: labels.halo, width: 3 }) : undefined,
      placement,
      overflow: false
    });
    return { text, style: new Style({ text, zIndex: 1000 }) };
  };
  const onLine = make('line');
  const onPoint = make('point');
  return (f) => {
    const v = f.get(field);
    if (v === undefined || v === null || v === '') return null;
    const type = f.getGeometry()?.getType();
    const t = type === 'LineString' || type === 'MultiLineString' ? onLine : onPoint;
    t.text.setText(String(v));
    return t.style;
  };
}

/** A style rule's Min/MaxScaleDenominator (null: unbounded). */
export interface RuleScale {
  min: number | null;
  max: number | null;
}

/** Scale ranges of the style's rules, in rule order, from its SLD. */
export function ruleScalesFromSld(sld: string): RuleScale[] {
  const doc = new DOMParser().parseFromString(sld, 'application/xml');
  const val = (rule: Element, tag: string) => {
    const el = [...rule.children].find((c) => c.localName === tag);
    const n = el ? Number(el.textContent) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  return [...doc.getElementsByTagNameNS('*', 'Rule')].map((r) => ({
    min: val(r, 'MinScaleDenominator'),
    max: val(r, 'MaxScaleDenominator')
  }));
}

export function legendToOlStyle(
  model: LegendModel | null,
  scales: RuleScale[] = []
): ((f: Feature, resolution: number) => Style[]) | null {
  if (!model || model.raster || !model.entries.length) return null;
  const rules: { test: Test | null; styles: { style: Style; rule?: number }[]; isElse: boolean }[] = [];
  for (const entry of model.entries) {
    const compiled = entry.filter === 'ELSE' ? null : compileFilter(entry.filter);
    if (compiled === 'unsupported') return null;
    rules.push({
      test: compiled,
      styles: entry.symbols.map((s, i) => ({ style: symbolStyle(s, i), rule: s.rule })),
      isElse: entry.filter === 'ELSE'
    });
  }
  const field = model.labels ? labelFieldOf(model.labels) : null;
  const label = model.labels && field ? labelStyle(model.labels, field) : null;
  const labelRule = model.labels?.rule;

  return (f, resolution) => {
    // OGC standard pixel (0.28 mm); the map is in metres (EPSG:3857).
    const scale = resolution / 0.00028;
    const inScale = (rule?: number) => {
      const r = rule === undefined ? undefined : scales[rule];
      return !r || ((r.min === null || scale >= r.min) && (r.max === null || scale < r.max));
    };
    const out: Style[] = [];
    let matched = false;
    for (const rule of rules) {
      if (rule.isElse) continue;
      if (!rule.test || rule.test(f)) {
        for (const s of rule.styles) if (inScale(s.rule)) out.push(s.style);
        matched = true;
      }
    }
    if (!matched) for (const rule of rules) if (rule.isElse) for (const s of rule.styles) if (inScale(s.rule)) out.push(s.style);
    const text = inScale(labelRule) ? label?.(f) : null;
    if (text) out.push(text);
    return out;
  };
}
