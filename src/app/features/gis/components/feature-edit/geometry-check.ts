/**
 * Client-side geometry validation before a feature is saved — the checks a
 * desktop GIS runs while digitizing: enough vertices, no zero-length line,
 * no zero-area or self-crossing polygon ring. Returns a message, or null
 * when the geometry is fine. Input is GeoJSON (EPSG:4326).
 */
type Position = number[];

export function geometryProblem(geometry: Record<string, unknown> | null): string | null {
  if (!geometry) return 'Draw the feature on the map first.';
  const coords = geometry['coordinates'] as unknown;
  switch (geometry['type']) {
    case 'Point':
      return validPosition(coords as Position) ? null : 'The point has no valid position.';
    case 'MultiPoint':
      return (coords as Position[]).every(validPosition) ? null : 'A point has no valid position.';
    case 'LineString':
      return lineProblem(coords as Position[]);
    case 'MultiLineString':
      return firstProblem((coords as Position[][]).map(lineProblem));
    case 'Polygon':
      return polygonProblem(coords as Position[][]);
    case 'MultiPolygon':
      return firstProblem((coords as Position[][][]).map(polygonProblem));
    default:
      return null;
  }
}

function firstProblem(problems: (string | null)[]): string | null {
  return problems.find((p) => p !== null) ?? null;
}

function validPosition(p: Position): boolean {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

function distinct(points: Position[]): Position[] {
  return points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
}

function lineProblem(line: Position[]): string | null {
  if (!line.every(validPosition)) return 'The line has an invalid vertex.';
  return distinct(line).length < 2 ? 'A line needs at least two different vertices.' : null;
}

function polygonProblem(rings: Position[][]): string | null {
  for (const ring of rings) {
    if (!ring.every(validPosition)) return 'The polygon has an invalid vertex.';
    const open = distinct(ring);
    const closed =
      open.length > 1 && open[0][0] === open[open.length - 1][0] && open[0][1] === open[open.length - 1][1];
    const vertices = closed ? open.slice(0, -1) : open;
    if (vertices.length < 3) return 'A polygon needs at least three corners.';
    if (Math.abs(ringArea(vertices)) < 1e-14) return 'The polygon has no area.';
    if (crossesItself(vertices)) return 'The polygon crosses itself — reshape it so its edges do not cross.';
  }
  return null;
}

function ringArea(v: Position[]): number {
  let area = 0;
  for (let i = 0; i < v.length; i++) {
    const [x1, y1] = v[i];
    const [x2, y2] = v[(i + 1) % v.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

/** Any two non-adjacent edges of the closed ring intersecting. */
function crossesItself(v: Position[]): boolean {
  const n = v.length;
  if (n > 2000) return false; // O(n²) — leave very large rings to the server
  for (let i = 0; i < n; i++) {
    const a1 = v[i];
    const a2 = v[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // neighbours share a vertex
      if (segmentsIntersect(a1, a2, v[j], v[(j + 1) % n])) return true;
    }
  }
  return false;
}

function segmentsIntersect(p1: Position, p2: Position, p3: Position, p4: Position): boolean {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (
    (d1 === 0 && onSegment(p3, p4, p1)) ||
    (d2 === 0 && onSegment(p3, p4, p2)) ||
    (d3 === 0 && onSegment(p1, p2, p3)) ||
    (d4 === 0 && onSegment(p1, p2, p4))
  );
}

function cross(a: Position, b: Position, c: Position): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: Position, b: Position, p: Position): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])
  );
}
