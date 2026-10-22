import { Component, Input, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { MapService, RING_COLORS } from '../../services/map.service';
import { FacilityResult, LonLat, NearestResult, NetworkService, RouteOption, RouteResult } from '../../services/network.service';
import { GisLayersService } from '../../../../core/services/gis-layers.service';
import { AnalyticsField } from '../../../../core/models/layer-analytics.model';

type Mode = 'route' | 'nearest' | 'trace' | 'service';
/** What the next map click sets: a point, a routing stop (by index), or
 *  something to avoid. */
type Slot = 'from' | 'to' | number | 'avoidArea' | 'avoidRoad';

/** Module Access catalog ids (seed-modules.ts), children of Advanced Tools (5). */
export const NETWORK_TRACING_MODULE_ID = 13;
export const BASIC_ROUTING_MODULE_ID = 8;
export const NEAREST_FACILITY_MODULE_ID = 10;
export const SERVICE_AREA_MODULE_ID = 1004;

/**
 * GIS Advanced Tools — Basic Routing, Nearest Facility and Network Tracing
 * on an uploaded LINE layer (roads / pipelines), computed by the backend
 * (`NetworkService`). Points are clicked on the map; results draw on the
 * map's analysis overlay.
 */

/** Shortest route first, then the alternatives. */
const ROUTE_COLORS = ['#1d4ed8', '#ea580c', '#7c3aed'];
const MAX_STOPS = 25;
/** Nearest-facility results, nearest first (cycled past ten). */
const FACILITY_COLORS = ['#1d4ed8', '#ea580c', '#7c3aed', '#0891b2', '#be185d', '#4d7c0f', '#b45309', '#4338ca', '#0f766e', '#9f1239'];

/** "A", "B", … "Z", then "27" … — same labels as the backend's directions. */
export function stopLabel(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}
@Component({
  selector: 'app-advanced-tools',
  standalone: true,
  imports: [FormsModule, ButtonModule, SelectModule, MultiSelectModule],
  templateUrl: './advanced-tools.component.html',
  styleUrl: '../buffer-overlay/buffer-overlay.component.scss'
})
export class AdvancedToolsComponent implements OnDestroy {
  private readonly mapService = inject(MapService);
  private readonly network = inject(NetworkService);
  private readonly gisLayers = inject(GisLayersService);

  @Input() set layers(value: GisLayer[]) {
    this.layersSignal.set(value ?? []);
  }
  private readonly layersSignal = signal<GisLayer[]>([]);

  @Input() set allowedModuleIds(value: ReadonlySet<number>) {
    this.allowedSignal.set(value ?? new Set());
    if (!this.modes().some((m) => m.value === this.mode())) {
      this.mode.set(this.modes()[0]?.value ?? 'route');
    }
  }
  private readonly allowedSignal = signal<ReadonlySet<number>>(new Set());

  /** False while the panel is kept mounted but hidden — cancels a pending pick. */
  @Input() set active(value: boolean) {
    if (!value && this.picking()) this.cancelPick();
  }

  readonly modes = computed(() =>
    [
      { value: 'route' as Mode, label: 'Routing', moduleId: BASIC_ROUTING_MODULE_ID },
      { value: 'nearest' as Mode, label: 'Nearest Facility', moduleId: NEAREST_FACILITY_MODULE_ID },
      { value: 'trace' as Mode, label: 'Tracing', moduleId: NETWORK_TRACING_MODULE_ID },
      { value: 'service' as Mode, label: 'Service Area', moduleId: SERVICE_AREA_MODULE_ID }
    ].filter((m) => this.allowedSignal().has(m.moduleId))
  );
  readonly mode = signal<Mode>('route');

  /** Tracing works on any line layer; Routing / Nearest Facility /
   *  Service Area only on layers marked as routing layers at upload. */
  readonly lineLayers = computed(() =>
    this.layersSignal()
      .filter(
        (l) =>
          l.layerType === 'VECTOR' &&
          l.geometryType === 'LINE' &&
          (this.mode() === 'trace' || l.routingEnabled === true)
      )
      .map((l) => ({ label: l.name, value: l.id }))
  );
  readonly pointLayers = computed(() =>
    this.layersSignal()
      .filter((l) => l.layerType === 'VECTOR' && l.geometryType === 'POINT')
      .map((l) => ({ label: l.name, value: l.id }))
  );

  readonly networkLayerId = signal<string | null>(null);
  readonly facilityLayerId = signal<string | null>(null);
  facilityCount = 3;
  /** Nearest Facility options. */
  readonly facilityFields = signal<AnalyticsField[]>([]);
  readonly labelField = signal<string | null>(null);
  readonly filterField = signal<string | null>(null);
  readonly filterOptions = signal<{ label: string; value: string }[]>([]);
  readonly filterValues = signal<string[]>([]);
  nearestMaxM: number | null = null;
  readonly nearestByTime = signal(false);
  readonly activeFacility = signal(0);
  readonly fieldOptions = computed(() => this.facilityFields().map((f) => ({ label: f.name, value: f.name })));
  maxDistanceM: number | null = null;
  /** Service Area: comma-separated breaks, in metres or minutes. */
  serviceBreaksText = '500, 1000, 2000';
  readonly serviceByTime = signal(false);
  speedKmh = 30;
  readonly bands = signal<{ label: string; color: string; length: string }[]>([]);

  readonly from = signal<LonLat | null>(null);
  readonly to = signal<LonLat | null>(null);
  readonly picking = signal<Slot | null>(null);
  readonly running = signal(false);
  readonly error = signal<string | null>(null);
  readonly summary = signal<string | null>(null);
  readonly facilities = signal<{ label: string; length: string; time: string | null; color: string; result: FacilityResult }[]>([]);
  /** Routing: shortest route + alternatives; `activeRoute` is drawn bold. */
  readonly routes = signal<(RouteOption & { color: string; length: string })[]>([]);
  readonly activeRoute = signal(0);
  /** Routing stops in the user's order (null = not picked yet). */
  readonly stops = signal<(LonLat | null)[]>([null, null]);
  readonly optimize = signal(false);
  readonly roundTrip = signal(false);
  readonly avoidAreas = signal<LonLat[][]>([]);
  readonly avoidPoints = signal<LonLat[]>([]);
  /** The last result's visiting order (stop indexes). */
  private routeOrder: number[] = [];
  private stopDragOff?: () => void;
  readonly stopLabel = stopLabel;
  readonly maxStops = MAX_STOPS;
  readonly activeDirections = computed(() => this.routes()[this.activeRoute()]?.directions ?? []);
  /** Optimising needs something to reorder: 2+ stops between the fixed ends. */
  readonly canOptimize = computed(() => this.stops().length - (this.roundTrip() ? 1 : 2) >= 2);

  private pickSub?: Subscription;

  ngOnDestroy(): void {
    this.pickSub?.unsubscribe();
    this.mapService.cancelDraw();
    this.stopDragOff?.();
  }

  setMode(mode: Mode): void {
    this.mode.set(mode);
    // A pipeline picked for Tracing is not a road network for Routing.
    if (!this.lineLayers().some((l) => l.value === this.networkLayerId())) {
      this.networkLayerId.set(null);
    }
    this.clear();
  }

  pick(slot: Slot): void {
    this.picking.set(slot);
    this.error.set(null);
    this.pickSub?.unsubscribe();
    this.pickSub = this.mapService.beginDraw(slot === 'avoidArea' ? 'Polygon' : 'Point').subscribe({
      next: (geometry) => {
        const coordinates = geometry['coordinates'] as number[][][] | number[];
        if (slot === 'avoidArea') {
          const ring = (coordinates as number[][][])[0].map((p) => [p[0], p[1]] as LonLat);
          this.avoidAreas.update((areas) => [...areas, ring]);
        } else {
          const point = (coordinates as number[]).slice(0, 2) as LonLat;
          if (slot === 'avoidRoad') this.avoidPoints.update((points) => [...points, point]);
          else if (typeof slot === 'number') this.stops.update((stops) => stops.map((s, i) => (i === slot ? point : s)));
          else (slot === 'from' ? this.from : this.to).set(point);
        }
        this.picking.set(null);
        // OpenLayers adds the drawn feature after this callback — clear next tick.
        setTimeout(() => this.mapService.clearDraw());
        this.afterRoutingInputChange(typeof slot === 'number' || slot === 'avoidArea' || slot === 'avoidRoad' || slot === 'from');
      },
      complete: () => this.picking.set(null)
    });
  }

  // ----- routing stops -----

  isPickingStop(index: number): boolean {
    return this.picking() === index;
  }

  /** Adds an empty stop before the destination and picks it on the map. */
  addStop(): void {
    if (this.stops().length >= MAX_STOPS) return;
    const at = this.stops().length - 1;
    this.stops.update((stops) => [...stops.slice(0, at), null, ...stops.slice(at)]);
    this.pick(at);
  }

  removeStop(index: number): void {
    this.cancelPick();
    this.stops.update((stops) => (stops.length <= 2 ? stops.map((s, i) => (i === index ? null : s)) : stops.filter((_, i) => i !== index)));
    this.afterRoutingInputChange(true);
  }

  moveStop(index: number, by: -1 | 1): void {
    const target = index + by;
    const stops = [...this.stops()];
    if (target < 0 || target >= stops.length) return;
    [stops[index], stops[target]] = [stops[target], stops[index]];
    this.stops.set(stops);
    this.afterRoutingInputChange(true);
  }

  reverseStops(): void {
    this.stops.update((stops) => [...stops].reverse());
    this.afterRoutingInputChange(true);
  }

  setOptimize(on: boolean): void {
    this.optimize.set(on);
    this.afterRoutingInputChange(true);
  }

  setRoundTrip(on: boolean): void {
    this.roundTrip.set(on);
    this.afterRoutingInputChange(true);
  }

  clearAvoid(): void {
    this.avoidAreas.set([]);
    this.avoidPoints.set([]);
    this.afterRoutingInputChange(true);
  }

  /** Routing inputs changed: re-route if a route is showing (so edits apply
   *  at once), else just redraw the picks. */
  private afterRoutingInputChange(reroute: boolean): void {
    const mode = this.mode();
    if (mode !== 'route' && mode !== 'nearest') {
      this.showPicks();
      return;
    }
    const ready =
      mode === 'route' ? this.routes().length > 0 && this.stops().filter(Boolean).length >= 2 : this.facilities().length > 0 && !!this.from();
    if (reroute && ready) this.run();
    else this.renderRouting();
  }

  cancelPick(): void {
    this.mapService.cancelDraw();
    this.picking.set(null);
  }

  pointLabel(point: LonLat | null): string {
    return point ? `${point[1].toFixed(5)}, ${point[0].toFixed(5)}` : 'not set';
  }

  run(): void {
    const layerId = this.networkLayerId();
    const from = this.from();
    if (!layerId) return this.error.set('Choose the network (line) layer first.');

    if (this.mode() === 'route') {
      const stops = this.stops();
      const missing = stops.findIndex((s) => !s);
      if (missing >= 0) return this.error.set(`Pick stop ${stopLabel(missing)} on the map (or remove it).`);
      const picked = stops as LonLat[];
      const request = {
        stops: picked,
        optimize: this.optimize() && this.canOptimize(),
        roundTrip: this.roundTrip(),
        avoidAreas: this.avoidAreas(),
        avoidPoints: this.avoidPoints()
      };
      const firstRun = !this.routes().length;
      this.execute(this.network.route(layerId, request), (r) => this.showRouteResult(r, picked, firstRun));
      return;
    }
    if (!from) return this.error.set(this.mode() === 'trace' ? 'Click a start point on the network.' : 'Pick the start point on the map.');

    if (this.mode() === 'nearest') {
      const facilityLayerId = this.facilityLayerId();
      if (!facilityLayerId) return this.error.set('Choose the facility (point) layer.');
      const count = Math.min(Math.max(Math.round(this.facilityCount || 1), 1), 20);
      if (this.filterField() && !this.filterValues().length) return this.error.set('Pick at least one value to filter by, or clear the filter.');
      const firstRun = !this.facilities().length;
      this.execute(
        this.network.nearest(layerId, facilityLayerId, {
          from,
          count,
          maxDistanceM: this.nearestMaxM && this.nearestMaxM > 0 ? this.nearestMaxM : undefined,
          speedKmh: this.nearestByTime() ? this.speedKmh : undefined,
          filterField: this.filterField() ?? undefined,
          filterValues: this.filterField() ? this.filterValues() : undefined,
          labelField: this.labelField() ?? undefined,
          avoidAreas: this.avoidAreas(),
          avoidPoints: this.avoidPoints()
        }),
        (r) => this.showNearestResult(r, firstRun)
      );
    } else if (this.mode() === 'service') {
      const breaks = this.serviceBreaksText
        .split(/[,\s]+/)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
      if (!breaks.length || breaks.length > 5) return this.error.set('Enter 1–5 positive breaks, e.g. 500, 1000, 2000.');
      const speed = this.serviceByTime() ? this.speedKmh : undefined;
      this.execute(this.network.serviceArea(layerId, from, breaks, speed), (r) => {
        const areas = [...r.areas].reverse();
        this.mapService.setAnalysisColoredGeometries(
          areas
            .map((a, i) => ({ geometry: a.area, color: RING_COLORS[Math.min(areas.length - 1 - i, RING_COLORS.length - 1)] }))
            .filter((a): a is { geometry: Record<string, unknown>; color: string } => !!a.geometry)
        );
        const outer = areas[0]?.area;
        if (outer) this.mapService.zoomToGeometries([outer]);
        this.bands.set(
          r.areas.map((a, i) => ({
            label: `≤ ${a.break} ${r.unit}`,
            color: RING_COLORS[Math.min(i, RING_COLORS.length - 1)],
            length: `${this.formatLength(a.lengthM)} of road`
          }))
        );
        this.summary.set(`Reachable area from the start point${speed ? ` at ${speed} km/h` : ''}:`);
      });
    } else {
      const max = this.maxDistanceM && this.maxDistanceM > 0 ? this.maxDistanceM : undefined;
      this.execute(this.network.trace(layerId, from, max), (r) => {
        this.draw([r.path], [from, ...r.endPoints.coordinates]);
        this.summary.set(
          `${r.segmentCount} connected segment${r.segmentCount === 1 ? '' : 's'}, ` +
            `${this.formatLength(r.lengthM)} in total, ${r.endPoints.coordinates.length} end point(s).`
        );
      });
    }
  }

  clear(): void {
    this.cancelPick();
    this.mapService.clearAnalysisGeometry();
    this.from.set(null);
    this.to.set(null);
    this.error.set(null);
    this.summary.set(null);
    this.facilities.set([]);
    this.bands.set([]);
    this.routes.set([]);
    this.routeOrder = [];
    this.activeFacility.set(0);
    this.stops.set([null, null]);
    this.avoidAreas.set([]);
    this.avoidPoints.set([]);
    this.stopDragOff?.();
    this.stopDragOff = undefined;
  }

  /** Highlights route `index` (bold, on top); the others stay as dashed
   *  alternatives. */
  selectRoute(index: number): void {
    this.activeRoute.set(index);
    this.renderRouting();
  }

  private showRouteResult(r: RouteResult, stops: LonLat[], zoom: boolean): void {
    const found = r.routes.length ? r.routes : [r];
    this.routeOrder = r.order;
    this.routes.set(
      found.map((route, i) => ({
        ...route,
        length: this.formatLength(route.lengthM),
        color: ROUTE_COLORS[i % ROUTE_COLORS.length]
      }))
    );
    this.activeRoute.set(0);
    this.renderRouting();
    if (zoom) {
      this.mapService.zoomToGeometries([
        { type: 'MultiLineString', coordinates: found.flatMap((route) => route.path.coordinates) },
        { type: 'MultiPoint', coordinates: stops }
      ]);
    }
    const reordered = r.order.some((stop, i) => stop !== i && !(this.roundTrip() && i === r.order.length - 1));
    const visits = r.order.map(stopLabel).join(' → ');
    const avoided = r.blockedRoads ? ` Avoiding ${r.blockedRoads} road segment${r.blockedRoads === 1 ? '' : 's'}.` : '';
    this.summary.set(
      found.length > 1
        ? `${found.length} routes found — click one to highlight it.${avoided}`
        : stops.length > 2 || this.roundTrip()
          ? `${this.formatLength(r.lengthM)} via ${visits}${reordered ? ' (order optimised)' : ''}.${avoided}`
          : `Shortest route: ${this.formatLength(r.lengthM)}.${avoided}`
    );
    this.stopDragOff ??= this.mapService.enableRouteDrag((target) => this.onRouteDrag(target));
  }

  /** Draws the routing state: routes, lettered stops, avoid areas / roads. */
  private renderRouting(): void {
    if (this.mode() === 'nearest') {
      const from = this.from();
      const active = this.activeFacility();
      const facilities = this.facilities();
      this.mapService.setRoutingView({
        routes: facilities.map((f, i) => ({ lines: f.result.path.coordinates, color: f.color, active: i === active, draggable: false })),
        stops: [
          ...facilities.map((f, i) => ({
            at: f.result.location,
            index: i + 1,
            label: String(i + 1),
            role: 'end' as const,
            color: f.color,
            fixed: true
          })),
          ...(from ? [{ at: from, index: 0, label: '●', role: 'start' as const }] : [])
        ],
        avoidAreas: this.avoidAreas(),
        avoidPoints: this.avoidPoints(),
        connectors: facilities[active]?.result.access.coordinates ?? []
      });
      return;
    }
    const stops = this.stops();
    const last = stops.length - 1;
    const active = this.activeRoute();
    this.mapService.setRoutingView({
      routes: this.routes().map((r, i) => ({ lines: r.path.coordinates, color: r.color, active: i === active })),
      stops: stops
        .map((at, index) => ({ at, index }))
        .filter((s): s is { at: LonLat; index: number } => !!s.at)
        .map(({ at, index }) => ({
          at,
          index,
          label: stopLabel(index),
          role: index === 0 ? ('start' as const) : index === last && !this.roundTrip() ? ('end' as const) : ('via' as const)
        })),
      avoidAreas: this.avoidAreas(),
      avoidPoints: this.avoidPoints()
    });
  }

  /** A stop dragged → it moves there. The route dragged → a via stop is
   *  added at the drop point, on the leg that was grabbed. */
  private onRouteDrag(target: { stopIndex: number | null; grab: LonLat; drop: LonLat }): void {
    if (this.running()) return;
    if (this.mode() === 'nearest') {
      if (target.stopIndex === 0) {
        this.from.set(target.drop);
        this.run();
      }
      return;
    }
    if (this.mode() !== 'route') return;
    if (target.stopIndex !== null) {
      this.stops.update((stops) => stops.map((s, i) => (i === target.stopIndex ? target.drop : s)));
      this.run();
      return;
    }
    if (this.stops().length >= MAX_STOPS) {
      this.error.set(`A route can have at most ${MAX_STOPS} stops.`);
      return;
    }
    const route = this.routes()[this.activeRoute()];
    if (!route) return;
    const leg = nearestLeg(route.legs.map((l) => l.path.coordinates), target.grab);
    // Rebuild the stops in visiting order, then insert after that leg's start.
    const current = this.stops() as LonLat[];
    const visit = this.roundTrip() ? this.routeOrder.slice(0, -1) : this.routeOrder;
    const ordered = visit.length === current.length ? visit.map((i) => current[i]) : [...current];
    ordered.splice(Math.min(leg + 1, ordered.length - (this.roundTrip() ? 0 : 1)), 0, target.drop);
    this.stops.set(ordered);
    // Keep the order the user just shaped.
    this.optimize.set(false);
    this.run();
  }

  // ----- nearest facility -----

  onFacilityLayerChange(id: string | null): void {
    this.facilityLayerId.set(id);
    this.facilityFields.set([]);
    this.labelField.set(null);
    this.clearFacilityFilter();
    if (!id) return;
    this.gisLayers.analyticsFields(id).subscribe({
      next: (fields) => this.facilityFields.set(fields.filter((f) => f.kind !== 'geometry')),
      error: () => this.facilityFields.set([])
    });
  }

  onFilterFieldChange(field: string | null): void {
    this.filterField.set(field);
    this.filterValues.set([]);
    this.filterOptions.set([]);
    const layerId = this.facilityLayerId();
    if (!field || !layerId) return;
    this.gisLayers.analyticsSummary(layerId, field).subscribe({
      next: (summary) =>
        this.filterOptions.set((summary.categories ?? []).map((c) => ({ label: `${c.value} (${c.count})`, value: c.value }))),
      error: () => this.filterOptions.set([])
    });
  }

  clearFacilityFilter(): void {
    this.filterField.set(null);
    this.filterValues.set([]);
    this.filterOptions.set([]);
  }

  selectFacility(index: number): void {
    this.activeFacility.set(index);
    this.renderRouting();
  }

  /** Opens Routing from the start to this facility (directions, export…). */
  routeToFacility(index: number): void {
    const from = this.from();
    const facility = this.facilities()[index];
    if (!from || !facility) return;
    const [areas, points] = [this.avoidAreas(), this.avoidPoints()];
    this.setMode('route');
    this.stops.set([from, facility.result.location]);
    this.avoidAreas.set(areas);
    this.avoidPoints.set(points);
    this.run();
  }

  exportFacilitiesCsv(): void {
    const rows = this.facilities();
    if (!rows.length) return;
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r.result.properties)))];
    const cell = (v: unknown) => {
      const text = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const header = ['rank', 'label', 'distance_m', 'road_m', 'off_road_m', 'minutes', 'lon', 'lat', ...keys];
    const lines = rows.map((r, i) =>
      [
        i + 1,
        r.label,
        Math.round(r.result.lengthM),
        Math.round(r.result.roadM),
        Math.round(r.result.accessM),
        r.result.minutes === null ? '' : r.result.minutes.toFixed(1),
        r.result.location[0],
        r.result.location[1],
        ...keys.map((k) => r.result.properties[k])
      ]
        .map(cell)
        .join(',')
    );
    this.download([header.join(','), ...lines].join('\n'), 'text/csv', 'nearest-facilities.csv');
  }

  private showNearestResult(r: NearestResult, zoom: boolean): void {
    this.facilities.set(
      r.facilities.map((f, i) => ({
        label: f.label,
        length: this.formatLength(f.lengthM),
        time: f.minutes === null ? null : this.formatMinutes(f.minutes),
        color: FACILITY_COLORS[i % FACILITY_COLORS.length],
        result: f
      }))
    );
    this.activeFacility.set(0);
    this.renderRouting();
    if (zoom) {
      this.mapService.zoomToGeometries([
        { type: 'MultiLineString', coordinates: r.facilities.flatMap((f) => [...f.path.coordinates, ...f.access.coordinates]) }
      ]);
    }
    const notes = [
      r.offNetwork ? `${r.offNetwork} facilit${r.offNetwork === 1 ? 'y is' : 'ies are'} over 500 m from any road and left out.` : '',
      r.blockedRoads ? `Avoiding ${r.blockedRoads} road segment${r.blockedRoads === 1 ? '' : 's'}.` : ''
    ].filter(Boolean);
    this.summary.set(
      `${r.facilities.length} nearest of ${r.reachable.toLocaleString()} reachable facilit${r.reachable === 1 ? 'y' : 'ies'} by road. ${notes.join(' ')}`.trim()
    );
    this.stopDragOff ??= this.mapService.enableRouteDrag((target) => this.onRouteDrag(target));
  }

  private formatMinutes(minutes: number): string {
    return minutes < 60 ? `${Math.max(1, Math.round(minutes))} min` : `${Math.floor(minutes / 60)} h ${Math.round(minutes % 60)} min`;
  }

  private download(body: string, type: string, filename: string): void {
    const url = URL.createObjectURL(new Blob([body], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ----- export -----

  exportRoute(format: 'gpx' | 'kml' | 'geojson'): void {
    const route = this.routes()[this.activeRoute()];
    if (!route) return;
    const stops = (this.stops().filter(Boolean) as LonLat[]).map((at, i) => ({ at, name: `Stop ${stopLabel(i)}` }));
    const lines = route.path.coordinates;
    const name = `Route ${route.length}`;
    let body: string;
    let type: string;
    if (format === 'geojson') {
      type = 'application/geo+json';
      body = JSON.stringify(
        {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: route.path,
              properties: { name, lengthM: Math.round(route.lengthM), directions: route.directions.map((d) => d.text) }
            },
            ...stops.map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: s.at }, properties: { name: s.name } }))
          ]
        },
        null,
        2
      );
    } else if (format === 'gpx') {
      type = 'application/gpx+xml';
      const pt = (p: LonLat, tag: string) => `<${tag} lat="${p[1]}" lon="${p[0]}">`;
      body =
        `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Municipal GIS Platform" xmlns="http://www.topografix.com/GPX/1/1">\n` +
        stops.map((s) => `  ${pt(s.at, 'wpt')}<name>${s.name}</name></wpt>`).join('\n') +
        `\n  <trk><name>${xml(name)}</name>\n` +
        lines.map((line) => `    <trkseg>${line.map((p) => `${pt(p, 'trkpt')}</trkpt>`).join('')}</trkseg>`).join('\n') +
        `\n  </trk>\n</gpx>\n`;
    } else {
      type = 'application/vnd.google-earth.kml+xml';
      const coords = (line: LonLat[]) => line.map((p) => `${p[0]},${p[1]}`).join(' ');
      body =
        `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xml(name)}</name>\n` +
        `<Placemark><name>${xml(name)}</name><description>${xml(route.directions.map((d) => d.text).join('\n'))}</description>` +
        `<MultiGeometry>${lines.map((line) => `<LineString><coordinates>${coords(line)}</coordinates></LineString>`).join('')}</MultiGeometry></Placemark>\n` +
        stops.map((s) => `<Placemark><name>${s.name}</name><Point><coordinates>${s.at[0]},${s.at[1]}</coordinates></Point></Placemark>`).join('\n') +
        `\n</Document></kml>\n`;
    }
    this.download(body, type, `route.${format}`);
  }

  formatDistance(metres: number): string {
    return metres > 0 ? this.formatLength(metres) : '';
  }

  private execute<T>(request: Observable<T>, onResult: (result: T) => void): void {
    const mode = this.mode();
    this.running.set(true);
    this.error.set(null);
    this.summary.set(null);
    this.facilities.set([]);
    this.routes.set([]);
    request.subscribe({
      next: (result) => {
        this.running.set(false);
        // Mode switched while waiting: don't draw e.g. a route in Service Area.
        if (this.mode() === mode) onResult(result);
      },
      error: (err: HttpErrorResponse) => {
        this.running.set(false);
        const message = err.error?.message;
        if (this.mode() !== mode) return;
        this.error.set(
          Array.isArray(message)
            ? message.join('. ')
            : typeof message === 'string'
            ? message
            : err.status === 0
              ? 'Could not reach the server.'
              : `Network analysis failed (${err.status || 'unknown'}).`
        );
      }
    });
  }

  private showPicks(): void {
    if (this.mode() === 'route' || this.mode() === 'nearest') {
      this.renderRouting();
      return;
    }
    const points = [this.from(), this.to()].filter((p): p is LonLat => !!p);
    this.mapService.setAnalysisGeometry({ type: 'MultiPoint', coordinates: points });
  }

  private draw(paths: { coordinates: LonLat[][] }[], points: LonLat[]): void {
    const lines = paths.flatMap((p) => p.coordinates);
    this.mapService.setAnalysisRoute(lines, points);
    this.mapService.zoomToGeometries([
      {
        type: 'GeometryCollection',
        geometries: [
          { type: 'MultiLineString', coordinates: lines },
          { type: 'MultiPoint', coordinates: points }
        ]
      }
    ]);
  }

  private formatLength(metres: number): string {
    return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${Math.round(metres)} m`;
  }
}

/** Index of the leg whose line passes closest to `point`. */
function nearestLeg(legs: LonLat[][][], point: LonLat): number {
  let best = 0;
  let bestDistance = Infinity;
  const kx = Math.cos((point[1] * Math.PI) / 180);
  legs.forEach((lines, index) => {
    for (const line of lines) {
      for (let i = 0; i < line.length - 1; i++) {
        const [ax, ay] = [(line[i][0] - point[0]) * kx, line[i][1] - point[1]];
        const [bx, by] = [(line[i + 1][0] - point[0]) * kx, line[i + 1][1] - point[1]];
        const [dx, dy] = [bx - ax, by - ay];
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
        const distance = Math.hypot(ax + t * dx, ay + t * dy);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
    }
  });
  return best;
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
