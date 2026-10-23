import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map, of, shareReplay, tap } from 'rxjs';
import proj4 from 'proj4';
import { register } from 'ol/proj/proj4';
import { get as getProjection } from 'ol/proj';
import { environment } from '../../../../environments/environment';

/** A supported coordinate reference system (any EPSG 2D CRS). */
export interface CrsInfo {
  /** "EPSG:32643" */
  code: string;
  srid: number;
  name: string;
  kind: 'projected' | 'geographic';
  unit: string;
  proj4: string;
}

/** A layer's CRS, extent (lon/lat) and the systems that suit it. */
export interface LayerCrs {
  srid: number;
  crs: CrsInfo | null;
  workspaceCrs: string | null;
  extent: [number, number, number, number] | null;
  suggestions: CrsInfo[];
  /** Uploaded layers can be reprojected in place / have their CRS defined. */
  editable: boolean;
}

export const PROJECTION_MODULE_ID = 1028;

/**
 * The platform's CRS catalogue (backend: PostGIS spatial_ref_sys) — search
 * and look-up for the CRS pickers, and on-demand proj4 registration so
 * OpenLayers can transform coordinates in any of them.
 */
@Injectable({ providedIn: 'root' })
export class CrsService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/gis`;
  private readonly byCode = new Map<string, Observable<CrsInfo | null>>();
  private recommendedCache?: Observable<CrsInfo[]>;

  /** Empty query → the recommended systems. */
  search(query: string): Observable<CrsInfo[]> {
    const q = query.trim();
    if (!q) {
      this.recommendedCache ??= this.http.get<CrsInfo[]>(`${this.baseUrl}/crs`).pipe(shareReplay(1));
      return this.recommendedCache.pipe(tap((list) => list.forEach((c) => this.remember(c))));
    }
    return this.http
      .get<CrsInfo[]>(`${this.baseUrl}/crs`, { params: { q } })
      .pipe(tap((list) => list.forEach((c) => this.remember(c))));
  }

  get(code: string): Observable<CrsInfo | null> {
    const key = code.trim().toUpperCase();
    if (!/^EPSG:\d{4,6}$/.test(key)) return of(null);
    if (!this.byCode.has(key)) {
      this.byCode.set(
        key,
        this.http.get<CrsInfo>(`${this.baseUrl}/crs/${encodeURIComponent(key)}`).pipe(
          map((c) => c ?? null),
          shareReplay(1)
        )
      );
    }
    return this.byCode.get(key)!;
  }

  layerCrs(layerId: string): Observable<LayerCrs> {
    return this.http.get<LayerCrs>(`${this.baseUrl}/layers/${layerId}/crs`);
  }

  /** Makes `code` usable by OpenLayers (proj4 definition fetched once);
   *  emits false when the CRS is unknown. */
  ensureRegistered(code: string): Observable<boolean> {
    if (getProjection(code)) return of(true);
    return this.get(code).pipe(
      map((crs) => {
        if (!crs?.proj4) return false;
        if (!getProjection(crs.code)) {
          proj4.defs(crs.code, crs.proj4);
          register(proj4);
        }
        return true;
      })
    );
  }

  private remember(crs: CrsInfo): void {
    if (!this.byCode.has(crs.code)) this.byCode.set(crs.code, of(crs));
  }
}

/** "EPSG:32643 · WGS 84 / UTM zone 43N" */
export function crsLabel(crs: Pick<CrsInfo, 'code' | 'name'>): string {
  return crs.name && crs.name !== crs.code ? `${crs.code} · ${crs.name}` : crs.code;
}
