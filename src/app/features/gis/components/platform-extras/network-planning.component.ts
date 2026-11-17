import { Component, DestroyRef, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { Subscription } from 'rxjs';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { AnalyticsField } from '../../../../core/models/layer-analytics.model';
import { GisLayersService } from '../../../../core/services/gis-layers.service';
import { MapService } from '../../services/map.service';
import {
  FleetRoutesResult,
  LonLat,
  NetworkService,
  OdMatrixResult,
  SiteSelectionResult
} from '../../services/network.service';

const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5'];
const color = (i: number) => COLORS[i % COLORS.length];

export interface SiteSourceValue {
  mode: 'layer' | 'click';
  layerId: string;
  labelField: string;
  points: LonLat[];
}

/** "Where do the points come from": a point/polygon layer, or clicks. */
@Component({
  selector: 'app-site-source',
  standalone: true,
  imports: [FormsModule],
  styleUrl: './extras.scss',
  template: `
    <div class="px__field">
      <span class="px__label">{{ label }}</span>
      @if (allowClick) {
        <div class="px__seg">
          <button type="button" class="px__seg-btn" [class.is-active]="value.mode === 'layer'" (click)="set({ mode: 'layer' })">From a layer</button>
          <button type="button" class="px__seg-btn" [class.is-active]="value.mode === 'click'" (click)="set({ mode: 'click' })">Click on map</button>
        </div>
      }
      @if (value.mode === 'layer') {
        <select class="px__native-select" [ngModel]="value.layerId" (ngModelChange)="pickLayer($event)">
          <option value="">Choose a layer…</option>
          @for (l of layers; track l.id) { <option [value]="l.id">{{ l.name }}</option> }
        </select>
        @if (value.layerId && showLabel) {
          <select class="px__native-select" [ngModel]="value.labelField" (ngModelChange)="set({ labelField: $event })" aria-label="Name field">
            <option value="">Name field: automatic</option>
            @for (f of textFields(); track f.name) { <option [value]="f.name">Name field: {{ f.name }}</option> }
          </select>
        }
      } @else {
        <div class="px__secret">
          <button type="button" class="px__link-btn" style="flex: 1" (click)="picking() ? stopPicking() : startPicking()">
            <i class="pi" [class.pi-map-marker]="!picking()" [class.pi-stop-circle]="picking()"></i>
            {{ picking() ? 'Done adding' : 'Add points on map' }}
          </button>
          <span class="px__badge">{{ value.points.length }}</span>
          @if (value.points.length) {
            <button type="button" class="px__icon-btn px__icon-btn--danger" title="Clear points" (click)="set({ points: [] })"><i class="pi pi-trash"></i></button>
          }
        </div>
      }
    </div>
  `
})
export class SiteSourceComponent {
  private readonly map = inject(MapService);
  private readonly layersApi = inject(GisLayersService);

  @Input({ required: true }) label = '';
  @Input() layers: GisLayer[] = [];
  @Input() allowClick = true;
  @Input() showLabel = true;
  @Input({ required: true }) value!: SiteSourceValue;
  @Output() readonly valueChange = new EventEmitter<SiteSourceValue>();
  /** Fields of the chosen layer, for parents that need numeric ones. */
  @Output() readonly fieldsChange = new EventEmitter<AnalyticsField[]>();

  readonly fields = signal<AnalyticsField[]>([]);
  readonly textFields = computed(() => this.fields().filter((f) => f.kind === 'string' || f.kind === 'number'));
  readonly picking = signal(false);
  private pickSub: Subscription | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopPicking());
  }

  set(change: Partial<SiteSourceValue>): void {
    if (change.mode && change.mode !== 'click') this.stopPicking();
    this.value = { ...this.value, ...change };
    this.valueChange.emit(this.value);
  }

  pickLayer(id: string): void {
    this.set({ layerId: id, labelField: '' });
    this.fields.set([]);
    this.fieldsChange.emit([]);
    if (id)
      this.layersApi.analyticsFields(id).subscribe((f) => {
        this.fields.set(f);
        this.fieldsChange.emit(f);
      });
  }

  startPicking(): void {
    this.picking.set(true);
    const next = () => {
      this.pickSub = this.map.pickMapPoint().subscribe(({ lonLat }) => {
        this.set({ points: [...this.value.points, lonLat] });
        if (this.picking()) next();
      });
    };
    next();
  }

  stopPicking(): void {
    this.pickSub?.unsubscribe();
    this.pickSub = null;
    if (this.picking()) this.map.cancelMapPick();
    this.picking.set(false);
  }
}

