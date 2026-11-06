import { FetchSource, type RangeResponse, type Source } from 'pmtiles';
import type { LegendRamp } from '../components/layer-legend/legend-model';

/**
 * PMTiles archive behind the backend's authenticated range endpoint. The
 * access token is read on every request (Keycloak refreshes it), unlike a
 * plain FetchSource whose headers are fixed when it is created.
 */
export class AuthFetchSource implements Source {
  private readonly inner: FetchSource;

  constructor(
    private readonly url: string,
    private readonly token: () => string | undefined
  ) {
    this.inner = new FetchSource(url);
  }

  getKey(): string {
    return this.url;
  }

  getBytes(offset: number, length: number, signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
    const token = this.token();
    if (token) this.inner.customHeaders.set('Authorization', `Bearer ${token}`);
    return this.inner.getBytes(offset, length, signal, etag);
  }
}

type Rgba = [number, number, number, number];

const rgba = (hex: string, opacity: number): Rgba => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, Math.round(Math.max(0, Math.min(1, opacity)) * 255)];
};

const mix = (a: Rgba, b: Rgba, t: number): Rgba => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as Rgba;

/**
 * The layer's GeoServer colour map as a TiTiler interval colormap
 * ([[[min, max], [r, g, b, a]], …], applied to the raw pixel values), so a
 * COG tile looks like the WMS rendering. Continuous ramps are sampled in
 * 48 steps; interval / value maps are reproduced exactly.
 */
export function titilerColormap(ramp: LegendRamp): [[number, number], Rgba][] | null {
  const stops = [...ramp.stops].sort((a, b) => a.quantity - b.quantity);
  if (!stops.length) return null;
  if (ramp.type === 'values') {
    return stops.map((s) => [[s.quantity, s.quantity + 1e-9], rgba(s.color, s.opacity)]);
  }
  if (ramp.type === 'intervals') {
    // GeoServer: each entry colours the values BELOW its quantity.
    return stops.map((s, i) => [[i === 0 ? -1e30 : stops[i - 1].quantity, s.quantity], rgba(s.color, s.opacity)]);
  }
  if (stops.length === 1) return [[[-1e30, 1e30], rgba(stops[0].color, stops[0].opacity)]];
  const lo = stops[0].quantity;
  const hi = stops[stops.length - 1].quantity;
  const steps = 48;
  const out: [[number, number], Rgba][] = [];
  const colorAt = (q: number): Rgba => {
    const k = Math.max(1, stops.findIndex((s) => s.quantity >= q));
    const a = stops[k - 1];
    const b = stops[k] ?? a;
    const t = b.quantity === a.quantity ? 0 : (q - a.quantity) / (b.quantity - a.quantity);
    return mix(rgba(a.color, a.opacity), rgba(b.color, b.opacity), Math.max(0, Math.min(1, t)));
  };
  for (let i = 0; i < steps; i++) {
    const from = lo + ((hi - lo) * i) / steps;
    const to = lo + ((hi - lo) * (i + 1)) / steps;
    // Values beyond the ramp take its end colours, as in GeoServer.
    out.push([[i === 0 ? -1e30 : from, i === steps - 1 ? 1e30 : to], colorAt((from + to) / 2)]);
  }
  return out;
}
