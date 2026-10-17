import { RasterStatistics } from '../../services/raster.service';

/**
 * Tool-specific reading of a raster result: the output layer's statistics
 * turned into the numbers and classes that matter for that analysis
 * (slope → terrain classes, aspect → compass directions, …) instead of the
 * same generic min / max for every tool. Pure; class shares come from the
 * output's histogram, so no extra server work is needed.
 */

export interface InsightFact {
  label: string;
  value: string;
}

export interface InsightClass {
  label: string;
  /** Share of valid cells, 0–100. */
  pct: number;
  areaM2: number;
  color: string;
}

export interface RasterInsights {
  heading: string;
  facts: InsightFact[];
  classes: InsightClass[] | null;
}

type Band = [label: string, lo: number, hi: number, color: string];

const num = (v: number, digits = 1) =>
  Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
const pct = (v: number) => `${num(v, 1)} %`;
const area = (m2: number) =>
  m2 >= 1_000_000 ? `${num(m2 / 1_000_000, 2)} km²` : m2 >= 10_000 ? `${num(m2 / 10_000, 2)} ha` : `${num(m2, 0)} m²`;

/** Share (0–100) of valid cells with lo <= value < hi, from the histogram. */
export function shareInRange(stats: RasterStatistics, lo: number, hi: number): number {
  const { counts, edges } = stats.histogram;
  const total = counts.reduce((s, c) => s + c, 0);
  if (!total) return 0;
  let inside = 0;
  counts.forEach((c, i) => {
    const a = edges[i];
    const b = edges[i + 1];
    const overlap = Math.max(0, Math.min(b, hi) - Math.max(a, lo));
    if (overlap > 0) inside += b > a ? c * (overlap / (b - a)) : c;
  });
  return (100 * inside) / total;
}

function classify(stats: RasterStatistics, bands: Band[]): InsightClass[] {
  return bands
    .map(([label, lo, hi, color]) => {
      const p = shareInRange(stats, lo, hi);
      return { label, pct: p, areaM2: (stats.areaM2 * p) / 100, color };
    })
    .filter((c) => c.pct >= 0.05);
}

function baseFacts(stats: RasterStatistics, unit: string): InsightFact[] {
  const u = unit ? ` ${unit}` : '';
  return [
    { label: 'Mean', value: `${num(stats.mean, 2)}${u}` },
    { label: 'Median', value: `${num(stats.median, 2)}${u}` },
    { label: 'Range', value: `${num(stats.min, 2)} – ${num(stats.max, 2)}${u}` },
    { label: 'Std. deviation', value: `${num(stats.std, 2)}${u}` },
    { label: 'Area analysed', value: area(stats.areaM2) },
  ];
}

const GREEN_TO_RED = ['#1a9850', '#91cf60', '#fee08b', '#fc8d59', '#d73027', '#7f0000'];

