import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { GisLayer } from '../../../core/models/gis-layer.model';

/** `[longitude, latitude]` in EPSG:4326. */
export type LonLat = [number, number];
export type GeoJsonGeometry = Record<string, unknown>;

export interface RasterBandInfo {
  band: number;
  type: string;
  nodata: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  color: string;
}

export interface RasterInfo {
  width: number;
  height: number;
  bandCount: number;
  crs: string;
  geographic: boolean;
  pixelSize: [number, number];
  pixelSizeM: number;
  bands: RasterBandInfo[];
}

export interface RasterStyleSpec {
  mode: 'ramp' | 'values' | 'rgb';
  band?: number;
  ramp?: string;
  min?: number;
  max?: number;
  invert?: boolean;
  bands?: [number, number, number];
  opacity?: number;
}

export interface ProfilePoint {
  d: number;
  z: number | null;
  lon: number;
  lat: number;
  visible?: boolean;
}

export interface ProfileResult {
  lengthM: number;
  points: ProfilePoint[];
  min: number | null;
  max: number | null;
  gain: number;
  loss: number;
}

export interface LineOfSightResult {
  lengthM: number;
  targetVisible: boolean;
  points: ProfilePoint[];
  visible: GeoJsonGeometry;
  hidden: GeoJsonGeometry;
}

export interface CutFillResult {
  baseLevel: number;
  areaM2: number;
  cutM3: number;
  fillM3: number;
  netM3: number;
  minZ: number;
  maxZ: number;
  meanZ: number;
}

/** A tool that published its output as a new layer. */
export interface LayerResult {
  layer: GisLayer;
  result: Record<string, unknown>;
}

export const RASTER_RAMP_NAMES = ['terrain', 'grayscale', 'ndvi', 'diverging', 'water', 'heat', 'aspect', 'spectral'];

/** Raster Analysis API (`/gis/raster`). */
@Injectable({ providedIn: 'root' })
export class RasterService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/gis/raster`;

  upload(file: File, name: string, departmentId: string | null, description?: string): Observable<GisLayer> {
    const form = new FormData();
    form.append('file', file);
    form.append('name', name);
    if (departmentId) form.append('departmentId', departmentId);
    if (description) form.append('description', description);
    return this.http.post<GisLayer>(`${this.baseUrl}/upload`, form);
  }

  info(layerId: string): Observable<RasterInfo> {
    return this.http.get<RasterInfo>(`${this.baseUrl}/${layerId}/info`);
  }

  identify(layerId: string, point: LonLat): Observable<{ inside: boolean; values: { band: number; value: number | null }[] }> {
    return this.http.post<{ inside: boolean; values: { band: number; value: number | null }[] }>(
      `${this.baseUrl}/${layerId}/identify`,
      { point }
    );
  }

  style(layerId: string, spec: RasterStyleSpec): Observable<unknown> {
    return this.http.put(`${this.baseUrl}/${layerId}/style`, spec);
  }

  profile(body: { layerId: string; band: number; line: LonLat[] }): Observable<ProfileResult> {
    return this.http.post<ProfileResult>(`${this.baseUrl}/profile`, body);
  }

  lineOfSight(body: Record<string, unknown>): Observable<LineOfSightResult> {
    return this.http.post<LineOfSightResult>(`${this.baseUrl}/line-of-sight`, body);
  }

  cutFill(body: Record<string, unknown>): Observable<CutFillResult> {
    return this.http.post<CutFillResult>(`${this.baseUrl}/cut-fill`, body);
  }

  /** Every tool that creates a layer: terrain, contour, watershed, flood,
   *  viewshed, calculator, reclassify, clip, polygonize, ndvi, change-detection. */
  run(tool: string, body: Record<string, unknown>): Observable<LayerResult> {
    return this.http.post<LayerResult>(`${this.baseUrl}/${tool}`, body);
  }
}
