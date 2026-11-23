/**
 * Georeferencing maths (QGIS Georeferencer equivalents), pure TypeScript.
 *
 * Source points are image pixel / line positions (0,0 = top-left corner of
 * the top-left pixel, line grows downwards — GDAL's convention). Target
 * points are in the output CRS (metres for UTM, degrees for EPSG:4326).
 *
 * Identical copy of backend/src/gis/georef-math.ts (the backend uses it for
 * the Helmert warp and its report); here it drives the live residuals.
 */

export type GeorefTransform = 'helmert' | 'poly1' | 'poly2' | 'poly3' | 'tps';

export interface GcpPair {
  /** pixel column */
  px: number;
  /** pixel line (row) */
  py: number;
  /** target X / Y in the output CRS */
  x: number;
  y: number;
}

/** Fewest GCPs each transform can be solved with. */
export const MIN_GCPS: Record<GeorefTransform, number> = {
  helmert: 2,
  poly1: 3,
  poly2: 6,
  poly3: 10,
  tps: 3,
};

export interface FitResult {
  /** pixel → target */
  forward: (px: number, py: number) => [number, number];
  /** per-GCP residual in target units (predicted − given) */
  residuals: { dx: number; dy: number; d: number }[];
  /** root-mean-square error in target units */
  rmse: number;
  /** average ground size of one source pixel, in target units */
  pixelSize: number;
}

/** Polynomial terms of order n for normalised (u, v). */
function terms(order: number, u: number, v: number): number[] {
  const t = [1, u, v];
  if (order >= 2) t.push(u * u, u * v, v * v);
  if (order >= 3) t.push(u * u * u, u * u * v, u * v * v, v * v * v);
  return t;
}

/** Least squares A·c = b via the normal equations (Gaussian elimination
 *  with partial pivoting). Returns null when the system is singular. */
function leastSquares(rows: number[][], b: number[]): number[] | null {
  const n = rows[0].length;
  const m = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  rows.forEach((r, k) => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) m[i][j] += r[i] * r[j];
      m[i][n] += r[i] * b[k];
    }
  });
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-12) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/** Centre / scale of the pixel coordinates (keeps high orders stable). */
function normaliser(points: GcpPair[]) {
  const cx = points.reduce((s, p) => s + p.px, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.py, 0) / points.length;
  const sc = Math.max(1, ...points.map((p) => Math.max(Math.abs(p.px - cx), Math.abs(p.py - cy))));
  return (px: number, py: number): [number, number] => [(px - cx) / sc, (py - cy) / sc];
}

function finish(points: GcpPair[], forward: (px: number, py: number) => [number, number]): FitResult {
  const residuals = points.map((p) => {
    const [x, y] = forward(p.px, p.py);
    const dx = x - p.x;
    const dy = y - p.y;
    return { dx, dy, d: Math.hypot(dx, dy) };
  });
  const rmse = Math.sqrt(residuals.reduce((s, r) => s + r.d * r.d, 0) / Math.max(points.length, 1));
  // Ground size of a pixel at the centre of the GCPs: how far one pixel
  // step moves on the ground.
  const cx = points.reduce((s, p) => s + p.px, 0) / Math.max(points.length, 1);
  const cy = points.reduce((s, p) => s + p.py, 0) / Math.max(points.length, 1);
  const [x0, y0] = forward(cx, cy);
  const [x1, y1] = forward(cx + 1, cy);
  const [x2, y2] = forward(cx, cy + 1);
  const pixelSize = Math.sqrt(Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)));
  return { forward, residuals, rmse, pixelSize };
}

/** Fits `transform` to the GCPs. Null when there are too few points or
 *  they are degenerate (e.g. all on one line). */
export function fitTransform(transform: GeorefTransform, points: GcpPair[]): FitResult | null {
  if (points.length < MIN_GCPS[transform]) return null;

  if (transform === 'helmert') {
    // Similarity (shift, rotation, one scale): X = a·u − b·w + c,
    // Y = b·u + a·w + d with w = −line (image y up, like the map).
    const norm = normaliser(points);
    const rows: number[][] = [];
    const b: number[] = [];
    for (const p of points) {
      const [u, v] = norm(p.px, p.py);
      const w = -v;
      rows.push([u, -w, 1, 0]);
      b.push(p.x);
      rows.push([w, u, 0, 1]);
      b.push(p.y);
    }
    const c = leastSquares(rows, b);
    if (!c) return null;
    const [a, bb, cx, cy] = c;
    return finish(points, (px, py) => {
      const [u, v] = norm(px, py);
      const w = -v;
      return [a * u - bb * w + cx, bb * u + a * w + cy];
    });
  }

  if (transform === 'tps') {
    // Thin plate spline passes exactly through every GCP: no residuals.
    // The forward function (for the pixel size only) is the affine part.
    const affine = fitTransform('poly1', points);
    if (!affine) return null;
    return { ...finish(points, affine.forward), residuals: points.map(() => ({ dx: 0, dy: 0, d: 0 })), rmse: 0 };
  }

  const order = transform === 'poly1' ? 1 : transform === 'poly2' ? 2 : 3;
  const norm = normaliser(points);
  const rows = points.map((p) => terms(order, ...norm(p.px, p.py)));
  const cxs = leastSquares(rows, points.map((p) => p.x));
  const cys = leastSquares(rows, points.map((p) => p.y));
  if (!cxs || !cys) return null;
  return finish(points, (px, py) => {
    const t = terms(order, ...norm(px, py));
    return [t.reduce((s, v, i) => s + v * cxs[i], 0), t.reduce((s, v, i) => s + v * cys[i], 0)];
  });
}
