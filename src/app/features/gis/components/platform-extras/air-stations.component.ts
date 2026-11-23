import { Component, DestroyRef, Input, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { Subscription } from 'rxjs';
import { environment } from '../../../../../environments/environment';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { MapService } from '../../services/map.service';

type Pollutant = 'pm25' | 'pm10' | 'no2' | 'o3' | 'so2' | 'co';
type Measure = Pollutant | 'aqi';
type Tab = 'stations' | 'point' | 'cities' | 'exposure';
type LonLat = [number, number];

interface Station {
  id: string;
  name: string;
  source: 'cpcb' | 'openaq' | 'sensor.community';
  kind: 'reference' | 'low-cost';
  point: LonLat;
  updated: string | null;
  readings: Partial<Record<Pollutant, number>>;
  units: Partial<Record<Pollutant, string>>;
  aqi?: number;
  subIndex?: Partial<Record<Pollutant, number>>;
  range?: Partial<Record<Pollutant, [number, number]>>;
  predominant?: string;
  city?: string;
}

interface HistoryPoint {
  t: string;
  aqi: number | null;
  pm25: number | null;
  pm10: number | null;
}

interface CityRow {
  city: string;
  aqi: number;
  worst: number;
  stations: Station[];
  point: LonLat;
}

interface Exposure {
  layerName: string;
  areas: { id: string; count: number; features: { id: number; label: string; distanceKm: number }[] }[];
}

const LABEL: Record<Pollutant, string> = { pm25: 'PM2.5', pm10: 'PM10', no2: 'NO₂', o3: 'O₃', so2: 'SO₂', co: 'CO' };

/** India NAQI concentration breakpoints (upper bound of each band), µg/m³ — CO in mg/m³. */
const BANDS: Record<Pollutant, number[]> = {
  pm25: [30, 60, 90, 120, 250],
  pm10: [50, 100, 250, 350, 430],
  no2: [40, 80, 180, 280, 400],
  o3: [50, 100, 168, 208, 748],
  so2: [40, 80, 380, 800, 1600],
  co: [1, 2, 10, 17, 34]
};
/** India AQI / sub-index band upper bounds. */
const INDEX_BANDS = [50, 100, 200, 300, 400];

/** CPCB health statements for each AQI band. */
const CATS = [
  { name: 'Good', color: '#16a34a', advice: 'Minimal impact. A good day to be active outside.' },
  { name: 'Satisfactory', color: '#84cc16', advice: 'Minor breathing discomfort for sensitive people.' },
  { name: 'Moderate', color: '#eab308', advice: 'Breathing discomfort for people with lung or heart disease, children and older adults. Sensitive groups should cut long outdoor exertion.' },
  { name: 'Poor', color: '#f97316', advice: 'Breathing discomfort for most people on long exposure. Avoid long outdoor activity; sensitive groups stay indoors.' },
  { name: 'Very poor', color: '#dc2626', advice: 'Respiratory illness on long exposure. Avoid outdoor activity; wear an N95 mask outside; consider school sports and construction curbs.' },
  { name: 'Severe', color: '#7f1d1d', advice: 'Affects healthy people and seriously affects those with disease. Stay indoors, run air purifiers, trigger GRAP emergency measures.' }
];

const band = (v: number, bands: number[]) => {
  const i = bands.findIndex((max) => v <= max);
  return CATS[i === -1 ? CATS.length - 1 : i];
};

function km(a: LonLat, b: LonLat): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b[1] - a[1]) * r) / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Live air quality: CPCB official stations with the India AQI (free, no
 *  key), Sensor.Community citizen sensors and — with a server key —
 *  OpenAQ. Health advice, AQI at any point (IDW), an AQI surface, an
 *  all-India city ranking, captured trends and asset exposure. */
