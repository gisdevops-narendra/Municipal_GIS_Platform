import { Component, DestroyRef, Input, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { environment } from '../../../../../environments/environment';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { AnalyticsField } from '../../../../core/models/layer-analytics.model';
import { GisLayersService } from '../../../../core/services/gis-layers.service';
import { MapService } from '../../services/map.service';
import { NetworkService, SiteSelectionResult } from '../../services/network.service';

type CellStatus = 'served' | 'near' | 'gap' | 'empty';

interface Coverage {
  cellKm: number;
  serviceRadiusKm: number;
  chargersInArea: number;
  cells: { id: string; geometry: Record<string, unknown>; center: [number, number]; chargers: number; demand: number; status: CellStatus }[];
  stats: { cells: number; served: number; near: number; gaps: number; empty: number; gridCoveragePct: number; totalDemand: number; demandCoveredPct: number | null };
  topGaps: { rank: number; id: string; center: [number, number]; demand: number }[];
}

const STATUS_COLORS: Record<CellStatus, string> = { served: '#16a34a', near: '#86efac', gap: '#dc2626', empty: '#e5e7eb' };

/** EV charging: grid coverage of existing chargers (India's 3 × 3 km
 *  guideline by default), demand gaps, and best new sites. */
@Component({
  selector: 'app-ev-charging',
  standalone: true,
  imports: [FormsModule, ButtonModule],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      <p class="px__intro">Check where EV chargers are missing. The area on screen is split into a grid (India's guideline: one charging station per 3 × 3 km); cells without a charger in reach are gaps.</p>
      @if (!pointLayers().length) {
        <p class="px__hint">No point layer of chargers. Tip: OSM Download → Custom tag “amenity” = “charging_station”.</p>
      } @else {
        <label class="px__field"><span class="px__label">Existing chargers</span>
          <select class="px__native-select" [ngModel]="chargerId()" (ngModelChange)="chargerId.set($event)">
            @for (l of pointLayers(); track l.id) { <option [value]="l.id">{{ l.name }}</option> }
          </select></label>
        <label class="px__field"><span class="px__label">Demand (optional: buildings, parking, shops, population…)</span>
          <select class="px__native-select" [ngModel]="demandId()" (ngModelChange)="pickDemand($event)">
            <option value="">— none (every cell counts)</option>
            @for (l of siteLayers(); track l.id) { <option [value]="l.id">{{ l.name }}</option> }
          </select></label>
        @if (demandId()) {
          <label class="px__field"><span class="px__label">Weight</span>
            <select class="px__native-select" [ngModel]="weightField()" (ngModelChange)="weightField.set($event)">
              <option value="">Each feature counts 1</option>
              @for (f of numericFields(); track f.name) { <option [value]="f.name">{{ f.name }}</option> }
            </select></label>
        }
        <div class="px__row">
          <label class="px__field"><span class="px__label">Grid cell (km)</span>
            <select class="px__native-select" [ngModel]="cellKm()" (ngModelChange)="cellKm.set(+$event)">
              @for (k of [1, 2, 3, 5, 10]; track k) { <option [value]="k">{{ k }} × {{ k }}</option> }
            </select></label>
          <label class="px__field"><span class="px__label">Charger reach (km)</span>
            <input class="px__input" type="number" min="0.2" max="50" step="0.5" [ngModel]="radiusKm()" (ngModelChange)="radiusKm.set(+$event)" /></label>
        </div>
        <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-th-large" label="Check coverage in this view" [loading]="busy()" (click)="run()"></button>
        @if (error(); as e) { <p class="px__error" role="alert">{{ e }}</p> }

        @if (result(); as r) {
          <div class="px__card">
            <dl class="px__kv">
              <dt>Chargers in view</dt><dd>{{ r.chargersInArea }}</dd>
              <dt>Grid cells covered</dt><dd>{{ r.stats.gridCoveragePct }} %</dd>
              @if (r.stats.demandCoveredPct !== null) { <dt>Demand within {{ r.serviceRadiusKm }} km</dt><dd>{{ r.stats.demandCoveredPct }} %</dd> }
              <dt>Gap cells</dt><dd [style.color]="r.stats.gaps ? '#dc2626' : null">{{ r.stats.gaps }}</dd>
            </dl>
            <div class="px__secret" style="flex-wrap: wrap; gap: 8px">
              @for (s of legend; track s.key) {
                <span class="px__item-sub"><span [style.color]="s.color">■</span> {{ s.label }} {{ countOf(s.key) }}</span>
              }
            </div>
          </div>

          @if (r.topGaps.length) {
            <div class="px__section">
              <h4>Biggest gaps{{ demandId() ? ' (by demand)' : '' }}</h4>
              <div class="px__list">
                @for (g of r.topGaps; track g.id) {
                  <div class="px__item px__item--click" (click)="zoom(g.center)">
                    <span class="px__badge" style="background: #dc2626; color: #fff; border: 0">{{ g.rank }}</span>
                    <div class="px__item-main">
                      <span class="px__item-title">Gap {{ g.rank }}</span>
                      <span class="px__item-sub px__mono">{{ g.center[1].toFixed(4) }}, {{ g.center[0].toFixed(4) }}</span>
                    </div>
                    @if (demandId()) { <span class="px__mono">{{ g.demand }}</span> }
                  </div>
                }
              </div>
            </div>
          }

          <!-- Best new sites (location-allocation over the road network) -->
          <details class="px__card">
            <summary style="cursor: pointer; font-weight: 600; font-size: 12.5px">Suggest best new charger sites</summary>
            @if (!roadLayers().length || !demandId()) {
              <p class="px__hint">Needs a routing road layer and a demand layer above.</p>
            } @else {
              <label class="px__field"><span class="px__label">Candidate sites (parking, fuel stations…)</span>
                <select class="px__native-select" [ngModel]="candidateId()" (ngModelChange)="candidateId.set($event)">
                  <option value="">Choose a layer…</option>
                  @for (l of siteLayers(); track l.id) { <option [value]="l.id">{{ l.name }}</option> }
                </select></label>
              <div class="px__row">
                <label class="px__field"><span class="px__label">Road network</span>
                  <select class="px__native-select" [ngModel]="roadId()" (ngModelChange)="roadId.set($event)">
                    @for (l of roadLayers(); track l.id) { <option [value]="l.id">{{ l.name }}</option> }
                  </select></label>
                <label class="px__field"><span class="px__label">New sites</span>
                  <input class="px__input" type="number" min="1" max="50" [ngModel]="count()" (ngModelChange)="count.set(+$event)" /></label>
              </div>
              <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-bolt" label="Find best sites" [loading]="siting()"
                      [disabled]="!candidateId()" (click)="suggest()"></button>
              @if (sites(); as s) {
                <span class="px__item-sub">Demand within {{ radiusKm() }} km by road: {{ pct(s.stats.coveredWeight ?? 0, s.stats.totalWeight) }}</span>
                <div class="px__list">
                  @for (f of newSites(); track $index) {
                    <div class="px__item px__item--click" (click)="zoom(f.point)">
                      <i class="pi pi-bolt" style="color: #7c3aed"></i>
                      <div class="px__item-main"><span class="px__item-title" [title]="f.label">{{ f.label }}</span>
                        <span class="px__item-sub">serves {{ f.weight }}</span></div>
                    </div>
                  }
                </div>
              }
            }
          </details>
        }
      }
    </div>
  `
})
export class EvChargingComponent {
  private readonly http = inject(HttpClient);
  private readonly map = inject(MapService);
  private readonly layersApi = inject(GisLayersService);
  private readonly network = inject(NetworkService);

  @Input() set layers(value: GisLayer[] | null) {
    this.layersSignal.set(value ?? []);
    if (!this.chargerId() && this.pointLayers().length) {
      this.chargerId.set((this.pointLayers().find((l) => /charg|ev\b|electric/i.test(l.name)) ?? this.pointLayers()[0]).id);
    }
    if (!this.roadId() && this.roadLayers().length) this.roadId.set(this.roadLayers()[0].id);
  }
  private readonly layersSignal = signal<GisLayer[]>([]);
  readonly pointLayers = computed(() => this.layersSignal().filter((l) => l.layerType === 'VECTOR' && l.geometryType === 'POINT'));
  readonly siteLayers = computed(() =>
    this.layersSignal().filter((l) => l.layerType === 'VECTOR' && (l.geometryType === 'POINT' || l.geometryType === 'POLYGON'))
  );
  readonly roadLayers = computed(() => this.layersSignal().filter((l) => l.layerType === 'VECTOR' && l.geometryType === 'LINE' && l.routingEnabled));

  readonly legend: { key: CellStatus; label: string; color: string }[] = [
    { key: 'served', label: 'Has charger', color: STATUS_COLORS.served },
    { key: 'near', label: 'Charger in reach', color: STATUS_COLORS.near },
    { key: 'gap', label: 'Gap', color: STATUS_COLORS.gap },
    { key: 'empty', label: 'No demand', color: '#9ca3af' }
  ];

  readonly chargerId = signal('');
  readonly demandId = signal('');
  readonly demandFields = signal<AnalyticsField[]>([]);
  readonly numericFields = computed(() => this.demandFields().filter((f) => f.kind === 'number'));
  readonly weightField = signal('');
  readonly cellKm = signal(3);
  readonly radiusKm = signal(3);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<Coverage | null>(null);

  readonly candidateId = signal('');
  readonly roadId = signal('');
  readonly count = signal(5);
  readonly siting = signal(false);
  readonly sites = signal<SiteSelectionResult | null>(null);
  readonly newSites = computed(() => (this.sites()?.facilities ?? []).filter((f) => f.kind === 'new'));

  constructor() {
    inject(DestroyRef).onDestroy(() => this.map.setFilledAreas(null));
  }

  countOf = (s: CellStatus) => this.result()?.cells.filter((c) => c.status === s).length ?? 0;
  pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 1000) / 10} %` : '—');

  pickDemand(id: string): void {
    this.demandId.set(id);
    this.weightField.set('');
    this.demandFields.set([]);
    if (id) this.layersApi.analyticsFields(id).subscribe((f) => this.demandFields.set(f));
  }

  run(): void {
    const extent = this.map.currentExtent4326();
    if (!extent) return;
    this.busy.set(true);
    this.error.set(null);
    this.sites.set(null);
    this.http
      .post<Coverage>(`${environment.apiUrl}/gis/ev/coverage`, {
        chargerLayerId: this.chargerId(),
        ...(this.demandId() ? { demandLayerId: this.demandId() } : {}),
        ...(this.demandId() && this.weightField() ? { demandWeightField: this.weightField() } : {}),
        cellKm: this.cellKm(),
        serviceRadiusKm: this.radiusKm(),
        bbox: extent.map((n) => Math.round(n * 1e6) / 1e6)
      })
      .subscribe({
        next: (r) => {
          this.result.set(r);
          this.busy.set(false);
          this.draw();
        },
        error: (e) => {
          this.busy.set(false);
          const m = e?.error?.message;
          this.error.set(Array.isArray(m) ? m.join(', ') : m ?? 'The coverage check failed.');
        }
      });
  }

  private draw(): void {
    const r = this.result();
    if (!r) return;
    const maxGap = Math.max(1, ...r.cells.filter((c) => c.status === 'gap').map((c) => c.demand));
    const items: { geometry: Record<string, unknown>; color: string; fill?: number; stroke?: string; radius?: number }[] = r.cells
      .filter((c) => c.status !== 'empty')
      .map((c) => ({
        geometry: c.geometry,
        color: STATUS_COLORS[c.status],
        fill: c.status === 'gap' ? (this.demandId() ? 0.15 + (c.demand / maxGap) * 0.5 : 0.3) : 0.3
      }));
    for (const f of this.newSites()) items.push({ geometry: { type: 'Point', coordinates: f.point }, color: '#7c3aed', radius: 8 });
    this.map.setFilledAreas(items);
  }

  zoom(point: [number, number]): void {
    this.map.zoomToGeometries([{ type: 'Point', coordinates: point }]);
  }

  suggest(): void {
    this.siting.set(true);
    this.network
      .siteSelection(this.roadId(), {
        demandLayerId: this.demandId(),
        ...(this.weightField() ? { weightField: this.weightField() } : {}),
        candidateLayerId: this.candidateId(),
        existingLayerId: this.chargerId(),
        count: this.count(),
        objective: 'MAX_COVERAGE',
        cutoffM: this.radiusKm() * 1000
      })
      .subscribe({
        next: (s) => {
          this.sites.set(s);
          this.siting.set(false);
          this.draw();
        },
        error: (e) => {
          this.siting.set(false);
          const m = e?.error?.message;
          this.error.set(Array.isArray(m) ? m.join(', ') : m ?? 'Site suggestion failed.');
        }
      });
  }
}
