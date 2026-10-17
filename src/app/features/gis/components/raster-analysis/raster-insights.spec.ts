import { RasterStatistics } from '../../services/raster.service';
import { rasterInsights, shareInRange } from './raster-insights';

/** Uniform histogram over [min, max) with `bins` equal bins. */
function stats(min: number, max: number, counts: number[]): RasterStatistics {
  const step = (max - min) / counts.length;
  const edges = counts.map((_, i) => min + i * step).concat(max);
  return {
    band: 1, validCells: counts.reduce((s, c) => s + c, 0), nodataCells: 0,
    min, max, mean: (min + max) / 2, std: 1, p1: min, p25: min, median: (min + max) / 2, p75: max, p99: max,
    areaM2: 1_000_000, histogram: { counts, edges },
  } as RasterStatistics;
}

describe('rasterInsights', () => {
  it('splits shares across bins proportionally', () => {
    const s = stats(0, 10, [10, 10]); // half the cells in 0–5, half in 5–10
    expect(shareInRange(s, 0, 5)).toBeCloseTo(50);
    expect(shareInRange(s, 2.5, 7.5)).toBeCloseTo(50);
  });

  it('reads slope as terrain classes that add up to 100 %', () => {
    const s = stats(0, 60, [40, 30, 20, 10, 0, 0]); // 0–10, 10–20, … degrees
    const r = rasterInsights('slope', s);
    expect(r.heading).toBe('Terrain steepness');
    const total = r.classes!.reduce((sum, c) => sum + c.pct, 0);
    expect(total).toBeCloseTo(100, 0);
    expect(r.classes![0].label).toContain('Flat');
    expect(r.facts.some((f) => f.label.startsWith('Easily buildable'))).toBe(true);
  });

  it('reads aspect as compass sectors and finds the dominant one', () => {
    // all cells between 160° and 200° → South
    const counts = new Array(36).fill(0);
    counts[16] = 50; counts[17] = 50; counts[18] = 50; counts[19] = 50;
    const r = rasterInsights('aspect', stats(0, 360, counts));
    expect(r.facts[0].value).toContain('South');
  });

  it('falls back to generic statistics for other tools', () => {
    const r = rasterInsights('calc', stats(0, 1, [1, 1]));
    expect(r.classes).toBeNull();
    expect(r.facts.map((f) => f.label)).toContain('Mean');
  });
});