@Component({
  selector: 'app-air-stations',
  standalone: true,
  imports: [FormsModule, ButtonModule, DatePipe, NgTemplateOutlet],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      <div class="px__tabs" style="grid-template-columns: repeat(4, 1fr)" role="tablist">
        @for (t of tabs; track t.id) {
          <button type="button" role="tab" class="px__tab" [class.is-active]="tab() === t.id" [title]="t.title" (click)="openTab(t.id)">{{ t.label }}</button>
        }
      </div>

      @if (error(); as message) { <p class="px__error" role="alert">{{ message }}</p> }

      <!-- ===== Stations ===== -->
      @if (tab() === 'stations') {
        <p class="px__intro">Live readings from monitors around the map centre, coloured by the India AQI band.</p>

        <div class="px__row" style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px">
          <label class="px__field" style="min-width: 0"><span class="px__label">Within</span>
            <select class="px__native-select" style="width: 100%" [ngModel]="radiusKm()" (ngModelChange)="radiusKm.set(+$event)">
              @for (r of [10, 25, 50, 100, 200]; track r) { <option [value]="r">{{ r }} km</option> }
            </select>
          </label>
          <label class="px__field" style="min-width: 0"><span class="px__label">Colour by</span>
            <select class="px__native-select" style="width: 100%" [ngModel]="measure()" (ngModelChange)="measure.set($event); draw()">
              @for (p of measures; track p) { <option [value]="p">{{ label(p) }}</option> }
            </select>
          </label>
        </div>

        <div class="px__checks">
          <label class="px__check"><input type="checkbox" [ngModel]="surface()" (ngModelChange)="surface.set($event); draw()" /> Show estimated AQI surface</label>
          <label class="px__check"><input type="checkbox" [ngModel]="autoRefresh()" (ngModelChange)="setAutoRefresh($event)" /> Refresh every 15 min</label>
        </div>

        <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-refresh" label="Load stations" [loading]="busy()" (click)="load()"></button>

        @if (loaded() && !stations().length) {
          <p class="px__hint">No monitoring station within {{ radiusKm() }} km of the map centre — try a bigger radius or move the map to a city.</p>
        }

        @if (loaded() && shown().length) {
          @if (overall(); as o) {
            <div class="px__card" [style.border-left]="'4px solid ' + o.cat.color">
              <span class="px__label">Area {{ label(measure()) }} — average of {{ shown().length }} station{{ shown().length === 1 ? '' : 's' }}</span>
              <span class="px__item-title"><span [style.color]="o.cat.color">{{ o.value }}</span> {{ unitOf(measure()) }} · {{ o.cat.name }}</span>
              <span class="px__item-sub" style="white-space: normal">{{ o.cat.advice }}</span>
            </div>
          }
          <dl class="px__kv">
            @for (c of breakdown(); track c.name) {
              <dt><span [style.color]="c.color">●</span> {{ c.name }}</dt><dd>{{ c.count }}</dd>
            }
          </dl>
        }

        @if (loaded()) {
          <div class="px__list" style="margin-top: 8px">
            @for (s of shown(); track s.id) {
              <div class="px__item" style="cursor: pointer; align-items: flex-start" (click)="select(s)">
                <span [style.color]="colorOf(s)" aria-hidden="true">●</span>
                <div class="px__item-main">
                  <span class="px__item-title" style="white-space: normal">{{ s.name }}</span>
                  <span class="px__item-sub">
                    <b>{{ valueOf(s) }}</b> {{ unitFor(s) }} · {{ catOf(s)?.name ?? 'n/a' }}
                    · {{ s.kind === 'reference' ? 'official' : 'citizen' }}@if (s.updated) { · {{ s.updated | date: 'd MMM, HH:mm' }} }
                  </span>
                  @if (selected()?.id === s.id) {
                    <div (click)="$event.stopPropagation()" style="cursor: default">
                      @if (s.aqi !== undefined) {
                        <p class="px__hint" style="margin: 4px 0">{{ catOfIndex(s.aqi).advice }}</p>
                      }
                      <dl class="px__kv" style="margin-top: 4px">
                        @if (s.aqi !== undefined) { <dt>AQI</dt><dd>{{ s.aqi }}@if (s.predominant) { · {{ s.predominant }} }</dd> }
                        @for (p of pollutants; track p) {
                          @if (s.readings[p] !== undefined) {
                            <dt>{{ label(p) }}</dt>
                            <dd>
                              {{ s.readings[p] }} {{ s.units[p] }}
                              @if (s.range?.[p]; as r) { <span class="px__item-sub"> ({{ r[0] }}–{{ r[1] }})</span> }
                              @if (s.subIndex?.[p] !== undefined) { <span class="px__item-sub"> · index {{ s.subIndex?.[p] }}</span> }
                            </dd>
                          }
                        }
                        @if (s.city) { <dt>City</dt><dd>{{ s.city }}</dd> }
                        <dt>Source</dt><dd>{{ s.source === 'cpcb' ? 'CPCB (24 h avg, min–max)' : s.source === 'openaq' ? 'OpenAQ' : 'Sensor.Community' }}</dd>
                      </dl>
                      @if (s.source === 'cpcb') { <ng-container *ngTemplateOutlet="trend" /> }
                    </div>
                  }
                </div>
              </div>
            }
          </div>
        }
      }

      <!-- ===== AQI at a point ===== -->
      @if (tab() === 'point') {
        <p class="px__intro">Estimated AQI anywhere — weighted by distance from the nearest official stations (within 50 km) — with health advice.</p>
        <button pButton type="button" class="p-button-sm px__btn-block" [icon]="picking() ? 'pi pi-times' : 'pi pi-map-marker'"
                [label]="picking() ? 'Cancel — click the map' : 'Pick a point on the map'" [class.p-button-outlined]="picking()"
                [loading]="busy()" (click)="picking() ? cancelPick() : pickPoint()"></button>

        @if (pointResult(); as r) {
          @if (r.aqi === null) {
            <p class="px__hint">No official station within 50 km of this point.</p>
          } @else {
            <div class="px__card" [style.border-left]="'4px solid ' + catOfIndex(r.aqi).color">
              <span class="px__label">Estimated AQI</span>
              <span class="px__item-title"><span [style.color]="catOfIndex(r.aqi).color">{{ r.aqi }}</span> · {{ catOfIndex(r.aqi).name }}</span>
              <span class="px__item-sub" style="white-space: normal">{{ catOfIndex(r.aqi).advice }}</span>
            </div>
            <div class="px__section">
              <h4>Nearest stations</h4>
              <dl class="px__kv">
                @for (n of r.near; track n.s.id) {
                  <dt><span [style.color]="catOfIndex(n.s.aqi!).color">●</span> {{ n.s.name }}</dt><dd>AQI {{ n.s.aqi }} · {{ n.d }} km</dd>
                }
              </dl>
            </div>
          }
        }
      }

      <!-- ===== Cities ===== -->
      @if (tab() === 'cities') {
        <p class="px__intro">All-India city ranking by average AQI across CPCB stations.@if (indiaAt(); as at) { Feed from {{ at | date: 'd MMM, HH:mm' }}. }</p>
        <div class="px__row" style="display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: end">
          <label class="px__field" style="min-width: 0"><span class="px__label">Search</span>
            <input class="px__input" style="width: 100%" placeholder="City…" [ngModel]="cityQuery()" (ngModelChange)="cityQuery.set($event)" />
          </label>
          <button pButton type="button" class="p-button-sm p-button-outlined" icon="pi pi-refresh" [loading]="busy()" (click)="loadIndia()"></button>
        </div>
        @if (cities().length) {
          <div class="px__seg" style="margin: 8px 0">
            <button type="button" class="px__seg-btn" [class.is-active]="cityOrder() === 'worst'" (click)="cityOrder.set('worst')">Most polluted</button>
            <button type="button" class="px__seg-btn" [class.is-active]="cityOrder() === 'best'" (click)="cityOrder.set('best')">Cleanest</button>
          </div>
          <div class="px__list">
            @for (c of visibleCities(); track c.city) {
              <div class="px__item" style="cursor: pointer; align-items: flex-start" (click)="selectCity(c)">
                <span class="px__badge" [style.background]="catOfIndex(c.aqi).color" style="color: #fff; min-width: 34px; text-align: center">{{ c.aqi }}</span>
                <div class="px__item-main">
                  <span class="px__item-title">{{ c.city }}</span>
                  <span class="px__item-sub">{{ catOfIndex(c.aqi).name }} · {{ c.stations.length }} station{{ c.stations.length === 1 ? '' : 's' }} · worst {{ c.worst }}</span>
                  @if (selectedCity() === c.city) {
                    <div (click)="$event.stopPropagation()" style="cursor: default">
                      <p class="px__hint" style="margin: 4px 0">{{ catOfIndex(c.aqi).advice }}</p>
                      <ng-container *ngTemplateOutlet="trend" />
                    </div>
                  }
                </div>
              </div>
            }
          </div>
        }
      }

      <!-- ===== Exposure ===== -->
      @if (tab() === 'exposure') {
        <p class="px__intro">Features of a layer (schools, hospitals, wards…) near stations at or above an AQI band — load stations first.</p>
        <div class="px__row" style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px">
          <label class="px__field" style="min-width: 0"><span class="px__label">AQI at least</span>
            <select class="px__native-select" style="width: 100%" [ngModel]="minBand()" (ngModelChange)="minBand.set(+$event)">
              @for (c of cats; track c.name; let i = $index) { @if (i >= 2) { <option [value]="i">{{ c.name }}</option> } }
            </select>
          </label>
          <label class="px__field" style="min-width: 0"><span class="px__label">Within</span>
            <select class="px__native-select" style="width: 100%" [ngModel]="exposureKm()" (ngModelChange)="exposureKm.set(+$event)">
              @for (r of [1, 2, 3, 5]; track r) { <option [value]="r">{{ r }} km</option> }
            </select>
          </label>
        </div>
        <label class="px__field"><span class="px__label">Layer</span>
          <select class="px__native-select" style="width: 100%" [ngModel]="layerId()" (ngModelChange)="layerId.set($event)">
            <option value="">Choose a layer…</option>
            @for (l of vectorLayers(); track l.id) { <option [value]="l.id">{{ l.name }}</option> }
          </select>
        </label>
        <p class="px__hint">{{ pollutedStations().length }} loaded station{{ pollutedStations().length === 1 ? '' : 's' }} at {{ cats[minBand()].name }} or worse.</p>
        <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-shield" label="Check exposure"
                [disabled]="!layerId() || !pollutedStations().length" [loading]="busy()" (click)="checkExposure()"></button>

        @if (exposure(); as ex) {
          <div class="px__card" style="margin-top: 8px">
            <span class="px__item-title"><b>{{ exposedTotal() }}</b> {{ ex.layerName }} feature{{ exposedTotal() === 1 ? '' : 's' }} exposed</span>
          </div>
          <div class="px__list">
            @for (a of ex.areas; track a.id) {
              @if (a.count) {
                <div class="px__card">
                  <span class="px__item-title" style="white-space: normal">{{ stationName(a.id) }}</span>
                  <span class="px__item-sub">{{ a.count }} within {{ exposureKm() }} km</span>
                  <dl class="px__kv" style="margin-top: 4px">
                    @for (f of a.features; track f.id) { <dt>{{ f.label }}</dt><dd>{{ f.distanceKm }} km</dd> }
                  </dl>
                </div>
              }
            }
          </div>
        }
      }

      <ng-template #trend>
        @if (historyBusy()) {
          <p class="px__hint">Loading trend…</p>
        } @else if (chart().line) {
          <span class="px__label" style="margin-top: 6px; display: block">AQI, last 7 days ({{ chart().min }}–{{ chart().max }})</span>
          <svg viewBox="0 0 300 90" style="width: 100%; height: 90px" role="img" aria-label="AQI trend">
            @for (b of chart().bands; track b.y) { <rect x="0" [attr.y]="b.y" width="300" [attr.height]="b.h" [attr.fill]="b.color" fill-opacity="0.10" /> }
            <polyline [attr.points]="chart().line" fill="none" stroke="#0f766e" stroke-width="1.6" />
          </svg>
        } @else {
          <p class="px__hint">Trend builds up as the server records readings every 30 min — check back later.</p>
        }
      </ng-template>
    </div>
  `
})
export class AirStationsComponent {
  /** Open one tab / tool, e.g. picked from the workspace tool search. */
  @Input() set openSub(value: { parent: string; sub: string } | null) {
    if (value?.parent === 'air-stations') this.openTab(value.sub as Tab);
  }

  private readonly http = inject(HttpClient);
  private readonly map = inject(MapService);
  private readonly api = `${environment.apiUrl}/gis/location/air-stations`;

  @Input() set layers(value: GisLayer[] | null) {
    this.layersSignal.set(value ?? []);
  }
  private readonly layersSignal = signal<GisLayer[]>([]);
  readonly vectorLayers = computed(() => this.layersSignal().filter((l) => l.layerType === 'VECTOR'));

  readonly tabs: { id: Tab; label: string; title: string }[] = [
    { id: 'stations', label: 'Stations', title: 'Live stations around the map centre' },
    { id: 'point', label: 'Point', title: 'Estimated AQI at any point' },
    { id: 'cities', label: 'Cities', title: 'All-India city ranking' },
    { id: 'exposure', label: 'Exposure', title: 'Features near polluted stations' }
  ];
  readonly cats = CATS;
  readonly pollutants: Pollutant[] = ['pm25', 'pm10', 'no2', 'o3', 'so2', 'co'];
  readonly measures: Measure[] = ['aqi', ...this.pollutants];

  readonly tab = signal<Tab>('stations');
  readonly radiusKm = signal(25);
  readonly measure = signal<Measure>('aqi');
  readonly surface = signal(false);
  readonly autoRefresh = signal(false);
  readonly busy = signal(false);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);
  readonly stations = signal<Station[]>([]);
  readonly selected = signal<Station | null>(null);

  readonly history = signal<HistoryPoint[]>([]);
  readonly historyBusy = signal(false);

  readonly picking = signal(false);
  readonly pointResult = signal<{ aqi: number | null; near: { s: Station; d: number }[] } | null>(null);

  readonly india = signal<Station[]>([]);
  readonly indiaAt = signal<string | null>(null);
  readonly cityQuery = signal('');
  readonly cityOrder = signal<'worst' | 'best'>('worst');
  readonly selectedCity = signal<string | null>(null);

  readonly minBand = signal(3);
  readonly exposureKm = signal(2);
  readonly layerId = signal('');
  readonly exposure = signal<Exposure | null>(null);

  private pickSub: Subscription | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  readonly shown = computed(() =>
    this.stations()
      .filter((s) => this.valueOf(s) !== undefined)
      .sort((a, b) => (this.valueOf(b) ?? 0) - (this.valueOf(a) ?? 0))
  );

  readonly overall = computed(() => {
    const list = this.shown();
    if (!list.length) return null;
    const value = Math.round((list.reduce((t, s) => t + (this.valueOf(s) ?? 0), 0) / list.length) * 10) / 10;
    const m = this.measure();
    const cat = m === 'aqi' ? band(value, INDEX_BANDS) : band(value, BANDS[m]);
    return { value, cat };
  });

  readonly breakdown = computed(() =>
    [...CATS, { name: 'Other unit', color: '#94a3b8', advice: '' }]
      .map((c) => ({ ...c, count: this.shown().filter((s) => (this.catOf(s)?.name ?? 'Other unit') === c.name).length }))
      .filter((c) => c.count)
  );

  readonly cities = computed<CityRow[]>(() => {
    const by = new Map<string, Station[]>();
    for (const s of this.india()) {
      if (s.aqi === undefined || !s.city) continue;
      by.set(s.city, [...(by.get(s.city) ?? []), s]);
    }
    return [...by.entries()].map(([city, list]) => ({
      city,
      stations: list,
      aqi: Math.round(list.reduce((t, s) => t + s.aqi!, 0) / list.length),
      worst: Math.max(...list.map((s) => s.aqi!)),
      point: [list.reduce((t, s) => t + s.point[0], 0) / list.length, list.reduce((t, s) => t + s.point[1], 0) / list.length] as LonLat
    }));
  });

  readonly visibleCities = computed(() => {
    const q = this.cityQuery().trim().toLowerCase();
    const dir = this.cityOrder() === 'worst' ? -1 : 1;
    return this.cities()
      .filter((c) => !q || c.city.toLowerCase().includes(q))
      .sort((a, b) => dir * (a.aqi - b.aqi))
      .slice(0, 150);
  });

  readonly pollutedStations = computed(() =>
    this.stations().filter((s) => s.aqi !== undefined && CATS.indexOf(this.catOfIndex(s.aqi)) >= this.minBand())
  );
  readonly exposedTotal = computed(() => (this.exposure()?.areas ?? []).reduce((t, a) => t + a.count, 0));

  readonly chart = computed(() => {
    const pts = this.history().filter((p) => p.aqi !== null);
    if (pts.length < 2) return { line: '', min: 0, max: 0, bands: [] as { y: number; h: number; color: string }[] };
    const t0 = Date.parse(pts[0].t);
    const t1 = Date.parse(pts[pts.length - 1].t);
    const values = pts.map((p) => p.aqi!);
    const top = Math.max(100, ...values) * 1.1;
    const y = (v: number) => 85 - (v / top) * 80;
    const line = pts.map((p) => `${(((Date.parse(p.t) - t0) / Math.max(1, t1 - t0)) * 296 + 2).toFixed(1)},${y(p.aqi!).toFixed(1)}`).join(' ');
    const edges = [0, ...INDEX_BANDS, 500];
    const bands = CATS.map((c, i) => {
      const lo = Math.min(edges[i], top);
      const hi = Math.min(edges[i + 1], top);
      return { y: y(hi), h: Math.max(0, y(lo) - y(hi)), color: c.color };
    }).filter((b) => b.h > 0);
    return { line, min: Math.min(...values), max: Math.max(...values), bands };
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.setAutoRefresh(false);
      this.cancelPick();
      this.map.setFilledAreas(null);
      this.map.markLocation(null);
    });
  }

  label = (p: Measure) => (p === 'aqi' ? 'AQI (India)' : LABEL[p]);
  unitOf = (p: Measure) => (p === 'aqi' ? '' : (this.shown()[0]?.units[p] ?? ''));
  valueOf = (s: Station) => (this.measure() === 'aqi' ? s.aqi : s.readings[this.measure() as Pollutant]);
  unitFor = (s: Station) => (this.measure() === 'aqi' ? '' : (s.units[this.measure() as Pollutant] ?? ''));
  catOfIndex = (v: number) => band(v, INDEX_BANDS);
  colorOf = (s: Station) => this.catOf(s)?.color ?? '#94a3b8';
  stationName = (id: string) => this.stations().find((s) => s.id === id)?.name ?? id;

  catOf(s: Station): (typeof CATS)[number] | null {
    const m = this.measure();
    if (m === 'aqi') return s.aqi === undefined ? null : band(s.aqi, INDEX_BANDS);
    if (s.subIndex?.[m] !== undefined) return band(s.subIndex[m]!, INDEX_BANDS);
    const v = s.readings[m];
    const unit = (s.units[m] ?? '').toLowerCase();
    const ok = m === 'co' ? unit.startsWith('mg') : unit.startsWith('µg') || unit.startsWith('ug');
    return v === undefined || !ok ? null : band(v, BANDS[m]);
  }

  openTab(t: Tab): void {
    this.tab.set(t);
    this.cancelPick();
    this.history.set([]);
    if (t === 'cities' && !this.india().length) void this.loadIndia();
    if (t === 'stations' || t === 'exposure') this.draw();
    if (t === 'point') this.drawPointStations();
    if (t === 'cities') this.drawCities();
  }

  load(quiet = false): void {
    const view = this.map.viewSnapshot();
    if (!view) return;
    const [lon, lat] = view.center;
    if (!quiet) this.busy.set(true);
    this.error.set(null);
    this.http.get<{ stations: Station[] }>(this.api, { params: { lon, lat, radiusKm: this.radiusKm() } }).subscribe({
      next: (r) => {
        this.stations.set(r.stations);
        const sel = this.selected();
        this.selected.set(sel ? (r.stations.find((s) => s.id === sel.id) ?? null) : null);
        this.exposure.set(null);
        this.loaded.set(true);
        this.busy.set(false);
        if (this.tab() === 'stations' || this.tab() === 'exposure') this.draw();
        if (!quiet && r.stations.length) this.map.zoomToGeometries([{ type: 'MultiPoint', coordinates: r.stations.map((s) => s.point) }]);
      },
      error: (e) => {
        this.error.set(e?.error?.message ?? 'Could not load air-quality stations.');
        this.busy.set(false);
      }
    });
  }

  setAutoRefresh(on: boolean): void {
    this.autoRefresh.set(on);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = on ? setInterval(() => this.loaded() && this.load(true), 15 * 60_000) : null;
  }

  select(s: Station): void {
    this.selected.set(this.selected()?.id === s.id ? null : s);
    this.draw();
    const sel = this.selected();
    if (!sel) return;
    this.map.zoomToGeometries([{ type: 'Point', coordinates: sel.point }]);
    if (sel.source === 'cpcb') this.loadHistory({ station: sel.name });
  }

  private loadHistory(params: { station: string } | { city: string }): void {
    this.history.set([]);
    this.historyBusy.set(true);
    this.http.get<{ points: HistoryPoint[] }>(`${this.api}/history`, { params: { ...params, days: 7 } }).subscribe({
      next: (r) => {
        this.history.set(r.points);
        this.historyBusy.set(false);
      },
      error: () => this.historyBusy.set(false)
    });
  }

  /** Station dots, plus an IDW-estimated AQI grid when "surface" is on. */
  draw(): void {
    const sel = this.selected();
    const dots = this.shown().map((s) => ({
      geometry: { type: 'Point', coordinates: s.point },
      color: this.colorOf(s),
      radius: sel?.id === s.id ? 10 : s.kind === 'reference' ? 8 : 6
    }));
    this.map.setFilledAreas([...(this.surface() ? this.surfaceCells() : []), ...dots]);
  }

  private surfaceCells(): { geometry: Record<string, unknown>; color: string; fill: number }[] {
    const m = this.measure();
    const useIndex = (s: Station) => m === 'aqi' || s.subIndex?.[m] !== undefined;
    const src = this.shown().filter((s) => this.catOf(s));
    // Mixing index values with raw concentrations makes no sense — use one kind.
    const indexed = src.filter(useIndex);
    const list = indexed.length >= 2 ? indexed : src.filter((s) => !useIndex(s));
    if (list.length < 2) return [];
    const isIndex = list === indexed;
    const raw = (s: Station) => (m === 'aqi' ? s.aqi! : isIndex ? s.subIndex![m]! : s.readings[m]!);
    const xs = list.map((s) => s.point[0]);
    const ys = list.map((s) => s.point[1]);
    const pad = 0.05;
    const [minX, maxX, minY, maxY] = [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...ys) - pad, Math.max(...ys) + pad];
    const n = 40;
    const dx = (maxX - minX) / n;
    const dy = (maxY - minY) / n;
    const cells: { geometry: Record<string, unknown>; color: string; fill: number }[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const c: LonLat = [minX + (i + 0.5) * dx, minY + (j + 0.5) * dy];
        let wsum = 0;
        let vsum = 0;
        let nearest = Infinity;
        for (const s of list) {
          const d = Math.max(0.2, km(c, s.point));
          nearest = Math.min(nearest, d);
          const w = 1 / (d * d);
          wsum += w;
          vsum += w * raw(s);
        }
        if (nearest > 15) continue;
        const v = vsum / wsum;
        const cat = isIndex ? band(v, INDEX_BANDS) : band(v, BANDS[m as Pollutant]);
        const [x0, y0] = [minX + i * dx, minY + j * dy];
        cells.push({
          geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x0 + dx, y0], [x0 + dx, y0 + dy], [x0, y0 + dy], [x0, y0]]] },
          color: cat.color,
          fill: 0.28
        });
      }
    }
    return cells;
  }

  // ----- AQI at a point -----

  pickPoint(): void {
    this.cancelPick();
    this.picking.set(true);
    this.pickSub = this.map.pickMapPoint().subscribe(({ lonLat }) => {
      this.picking.set(false);
      void this.estimateAt(lonLat as LonLat);
    });
  }

  cancelPick(): void {
    this.pickSub?.unsubscribe();
    this.pickSub = null;
    if (this.picking()) this.map.cancelMapPick();
    this.picking.set(false);
  }

  private async estimateAt(p: LonLat): Promise<void> {
    this.map.markLocation(p);
    if (!this.india().length) await this.fetchIndia();
    const near = this.india()
      .filter((s) => s.aqi !== undefined)
      .map((s) => ({ s, d: Math.round(km(p, s.point) * 10) / 10 }))
      .filter((n) => n.d <= 50)
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);
    let aqi: number | null = null;
    if (near.length) {
      const w = near.map((n) => 1 / Math.max(0.2, n.d) ** 2);
      aqi = Math.round(near.reduce((t, n, i) => t + w[i] * n.s.aqi!, 0) / w.reduce((a, b) => a + b, 0));
    }
    this.pointResult.set({ aqi, near });
    this.drawPointStations();
  }

  private drawPointStations(): void {
    const near = this.pointResult()?.near ?? [];
    this.map.setFilledAreas(near.map((n) => ({ geometry: { type: 'Point', coordinates: n.s.point }, color: this.catOfIndex(n.s.aqi!).color, radius: 7 })));
  }

  // ----- Cities -----

  private fetchIndia(): Promise<void> {
    this.busy.set(true);
    return new Promise((resolve) =>
      this.http.get<{ updatedAt: string | null; stations: Station[] }>(`${this.api}/india`).subscribe({
        next: (r) => {
          this.india.set(r.stations);
          this.indiaAt.set(r.updatedAt);
          this.busy.set(false);
          resolve();
        },
        error: (e) => {
          this.error.set(e?.error?.message ?? 'Could not load the CPCB feed.');
          this.busy.set(false);
          resolve();
        }
      })
    );
  }

  async loadIndia(): Promise<void> {
    await this.fetchIndia();
    if (this.tab() === 'cities') this.drawCities();
  }

  private drawCities(): void {
    this.map.setFilledAreas(
      this.cities().map((c) => ({
        geometry: { type: 'Point', coordinates: c.point },
        color: this.catOfIndex(c.aqi).color,
        radius: this.selectedCity() === c.city ? 10 : 6
      }))
    );
  }

  selectCity(c: CityRow): void {
    this.selectedCity.set(this.selectedCity() === c.city ? null : c.city);
    this.drawCities();
    if (this.selectedCity()) {
      this.map.zoomToGeometries([{ type: 'MultiPoint', coordinates: c.stations.map((s) => s.point) }]);
      this.loadHistory({ city: c.city });
    }
  }

  // ----- Exposure -----

  checkExposure(): void {
    const list = this.pollutedStations().slice(0, 50);
    this.busy.set(true);
    this.error.set(null);
    this.http
      .post<Exposure>(`${environment.apiUrl}/gis/hazards/exposure`, {
        layerId: this.layerId(),
        areas: list.map((s) => ({ id: s.id, geometry: { type: 'Point', coordinates: s.point }, bufferKm: this.exposureKm() }))
      })
      .subscribe({
        next: (r) => {
          r.areas.sort((a, b) => b.count - a.count);
          this.exposure.set(r);
          this.busy.set(false);
        },
        error: (e) => {
          this.error.set(e?.error?.message ?? 'Exposure check failed.');
          this.busy.set(false);
        }
      });
  }
}
