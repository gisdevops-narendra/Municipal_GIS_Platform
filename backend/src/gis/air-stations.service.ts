import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { safeFetch } from '../common/safe-fetch';
import { PrismaService } from '../prisma/prisma.service';

export type Pollutant = 'pm25' | 'pm10' | 'no2' | 'o3' | 'so2' | 'co';

export interface AirStation {
  id: string;
  name: string;
  source: 'cpcb' | 'openaq' | 'sensor.community';
  kind: 'reference' | 'low-cost';
  point: [number, number];
  updated: string | null;
  readings: Partial<Record<Pollutant, number>>;
  units: Partial<Record<Pollutant, string>>;
  /** Official India AQI and per-pollutant sub-indices (CPCB only). */
  aqi?: number;
  subIndex?: Partial<Record<Pollutant, number>>;
  /** 24-hour min / max behind the average (CPCB). */
  range?: Partial<Record<Pollutant, [number, number]>>;
  predominant?: string;
  city?: string;
}

const CPCB_PARAMS: Record<string, Pollutant> = { 'PM2.5': 'pm25', PM10: 'pm10', NO2: 'no2', OZONE: 'o3', SO2: 'so2', CO: 'co' };
const CPCB_URL = 'https://airquality.cpcb.gov.in/caaqms/rss_feed';

const OPENAQ_PARAMS: Record<string, Pollutant> = { pm25: 'pm25', pm10: 'pm10', no2: 'no2', o3: 'o3', so2: 'so2', co: 'co' };

/**
 * Live air-quality stations near a point.
 *  - CPCB (India, free, no key): every official CAAQMS station with the
 *    National AQI — the public RSS feed, cached for 10 minutes.
 *  - Sensor.Community (free, no key): citizen PM2.5 / PM10 sensors.
 *  - OpenAQ v3 (free key, OPENAQ_API_KEY): official / reference monitors
 *    (CPCB etc.) with NO2, O3, SO2, CO too.
 */
