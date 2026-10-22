import { Component, Input, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { MapService, RING_COLORS } from '../../services/map.service';
import { LonLat, NetworkService, RouteOption, RouteResult } from '../../services/network.service';

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

/** "A", "B", … "Z", then "27" … — same labels as the backend's directions. */
export function stopLabel(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}
@Component({
  selector: 'app-advanced-tools',
  standalone: true,
  imports: [FormsModule, ButtonModule, SelectModule],
  templateUrl: './advanced-tools.component.html',
  styleUrl: '../buffer-overlay/buffer-overlay.component.scss'
})
export class AdvancedToolsComponent implements OnDestroy {
  private readonly mapService = inject(MapService);
  private readonly network = inject(NetworkService);

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
  readonly facilities = signal<{ label: string; length: string }[]>([]);
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
        this.afterRoutingInputChange(typeof slot === 'number' || slot === 'avoidArea' || slot === 'avoidRoad');
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
    if (this.mode() !== 'route') {
      this.showPicks();
      return;
    }
    if (reroute && this.routes().length && this.stops().filter(Boolean).length >= 2) {
      this.run();
    } else {
      this.renderRouting();
    }
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
      const count = Math.min(Math.max(Math.round(this.facilityCount || 1), 1), 10);
      this.execute(this.network.nearest(layerId, facilityLayerId, from, count), (r) => {
        this.draw(
          r.facilities.map((f) => f.path),
          [from, ...r.facilities.map((f) => f.location)]
        );
        this.facilities.set(r.facilities.map((f) => ({ label: f.label, length: this.formatLength(f.lengthM) })));
        this.summary.set(`${r.facilities.length} nearest facilit${r.facilities.length === 1 ? 'y' : 'ies'} by road:`);
      });
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
    if (this.running() || this.mode() !== 'route') return;
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
    const url = URL.createObjectURL(new Blob([body], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `route.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    if (this.mode() === 'route') {
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
