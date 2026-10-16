import { HttpClient, HttpEvent, HttpResponse } from '@angular/common/http';
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
  /** e.g. "Red (B4)" for downloaded Sentinel-2 bands. */
  description?: string | null;
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
  stretch?: 'normalize' | 'histogram';
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

export interface RasterStatistics {
  band: number;
  validCells: number;
  nodataCells: number;
  min: number;
  max: number;
  mean: number;
  std: number;
  p1: number;
  p25: number;
  median: number;
  p75: number;
  p99: number;
  areaM2: number;
  histogram: { counts: number[]; edges: number[] };
}

export interface ZoneRow {
  zone: string;
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  sum: number | null;
  std: number | null;
  areaM2: number;
}

export interface ZonalResult {
  zones: number;
  zonesWithData: number;
  rows: ZoneRow[];
  truncated: boolean;
}

export interface SentinelScene {
  id: string;
  datetime: string | null;
  cloud: number | null;
  coverage: number;
  platform: string | null;
  thumbnail: string | null;
  footprint: GeoJsonGeometry;
}

export interface VectorField {
  name: string;
  type: string;
  numeric: boolean;
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

  /** Emits HttpEvents so the panel can show upload progress. */
  upload(file: File, name: string, departmentId: string | null, description?: string): Observable<HttpEvent<GisLayer>> {
    const form = new FormData();
    form.append('file', file);
    form.append('name', name);
    if (departmentId) form.append('departmentId', departmentId);
    if (description) form.append('description', description);
    return this.http.post<GisLayer>(`${this.baseUrl}/upload`, form, { reportProgress: true, observe: 'events' });
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

  sentinelSearch(body: { bbox: number[]; from: string; to: string; maxCloud: number }): Observable<{ scenes: SentinelScene[] }> {
    return this.http.post<{ scenes: SentinelScene[] }>(`${this.baseUrl}/online/sentinel2/search`, body);
  }

  /** True-colour PNG of a scene over the area (EPSG:4326 bbox). */
  sentinelPreview(sceneId: string, bbox: number[]): Observable<Blob> {
    return this.http.post(`${this.baseUrl}/online/sentinel2/preview`, { sceneId, bbox }, { responseType: 'blob' });
  }

  vectorFields(layerId: string): Observable<VectorField[]> {
    return this.http.get<VectorField[]>(`${this.baseUrl}/vector/${layerId}/fields`);
  }

  statistics(body: { layerId: string; band: number; bins?: number }): Observable<RasterStatistics> {
    return this.http.post<RasterStatistics>(`${this.baseUrl}/statistics`, body);
  }

  /** Without `outputName` only the table comes back; with it the zones are
   *  also published as a layer. */
  zonalStatistics(body: Record<string, unknown>): Observable<{ layer?: GisLayer; result: ZonalResult }> {
    return this.http.post<{ layer?: GisLayer; result: ZonalResult }>(`${this.baseUrl}/zonal-statistics`, body);
  }

  /** GeoTIFF download; `bbox` (EPSG:4326) cuts it to the map view. */
  download(layerId: string, bbox?: [number, number, number, number]): Observable<HttpResponse<Blob>> {
    const params: Record<string, string> = bbox ? { bbox: bbox.join(',') } : {};
    return this.http.get(`${this.baseUrl}/${layerId}/download`, { params, responseType: 'blob', observe: 'response' });
  }

  /** Every tool that creates a layer: terrain, contour, watershed, flood,
   *  viewshed, calculator, reclassify, clip, polygonize, ndvi, change-detection. */
  run(tool: string, body: Record<string, unknown>): Observable<LayerResult> {
    return this.http.post<LayerResult>(`${this.baseUrl}/${tool}`, body);
  }
}
