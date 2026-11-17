import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppUser } from '../auth/types/app-user.type';
import { safeFetch } from '../common/safe-fetch';
import { PlaceSearchService, ReversePlace } from './place-search.service';

export interface StreetAddress {
  displayName: string;
  road: string | null;
  locality: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
}

export interface ReverseResult {
  lon: number;
  lat: number;
  places: ReversePlace[];
  address: StreetAddress | null;
  /** False when the street-address lookup is switched off. */
  addressLookup: boolean;
}

export interface StreetImage {
  id: string;
  thumbUrl: string | null;
  capturedAt: string | null;
  compassAngle: number | null;
  lon: number;
  lat: number;
  distanceM: number;
  viewerUrl: string;
}

const CACHE_MS = 10 * 60 * 1000;

/**
 * Reverse geocoding ("What's here?") and street-level imagery lookup.
 *  - Places come from the municipality's own layers (PlaceSearchService).
 *  - A street address comes from a Nominatim-compatible service
 *    (REVERSE_GEOCODER_URL, default OpenStreetMap's; REVERSE_GEOCODER=off
 *    disables it). Only the clicked coordinate is sent.
 *  - Street imagery comes from Mapillary when MAPILLARY_ACCESS_TOKEN is set.
 */
@Injectable()
export class LocationService {
  private readonly logger = new Logger(LocationService.name);
  private readonly addressCache = new Map<string, { at: number; value: StreetAddress | null }>();

  constructor(
    private readonly config: ConfigService,
    private readonly placeSearch: PlaceSearchService,
  ) {}

  get addressLookupEnabled(): boolean {
    return (this.config.get<string>('REVERSE_GEOCODER') ?? 'on').toLowerCase() !== 'off';
  }

  get streetImageryEnabled(): boolean {
    return !!this.config.get<string>('MAPILLARY_ACCESS_TOKEN');
  }

  async reverse(appUser: AppUser, lon: number, lat: number): Promise<ReverseResult> {
    const [places, address] = await Promise.all([
      this.placeSearch.reverse(appUser, lon, lat).catch(() => []),
      this.addressLookupEnabled ? this.streetAddress(lon, lat) : Promise.resolve(null),
    ]);
    return { lon, lat, places, address, addressLookup: this.addressLookupEnabled };
  }

  private async streetAddress(lon: number, lat: number): Promise<StreetAddress | null> {
    const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    const hit = this.addressCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const base = this.config.get<string>('REVERSE_GEOCODER_URL') ?? 'https://nominatim.openstreetmap.org/reverse';
    const url = `${base}?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lon}`;
    let value: StreetAddress | null = null;
    try {
      const res = await safeFetch(url, { timeoutMs: 6000, maxBytes: 512 * 1024, allowPrivate: true, headers: { Accept: 'application/json' } });
      if (res.status === 200) {
        const json = JSON.parse(res.body.toString('utf8')) as {
          display_name?: string;
          address?: Record<string, string>;
        };
        const a = json.address ?? {};
        if (json.display_name) {
          value = {
            displayName: json.display_name,
            road: a['road'] ?? a['pedestrian'] ?? a['footway'] ?? null,
            locality: a['neighbourhood'] ?? a['suburb'] ?? a['village'] ?? a['hamlet'] ?? null,
            city: a['city'] ?? a['town'] ?? a['municipality'] ?? null,
            district: a['state_district'] ?? a['county'] ?? null,
            state: a['state'] ?? null,
            postcode: a['postcode'] ?? null,
            country: a['country'] ?? null,
          };
        }
      }
    } catch (error) {
      this.logger.debug(`Reverse geocoder failed: ${(error as Error).message}`);
      return null;
    }
    this.addressCache.set(key, { at: Date.now(), value });
    if (this.addressCache.size > 1000) this.addressCache.delete(this.addressCache.keys().next().value as string);
    return value;
  }

  async streetImages(lon: number, lat: number): Promise<{ configured: boolean; images: StreetImage[] }> {
    const token = this.config.get<string>('MAPILLARY_ACCESS_TOKEN');
    if (!token) return { configured: false, images: [] };
    const d = 0.002; // ~200 m
    const bbox = [lon - d, lat - d, lon + d, lat + d].map((n) => n.toFixed(6)).join(',');
    const url =
      `https://graph.mapillary.com/images?fields=id,thumb_1024_url,captured_at,compass_angle,computed_geometry,geometry` +
      `&bbox=${bbox}&limit=100&access_token=${encodeURIComponent(token)}`;
    const res = await safeFetch(url, { timeoutMs: 8000, maxBytes: 2 * 1024 * 1024 });
    if (res.status !== 200) {
      this.logger.warn(`Mapillary answered ${res.status}`);
      return { configured: true, images: [] };
    }
    const json = JSON.parse(res.body.toString('utf8')) as {
      data?: {
        id: string;
        thumb_1024_url?: string;
        captured_at?: number;
        compass_angle?: number;
        computed_geometry?: { coordinates: [number, number] };
        geometry?: { coordinates: [number, number] };
      }[];
    };
    const images = (json.data ?? [])
      .map((img) => {
        const [x, y] = (img.computed_geometry ?? img.geometry)?.coordinates ?? [NaN, NaN];
        return {
          id: img.id,
          thumbUrl: img.thumb_1024_url ?? null,
          capturedAt: img.captured_at ? new Date(img.captured_at).toISOString() : null,
          compassAngle: img.compass_angle ?? null,
          lon: x,
          lat: y,
          distanceM: Math.round(haversine(lon, lat, x, y)),
          viewerUrl: `https://www.mapillary.com/app/?pKey=${img.id}&focus=photo`,
        };
      })
      .filter((img) => Number.isFinite(img.lon) && Number.isFinite(img.lat))
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, 8);
    return { configured: true, images };
  }
}

function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}
