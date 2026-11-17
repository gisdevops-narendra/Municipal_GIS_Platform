import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { ExternalLayerSpec, FetchText } from './external-layers';

// ----- What's Here -----
export interface ReversePlace {
  layerName: string;
  label: string;
  kind: 'within' | 'near';
  distanceM: number | null;
}
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
  addressLookup: boolean;
}

// ----- Street View -----
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

// ----- Share Map -----
export interface ShareLink {
  id: string;
  token: string;
  title: string;
  description: string | null;
  layerCount: number;
  createdById: string;
  expiresAt: string | null;
  expired: boolean;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
}
export interface CreateShareLink {
  title: string;
  description?: string;
  layerIds: string[];
  external: ExternalLayerSpec[];
  basemap: string;
  center: [number, number];
  zoom: number;
  expiresInDays: number | null;
}
export interface PublicShare {
  title: string;
  description: string | null;
  municipalityName: string | null;
  basemap: string;
  center: [number, number];
  zoom: number;
  expiresAt: string | null;
  layers: {
    id: string;
    name: string;
    layerType: 'VECTOR' | 'RASTER';
    geometryType: string | null;
    geoserverWorkspace: string;
    geoserverLayer: string;
    styleName: string | null;
  }[];
  external: ExternalLayerSpec[];
}

// ----- API & Webhooks -----
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdById: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  createdAt: string;
}
export interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveredAt: string | null;
  createdAt: string;
}

/** HTTP for Add Service, What's Here, Street View, Share Map and
 *  API & Webhooks. */
@Injectable({ providedIn: 'root' })
export class PlatformExtrasService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  reverse(lon: number, lat: number): Observable<ReverseResult> {
    return this.http.get<ReverseResult>(`${this.api}/gis/location/reverse`, { params: { lon, lat } });
  }

  streetImagery(lon: number, lat: number): Observable<{ configured: boolean; images: StreetImage[] }> {
    return this.http.get<{ configured: boolean; images: StreetImage[] }>(`${this.api}/gis/location/street-imagery`, {
      params: { lon, lat }
    });
  }

  /** Fetches an outside service's document through the backend (CORS). */
  readonly proxyFetchText: FetchText = (url) =>
    firstValueFrom(
      this.http.get(`${this.api}/gis/external-services/fetch`, {
        params: new HttpParams().set('url', url),
        responseType: 'text'
      })
    );

  /** Direct first (fast, no server hop), proxy when CORS blocks it. */
  readonly smartFetchText: FetchText = async (url) => {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
    } catch {
      /* CORS / network — fall through to the proxy */
    }
    return this.proxyFetchText(url);
  };

  listShares(): Observable<ShareLink[]> {
    return this.http.get<ShareLink[]>(`${this.api}/gis/shares`);
  }
  createShare(body: CreateShareLink): Observable<ShareLink> {
    return this.http.post<ShareLink>(`${this.api}/gis/shares`, body);
  }
  revokeShare(id: string): Observable<void> {
    return this.http.delete<void>(`${this.api}/gis/shares/${id}`);
  }
  openPublicShare(token: string): Observable<PublicShare> {
    return this.http.get<PublicShare>(`${this.api}/public/shares/${encodeURIComponent(token)}`);
  }

  listApiKeys(): Observable<ApiKey[]> {
    return this.http.get<ApiKey[]>(`${this.api}/gis/integrations/api-keys`);
  }
  createApiKey(name: string, expiresInDays: number | null): Observable<ApiKey & { key: string }> {
    return this.http.post<ApiKey & { key: string }>(`${this.api}/gis/integrations/api-keys`, { name, expiresInDays });
  }
  revokeApiKey(id: string): Observable<void> {
    return this.http.delete<void>(`${this.api}/gis/integrations/api-keys/${id}`);
  }
  webhookEvents(): Observable<string[]> {
    return this.http.get<string[]>(`${this.api}/gis/integrations/webhooks/events`);
  }
  listWebhooks(): Observable<Webhook[]> {
    return this.http.get<Webhook[]>(`${this.api}/gis/integrations/webhooks`);
  }
  createWebhook(body: { name: string; url: string; events: string[] }): Observable<Webhook & { secret: string }> {
    return this.http.post<Webhook & { secret: string }>(`${this.api}/gis/integrations/webhooks`, body);
  }
  updateWebhook(id: string, body: Partial<{ name: string; url: string; events: string[]; active: boolean }>): Observable<Webhook> {
    return this.http.patch<Webhook>(`${this.api}/gis/integrations/webhooks/${id}`, body);
  }
  deleteWebhook(id: string): Observable<void> {
    return this.http.delete<void>(`${this.api}/gis/integrations/webhooks/${id}`);
  }
  testWebhook(id: string): Observable<{ ok: boolean; status: number | null; error: string | null }> {
    return this.http.post<{ ok: boolean; status: number | null; error: string | null }>(
      `${this.api}/gis/integrations/webhooks/${id}/test`,
      {}
    );
  }
}
