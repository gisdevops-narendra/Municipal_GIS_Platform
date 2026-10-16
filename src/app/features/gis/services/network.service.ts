import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

/** `[longitude, latitude]` in EPSG:4326. */
export type LonLat = [number, number];

export interface MultiLineGeometry {
  type: 'MultiLineString';
  coordinates: LonLat[][];
}

export interface RouteResult {
  lengthM: number;
  path: MultiLineGeometry;
}

export interface FacilityResult {
  label: string;
  lengthM: number;
  location: LonLat;
  properties: Record<string, unknown>;
  path: MultiLineGeometry;
}

export interface TraceResult {
  segmentCount: number;
  lengthM: number;
  path: MultiLineGeometry;
  endPoints: { type: 'MultiPoint'; coordinates: LonLat[] };
}

/** GIS Advanced Tools — network analysis on the backend (`/gis/network`). */
@Injectable({ providedIn: 'root' })
export class NetworkService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/gis/network`;

  route(layerId: string, from: LonLat, to: LonLat): Observable<RouteResult> {
    return this.http.post<RouteResult>(`${this.baseUrl}/route`, { layerId, from, to });
  }

  nearest(
    layerId: string,
    facilityLayerId: string,
    from: LonLat,
    count: number
  ): Observable<{ facilities: FacilityResult[] }> {
    return this.http.post<{ facilities: FacilityResult[] }>(`${this.baseUrl}/nearest`, {
      layerId,
      facilityLayerId,
      from,
      count
    });
  }

  trace(layerId: string, at: LonLat, maxDistanceM?: number): Observable<TraceResult> {
    return this.http.post<TraceResult>(`${this.baseUrl}/trace`, { layerId, at, maxDistanceM });
  }
}
