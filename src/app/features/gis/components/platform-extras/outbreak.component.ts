import { Component, DestroyRef, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { environment } from '../../../../../environments/environment';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { AnalyticsField } from '../../../../core/models/layer-analytics.model';
import { GisLayersService } from '../../../../core/services/gis-layers.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { MapService } from '../../services/map.service';

interface Cluster {
  rank: number;
  cases: number;
  recentCases: number;
  active: boolean;
  firstCase: string;
  lastCase: string;
  center: [number, number];
  hull: Record<string, unknown>;
  zone: Record<string, unknown>;
}

interface OutbreakResult {
  period: { from: string; to: string };
  totalCases: number;
  weekly: { week: string; cases: number }[];
  clusters: Cluster[];
  casesInClusters: number;
  points: [number, number, string][];
  breakdown: { value: string; cases: number }[];
  areas: { layerName: string; rows: { label: string; cases: number; population: number | null; per10k: number | null; geometry: Record<string, unknown> }[] } | null;
  savedLayer: GisLayer | null;
  settings: { clusterDistanceM: number; minCases: number; zoneBufferM: number };
}

/** Disease outbreaks: cases over time, hotspots (clusters), fogging /
 *  spraying zones around them and cases per ward. */
@Component({
  selector: 'app-outbreak',
  standalone: true,
  imports: [FormsModule, ButtonModule, DatePipe],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      <p class="px__intro">Map dengue, malaria or any reported cases: weekly trend, hotspots and the area to fog or spray around each one.</p>
      @if (!pointLayers().length) {
        <p class="px__hint">No point layer of cases. Upload cases with a location and a date first.</p>
      } @else {
        <label class="px__field"><span class="px__label">Case layer</span>
          <select class="px__native-select" [ngModel]="layerId()" (ngModelChange)="pickLayer($event)">
            @for (l of pointLayers(); track l.id) { <option [value]="l.id">{{ l.name }}</option> }
          </select></label>
        <div class="px__row">
          <label class="px__field"><span class="px__label">Date field</span>
            <select class="px__native-select" [ngModel]="dateField()" (ngModelChange)="dateField.set($event)">
              @for (f of dateFields(); track f.name) { <option [value]="f.name">{{ f.name }}</option> }
              @empty { <option value="">No date field</option> }
            </select></label>
          <label class="px__field"><span class="px__label">Disease field</span>
            <select class="px__native-select" [ngModel]="diseaseField()" (ngModelChange)="diseaseField.set($event)">
              <option value="">— (all cases)</option>
              @for (f of textFields(); track f.name) { <option [value]="f.name">{{ f.name }}</option> }
            </select></label>
        </div>
        @if (diseaseField()) {
          <label class="px__field"><span class="px__label">Only these values (comma separated, optional)</span>
            <input class="px__input" [ngModel]="diseaseValues()" (ngModelChange)="diseaseValues.set($event)" placeholder="Dengue, Malaria" /></label>
        }
        <div class="px__row">
          <label class="px__field"><span class="px__label">From</span>
            <input class="px__input" type="date" [ngModel]="from()" (ngModelChange)="from.set($event)" /></label>
          <label class="px__field"><span class="px__label">To</span>
            <input class="px__input" type="date" [ngModel]="to()" (ngModelChange)="to.set($event)" /></label>
        </div>
        <span class="px__item-sub">Empty dates = the 90 days up to the latest case.</span>

        <details class="px__card">
          <summary style="cursor: pointer; font-weight: 600; font-size: 12.5px">Hotspot settings</summary>
          <div class="px__row">
            <label class="px__field"><span class="px__label">Cases within (m)</span>
              <input class="px__input" type="number" min="20" max="5000" [ngModel]="distance()" (ngModelChange)="distance.set(+$event)" /></label>
            <label class="px__field"><span class="px__label">Min. cases</span>
              <input class="px__input" type="number" min="2" max="100" [ngModel]="minCases()" (ngModelChange)="minCases.set(+$event)" /></label>
          </div>
          <label class="px__field"><span class="px__label">Control zone around hotspot (m)</span>
            <input class="px__input" type="number" min="0" max="5000" [ngModel]="buffer()" (ngModelChange)="buffer.set(+$event)" /></label>
          <p class="px__hint">Default 400 m ≈ the flight range of the Aedes (dengue) mosquito.</p>
        </details>

        <label class="px__field"><span class="px__label">Count per area (optional)</span>
          <select class="px__native-select" [ngModel]="areaId()" (ngModelChange)="pickArea($event)">
            <option value="">— none</option>
            @for (l of polygonLayers(); track l.id) { <option [value]="l.id">{{ l.name }}</option> }
          </select></label>
        @if (areaId()) {
          <label class="px__field"><span class="px__label">Population field (for rate per 10,000)</span>
            <select class="px__native-select" [ngModel]="popField()" (ngModelChange)="popField.set($event)">
              <option value="">— none</option>
              @for (f of areaNumeric(); track f.name) { <option [value]="f.name">{{ f.name }}</option> }
            </select></label>
        }

        <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-search" label="Find hotspots" [loading]="busy()"
                [disabled]="!dateField()" (click)="run()"></button>
        @if (error(); as e) { <p class="px__error" role="alert">{{ e }}</p> }

        @if (result(); as r) {
          <div class="px__card">
            <dl class="px__kv">
              <dt>Period</dt><dd>{{ r.period.from | date: 'd MMM' }} – {{ r.period.to | date: 'd MMM y' }}</dd>
              <dt>Cases</dt><dd>{{ r.totalCases }}</dd>
              <dt>Hotspots</dt><dd>{{ r.clusters.length }} ({{ activeCount() }} active)</dd>
              <dt>Cases in hotspots</dt><dd>{{ pct(r.casesInClusters, r.totalCases) }}</dd>
              <dt>Trend</dt><dd [style.color]="trend().color">{{ trend().text }}</dd>
            </dl>
          </div>

          <div class="px__section">
            <h4>Cases per week</h4>
            <div style="display: flex; align-items: flex-end; gap: 2px; height: 64px; border-bottom: 1px solid var(--color-line)" role="img" aria-label="Cases per week">
              @for (w of r.weekly; track w.week) {
                <div style="flex: 1; background: #dc2626; border-radius: 2px 2px 0 0; min-height: 1px" [style.height.%]="weekHeight(w.cases)" [title]="(w.week | date: 'd MMM') + ': ' + w.cases + ' cases'"></div>
              }
            </div>
          </div>

          @if (r.breakdown.length > 1) {
            <dl class="px__kv">
              @for (b of r.breakdown; track b.value) { <dt>{{ b.value }}</dt><dd>{{ b.cases }}</dd> }
            </dl>
          }

          <div class="px__section">
            <h4>Hotspots</h4>
            <div class="px__list">
              @for (c of r.clusters; track c.rank) {
                <div class="px__item px__item--click" (click)="zoomTo(c)">
                  <span class="px__badge" [style.background]="c.active ? '#dc2626' : '#f59e0b'" style="color: #fff; border: 0">{{ c.active ? 'ACTIVE' : 'quiet' }}</span>
                  <div class="px__item-main">
                    <span class="px__item-title">Hotspot {{ c.rank }} · {{ c.cases }} cases</span>
                    <span class="px__item-sub">{{ c.recentCases }} in last 14 days · {{ c.firstCase | date: 'd MMM' }} – {{ c.lastCase | date: 'd MMM' }}</span>
                  </div>
                </div>
              } @empty {
                <p class="px__hint px__hint--center">No hotspots — cases are scattered. Try a larger distance or fewer minimum cases.</p>
              }
            </div>
          </div>

          @if (r.areas; as a) {
            <div class="px__section">
              <h4>By {{ a.layerName }}</h4>
              <div class="px__list">
                @for (row of a.rows.slice(0, 50); track $index) {
                  <div class="px__item">
                    <div class="px__item-main"><span class="px__item-title">{{ row.label }}</span></div>
                    <span class="px__mono">{{ row.cases }}@if (row.per10k !== null) { · {{ row.per10k }}/10k }</span>
                  </div>
                }
              </div>
            </div>
          }

          @if (r.clusters.length) {
            <div class="px__card">
              <label class="px__field"><span class="px__label">Save control zones as a layer</span>
                <input class="px__input" maxlength="120" [ngModel]="zoneName()" (ngModelChange)="zoneName.set($event)" placeholder="Fogging zones {{ r.period.to }}" /></label>
              <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-save" label="Save zones" [loading]="saving()" (click)="saveZones()"></button>
            </div>
            <button pButton type="button" class="p-button-sm p-button-outlined px__btn-block" icon="pi pi-download" label="Download hotspots (CSV)" (click)="csv()"></button>
          }
          <p class="px__hint"><span style="color: #dc2626">●</span> case in last 14 days · <span style="color: #9ca3af">●</span> older · red ring = control zone</p>
        }
      }
    </div>
  `
})
export class OutbreakComponent {
  private readonly http = inject(HttpClient);
  private readonly map = inject(MapService);
  private readonly layersApi = inject(GisLayersService);
  private readonly notify = inject(NotificationService);

  @Output() readonly layerCreated = new EventEmitter<GisLayer>();

  @Input() set layers(value: GisLayer[] | null) {
    this.layersSignal.set(value ?? []);
    if (!this.layerId() && this.pointLayers().length) {
      const guess = this.pointLayers().find((l) => /case|dengue|malaria|disease|patient|outbreak/i.test(l.name)) ?? this.pointLayers()[0];
      this.pickLayer(guess.id);
    }
  }
  private readonly layersSignal = signal<GisLayer[]>([]);
  readonly pointLayers = computed(() => this.layersSignal().filter((l) => l.layerType === 'VECTOR' && l.geometryType === 'POINT'));
  readonly polygonLayers = computed(() => this.layersSignal().filter((l) => l.layerType === 'VECTOR' && l.geometryType === 'POLYGON'));

  readonly layerId = signal('');
  readonly fields = signal<AnalyticsField[]>([]);
  readonly dateFields = computed(() => {
    const f = this.fields();
    return [...f.filter((x) => x.kind === 'date'), ...f.filter((x) => x.kind === 'string' && /date|day|time|report|onset/i.test(x.name))];
  });
  readonly textFields = computed(() => this.fields().filter((x) => x.kind === 'string'));
  readonly dateField = signal('');
  readonly diseaseField = signal('');
  readonly diseaseValues = signal('');
  readonly from = signal('');
  readonly to = signal('');
  readonly distance = signal(200);
  readonly minCases = signal(3);
  readonly buffer = signal(400);
  readonly areaId = signal('');
  readonly areaFields = signal<AnalyticsField[]>([]);
  readonly areaNumeric = computed(() => this.areaFields().filter((x) => x.kind === 'number'));
  readonly popField = signal('');
  readonly busy = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<OutbreakResult | null>(null);
  readonly zoneName = signal('');

  readonly activeCount = computed(() => this.result()?.clusters.filter((c) => c.active).length ?? 0);
  readonly trend = computed(() => {
    const w = this.result()?.weekly ?? [];
    if (w.length < 4) return { text: 'Too few weeks', color: 'inherit' };
    const last2 = w.slice(-2).reduce((s, x) => s + x.cases, 0);
    const prev2 = w.slice(-4, -2).reduce((s, x) => s + x.cases, 0);
    if (prev2 === 0) return last2 > 0 ? { text: 'New cases appearing', color: '#dc2626' } : { text: 'No recent cases', color: '#16a34a' };
    const change = Math.round(((last2 - prev2) / prev2) * 100);
    return change >= 25
      ? { text: `Rising (+${change} % in 2 weeks)`, color: '#dc2626' }
      : change <= -25
        ? { text: `Falling (${change} % in 2 weeks)`, color: '#16a34a' }
        : { text: `Steady (${change >= 0 ? '+' : ''}${change} %)`, color: '#ca8a04' };
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.map.setFilledAreas(null));
  }

  pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : '—');
  weekHeight = (n: number) => {
    const max = Math.max(1, ...(this.result()?.weekly ?? []).map((w) => w.cases));
    return Math.max(2, (n / max) * 100);
  };

  pickLayer(id: string): void {
    this.layerId.set(id);
    this.fields.set([]);
    this.layersApi.analyticsFields(id).subscribe((f) => {
      this.fields.set(f);
      this.dateField.set(this.dateFields()[0]?.name ?? '');
      this.diseaseField.set(f.find((x) => x.kind === 'string' && /disease|diagnos|illness|type/i.test(x.name))?.name ?? '');
    });
  }

  pickArea(id: string): void {
    this.areaId.set(id);
    this.popField.set('');
    this.areaFields.set([]);
    if (id)
      this.layersApi.analyticsFields(id).subscribe((f) => {
        this.areaFields.set(f);
        this.popField.set(f.find((x) => x.kind === 'number' && /pop|people|persons|total_?p/i.test(x.name))?.name ?? '');
      });
  }

  private body(saveAs?: string) {
    const values = this.diseaseValues().split(',').map((v) => v.trim()).filter(Boolean);
    return {
      layerId: this.layerId(),
      dateField: this.dateField(),
      ...(this.diseaseField() ? { diseaseField: this.diseaseField() } : {}),
      ...(this.diseaseField() && values.length ? { diseaseValues: values } : {}),
      ...(this.from() ? { from: this.from() } : {}),
      ...(this.to() ? { to: this.to() } : {}),
      clusterDistanceM: this.distance(),
      minCases: this.minCases(),
      zoneBufferM: this.buffer(),
      ...(this.areaId() ? { areaLayerId: this.areaId() } : {}),
      ...(this.areaId() && this.popField() ? { areaPopulationField: this.popField() } : {}),
      ...(saveAs ? { saveZonesAs: saveAs } : {})
    };
  }

  run(): void {
    this.busy.set(true);
    this.error.set(null);
    this.http.post<OutbreakResult>(`${environment.apiUrl}/gis/outbreak/analyze`, this.body()).subscribe({
      next: (r) => {
        this.result.set(r);
        this.busy.set(false);
        this.draw(r);
      },
      error: (e) => {
        this.busy.set(false);
        const m = e?.error?.message;
        this.error.set(Array.isArray(m) ? m.join(', ') : m ?? 'The analysis failed.');
      }
    });
  }

  private draw(r: OutbreakResult): void {
    const cutoff = new Date(Date.parse(r.period.to) - 14 * 86_400_000).toISOString().slice(0, 10);
    const recent = r.points.filter((p) => p[2] > cutoff).map((p) => [p[0], p[1]]);
    const older = r.points.filter((p) => p[2] <= cutoff).map((p) => [p[0], p[1]]);
    const items: { geometry: Record<string, unknown>; color: string; fill?: number; stroke?: string; radius?: number }[] = [];
    if (r.areas) {
      const max = Math.max(1, ...r.areas.rows.map((a) => a.per10k ?? a.cases));
      for (const a of r.areas.rows) {
        const v = (a.per10k ?? a.cases) / max;
        if (v > 0) items.push({ geometry: a.geometry, color: '#f97316', fill: 0.08 + v * 0.45, stroke: '#ffffff' });
      }
    }
    for (const c of r.clusters) {
      items.push({ geometry: c.zone, color: c.active ? '#dc2626' : '#f59e0b', fill: 0.12, stroke: c.active ? '#dc2626' : '#f59e0b' });
    }
    if (older.length) items.push({ geometry: { type: 'MultiPoint', coordinates: older }, color: '#9ca3af', radius: 3.5 });
    if (recent.length) items.push({ geometry: { type: 'MultiPoint', coordinates: recent }, color: '#dc2626', radius: 4.5 });
    this.map.setFilledAreas(items);
    const frame = r.clusters.length ? r.clusters.map((c) => c.zone) : [{ type: 'MultiPoint', coordinates: r.points.map((p) => [p[0], p[1]]) }];
    this.map.zoomToGeometries(frame);
  }

  zoomTo(c: Cluster): void {
    this.map.zoomToGeometries([c.zone]);
  }

  saveZones(): void {
    const name = this.zoneName().trim() || `Fogging zones ${this.result()?.period.to ?? ''}`;
    this.saving.set(true);
    this.http.post<OutbreakResult>(`${environment.apiUrl}/gis/outbreak/analyze`, this.body(name)).subscribe({
      next: (r) => {
        this.saving.set(false);
        this.result.set(r);
        if (r.savedLayer) {
          this.layerCreated.emit(r.savedLayer);
          this.notify.success(`Control zones saved as “${name}”.`);
        }
      },
      error: (e) => {
        this.saving.set(false);
        const m = e?.error?.message;
        this.notify.error(Array.isArray(m) ? m.join(', ') : m ?? 'Could not save the zones.');
      }
    });
  }

  csv(): void {
    const r = this.result();
    if (!r) return;
    const rows = [
      ['hotspot', 'cases', 'cases_last_14_days', 'active', 'first_case', 'last_case', 'longitude', 'latitude'],
      ...r.clusters.map((c) => [String(c.rank), String(c.cases), String(c.recentCases), c.active ? 'yes' : 'no', c.firstCase, c.lastCase, String(c.center[0]), String(c.center[1])])
    ];
    const url = URL.createObjectURL(new Blob([rows.map((x) => x.join(',')).join('\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `outbreak-hotspots-${r.period.to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
