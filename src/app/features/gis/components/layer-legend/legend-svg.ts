import { LegendLabels, LegendRamp, LegendSymbol } from './legend-model';

/**
 * Swatch geometry shared by the on-screen legend (LegendSwatchComponent)
 * and the print legend (SVG strings rasterised to PNG for MapFish).
 */

export function clampW(v: number, max: number): number {
  return Math.max(0.75, Math.min(v, max));
}

/** Room for an outline so thick strokes are not clipped. */
export function fillInset(strokeWidth: number): number {
  return 1 + clampW(strokeWidth, 3) / 2;
}

/** Map dash patterns are in map pixels; shrink them to fit a swatch. */
export function scaleDash(d: string | null): string | null {
  if (!d) return null;
  return d.split(/[\s,]+/).map((n) => Math.max(0.5, parseFloat(n) * 0.6).toFixed(1)).join(' ');
}

export function linePath(w: number, h: number): string {
  return `M2 ${h * 0.68} C ${w * 0.32} ${h * 0.05}, ${w * 0.62} ${h * 0.98}, ${w - 2} ${h * 0.3}`;
}

export function pointSize(size: number, h: number): number {
  return Math.max(6, Math.min(size, h - 2));
}

/** GeoServer well-known marks, centred in a w × h swatch. */
export function markPath(mark: string, size: number, w: number, h: number): string {
  const cx = w / 2, cy = h / 2, r = size / 2;
  switch (mark) {
    case 'square':
      return `M${cx - r} ${cy - r}h${size}v${size}h${-size}z`;
    case 'triangle':
      return `M${cx} ${cy - r}L${cx + r} ${cy + r}L${cx - r} ${cy + r}z`;
    case 'diamond':
      return `M${cx} ${cy - r}L${cx + r} ${cy}L${cx} ${cy + r}L${cx - r} ${cy}z`;
    case 'star': {
      let d = '';
      for (let i = 0; i < 10; i++) {
        const a = (Math.PI / 5) * i - Math.PI / 2, rr = i % 2 ? r * 0.45 : r;
        d += `${i ? 'L' : 'M'}${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`;
      }
      return d + 'z';
    }
    case 'cross': {
      const t = r * 0.35;
      return `M${cx - t} ${cy - r}h${2 * t}v${r - t}h${r - t}v${2 * t}h${t - r}v${r - t}h${-2 * t}v${t - r}h${t - r}v${-2 * t}h${r - t}z`;
    }
    case 'x':
      return `M${cx - r} ${cy - r}L${cx + r} ${cy + r}M${cx + r} ${cy - r}L${cx - r} ${cy + r}`;
    default:
      return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${size} 0a${r} ${r} 0 1 0 ${-size} 0`;
  }
}

// ---------------------------------------------------------------- strings

const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function attrs(a: Record<string, unknown>): string {
  return Object.entries(a)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(' ');
}

function wrap(w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
}

/** A symbol stack as a standalone SVG document. */
export function swatchSvg(symbols: LegendSymbol[], w: number, h: number): string {
  const body = symbols
    .map((s) => {
      if (s.kind === 'fill') {
        const i = fillInset(s.strokeWidth);
        return `<rect ${attrs({
          x: i, y: i, width: w - 2 * i, height: h - 2 * i, rx: 2,
          fill: s.fill ?? 'none', 'fill-opacity': s.fillOpacity,
          stroke: s.stroke ?? 'none', 'stroke-width': clampW(s.strokeWidth, 3),
          'stroke-opacity': s.strokeOpacity, 'stroke-dasharray': scaleDash(s.dash)
        })}/>`;
      }
      if (s.kind === 'line') {
        return `<path ${attrs({
          d: linePath(w, h), fill: 'none',
          stroke: s.stroke, 'stroke-width': clampW(s.strokeWidth, h * 0.4),
          'stroke-opacity': s.strokeOpacity, 'stroke-dasharray': scaleDash(s.dash),
          'stroke-linecap': s.linecap, 'stroke-linejoin': 'round'
        })}/>`;
      }
      // External-graphic icons cannot load inside an <img>-rendered SVG; a neutral dot stands in.
      const size = pointSize(s.size, h);
      return `<path ${attrs({
        d: markPath(s.image ? 'circle' : s.mark, size, w, h),
        fill: s.image ? '#808080' : s.fill ?? 'none', 'fill-opacity': s.fillOpacity,
        stroke: s.stroke ?? (s.fill ? 'none' : '#808080'), 'stroke-width': clampW(s.strokeWidth, 2),
        'stroke-linejoin': 'round'
      })}/>`;
    })
    .join('');
  return wrap(w, h, body);
}

/** A continuous colour ramp as a horizontal bar. */
export function rampSvg(ramp: LegendRamp, w: number, h: number): string {
  const s = ramp.stops;
  const lo = s[0].quantity, hi = s[s.length - 1].quantity, span = hi - lo || 1;
  const stops = s
    .map((x) => `<stop ${attrs({ offset: (x.quantity - lo) / span, 'stop-color': x.color, 'stop-opacity': x.opacity })}/>`)
    .join('');
  return wrap(
    w, h,
    `<defs><linearGradient id="g">${stops}</linearGradient></defs>` +
      `<rect x="0.5" y="${h * 0.2}" width="${w - 1}" height="${h * 0.6}" rx="2" fill="url(#g)" stroke="#9e9e9e" stroke-width="0.5"/>`
  );
}

/** A flat colour chip (a class of an interval / value colour map). */
export function chipSvg(color: string, opacity: number, w: number, h: number): string {
  return wrap(w, h, `<rect ${attrs({ x: 1, y: 1, width: w - 2, height: h - 2, rx: 2, fill: color, 'fill-opacity': opacity, stroke: '#9e9e9e', 'stroke-width': 0.5 })}/>`);
}

/** "Aa" in the label's colour, font and halo. */
export function labelsSvg(l: LegendLabels, w: number, h: number): string {
  return wrap(
    w, h,
    `<text ${attrs({
      x: w / 2, y: h * 0.78, 'text-anchor': 'middle', 'font-size': h * 0.8,
      'font-family': l.fontFamily === 'inherit' ? 'sans-serif' : l.fontFamily,
      'font-weight': l.bold ? 700 : 500, 'font-style': l.italic ? 'italic' : 'normal',
      fill: l.color, stroke: l.halo ?? 'none', 'stroke-width': l.halo ? 2.5 : 0,
      'paint-order': 'stroke fill'
    })}>Aa</text>`
  );
}

/** Rasterise an SVG string to a PNG data URI, `scale`× for crisp print. */
export async function svgToPng(svg: string, w: number, h: number, scale = 4): Promise<string | null> {
  try {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