const emptySource = (mode: 'layer' | 'click' = 'layer'): SiteSourceValue => ({ mode, layerId: '', labelField: '', points: [] });

/** Network Planning: fleet routes (vehicle routing), travel matrix (OD
 *  cost matrix) and site selection (location-allocation). */
@Component({
  selector: 'app-network-planning',
  standalone: true,
  imports: [FormsModule, ButtonModule, SiteSourceComponent],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      <div class="px__tabs" style="grid-template-columns: repeat(3, 1fr)" role="tablist">
        <button type="button" role="tab" class="px__tab" [class.is-active]="tab() === 'fleet'" title="Fleet routes" (click)="switchTab('fleet')">Fleet</button>
        <button type="button" role="tab" class="px__tab" [class.is-active]="tab() === 'matrix'" title="Travel matrix" (click)="switchTab('matrix')">Matrix</button>
        <button type="button" role="tab" class="px__tab" [class.is-active]="tab() === 'sites'" title="Site selection" (click)="switchTab('sites')">Sites</button>
      </div>

      @if (!roadLayers().length) {
        <p class="px__hint">No routing (road network) layer. Mark a line layer as a routing layer when uploading it.</p>
      } @else {
        <label class="px__field">
          <span class="px__label">Road network</span>
          <select class="px__native-select" [ngModel]="roadId()" (ngModelChange)="roadId.set($event)">
            @for (l of roadLayers(); track l.id) { <option [value]="l.id">{{ l.name }}</option> }
          </select>
        </label>

        @switch (tab()) {
          <!-- ===== Fleet routes ===== -->
          @case ('fleet') {
            <p class="px__intro">Split stops (bins, inspections, deliveries…) across several vehicles from one depot, each with its own ordered route.</p>
            <div class="px__field">
              <span class="px__label">Depot</span>
              <div class="px__secret">
                <button type="button" class="px__link-btn" style="flex: 1" (click)="pickDepot()">
                  <i class="pi pi-home"></i>{{ depot() ? 'Move depot' : 'Pick depot on map' }}
                </button>
                @if (depot(); as d) { <span class="px__mono">{{ d[1].toFixed(4) }}, {{ d[0].toFixed(4) }}</span> }
              </div>
            </div>
            <app-site-source label="Stops" [layers]="siteLayers()" [value]="stops()" (valueChange)="stops.set($event)" (fieldsChange)="stopFields.set($event)" />
            @if (stops().mode === 'layer' && stops().layerId) {
              <label class="px__field">
                <span class="px__label">Load per stop (optional)</span>
                <select class="px__native-select" [ngModel]="demandField()" (ngModelChange)="demandField.set($event)">
                  <option value="">1 per stop</option>
                  @for (f of numeric(stopFields()); track f.name) { <option [value]="f.name">{{ f.name }}</option> }
                </select>
              </label>
            }
            <div class="px__row">
              <label class="px__field"><span class="px__label">Vehicles</span>
                <input class="px__input" type="number" min="1" max="20" [ngModel]="vehicles()" (ngModelChange)="vehicles.set(+$event)" /></label>
              <label class="px__field"><span class="px__label">Capacity</span>
                <input class="px__input" type="number" min="1" placeholder="even" [ngModel]="capacity()" (ngModelChange)="capacity.set(num($event))" /></label>
            </div>
            <div class="px__row">
              <label class="px__field"><span class="px__label">Speed km/h</span>
                <input class="px__input" type="number" min="1" max="200" placeholder="—" [ngModel]="speed()" (ngModelChange)="speed.set(num($event))" /></label>
              <label class="px__field"><span class="px__label">Min / stop</span>
                <input class="px__input" type="number" min="0" max="240" placeholder="0" [ngModel]="serviceMin()" (ngModelChange)="serviceMin.set(num($event))" /></label>
            </div>
            <label class="px__check"><input type="checkbox" [ngModel]="returnToDepot()" (ngModelChange)="returnToDepot.set($event)" /> Vehicles return to the depot</label>
            <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-truck" label="Plan routes" [loading]="busy()"
                    [disabled]="!depot() || !sourceReady(stops())" (click)="runFleet()"></button>
            @if (error(); as e) { <p class="px__error" role="alert">{{ e }}</p> }

            @if (fleet(); as r) {
              <div class="px__card">
                <dl class="px__kv">
                  <dt>Vehicles used</dt><dd>{{ r.vehiclesUsed }}</dd>
                  <dt>Total distance</dt><dd>{{ km(r.totalLengthM) }}</dd>
                  <dt>Load limit</dt><dd>{{ r.capacity }}</dd>
                </dl>
                @if (r.vehiclesNeeded) { <p class="px__warn">With this load limit {{ r.vehiclesNeeded }} vehicles are needed.</p> }
                @if (r.unassigned.length) { <p class="px__warn">{{ r.unassigned.length }} stop(s) could not be reached: {{ r.unassigned.slice(0, 5).join(', ') }}…</p> }
              </div>
              <div class="px__list" style="max-height: none">
                @for (t of r.trips; track t.vehicle; let i = $index) {
                  <div class="px__item px__item--click" (click)="openTrip.set(openTrip() === i ? null : i)">
                    <span class="px__badge" [style.background]="colorOf(i)" style="color: #fff; border: 0">V{{ t.vehicle }}</span>
                    <div class="px__item-main">
                      <span class="px__item-title">{{ t.stops.length }} stops · {{ km(t.lengthM) }}</span>
                      <span class="px__item-sub">Load {{ t.load }}@if (t.minutes !== null) { · {{ hm(t.minutes) }} }</span>
                    </div>
                    <i class="pi" [class.pi-chevron-down]="openTrip() !== i" [class.pi-chevron-up]="openTrip() === i"></i>
                  </div>
                  @if (openTrip() === i) {
                    <ol style="margin: 0; padding: 4px 12px 8px 34px; font-size: 12px; color: var(--color-ink-700)">
                      @for (s of t.stops; track $index) { <li>{{ s.label }}</li> }
                    </ol>
                  }
                }
              </div>
              <button pButton type="button" class="p-button-sm p-button-outlined px__btn-block" icon="pi pi-download" label="Download CSV" (click)="csvFleet(r)"></button>
            }
          }

          <!-- ===== Travel matrix ===== -->
          @case ('matrix') {
            <p class="px__intro">Road distance (and time) from every origin to every destination — e.g. every ward office to every hospital.</p>
            <app-site-source label="Origins (max 100)" [layers]="siteLayers()" [value]="origins()" (valueChange)="origins.set($event)" />
            <app-site-source label="Destinations (max 1000)" [layers]="siteLayers()" [value]="destinations()" (valueChange)="destinations.set($event)" />
            <div class="px__row">
              <label class="px__field"><span class="px__label">Speed km/h</span>
                <input class="px__input" type="number" min="1" max="200" placeholder="—" [ngModel]="speed()" (ngModelChange)="speed.set(num($event))" /></label>
              <label class="px__field"><span class="px__label">Max km</span>
                <input class="px__input" type="number" min="0.1" placeholder="none" [ngModel]="maxKm()" (ngModelChange)="maxKm.set(num($event))" /></label>
            </div>
            <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-table" label="Build matrix" [loading]="busy()"
                    [disabled]="!sourceReady(origins()) || !sourceReady(destinations())" (click)="runMatrix()"></button>
            @if (error(); as e) { <p class="px__error" role="alert">{{ e }}</p> }

            @if (matrix(); as r) {
              @if (r.offNetwork.origins || r.offNetwork.destinations) {
                <p class="px__warn">Left out (over 500 m from a road): {{ r.offNetwork.origins }} origin(s), {{ r.offNetwork.destinations }} destination(s).</p>
              }
              <div class="px__section">
                <h4>Closest destination</h4>
                <div class="px__list">
                  @for (n of r.nearest; track n.origin) {
                    <div class="px__item">
                      <div class="px__item-main">
                        <span class="px__item-title">{{ r.origins[n.origin].label }}</span>
                        <span class="px__item-sub">→ {{ n.destination !== null ? r.destinations[n.destination].label : 'none reachable' }}</span>
                      </div>
                      @if (n.distanceM !== null) {
                        <span class="px__mono">{{ km(n.distanceM) }}@if (n.minutes !== null) { · {{ hm(n.minutes) }} }</span>
                      }
                    </div>
                  }
                </div>
              </div>
              @if (r.origins.length <= 12 && r.destinations.length <= 8) {
                <div style="overflow-x: auto; border: 1px solid var(--color-line); border-radius: var(--radius-md)">
                  <table style="border-collapse: collapse; font-size: 11.5px; width: 100%">
                    <thead><tr>
                      <th style="padding: 6px; text-align: left"></th>
                      @for (d of r.destinations; track $index) { <th style="padding: 6px; text-align: right; white-space: nowrap; max-width: 90px; overflow: hidden; text-overflow: ellipsis" [title]="d.label">{{ d.label }}</th> }
                    </tr></thead>
                    <tbody>
                      @for (o of r.origins; track $index; let i = $index) {
                        <tr style="border-top: 1px solid var(--color-line)">
                          <th style="padding: 6px; text-align: left; white-space: nowrap; font-weight: 600">{{ o.label }}</th>
                          @for (v of r.distancesM[i]; track $index; let j = $index) {
                            <td class="px__mono" style="padding: 6px; text-align: right" [style.font-weight]="r.nearest[i].destination === j ? 700 : 400">{{ v === null ? '—' : km(v) }}</td>
                          }
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
              <button pButton type="button" class="p-button-sm p-button-outlined px__btn-block" icon="pi pi-download" label="Download full matrix (CSV)" (click)="csvMatrix(r)"></button>
            }
          }

          <!-- ===== Site selection ===== -->
          @case ('sites') {
            <p class="px__intro">Choose the best places for new facilities (schools, clinics, ward offices…) from a set of candidate sites, to serve the demand layer.</p>
            <app-site-source label="Demand (homes, wards, population…)" [layers]="siteLayers()" [allowClick]="false" [showLabel]="false" [value]="demand()" (valueChange)="demand.set($event)" (fieldsChange)="demandFields.set($event)" />
            @if (demand().layerId) {
              <label class="px__field">
                <span class="px__label">Weight (optional)</span>
                <select class="px__native-select" [ngModel]="weightField()" (ngModelChange)="weightField.set($event)">
                  <option value="">Each feature counts 1</option>
                  @for (f of numeric(demandFields()); track f.name) { <option [value]="f.name">{{ f.name }}</option> }
                </select>
              </label>
            }
            <app-site-source label="Candidate sites" [layers]="siteLayers()" [allowClick]="false" [value]="candidates()" (valueChange)="candidates.set($event)" />
            <label class="px__field">
              <span class="px__label">Existing facilities (optional)</span>
              <select class="px__native-select" [ngModel]="existingId()" (ngModelChange)="existingId.set($event)">
                <option value="">None</option>
                @for (l of siteLayers(); track l.id) { <option [value]="l.id">{{ l.name }}</option> }
              </select>
            </label>
            <div class="px__field">
              <span class="px__label">Goal</span>
              <div class="px__seg">
                <button type="button" class="px__seg-btn" [class.is-active]="objective() === 'MIN_DISTANCE'" (click)="objective.set('MIN_DISTANCE')">Shortest travel</button>
                <button type="button" class="px__seg-btn" [class.is-active]="objective() === 'MAX_COVERAGE'" (click)="objective.set('MAX_COVERAGE')">Most covered</button>
              </div>
            </div>
            <div class="px__row">
              <label class="px__field"><span class="px__label">New sites</span>
                <input class="px__input" type="number" min="1" max="50" [ngModel]="count()" (ngModelChange)="count.set(+$event)" /></label>
              <label class="px__field"><span class="px__label">Service km{{ objective() === 'MAX_COVERAGE' ? '' : ' (opt.)' }}</span>
                <input class="px__input" type="number" min="0.05" step="0.5" placeholder="—" [ngModel]="cutoffKm()" (ngModelChange)="cutoffKm.set(num($event))" /></label>
            </div>
            <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-building" label="Find best sites" [loading]="busy()"
                    [disabled]="!demand().layerId || !candidates().layerId || (objective() === 'MAX_COVERAGE' && !cutoffKm())" (click)="runSites()"></button>
            @if (error(); as e) { <p class="px__error" role="alert">{{ e }}</p> }

            @if (sites(); as r) {
              <div class="px__card">
                <dl class="px__kv">
                  <dt>Demand served</dt><dd>{{ r.stats.reachedWeight.toLocaleString() }} / {{ r.stats.totalWeight.toLocaleString() }}</dd>
                  @if (r.stats.coveredWeight !== null) { <dt>Within {{ km(r.cutoffM ?? 0) }}</dt><dd>{{ pct(r.stats.coveredWeight, r.stats.totalWeight) }}</dd> }
                  @if (r.stats.avgDistanceM !== null) { <dt>Average distance</dt><dd>{{ km(r.stats.avgDistanceM) }}</dd> }
                  @if (r.stats.avgDistanceBeforeM !== null) { <dt>Before (existing only)</dt><dd>{{ km(r.stats.avgDistanceBeforeM) }}</dd> }
                </dl>
                @if (r.stats.offNetwork) { <p class="px__hint">{{ r.stats.offNetwork }} demand feature(s) are over 500 m from a road and were left out.</p> }
              </div>
              <div class="px__list" style="max-height: none">
                @for (f of r.facilities; track $index; let i = $index) {
                  <div class="px__item px__item--click" (click)="zoomTo(f.point)">
                    <span class="px__badge" [style.background]="f.kind === 'new' ? colorOf(i) : '#6b7280'" style="color: #fff; border: 0">{{ f.kind === 'new' ? 'NEW' : 'OLD' }}</span>
                    <div class="px__item-main">
                      <span class="px__item-title" [title]="f.label">{{ f.label }}</span>
                      <span class="px__item-sub">Serves {{ f.weight.toLocaleString() }} ({{ f.demandCount }} features)@if (f.avgDistanceM !== null) { · avg {{ km(f.avgDistanceM) }} }</span>
                    </div>
                  </div>
                }
              </div>
              <button pButton type="button" class="p-button-sm p-button-outlined px__btn-block" icon="pi pi-download" label="Download CSV" (click)="csvSites(r)"></button>
            }
          }
        }
      }
    </div>
  `
})
export class NetworkPlanningComponent {
  private readonly map = inject(MapService);
  private readonly network = inject(NetworkService);

  @Input() set layers(value: GisLayer[] | null) {
    this.layersSignal.set(value ?? []);
    if (!this.roadId() && this.roadLayers().length) this.roadId.set(this.roadLayers()[0].id);
  }
  private readonly layersSignal = signal<GisLayer[]>([]);
  readonly roadLayers = computed(() =>
    this.layersSignal().filter((l) => l.layerType === 'VECTOR' && l.geometryType === 'LINE' && l.routingEnabled)
  );
  readonly siteLayers = computed(() =>
    this.layersSignal().filter((l) => l.layerType === 'VECTOR' && (l.geometryType === 'POINT' || l.geometryType === 'POLYGON'))
  );

  readonly tab = signal<'fleet' | 'matrix' | 'sites'>('fleet');
  readonly roadId = signal('');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly speed = signal<number | null>(25);

  // fleet
  readonly depot = signal<LonLat | null>(null);
  readonly stops = signal<SiteSourceValue>(emptySource());
  readonly stopFields = signal<AnalyticsField[]>([]);
  readonly demandField = signal('');
  readonly vehicles = signal(3);
  readonly capacity = signal<number | null>(null);
  readonly serviceMin = signal<number | null>(null);
  readonly returnToDepot = signal(true);
  readonly fleet = signal<FleetRoutesResult | null>(null);
  readonly openTrip = signal<number | null>(null);
  private depotSub: Subscription | null = null;

  // matrix
  readonly origins = signal<SiteSourceValue>(emptySource());
  readonly destinations = signal<SiteSourceValue>(emptySource());
  readonly maxKm = signal<number | null>(null);
  readonly matrix = signal<OdMatrixResult | null>(null);

  // sites
  readonly demand = signal<SiteSourceValue>(emptySource());
  readonly demandFields = signal<AnalyticsField[]>([]);
  readonly weightField = signal('');
  readonly candidates = signal<SiteSourceValue>(emptySource());
  readonly existingId = signal('');
  readonly objective = signal<'MIN_DISTANCE' | 'MAX_COVERAGE'>('MIN_DISTANCE');
  readonly count = signal(3);
  readonly cutoffKm = signal<number | null>(null);
  readonly sites = signal<SiteSelectionResult | null>(null);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.depotSub?.unsubscribe();
      this.map.clearAnalysisGeometry();
    });
  }

  num = (v: unknown): number | null => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  numeric = (fields: AnalyticsField[]) => fields.filter((f) => f.kind === 'number');
  colorOf = color;
  km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km` : `${Math.round(m)} m`);
  hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${Math.round(min)} min`);
  pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 1000) / 10} %` : '—');

  sourceReady(s: SiteSourceValue): boolean {
    return s.mode === 'layer' ? !!s.layerId : s.points.length > 0;
  }

  switchTab(tab: 'fleet' | 'matrix' | 'sites'): void {
    this.tab.set(tab);
    this.error.set(null);
    this.map.clearAnalysisGeometry();
    if (tab === 'fleet' && this.fleet()) this.drawFleet(this.fleet()!);
    if (tab === 'matrix' && this.matrix()) this.drawMatrix(this.matrix()!);
    if (tab === 'sites' && this.sites()) this.drawSites(this.sites()!);
  }

  pickDepot(): void {
    this.depotSub?.unsubscribe();
    this.depotSub = this.map.pickMapPoint().subscribe(({ lonLat }) => {
      this.depot.set(lonLat);
      this.map.setAnalysisColoredGeometries([{ geometry: { type: 'Point', coordinates: lonLat }, color: '#111827' }]);
    });
  }

  private siteRequest(s: SiteSourceValue, prefix: 'origin' | 'destination' | 'stop') {
    return s.mode === 'layer'
      ? { [`${prefix}LayerId`]: s.layerId, ...(s.labelField ? { [`${prefix}LabelField`]: s.labelField } : {}) }
      : { [`${prefix}s`]: s.points };
  }

  private fail(e: { error?: { message?: string | string[] } }): void {
    const m = e?.error?.message;
    this.error.set(Array.isArray(m) ? m.join(', ') : m ?? 'The analysis failed.');
    this.busy.set(false);
  }

  runFleet(): void {
    this.busy.set(true);
    this.error.set(null);
    this.network
      .fleetRoutes(this.roadId(), {
        depot: this.depot()!,
        ...this.siteRequest(this.stops(), 'stop'),
        ...(this.demandField() && this.stops().mode === 'layer' ? { demandField: this.demandField() } : {}),
        vehicles: this.vehicles(),
        ...(this.capacity() ? { capacity: this.capacity()! } : {}),
        returnToDepot: this.returnToDepot(),
        ...(this.speed() ? { speedKmh: this.speed()! } : {}),
        ...(this.serviceMin() ? { serviceMinutes: this.serviceMin()! } : {})
      })
      .subscribe({
        next: (r) => {
          this.fleet.set(r);
          this.openTrip.set(null);
          this.busy.set(false);
          this.drawFleet(r);
        },
        error: (e) => this.fail(e)
      });
  }

  runMatrix(): void {
    this.busy.set(true);
    this.error.set(null);
    this.network
      .odMatrix(this.roadId(), {
        ...this.siteRequest(this.origins(), 'origin'),
        ...this.siteRequest(this.destinations(), 'destination'),
        ...(this.speed() ? { speedKmh: this.speed()! } : {}),
        ...(this.maxKm() ? { maxDistanceM: this.maxKm()! * 1000 } : {})
      })
      .subscribe({
        next: (r) => {
          this.matrix.set(r);
          this.busy.set(false);
          this.drawMatrix(r);
        },
        error: (e) => this.fail(e)
      });
  }

  runSites(): void {
    this.busy.set(true);
    this.error.set(null);
    this.network
      .siteSelection(this.roadId(), {
        demandLayerId: this.demand().layerId,
        ...(this.weightField() ? { weightField: this.weightField() } : {}),
        candidateLayerId: this.candidates().layerId,
        ...(this.candidates().labelField ? { candidateLabelField: this.candidates().labelField } : {}),
        ...(this.existingId() ? { existingLayerId: this.existingId() } : {}),
        count: this.count(),
        objective: this.objective(),
        ...(this.cutoffKm() ? { cutoffM: this.cutoffKm()! * 1000 } : {}),
        ...(this.speed() ? { speedKmh: this.speed()! } : {})
      })
      .subscribe({
        next: (r) => {
          this.sites.set(r);
          this.busy.set(false);
          this.drawSites(r);
        },
        error: (e) => this.fail(e)
      });
  }

  private drawFleet(r: FleetRoutesResult): void {
    const items: { geometry: Record<string, unknown>; color: string }[] = [];
    r.trips.forEach((t, i) => {
      items.push({ geometry: t.path as unknown as Record<string, unknown>, color: color(i) });
      items.push({ geometry: { type: 'MultiPoint', coordinates: t.stops.map((s) => s.point) }, color: color(i) });
    });
    items.push({ geometry: { type: 'Point', coordinates: r.depot }, color: '#111827' });
    this.map.setAnalysisColoredGeometries(items);
    this.map.zoomToGeometries(items.map((i) => i.geometry));
  }

  private drawMatrix(r: OdMatrixResult): void {
    const items: { geometry: Record<string, unknown>; color: string }[] = [];
    for (const n of r.nearest) if (n.path) items.push({ geometry: n.path as unknown as Record<string, unknown>, color: '#2563eb' });
    items.push({ geometry: { type: 'MultiPoint', coordinates: r.destinations.map((d) => d.point) }, color: '#dc2626' });
    items.push({ geometry: { type: 'MultiPoint', coordinates: r.origins.map((o) => o.point) }, color: '#16a34a' });
    this.map.setAnalysisColoredGeometries(items);
    this.map.zoomToGeometries(items.map((i) => i.geometry));
  }

  private drawSites(r: SiteSelectionResult): void {
    const items: { geometry: Record<string, unknown>; color: string }[] = [];
    r.facilities.forEach((f, i) => {
      const c = f.kind === 'new' ? color(i) : '#6b7280';
      if (f.allocation.coordinates.length) items.push({ geometry: f.allocation as unknown as Record<string, unknown>, color: c });
    });
    r.facilities.forEach((f, i) => items.push({ geometry: { type: 'Point', coordinates: f.point }, color: f.kind === 'new' ? color(i) : '#6b7280' }));
    this.map.setAnalysisColoredGeometries(items);
    this.map.zoomToGeometries(r.facilities.map((f) => ({ type: 'Point', coordinates: f.point })));
  }

  zoomTo(point: LonLat): void {
    this.map.zoomToGeometries([{ type: 'Point', coordinates: point }]);
  }

  csvFleet(r: FleetRoutesResult): void {
    const rows = [['vehicle', 'order', 'stop', 'longitude', 'latitude', 'trip_km', 'trip_minutes']];
    for (const t of r.trips) {
      t.stops.forEach((s, i) =>
        rows.push([String(t.vehicle), String(i + 1), s.label, String(s.point[0]), String(s.point[1]), (t.lengthM / 1000).toFixed(2), t.minutes === null ? '' : String(t.minutes)])
      );
    }
    download('fleet-routes.csv', rows);
  }

  csvMatrix(r: OdMatrixResult): void {
    const rows = [['origin', 'destination', 'distance_km', 'minutes']];
    r.origins.forEach((o, i) =>
      r.destinations.forEach((d, j) => {
        const m = r.distancesM[i][j];
        rows.push([o.label, d.label, m === null ? '' : (m / 1000).toFixed(3), r.minutes?.[i][j] == null ? '' : String(r.minutes[i][j])]);
      })
    );
    download('travel-matrix.csv', rows);
  }

  csvSites(r: SiteSelectionResult): void {
    const rows = [['status', 'site', 'longitude', 'latitude', 'demand_features', 'demand_weight', 'avg_distance_km']];
    for (const f of r.facilities) {
      rows.push([f.kind, f.label, String(f.point[0]), String(f.point[1]), String(f.demandCount), String(f.weight), f.avgDistanceM === null ? '' : (f.avgDistanceM / 1000).toFixed(2)]);
    }
    download('site-selection.csv', rows);
  }
}

function download(name: string, rows: string[][]): void {
  const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
