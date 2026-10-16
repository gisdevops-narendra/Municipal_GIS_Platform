/**
 * COGO traverse entry — "bearing distance" legs from a start point, as used
 * on survey plans / land records. Each line is one leg:
 *
 *   45.5 30          azimuth in decimal degrees (clockwise from north), metres
 *   45-30-15 30      azimuth as degrees-minutes-seconds
 *   N45-30E 30       quadrant bearing (N/S … E/W)
 *
 * Positions are computed on the sphere (accurate to well under a centimetre
 * per 100 m leg), in EPSG:4326.
 */

const EARTH_RADIUS_M = 6371008.8;

export interface CogoLeg {
  azimuth: number;
  distance: number;
}

export function parseCogoLegs(text: string): CogoLeg[] | string {
  const legs: CogoLeg[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const parts = line.split(/[\s,]+/);
    if (parts.length !== 2) return `Line ${i + 1}: expected "bearing distance".`;
    const azimuth = parseBearing(parts[0]);
    const distance = Number(parts[1]);
    if (azimuth === null) return `Line ${i + 1}: cannot read bearing "${parts[0]}".`;
    if (!(distance > 0)) return `Line ${i + 1}: distance must be a positive number of metres.`;
    legs.push({ azimuth, distance });
  }
  return legs.length ? legs : 'Enter at least one leg.';
}

function parseBearing(raw: string): number | null {
  const quadrant = /^([NS])([\d.]+)(?:[-°:]([\d.]+))?(?:[-':]([\d.]+))?"?([EW])$/i.exec(raw);
  if (quadrant) {
    const angle = dms(quadrant[2], quadrant[3], quadrant[4]);
    if (angle === null || angle > 90) return null;
    const ns = quadrant[1].toUpperCase();
    const ew = quadrant[5].toUpperCase();
    if (ns === 'N') return ew === 'E' ? angle : 360 - angle;
    return ew === 'E' ? 180 - angle : 180 + angle;
  }
  const plain = /^([\d.]+)(?:[-°:]([\d.]+))?(?:[-':]([\d.]+))?"?$/.exec(raw);
  if (!plain) return null;
  const angle = dms(plain[1], plain[2], plain[3]);
  return angle !== null && angle < 360 ? angle : null;
}

function dms(d: string, m?: string, s?: string): number | null {
  const value = Number(d) + Number(m ?? 0) / 60 + Number(s ?? 0) / 3600;
  return Number.isFinite(value) ? value : null;
}

/** The traverse vertices, starting with `start` ([lon, lat]). */
export function traverse(start: [number, number], legs: CogoLeg[]): [number, number][] {
  const points: [number, number][] = [start];
  let [lon, lat] = start;
  for (const leg of legs) {
    const φ1 = (lat * Math.PI) / 180;
    const λ1 = (lon * Math.PI) / 180;
    const θ = (leg.azimuth * Math.PI) / 180;
    const δ = leg.distance / EARTH_RADIUS_M;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
    const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
    lon = (λ2 * 180) / Math.PI;
    lat = (φ2 * 180) / Math.PI;
    points.push([lon, lat]);
  }
  return points;
}

/** Closing error of a traverse meant to return to its start, in metres. */
export function misclosure(points: [number, number][]): number {
  const [a, b] = [points[0], points[points.length - 1]];
  const φ1 = (a[1] * Math.PI) / 180;
  const φ2 = (b[1] * Math.PI) / 180;
  const dφ = φ2 - φ1;
  const dλ = ((b[0] - a[0]) * Math.PI) / 180;
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}