export function rasterInsights(tool: string, stats: RasterStatistics): RasterInsights {
  switch (tool) {
    case 'slope': {
      // Percent output when values run past 90.
      const percent = stats.max > 90;
      const unit = percent ? '%' : '°';
      const bands: Band[] = percent
        ? [['Flat (0–5 %)', 0, 5, GREEN_TO_RED[0]], ['Gentle (5–15 %)', 5, 15, GREEN_TO_RED[1]], ['Moderate (15–30 %)', 15, 30, GREEN_TO_RED[2]], ['Steep (30–60 %)', 30, 60, GREEN_TO_RED[3]], ['Very steep (> 60 %)', 60, Infinity, GREEN_TO_RED[4]]]
        : [['Flat (0–5°)', 0, 5, GREEN_TO_RED[0]], ['Gentle (5–15°)', 5, 15, GREEN_TO_RED[1]], ['Moderate (15–30°)', 15, 30, GREEN_TO_RED[2]], ['Steep (30–45°)', 30, 45, GREEN_TO_RED[3]], ['Very steep (> 45°)', 45, Infinity, GREEN_TO_RED[4]]];
      const limit = percent ? 15 : 8.5; // ~15 % grade: usual limit for roads / easy building
      const easy = shareInRange(stats, 0, limit);
      return {
        heading: 'Terrain steepness',
        facts: [
          { label: 'Mean slope', value: `${num(stats.mean, 1)} ${unit}` },
          { label: 'Steepest', value: `${num(stats.max, 1)} ${unit}` },
          { label: `Easily buildable (< ${percent ? '15 %' : '8.5°'})`, value: `${pct(easy)} · ${area((stats.areaM2 * easy) / 100)}` },
          { label: 'Steep or worse', value: pct(shareInRange(stats, percent ? 30 : 30, Infinity)) },
          { label: 'Area analysed', value: area(stats.areaM2) },
        ],
        classes: classify(stats, bands),
      };
    }

    case 'aspect': {
      const flat = shareInRange(stats, -Infinity, 0);
      const sectors: Band[] = [
        ['North', 337.5, 360, '#4575b4'], ['North-east', 22.5, 67.5, '#74add1'], ['East', 67.5, 112.5, '#abd9e9'],
        ['South-east', 112.5, 157.5, '#fee090'], ['South', 157.5, 202.5, '#fdae61'], ['South-west', 202.5, 247.5, '#f46d43'],
        ['West', 247.5, 292.5, '#d73027'], ['North-west', 292.5, 337.5, '#313695'],
      ];
      const classes = classify(stats, sectors);
      const north0 = shareInRange(stats, 0, 22.5);
      const n = classes.find((c) => c.label === 'North');
      if (n) { n.pct += north0; n.areaM2 = (stats.areaM2 * n.pct) / 100; }
      if (flat >= 0.05) classes.push({ label: 'Flat (no aspect)', pct: flat, areaM2: (stats.areaM2 * flat) / 100, color: '#bdbdbd' });
      const dominant = [...classes].filter((c) => !c.label.startsWith('Flat')).sort((a, b) => b.pct - a.pct)[0];
      const south = shareInRange(stats, 112.5, 247.5);
      return {
        heading: 'Direction slopes face',
        facts: [
          { label: 'Dominant direction', value: dominant ? `${dominant.label} (${pct(dominant.pct)})` : '—' },
          { label: 'South-facing (best solar exposure)', value: pct(south) },
          { label: 'North-facing (most shade)', value: pct(shareInRange(stats, 315, 360) + shareInRange(stats, 0, 45)) },
          { label: 'Flat ground', value: pct(flat) },
          { label: 'Area analysed', value: area(stats.areaM2) },
        ],
        classes,
      };
    }

    case 'hillshade': {
      const bands: Band[] = [
        ['Deep shadow (0–64)', 0, 64, '#252525'], ['Shaded (64–128)', 64, 128, '#737373'],
        ['Lit (128–192)', 128, 192, '#bdbdbd'], ['Brightly lit (192–255)', 192, 256, '#f0f0f0'],
      ];
      return {
        heading: 'Illumination',
        facts: [
          { label: 'Mean illumination', value: `${num(stats.mean, 0)} / 255` },
          { label: 'In shadow (< 128)', value: pct(shareInRange(stats, 0, 128)) },
          { label: 'Relief contrast (std.)', value: num(stats.std, 1) },
          { label: 'Area analysed', value: area(stats.areaM2) },
        ],
        classes: classify(stats, bands),
      };
    }

    case 'curvature': {
      const t = Math.max(stats.std * 0.25, 1e-6);
      const bands: Band[] = [['Concave (valleys, water collects)', -Infinity, -t, '#2c7bb6'], ['Near-flat', -t, t, '#ffffbf'], ['Convex (ridges, water sheds)', t, Infinity, '#d7191c']];
      return { heading: 'Surface shape', facts: baseFacts(stats, ''), classes: classify(stats, bands) };
    }

    case 'rugged': {
      // Riley et al. (1999) Terrain Ruggedness Index classes, metres.
      const bands: Band[] = [['Level (0–80)', 0, 81, GREEN_TO_RED[0]], ['Nearly level (81–116)', 81, 117, GREEN_TO_RED[1]], ['Slightly rugged (117–161)', 117, 162, GREEN_TO_RED[2]], ['Intermediately rugged (162–239)', 162, 240, GREEN_TO_RED[3]], ['Moderately rugged (240–497)', 240, 498, GREEN_TO_RED[4]], ['Highly rugged (≥ 498)', 498, Infinity, GREEN_TO_RED[5]]];
      return { heading: 'Terrain ruggedness (TRI)', facts: baseFacts(stats, 'm'), classes: classify(stats, bands) };
    }

    case 'ndvi':
    case 'greencover': {
      const bands: Band[] = [['Water / built-up (< 0)', -Infinity, 0, '#4575b4'], ['Bare soil (0–0.2)', 0, 0.2, '#d8b365'], ['Sparse vegetation (0.2–0.4)', 0.2, 0.4, '#d9ef8b'], ['Moderate vegetation (0.4–0.6)', 0.4, 0.6, '#66bd63'], ['Dense vegetation (> 0.6)', 0.6, Infinity, '#006837']];
      const green = shareInRange(stats, 0.2, Infinity);
      return {
        heading: 'Vegetation cover',
        facts: [
          { label: 'Mean NDVI', value: num(stats.mean, 3) },
          { label: 'Vegetated (NDVI > 0.2)', value: `${pct(green)} · ${area((stats.areaM2 * green) / 100)}` },
          { label: 'Dense vegetation (> 0.6)', value: pct(shareInRange(stats, 0.6, Infinity)) },
          { label: 'Area analysed', value: area(stats.areaM2) },
        ],
        classes: classify(stats, bands),
      };
    }

    case 'heights': {
      const bands: Band[] = [['Ground / < 3 m', -Infinity, 3, '#f7fbff'], ['Low-rise (3–10 m, 1–3 floors)', 3, 10, '#c6dbef'], ['Mid-rise (10–20 m)', 10, 20, '#6baed6'], ['High-rise (20–40 m)', 20, 40, '#2171b5'], ['Tall (> 40 m)', 40, Infinity, '#08306b']];
      return { heading: 'Object heights', facts: baseFacts(stats, 'm'), classes: classify(stats, bands) };
    }

    case 'proximity': {
      const bands: Band[] = [['< 100 m', 0, 100, GREEN_TO_RED[0]], ['100–500 m', 100, 500, GREEN_TO_RED[1]], ['500 m – 1 km', 500, 1000, GREEN_TO_RED[2]], ['1–2 km', 1000, 2000, GREEN_TO_RED[3]], ['> 2 km', 2000, Infinity, GREEN_TO_RED[4]]];
      return { heading: 'Distance bands', facts: baseFacts(stats, 'm'), classes: classify(stats, bands) };
    }

    case 'flood':
    case 'floodrisk': {
      const bands: Band[] = [['Shallow (< 0.3 m)', 0, 0.3, '#c6dbef'], ['Ankle–knee (0.3–1 m)', 0.3, 1, '#6baed6'], ['Deep (1–2 m)', 1, 2, '#2171b5'], ['Very deep (> 2 m)', 2, Infinity, '#08306b']];
      return { heading: 'Water depth', facts: baseFacts(stats, 'm'), classes: tool === 'flood' ? classify(stats, bands) : null };
    }

    default:
      return { heading: 'Value distribution', facts: baseFacts(stats, ''), classes: null };
  }
}
