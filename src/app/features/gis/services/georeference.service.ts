import { HttpClient, HttpEvent } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import type { GeorefTransform } from './georef-math';

export type GeorefResampling = 'near' | 'bilinear' | 'cubic' | 'cubicspline' | 'lanczos';

export interface GeorefGcp {
  id: string;
  enabled: boolean;
  /** source image pixel column / line */
  px: number;
  py: number;
  /** destination, WGS84 */
  lon: number;
  lat: number;
}

export interface GeorefSettings {
  transform: GeorefTransform;
  resampling: GeorefResampling;
  /** output CRS, e.g. "EPSG:32642" */
  targetCrs: string;
}

export interface GeorefSession {
  id: string;
  name: string;
  originalName: string;
  createdAt: string;
  updatedAt: string;
  status: 'processing' | 'ready' | 'failed';
  stage: string | null;
  error: string | null;
  width: number;
  height: number;
  maxZoom: number;
  previewScale: number;
  dpi: number | null;
  gcps: GeorefGcp[];
  settings: GeorefSettings | null;
  outputs: { layerId: string; name: string; createdAt: string; rmse: number | null; transform: string }[];
}

export interface GeorefPreview {
  /** WGS84 [minLon, minLat, maxLon, maxLat] */
  bounds: [number, number, number, number];
  /** data URL (WEBP / PNG) */
  image: string;
  rmse: number;
  pixelSize: number;
}

/** Georeferencer API (backend: GeoreferenceController). The final warp is
 *  the background raster job "georeference" (RasterService.startJob). */
@Injectable({ providedIn: 'root' })
export class GeoreferenceService {
  private readonly http = inject(HttpClient);
  readonly baseUrl = `${environment.apiUrl}/gis/raster/georef`;

  upload(file: File, dpi: number): Observable<HttpEvent<GeorefSession>> {
    const form = new FormData();
    form.append('file', file);
    form.append('dpi', String(dpi));
    return this.http.post<GeorefSession>(this.baseUrl, form, { reportProgress: true, observe: 'events' });
  }

  list(): Observable<GeorefSession[]> {
    return this.http.get<GeorefSession[]>(this.baseUrl);
  }

  get(id: string): Observable<GeorefSession> {
    return this.http.get<GeorefSession>(`${this.baseUrl}/${id}`);
  }

  save(id: string, gcps: GeorefGcp[], settings: GeorefSettings): Observable<GeorefSession> {
    return this.http.put<GeorefSession>(`${this.baseUrl}/${id}`, { gcps, settings });
  }

  remove(id: string): Observable<{ success: true }> {
    return this.http.delete<{ success: true }>(`${this.baseUrl}/${id}`);
  }

  preview(id: string, gcps: GeorefGcp[], settings: GeorefSettings): Observable<GeorefPreview> {
    return this.http.post<GeorefPreview>(`${this.baseUrl}/${id}/preview`, { gcps, settings });
  }

  tileUrl(id: string): string {
    return `${this.baseUrl}/${id}/tiles/{z}/{x}/{y}`;
  }
}

/** QGIS ".points" GCP file. Map coordinates are written as WGS84
 *  longitude / latitude; source Y is negative (QGIS convention). */
export function toPointsFile(gcps: GeorefGcp[], residualsPx: (number | null)[]): string {
  const wkt =
    'GEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]]],' +
    'PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],CS[ellipsoidal,2],' +
    'AXIS["geodetic latitude (Lat)",north,ORDER[1],ANGLEUNIT["degree",0.0174532925199433]],' +
    'AXIS["geodetic longitude (Lon)",east,ORDER[2],ANGLEUNIT["degree",0.0174532925199433]],ID["EPSG",4326]]';
  const lines = gcps.map((g, i) => {
    const r = residualsPx[i] ?? 0;
    return [g.lon, g.lat, g.px, -g.py, g.enabled ? 1 : 0, 0, 0, r].join(',');
  });
  return [`#CRS: ${wkt}`, 'mapX,mapY,sourceX,sourceY,enable,dX,dY,residual', ...lines].join('\n') + '\n';
}

/** Parses a QGIS ".points" file. Returns the points with map coordinates
 *  as given, and whether the file declares a geographic (lon/lat) CRS. */
export function parsePointsFile(text: string): { points: { mapX: number; mapY: number; px: number; py: number; enabled: boolean }[]; crsWkt: string | null } {
  const crsLine = text.split(/\r?\n/).find((l) => l.startsWith('#CRS:'));
  const points = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !/^mapX/i.test(l))
    .map((l) => l.split(/[,;\t]/).map(Number))
    .filter((c) => c.length >= 4 && c.slice(0, 4).every(Number.isFinite))
    .map((c) => ({ mapX: c[0], mapY: c[1], px: c[2], py: Math.abs(c[3]), enabled: c.length < 5 || c[4] !== 0 }));
  return { points, crsWkt: crsLine ? crsLine.slice(5).trim() : null };
}
