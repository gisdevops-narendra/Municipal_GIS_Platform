import { Component, Input, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { MapService, RING_COLORS } from '../../services/map.service';
import { LonLat, NetworkService } from '../../services/network.service';

type Mode = 'route' | 'nearest' | 'trace' | 'service';
type Slot = 'from' | 'to';

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

  readonly lineLayers = computed(() =>
    this.layersSignal()
      .filter((l) => l.layerType === 'VECTOR' && l.geometryType === 'LINE')
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

  private pickSub?: Subscription;

  ngOnDestroy(): void {
    this.pickSub?.unsubscribe();
    this.mapService.cancelDraw();
  }

  setMode(mode: Mode): void {
    this.mode.set(mode);
    this.clear();
  }

  pick(slot: Slot): void {
    this.picking.set(slot);
    this.error.set(null);
    this.pickSub?.unsubscribe();
    this.pickSub = this.mapService.beginDraw('Point').subscribe({
      next: (geometry) => {
        const point = (geometry['coordinates'] as number[]).slice(0, 2) as LonLat;
        (slot === 'from' ? this.from : this.to).set(point);
        this.picking.set(null);
        this.mapService.clearDraw();
        this.showPicks();
      },
      complete: () => this.picking.set(null)
    });
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
    if (!from) return this.error.set(this.mode() === 'trace' ? 'Click a start point on the network.' : 'Pick the start point on the map.');

    if (this.mode() === 'route') {
      const to = this.to();
      if (!to) return this.error.set('Pick the destination on the map.');
      this.execute(this.network.route(layerId, from, to), (r) => {
        this.draw([r.path], [from, to]);
        this.summary.set(`Shortest route: ${this.formatLength(r.lengthM)}.`);
      });
    } else if (this.mode() === 'nearest') {
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
  }

  private execute<T>(request: Observable<T>, onResult: (result: T) => void): void {
    const mode = this.mode();
    this.running.set(true);
    this.error.set(null);
    this.summary.set(null);
    this.facilities.set([]);
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
    const points = [this.from(), this.to()].filter((p): p is LonLat => !!p);
    this.mapService.setAnalysisGeometry({ type: 'MultiPoint', coordinates: points });
  }

  private draw(paths: { coordinates: LonLat[][] }[], points: LonLat[]): void {
    const geometry = {
      type: 'GeometryCollection',
      geometries: [
        { type: 'MultiLineString', coordinates: paths.flatMap((p) => p.coordinates) },
        { type: 'MultiPoint', coordinates: points }
      ]
    };
    this.mapService.setAnalysisGeometry(geometry);
    this.mapService.zoomToGeometries([geometry]);
  }

  private formatLength(metres: number): string {
    return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${Math.round(metres)} m`;
  }
}