@Injectable()
export class AirStationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AirStationsService.name);

  private cpcbCache: { at: number; stations: AirStation[] } | null = null;

  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Snapshot CPCB every 30 min so trends build up over time. */
  onModuleInit(): void {
    if (this.config.get<string>('AQI_SNAPSHOTS') === 'off') return;
    this.first = setTimeout(() => void this.snapshot(), 60_000);
    this.timer = setInterval(() => void this.snapshot(), 30 * 60_000);
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  private async snapshot(): Promise<void> {
    try {
      const stations = await this.cpcbAll(true);
      const rows = stations
        .filter((s) => s.updated && (s.aqi !== undefined || s.readings.pm25 !== undefined))
        .map((s) => ({
          station: s.name,
          hour: new Date(s.updated!),
          city: s.city ?? null,
          aqi: s.aqi ?? null,
          pm25: s.readings.pm25 ?? null,
          pm10: s.readings.pm10 ?? null,
        }));
      await this.prisma.gISAqiSnapshot.createMany({ data: rows, skipDuplicates: true });
      await this.prisma.gISAqiSnapshot.deleteMany({ where: { hour: { lt: new Date(Date.now() - 90 * 86_400_000) } } });
    } catch (e) {
      this.logger.warn(`AQI snapshot failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Every CPCB station in India (city ranking, national map). */
  async india() {
    const stations = await this.cpcbAll();
    return { updatedAt: this.cpcbCache ? new Date(this.cpcbCache.at).toISOString() : null, stations };
  }

  /** Captured AQI / PM history of one station, or the average of a city. */
  async history(station: string | undefined, city: string | undefined, days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    if (station) {
      const rows = await this.prisma.gISAqiSnapshot.findMany({
        where: { station, hour: { gte: since } },
        orderBy: { hour: 'asc' },
        select: { hour: true, aqi: true, pm25: true, pm10: true },
      });
      return { points: rows.map((r) => ({ t: r.hour.toISOString(), aqi: r.aqi, pm25: r.pm25, pm10: r.pm10 })) };
    }
    if (!city) return { points: [] };
    const rows = await this.prisma.$queryRaw<{ hour: Date; aqi: number | null; pm25: number | null; pm10: number | null }[]>`
      SELECT hour, round(avg(aqi))::int AS aqi, round(avg(pm25)::numeric, 1)::float8 AS pm25, round(avg(pm10)::numeric, 1)::float8 AS pm10
        FROM gis_aqi_snapshots WHERE city = ${city} AND hour >= ${since} GROUP BY hour ORDER BY hour`;
    return { points: rows.map((r) => ({ t: r.hour.toISOString(), aqi: r.aqi, pm25: r.pm25, pm10: r.pm10 })) };
  }

  async near(lon: number, lat: number, radiusKm: number) {
    const key = this.config.get<string>('OPENAQ_API_KEY');
    const [cpcb, community, openaq] = await Promise.all([
      this.cpcb(lon, lat, radiusKm).catch((e) => this.fail('CPCB', e)),
      this.sensorCommunity(lon, lat, radiusKm).catch((e) => this.fail('Sensor.Community', e)),
      key ? this.openAq(lon, lat, radiusKm, key).catch((e) => this.fail('OpenAQ', e)) : Promise.resolve([] as AirStation[]),
    ]);
    return { openaqConfigured: !!key, stations: [...cpcb, ...openaq, ...community] };
  }

  private fail(source: string, e: unknown): AirStation[] {
    this.logger.warn(`${source} air stations failed: ${e instanceof Error ? e.message : e}`);
    return [];
  }

  private async json<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
    const res = await safeFetch(url, { timeoutMs: 20_000, maxBytes: 20 * 1024 * 1024, headers: { Accept: 'application/json', ...headers } });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return JSON.parse(res.body.toString('utf8')) as T;
  }

  private async cpcbAll(fresh = false): Promise<AirStation[]> {
    if (fresh || !this.cpcbCache || Date.now() - this.cpcbCache.at > 10 * 60_000) {
      const res = await safeFetch(CPCB_URL, { timeoutMs: 30_000, maxBytes: 10 * 1024 * 1024 });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      this.cpcbCache = { at: Date.now(), stations: this.parseCpcb(res.body.toString('utf8')) };
    }
    return this.cpcbCache.stations;
  }

  private async cpcb(lon: number, lat: number, radiusKm: number): Promise<AirStation[]> {
    return (await this.cpcbAll()).filter((s) => this.km([lon, lat], s.point) <= radiusKm);
  }

  private parseCpcb(xml: string): AirStation[] {
    const attr = (tag: string, name: string) => {
      const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
      return m ? m[1].replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"') : '';
    };
    const out: AirStation[] = [];
    const cityRe = /<City\b([^>]*)>([\s\S]*?)<\/City>/g;
    for (let c = cityRe.exec(xml); c; c = cityRe.exec(xml)) {
      const city = attr(c[1], 'id');
      const stRe = /<Station\b([^>]*)>([\s\S]*?)<\/Station>/g;
      for (let m = stRe.exec(c[2]); m; m = stRe.exec(c[2])) {
        const lat = Number(attr(m[1], 'latitude'));
        const lon = Number(attr(m[1], 'longitude'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) continue;
        const readings: Partial<Record<Pollutant, number>> = {};
        const units: Partial<Record<Pollutant, string>> = {};
        const subIndex: Partial<Record<Pollutant, number>> = {};
        const range: Partial<Record<Pollutant, [number, number]>> = {};
        for (const pm of m[2].matchAll(/<Pollutant_Index\b([^>]*)\/>/g)) {
          const p = CPCB_PARAMS[attr(pm[1], 'id')];
          if (!p) continue;
          const avg = Number(attr(pm[1], 'Avg'));
          const si = Number(attr(pm[1], 'Hourly_sub_index'));
          if (attr(pm[1], 'Avg') !== '' && Number.isFinite(avg)) {
            readings[p] = avg;
            units[p] = p === 'co' ? 'mg/m³' : 'µg/m³';
            const lo = Number(attr(pm[1], 'Min'));
            const hi = Number(attr(pm[1], 'Max'));
            if (Number.isFinite(lo) && Number.isFinite(hi)) range[p] = [lo, hi];
          }
          if (attr(pm[1], 'Hourly_sub_index') !== '' && Number.isFinite(si)) subIndex[p] = si;
        }
        const aqiTag = /<Air_Quality_Index\b([^>]*)\/>/.exec(m[2]);
        const aqi = aqiTag ? Number(attr(aqiTag[1], 'Value')) : NaN;
        const [d, mo, y] = attr(m[1], 'lastupdate').split(/[- ]/);
        const time = attr(m[1], 'lastupdate').split(' ')[1];
        out.push({
          id: `cpcb-${out.length}-${attr(m[1], 'id')}`,
          name: attr(m[1], 'id'),
          source: 'cpcb',
          kind: 'reference',
          point: [lon, lat],
          // CPCB times are IST.
          updated: y && time ? `${y}-${mo}-${d}T${time}+05:30` : null,
          readings,
          units,
          subIndex,
          range,
          aqi: Number.isFinite(aqi) && aqiTag && attr(aqiTag[1], 'Value') !== '' ? aqi : undefined,
          predominant: aqiTag ? attr(aqiTag[1], 'Predominant_Parameter') || undefined : undefined,
          city,
        });
      }
    }
    return out;
  }

  private km(a: [number, number], b: [number, number]): number {
    const r = Math.PI / 180;
    const h = Math.sin(((b[1] - a[1]) * r) / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  private async sensorCommunity(lon: number, lat: number, radiusKm: number): Promise<AirStation[]> {
    type Row = {
      timestamp: string;
      location: { id: number; latitude: string; longitude: string; indoor?: number };
      sensor: { sensor_type: { name: string } };
      sensordatavalues: { value_type: string; value: string }[];
    };
    const rows = await this.json<Row[]>(
      `https://data.sensor.community/airrohr/v1/filter/area=${lat.toFixed(4)},${lon.toFixed(4)},${Math.min(radiusKm, 100)}`,
    );
    const byLoc = new Map<number, AirStation & { n: Partial<Record<Pollutant, number>> }>();
    for (const r of rows) {
      if (r.location.indoor) continue;
      let s = byLoc.get(r.location.id);
      if (!s) {
        s = {
          id: `sc-${r.location.id}`,
          name: `Sensor ${r.location.id}`,
          source: 'sensor.community',
          kind: 'low-cost',
          point: [Number(r.location.longitude), Number(r.location.latitude)],
          updated: null,
          readings: {},
          units: {},
          n: {},
        };
        byLoc.set(r.location.id, s);
      }
      const ts = r.timestamp.replace(' ', 'T') + 'Z';
      if (!s.updated || ts > s.updated) s.updated = ts;
      for (const v of r.sensordatavalues) {
        const p: Pollutant | null = v.value_type === 'P2' ? 'pm25' : v.value_type === 'P1' ? 'pm10' : null;
        const val = Number(v.value);
        if (!p || !Number.isFinite(val) || val < 0 || val > 2000) continue;
        // The feed holds several 5-min samples — average them.
        const n = (s.n[p] ?? 0) + 1;
        s.readings[p] = ((s.readings[p] ?? 0) * (n - 1) + val) / n;
        s.n[p] = n;
        s.units[p] = 'µg/m³';
      }
    }
    return [...byLoc.values()]
      .filter((s) => Object.keys(s.readings).length)
      .map(({ n: _n, ...s }) => ({ ...s, readings: this.round(s.readings) }));
  }

  private async openAq(lon: number, lat: number, radiusKm: number, key: string): Promise<AirStation[]> {
    const headers = { 'X-API-Key': key };
    type Loc = {
      id: number;
      name: string | null;
      coordinates: { latitude: number; longitude: number };
      datetimeLast?: { utc: string } | null;
      sensors: { id: number; parameter: { name: string; units: string } }[];
    };
    // OpenAQ caps the search radius at 25 km — use a bbox beyond that.
    const area =
      radiusKm <= 25
        ? `coordinates=${lat.toFixed(4)},${lon.toFixed(4)}&radius=${Math.round(radiusKm * 1000)}`
        : (() => {
            const dy = radiusKm / 110.54;
            const dx = radiusKm / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
            return `bbox=${[lon - dx, lat - dy, lon + dx, lat + dy].map((n) => n.toFixed(4)).join(',')}`;
          })();
    const locs = await this.json<{ results: Loc[] }>(`https://api.openaq.org/v3/locations?${area}&limit=60`, headers);
    const recent = locs.results.filter((l) => l.datetimeLast && Date.now() - Date.parse(l.datetimeLast.utc) < 7 * 86_400_000);
    const out = await Promise.all(
      recent.slice(0, 40).map(async (l): Promise<AirStation | null> => {
        try {
          const latest = await this.json<{ results: { sensorsId: number; value: number; datetime: { utc: string } }[] }>(
            `https://api.openaq.org/v3/locations/${l.id}/latest`,
            headers,
          );
          const readings: Partial<Record<Pollutant, number>> = {};
          const units: Partial<Record<Pollutant, string>> = {};
          for (const v of latest.results) {
            const sensor = l.sensors.find((s) => s.id === v.sensorsId);
            const p = sensor && OPENAQ_PARAMS[sensor.parameter.name];
            if (!p || !Number.isFinite(v.value) || v.value < 0) continue;
            readings[p] = v.value;
            units[p] = sensor.parameter.units;
          }
          if (!Object.keys(readings).length) return null;
          return {
            id: `oaq-${l.id}`,
            name: l.name || `Station ${l.id}`,
            source: 'openaq',
            kind: 'reference',
            point: [l.coordinates.longitude, l.coordinates.latitude],
            updated: l.datetimeLast?.utc ?? null,
            readings: this.round(readings),
            units,
          };
        } catch {
          return null;
        }
      }),
    );
    return out.filter((s): s is AirStation => !!s);
  }

  private round(r: Partial<Record<Pollutant, number>>) {
    const out: Partial<Record<Pollutant, number>> = {};
    for (const [k, v] of Object.entries(r)) out[k as Pollutant] = Math.round((v as number) * 10) / 10;
    return out;
  }
}
