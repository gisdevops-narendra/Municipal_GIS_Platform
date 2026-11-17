import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

/** GET /gis/network/places — a named place and a point on it. */
export interface PlaceHit {
  label: string;
  layerName: string;
  point: LonLat;
}

/** `[longitude, latitude]` in EPSG:4326. */
export type LonLat = [number, number];

export interface MultiLineGeometry {
  type: 'MultiLineString';
  coordinates: LonLat[][];
}

export interface RouteStep {
  text: string;
  distanceM: number;
  at: LonLat;
  kind: 'depart' | 'turn' | 'waypoint' | 'arrive';
}

/** One way through all the stops. */
export interface RouteOption {
  lengthM: number;
  path: MultiLineGeometry;
  /** Consecutive stop pairs; `from` / `to` index the request's stops. */
  legs: { from: number; to: number; lengthM: number; path: MultiLineGeometry }[];
  directions: RouteStep[];
}

export interface RouteResult extends RouteOption {
  /** Stop indexes in visiting order (a round trip ends with the first). */
  order: number[];
  /** Each stop moved onto the road it snapped to. */
  snapped: LonLat[];
  blockedRoads: number;
  /** Shortest first; alternatives only for a plain two-stop route. */
  routes: RouteOption[];
}

export interface RouteRequest {
  stops: LonLat[];
  optimize?: boolean;
  roundTrip?: boolean;
  avoidAreas?: LonLat[][];
  avoidPoints?: LonLat[];
}

export interface FacilityResult {
  label: string;
  /** Road distance + the off-road bits at both ends. */
  lengthM: number;
  roadM: number;
  accessM: number;
  /** Estimated travel time, when a speed was given. */
  minutes: number | null;
  location: LonLat;
  properties: Record<string, unknown>;
  path: MultiLineGeometry;
  /** Off-road connectors: start → road, road → facility. */
  access: MultiLineGeometry;
}

export interface NearestResult {
  /** Facilities looked at (the nearest by straight line, after the filter). */
  considered: number;
  reachable: number;
  /** Left out: further than 500 m from any road. */
  offNetwork: number;
  blockedRoads: number;
  start: LonLat;
  facilities: FacilityResult[];
}

export interface NearestRequest {
  from: LonLat;
  count: number;
  maxDistanceM?: number;
  speedKmh?: number;
  filterField?: string;
  filterValues?: string[];
  labelField?: string;
  avoidAreas?: LonLat[][];
  avoidPoints?: LonLat[];
}

export interface TraceResult {
  segmentCount: number;
  lengthM: number;
  path: MultiLineGeometry;
  endPoints: { type: 'MultiPoint'; coordinates: LonLat[] };
}

export interface ServiceAreaResult {
  unit: 'm' | 'min';
  areas: {
    break: number;
    distanceM: number;
    lengthM: number;
    roads: MultiLineGeometry;
    area: Record<string, unknown> | null;
  }[];
}

// ----- Network Planning -----

export interface PlannedSite {
  label: string;
  point: LonLat;
}

export interface OdMatrixRequest {
  originLayerId?: string;
  origins?: LonLat[];
  originLabelField?: string;
  destinationLayerId?: string;
  destinations?: LonLat[];
  destinationLabelField?: string;
  speedKmh?: number;
  maxDistanceM?: number;
}

export interface OdMatrixResult {
  origins: PlannedSite[];
  destinations: PlannedSite[];
  /** [origin][destination] metres; null = not reachable / over the limit. */
  distancesM: (number | null)[][];
  minutes: (number | null)[][] | null;
  nearest: { origin: number; destination: number | null; distanceM: number | null; minutes: number | null; path: MultiLineGeometry | null }[];
  offNetwork: { origins: number; destinations: number };
  truncated: boolean;
}

export interface FleetRoutesRequest {
  depot: LonLat;
  stopLayerId?: string;
  stops?: LonLat[];
  stopLabelField?: string;
  demandField?: string;
  vehicles: number;
  capacity?: number;
  returnToDepot?: boolean;
  speedKmh?: number;
  serviceMinutes?: number;
}

export interface FleetTrip {
  vehicle: number;
  stops: PlannedSite[];
  load: number;
  lengthM: number;
  minutes: number | null;
  path: MultiLineGeometry;
}

export interface FleetRoutesResult {
  depot: LonLat;
  capacity: number;
  vehiclesUsed: number;
  /** Set when the load limit needs more vehicles than were given. */
  vehiclesNeeded: number | null;
  totalLengthM: number;
  trips: FleetTrip[];
  unassigned: string[];
  truncated: boolean;
}

export interface SiteSelectionRequest {
  demandLayerId: string;
  weightField?: string;
  candidateLayerId: string;
  candidateLabelField?: string;
  existingLayerId?: string;
  count: number;
  objective: 'MIN_DISTANCE' | 'MAX_COVERAGE';
  cutoffM?: number;
  speedKmh?: number;
}

export interface SiteSelectionResult {
  objective: 'MIN_DISTANCE' | 'MAX_COVERAGE';
  cutoffM: number | null;
  facilities: {
    kind: 'new' | 'existing';
    label: string;
    point: LonLat;
    properties: Record<string, unknown>;
    demandCount: number;
    weight: number;
    avgDistanceM: number | null;
    avgMinutes: number | null;
    allocation: MultiLineGeometry;
  }[];
  stats: {
    demandFeatures: number;
    offNetwork: number;
    totalWeight: number;
    reachedWeight: number;
    coveredWeight: number | null;
    avgDistanceM: number | null;
    avgDistanceBeforeM: number | null;
  };
  truncated: boolean;
}

/** GIS Advanced Tools — network analysis on the backend (`/gis/network`). */
@Injectable({ providedIn: 'root' })
export class NetworkService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/gis/network`;

  /** Places by name (fast, for routing stops). */
  places(q: string): Observable<PlaceHit[]> {
    return this.http.get<PlaceHit[]>(`${this.baseUrl}/places`, { params: new HttpParams().set('q', q) });
  }

  route(layerId: string, request: RouteRequest): Observable<RouteResult> {
    return this.http.post<RouteResult>(`${this.baseUrl}/route`, { layerId, ...request });
  }

  nearest(layerId: string, facilityLayerId: string, request: NearestRequest): Observable<NearestResult> {
    return this.http.post<NearestResult>(`${this.baseUrl}/nearest`, { layerId, facilityLayerId, ...request });
  }

  /** `breaks` are metres, or minutes when `speedKmh` is given. */
  serviceArea(layerId: string, at: LonLat, breaks: number[], speedKmh?: number): Observable<ServiceAreaResult> {
    return this.http.post<ServiceAreaResult>(`${this.baseUrl}/service-area`, { layerId, at, breaks, speedKmh });
  }

  odMatrix(layerId: string, request: OdMatrixRequest): Observable<OdMatrixResult> {
    return this.http.post<OdMatrixResult>(`${this.baseUrl}/od-matrix`, { layerId, ...request });
  }

  fleetRoutes(layerId: string, request: FleetRoutesRequest): Observable<FleetRoutesResult> {
    return this.http.post<FleetRoutesResult>(`${this.baseUrl}/fleet-routes`, { layerId, ...request });
  }

  siteSelection(layerId: string, request: SiteSelectionRequest): Observable<SiteSelectionResult> {
    return this.http.post<SiteSelectionResult>(`${this.baseUrl}/site-selection`, { layerId, ...request });
  }

  trace(layerId: string, at: LonLat, maxDistanceM?: number): Observable<TraceResult> {
    return this.http.post<TraceResult>(`${this.baseUrl}/trace`, { layerId, at, maxDistanceM });
  }
}
