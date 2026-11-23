import { Input, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { Subscription } from 'rxjs';
import { MapService } from '../../services/map.service';

type Tab = 'forecast' | 'layers' | 'air' | 'river';
type LonLat = [number, number];

/** WMO weather codes (Open-Meteo): label + PrimeIcons icon. */
const WMO: Record<number, [string, string]> = {
  0: ['Clear sky', 'pi-sun'],
  1: ['Mainly clear', 'pi-sun'],
  2: ['Partly cloudy', 'pi-cloud'],
  3: ['Overcast', 'pi-cloud'],
  45: ['Fog', 'pi-cloud'],
  48: ['Rime fog', 'pi-cloud'],
  51: ['Light drizzle', 'pi-cloud'],
  53: ['Drizzle', 'pi-cloud'],
  55: ['Heavy drizzle', 'pi-cloud'],
  61: ['Light rain', 'pi-cloud'],
  63: ['Rain', 'pi-cloud'],
  65: ['Heavy rain', 'pi-cloud'],
  66: ['Freezing rain', 'pi-cloud'],
  67: ['Heavy freezing rain', 'pi-cloud'],
  71: ['Light snow', 'pi-cloud'],
  73: ['Snow', 'pi-cloud'],
  75: ['Heavy snow', 'pi-cloud'],
  80: ['Rain showers', 'pi-cloud'],
  81: ['Heavy showers', 'pi-cloud'],
  82: ['Violent showers', 'pi-cloud'],
  95: ['Thunderstorm', 'pi-bolt'],
  96: ['Thunderstorm, hail', 'pi-bolt'],
  99: ['Severe thunderstorm', 'pi-bolt']
};

interface Alert {
  level: 'yellow' | 'orange' | 'red';
  text: string;
}

interface Forecast {
  current: {
    temperature: number;
    feelsLike: number;
    humidity: number;
    precipitation: number;
    wind: number;
    gusts: number;
    direction: number;
    code: number;
    uv: number | null;
  };
  hourly: { time: string; temp: number; rain: number; prob: number | null }[];
  daily: { date: string; max: number; min: number; rain: number; prob: number | null; gusts: number; uv: number | null; code: number; sunrise: string; sunset: string }[];
  past: { date: string; rain: number }[];
  alerts: Alert[];
}

interface AirQuality {
  usAqi: number | null;
  pm25: number | null;
  pm10: number | null;
  no2: number | null;
  o3: number | null;
  so2: number | null;
  co: number | null;
  pm25Avg24: number | null;
  pm10Avg24: number | null;
  indianAqi: { value: number; category: string; color: string; driver: string } | null;
  hourly: { time: string; pm25: number }[];
}

interface River {
  days: { date: string; flow: number; forecast: boolean }[];
  mean: number;
  peak: number;
  peakDate: string;
  status: { text: string; color: string };
}

const SATELLITES = [
  { id: 'MODIS_Terra_CorrectedReflectance_TrueColor', label: 'MODIS Terra (morning)' },
  { id: 'VIIRS_SNPP_CorrectedReflectance_TrueColor', label: 'VIIRS (afternoon)' }
];

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const AIR_API = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const FLOOD_API = 'https://flood-api.open-meteo.com/v1/flood';

/** CPCB National AQI sub-index (India) from 24-h average concentration. */
function naqiSubIndex(c: number, breaks: number[]): number {
  const aqi = [0, 50, 100, 200, 300, 400, 500];
  for (let i = 0; i < breaks.length - 1; i++) {
    if (c <= breaks[i + 1]) return aqi[i] + ((c - breaks[i]) / (breaks[i + 1] - breaks[i])) * (aqi[i + 1] - aqi[i]);
  }
  return 500;
}
const NAQI_CATEGORIES: [number, string, string][] = [
  [50, 'Good', '#16a34a'],
  [100, 'Satisfactory', '#84cc16'],
  [200, 'Moderate', '#eab308'],
  [300, 'Poor', '#f97316'],
  [400, 'Very poor', '#dc2626'],
  [500, 'Severe', '#7f1d1d']
];

/** Weather & Environment: forecast + warnings, rain radar, satellite,
 *  air quality and river flow. All from free, keyless
 *  open data (Open-Meteo, RainViewer, NASA GIBS). */
@Component({
  selector: 'app-weather',
  standalone: true,
  imports: [FormsModule, ButtonModule, DatePipe, DecimalPipe],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      <div class="px__tabs" style="grid-template-columns: repeat(4, 1fr)" role="tablist">
        @for (t of tabs; track t.id) {
          <button type="button" role="tab" class="px__tab" [class.is-active]="tab() === t.id" [title]="t.title" (click)="openTab(t.id)">{{ t.label }}</button>
        }
      </div>

      @if (tab() !== 'layers') {
        <!-- Location for the point tabs -->
        <div class="px__card" style="flex-direction: row; align-items: center; gap: 8px">
          <i class="pi pi-map-marker" style="color: var(--color-primary-600)"></i>
          <div class="px__item-main">
            <span class="px__item-title">{{ placeLabel() }}</span>
            @if (place(); as p) { <span class="px__item-sub px__mono">{{ p[1].toFixed(4) }}, {{ p[0].toFixed(4) }}</span> }
          </div>
          <button type="button" class="px__icon-btn" title="Use the map centre" (click)="useCentre()"><i class="pi pi-compass"></i></button>
          <button type="button" class="px__icon-btn" [title]="picking() ? 'Cancel' : 'Pick a point on the map'" (click)="picking() ? cancelPick() : pick()">
            <i class="pi" [class.pi-map]="!picking()" [class.pi-times]="picking()"></i>
          </button>
        </div>
        @if (picking()) { <p class="px__hint">Click the map…</p> }
      }

      @switch (tab()) {
        <!-- ================= Forecast ================= -->
        @case ('forecast') {
          @if (loading()) { <p class="px__hint">Loading forecast…</p> }
          @if (error(); as e) { <p class="px__error">{{ e }}</p> }
          @if (forecast(); as f) {
            @if (f.alerts.length) {
              <div class="px__section">
                <h4>Warnings</h4>
                @for (a of f.alerts; track a.text) {
                  <div class="px__item" style="border-radius: var(--radius-md)" [style.background]="alertBg(a.level)">
                    <i class="pi pi-exclamation-triangle" [style.color]="alertColor(a.level)"></i>
                    <span style="font-size: 12.5px; color: var(--color-ink-900)">{{ a.text }}</span>
                  </div>
                }
              </div>
            } @else {
              <p class="px__hint"><i class="pi pi-check-circle" style="color: var(--color-success-600)"></i> No weather warnings in the next 7 days.</p>
            }

            <div class="px__card">
              <div class="px__secret" style="align-items: center">
                <i class="pi" [class]="'pi ' + icon(f.current.code)" style="font-size: 28px; color: var(--color-primary-600)"></i>
                <div class="px__item-main">
                  <span class="px__item-title" style="font-size: 22px">{{ f.current.temperature }}°C</span>
                  <span class="px__item-sub">{{ describe(f.current.code) }} · feels like {{ f.current.feelsLike }}°C</span>
                </div>
              </div>
              <dl class="px__kv">
                <dt>Rain now</dt><dd>{{ f.current.precipitation }} mm</dd>
                <dt>Humidity</dt><dd>{{ f.current.humidity }} %</dd>
                <dt>Wind</dt><dd>{{ f.current.wind }} km/h {{ compass(f.current.direction) }} · gusts {{ f.current.gusts }}</dd>
                @if (f.current.uv !== null) { <dt>UV index</dt><dd>{{ f.current.uv }} ({{ uvLabel(f.current.uv) }})</dd> }
                @if (f.daily[0]; as d) { <dt>Sun</dt><dd>{{ d.sunrise | date: 'shortTime' }} – {{ d.sunset | date: 'shortTime' }}</dd> }
              </dl>
            </div>

            <div class="px__section">
              <h4>Next 48 hours</h4>
              <div class="chart" role="img" [attr.aria-label]="'Hourly rain, total ' + sum(f.hourly, 'rain') + ' mm'">
                @for (h of f.hourly; track h.time) {
                  <div class="chart__bar" [style.height.%]="pctOf(h.rain, maxOf(f.hourly, 'rain'))"
                       [title]="(h.time | date: 'EEE HH:mm') + ' · ' + h.temp + '°C · ' + h.rain + ' mm' + (h.prob !== null ? ' (' + h.prob + ' %)' : '')"></div>
                }
              </div>
              <div class="px__secret" style="justify-content: space-between">
                <span class="px__item-sub">now</span>
                <span class="px__item-sub">rain {{ sum(f.hourly, 'rain') }} mm · {{ minOf(f.hourly, 'temp') }}–{{ maxOf(f.hourly, 'temp') }}°C</span>
                <span class="px__item-sub">+48 h</span>
              </div>
            </div>

            <div class="px__section">
              <h4>7 days</h4>
              <div class="px__list" style="max-height: none">
                @for (d of f.daily; track d.date) {
                  <div class="px__item">
                    <i class="pi" [class]="'pi ' + icon(d.code)" style="color: var(--color-ink-500)"></i>
                    <div class="px__item-main">
                      <span class="px__item-title">{{ d.date | date: 'EEE d MMM' }}</span>
                      <span class="px__item-sub">{{ describe(d.code) }} · {{ d.rain }} mm@if (d.prob !== null) { ({{ d.prob }} %) } · gusts {{ d.gusts }}</span>
                    </div>
                    <span class="px__mono">{{ d.min }}° / {{ d.max }}°</span>
                  </div>
                }
              </div>
            </div>

            <div class="px__section">
              <h4>Last 30 days rain</h4>
              <div class="chart chart--short" role="img" [attr.aria-label]="'Daily rain, total ' + sum(f.past, 'rain') + ' mm'">
                @for (d of f.past; track d.date) {
                  <div class="chart__bar" [style.height.%]="pctOf(d.rain, maxOf(f.past, 'rain'))" [title]="(d.date | date: 'd MMM') + ': ' + d.rain + ' mm'"></div>
                }
              </div>
              <span class="px__item-sub">Total {{ sum(f.past, 'rain') }} mm · {{ rainyDays(f.past) }} rainy days · wettest {{ maxOf(f.past, 'rain') }} mm</span>
            </div>
          }
        }

        <!-- ================= Map layers ================= -->
        @case ('layers') {
          <div class="px__section">
            <h4>Rain radar</h4>
            <label class="px__check"><input type="checkbox" [ngModel]="radarOn()" (ngModelChange)="toggleRadar($event)" /> Live rain radar (last 2 h + nowcast)</label>
            @if (radarOn()) {
              @if (radarError(); as e) {
                <p class="px__error">{{ e }}</p>
              } @else if (frames().length) {
                <div class="px__card">
                  <div class="px__secret">
                    <button type="button" class="px__icon-btn" [title]="playing() ? 'Pause' : 'Play'" (click)="playing() ? pause() : play()">
                      <i class="pi" [class.pi-play]="!playing()" [class.pi-pause]="playing()"></i>
                    </button>
                    <input type="range" style="flex: 1; min-width: 0" min="0" [max]="frames().length - 1" [ngModel]="frameIndex()" (ngModelChange)="showFrame(+$event)" aria-label="Radar time" />
                  </div>
                  @if (frame(); as fr) { <span class="px__item-sub">{{ fr.time * 1000 | date: 'shortTime' }} · {{ fr.forecast ? 'nowcast' : 'observed' }}</span> }
                  <label class="px__field"><span class="px__label">Opacity</span>
                    <input type="range" min="0.2" max="1" step="0.05" [ngModel]="radarOpacity()" (ngModelChange)="radarOpacity.set(+$event); showFrame(frameIndex())" /></label>
                </div>
              } @else {
                <p class="px__hint">Loading radar…</p>
              }
            }
          </div>

          <div class="px__section">
            <h4>Satellite image</h4>
            <label class="px__check"><input type="checkbox" [ngModel]="satOn()" (ngModelChange)="satOn.set($event); applySatellite()" /> Daily true-colour satellite image (clouds, smoke, floods)</label>
            @if (satOn()) {
              <div class="px__card">
                <div class="px__row">
                  <label class="px__field"><span class="px__label">Satellite</span>
                    <select class="px__native-select" [ngModel]="satLayer()" (ngModelChange)="satLayer.set($event); applySatellite()">
                      @for (s of satellites; track s.id) { <option [value]="s.id">{{ s.label }}</option> }
                    </select></label>
                  <label class="px__field"><span class="px__label">Date</span>
                    <input class="px__input" type="date" [max]="yesterday" [ngModel]="satDate()" (ngModelChange)="satDate.set($event); applySatellite()" /></label>
                </div>
                <label class="px__field"><span class="px__label">Opacity</span>
                  <input type="range" min="0.2" max="1" step="0.05" [ngModel]="satOpacity()" (ngModelChange)="satOpacity.set(+$event); applySatellite()" /></label>
              </div>
              <p class="px__hint">~250 m detail, one image per day (NASA GIBS). Compare dates to follow floods or smoke.</p>
            }
          </div>
        }

        <!-- ================= Air quality ================= -->
        @case ('air') {
          @if (loading()) { <p class="px__hint">Loading air quality…</p> }
          @if (error(); as e) { <p class="px__error">{{ e }}</p> }
          @if (air(); as a) {
            @if (a.indianAqi; as n) {
              <div class="px__card" [style.border-color]="n.color">
                <span class="px__label">India AQI (approx., 24-h average)</span>
                <div class="px__secret" style="align-items: baseline">
                  <span style="font-size: 26px; font-weight: 700" [style.color]="n.color">{{ n.value }}</span>
                  <span class="px__item-title" [style.color]="n.color">{{ n.category }}</span>
                </div>
                <span class="px__item-sub">Driven by {{ n.driver }}. {{ aqiAdvice(n.value) }}</span>
              </div>
            }
            <dl class="px__kv">
              @if (a.usAqi !== null) { <dt>US AQI now</dt><dd>{{ a.usAqi }}</dd> }
              @if (a.pm25 !== null) { <dt>PM2.5</dt><dd>{{ a.pm25 }} µg/m³</dd> }
              @if (a.pm10 !== null) { <dt>PM10</dt><dd>{{ a.pm10 }} µg/m³</dd> }
              @if (a.no2 !== null) { <dt>NO₂</dt><dd>{{ a.no2 }} µg/m³</dd> }
              @if (a.o3 !== null) { <dt>Ozone</dt><dd>{{ a.o3 }} µg/m³</dd> }
              @if (a.so2 !== null) { <dt>SO₂</dt><dd>{{ a.so2 }} µg/m³</dd> }
              @if (a.co !== null) { <dt>CO</dt><dd>{{ a.co }} µg/m³</dd> }
            </dl>
            @if (a.hourly.length) {
              <div class="px__section">
                <h4>PM2.5, next 3 days</h4>
                <div class="chart" role="img" aria-label="Hourly PM2.5 forecast">
                  @for (h of a.hourly; track h.time) {
                    <div class="chart__bar" [style.background]="pmColor(h.pm25)" [style.height.%]="pctOf(h.pm25, maxOf(a.hourly, 'pm25'))" [title]="(h.time | date: 'EEE HH:mm') + ': ' + h.pm25 + ' µg/m³'"></div>
                  }
                </div>
              </div>
            }
            <p class="px__hint">Modelled values (CAMS via Open-Meteo), not a monitoring station. For official readings use CPCB stations.</p>
          }
        }

        <!-- ================= River ================= -->
        @case ('river') {
          <p class="px__intro">River flow at the nearest modelled river (GloFAS, ~5 km grid). Pick a point on or next to a river.</p>
          @if (loading()) { <p class="px__hint">Loading river flow…</p> }
          @if (error(); as e) { <p class="px__error">{{ e }}</p> }
          @if (river(); as r) {
            <div class="px__card" [style.border-color]="r.status.color">
              <span class="px__item-title" [style.color]="r.status.color">{{ r.status.text }}</span>
              <dl class="px__kv">
                <dt>Usual flow (60 days)</dt><dd>{{ r.mean | number: '1.0-1' }} m³/s</dd>
                <dt>Forecast peak</dt><dd>{{ r.peak | number: '1.0-1' }} m³/s</dd>
                <dt>Peak on</dt><dd>{{ r.peakDate | date: 'EEE d MMM' }}</dd>
              </dl>
            </div>
            <div class="chart" role="img" aria-label="Daily river discharge, past and forecast">
              @for (d of r.days; track d.date) {
                <div class="chart__bar" [style.background]="d.forecast ? '#f59e0b' : '#2563eb'" [style.height.%]="pctOf(d.flow, r.peak > maxPast(r) ? r.peak : maxPast(r))" [title]="(d.date | date: 'd MMM') + ': ' + (d.flow | number: '1.0-1') + ' m³/s' + (d.forecast ? ' (forecast)' : '')"></div>
              }
            </div>
            <span class="px__item-sub"><span style="color: #2563eb">■</span> past 60 days · <span style="color: #f59e0b">■</span> forecast 30 days</span>
          }
        }

      }

      <p class="px__hint" style="font-size: 10.5px">Data: Open-Meteo, RainViewer, NASA GIBS, Copernicus CAMS & GloFAS.</p>
    </div>
  `,
  styles: [
    `
      .chart { display: flex; align-items: flex-end; gap: 1px; height: 70px; padding: 4px 0; border-bottom: 1px solid var(--color-line); }
      .chart--short { height: 50px; }
      .chart__bar { flex: 1; min-width: 1px; min-height: 1px; background: #2563eb; border-radius: 2px 2px 0 0; }
    `
  ]
})
export class WeatherComponent {
  /** Open one tab / tool, e.g. picked from the workspace tool search. */
  @Input() set openSub(value: { parent: string; sub: string } | null) {
    if (value?.parent === 'weather') this.openTab(value.sub as Tab);
  }

  private readonly map = inject(MapService);

  readonly tabs: { id: Tab; label: string; title: string }[] = [
    { id: 'forecast', label: 'Forecast', title: 'Forecast & warnings' },
    { id: 'layers', label: 'Map', title: 'Radar & satellite on the map' },
    { id: 'air', label: 'Air', title: 'Air quality' },
    { id: 'river', label: 'River', title: 'River flow & flood outlook' }
  ];
  readonly satellites = SATELLITES;
  readonly yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  readonly tab = signal<Tab>('forecast');
  readonly place = signal<LonLat | null>(null);
  readonly placeIsCentre = signal(true);
  readonly picking = signal(false);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  private pickSub: Subscription | null = null;

  readonly forecast = signal<Forecast | null>(null);
  readonly air = signal<AirQuality | null>(null);
  readonly river = signal<River | null>(null);

  // radar
  readonly radarOn = signal(false);
  readonly frames = signal<{ time: number; path: string; forecast: boolean }[]>([]);
  readonly frameIndex = signal(0);
  readonly frame = computed(() => this.frames()[this.frameIndex()] ?? null);
  readonly playing = signal(false);
  readonly radarOpacity = signal(0.7);
  readonly radarError = signal<string | null>(null);
  private radarHost = '';
  private playTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  // satellite
  readonly satOn = signal(false);
  readonly satLayer = signal(SATELLITES[0].id);
  readonly satDate = signal(this.yesterday);
  readonly satOpacity = signal(1);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.pause();
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      this.cancelPick();
      this.map.setOverlayTiles('radar', null);
      this.map.setOverlayTiles('satellite', null);
      this.map.markLocation(null);
    });
    queueMicrotask(() => this.useCentre());
  }

  // ----- helpers for the template -----
  describe = (code: number) => WMO[code]?.[0] ?? 'Unknown';
  icon = (code: number) => WMO[code]?.[1] ?? 'pi-cloud';
  compass = (deg: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  uvLabel = (uv: number) => (uv < 3 ? 'low' : uv < 6 ? 'moderate' : uv < 8 ? 'high' : uv < 11 ? 'very high' : 'extreme');
  alertColor = (l: Alert['level']) => (l === 'red' ? '#dc2626' : l === 'orange' ? '#ea580c' : '#ca8a04');
  alertBg = (l: Alert['level']) => (l === 'red' ? '#fee2e2' : l === 'orange' ? '#ffedd5' : '#fef9c3');
  pctOf = (v: number, max: number) => (max > 0 ? Math.max(2, (v / max) * 100) : 2);
  sum = <T>(list: T[], key: keyof T) => Math.round(list.reduce((s, x) => s + (Number(x[key]) || 0), 0) * 10) / 10;
  maxOf = <T>(list: T[], key: keyof T) => Math.round(Math.max(0, ...list.map((x) => Number(x[key]) || 0)) * 10) / 10;
  minOf = <T>(list: T[], key: keyof T) => Math.round(Math.min(...list.map((x) => Number(x[key]) || 0)) * 10) / 10;
  rainyDays = (list: { rain: number }[]) => list.filter((d) => d.rain >= 2.5).length;
  maxPast = (r: River) => Math.max(0, ...r.days.filter((d) => !d.forecast).map((d) => d.flow));
  pmColor = (pm: number) => (pm <= 30 ? '#16a34a' : pm <= 60 ? '#84cc16' : pm <= 90 ? '#eab308' : pm <= 120 ? '#f97316' : pm <= 250 ? '#dc2626' : '#7f1d1d');
  aqiAdvice = (v: number) =>
    v <= 100 ? 'Air is fine for most people.' : v <= 200 ? 'Sensitive groups should limit long outdoor effort.' : v <= 300 ? 'Limit outdoor activity; consider dust/vehicle controls.' : 'Health alert — avoid outdoor activity; emergency measures advised.';

  placeLabel(): string {
    return this.placeIsCentre() ? 'Map centre' : 'Picked point';
  }

  openTab(tab: Tab): void {
    this.tab.set(tab);
    this.error.set(null);
    this.loadForTab();
  }

  useCentre(): void {
    const view = this.map.viewSnapshot();
    if (!view) return;
    this.cancelPick();
    this.placeIsCentre.set(true);
    this.place.set(view.center);
    this.map.markLocation(null);
    this.reloadPoint();
  }

  pick(): void {
    this.cancelPick();
    this.picking.set(true);
    this.pickSub = this.map.pickMapPoint().subscribe(({ lonLat }) => {
      this.picking.set(false);
      this.placeIsCentre.set(false);
      this.place.set(lonLat);
      this.map.markLocation(lonLat);
      this.reloadPoint();
    });
  }

  cancelPick(): void {
    this.pickSub?.unsubscribe();
    this.pickSub = null;
    if (this.picking()) this.map.cancelMapPick();
    this.picking.set(false);
  }

  private reloadPoint(): void {
    this.forecast.set(null);
    this.air.set(null);
    this.river.set(null);
    this.loadForTab();
  }

  private loadForTab(): void {
    const t = this.tab();
    if (t === 'forecast' && !this.forecast()) void this.loadForecast();
    if (t === 'air' && !this.air()) void this.loadAir();
    if (t === 'river' && !this.river()) void this.loadRiver();
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { reason?: string } | null;
      throw new Error(body?.reason ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private async run(task: () => Promise<void>, what: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      await task();
    } catch (e) {
      this.error.set(`${what} unavailable (${(e as Error).message}).`);
    } finally {
      this.loading.set(false);
    }
  }

  // ----- Forecast -----
  private loadForecast(): Promise<void> {
    const p = this.place();
    if (!p) return Promise.resolve();
    return this.run(async () => {
      const j = await this.getJson<{
        current: Record<string, number>;
        hourly: { time: string[]; temperature_2m: number[]; precipitation: number[]; precipitation_probability?: (number | null)[] };
        daily: {
          time: string[];
          weather_code: number[];
          temperature_2m_max: number[];
          temperature_2m_min: number[];
          precipitation_sum: number[];
          precipitation_probability_max?: (number | null)[];
          wind_gusts_10m_max: number[];
          uv_index_max?: (number | null)[];
          sunrise: string[];
          sunset: string[];
        };
      }>(
        `${OPEN_METEO}?latitude=${p[1].toFixed(4)}&longitude=${p[0].toFixed(4)}&timezone=auto&past_days=30&forecast_days=7` +
          `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,uv_index` +
          `&hourly=temperature_2m,precipitation,precipitation_probability` +
          `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_gusts_10m_max,uv_index_max,sunrise,sunset`
      );
      const c = j.current;
      const today = new Date().toISOString().slice(0, 10);
      const nowHour = new Date().toISOString().slice(0, 13);
      const start = Math.max(0, j.hourly.time.findIndex((t) => new Date(t).toISOString().slice(0, 13) >= nowHour));
      const dIdx = j.daily.time.map((d, i) => ({ d, i }));
      const daily = dIdx
        .filter(({ d }) => d >= today)
        .map(({ d, i }) => ({
          date: d,
          max: Math.round(j.daily.temperature_2m_max[i]),
          min: Math.round(j.daily.temperature_2m_min[i]),
          rain: Math.round((j.daily.precipitation_sum[i] ?? 0) * 10) / 10,
          prob: j.daily.precipitation_probability_max?.[i] ?? null,
          gusts: Math.round(j.daily.wind_gusts_10m_max[i] ?? 0),
          uv: j.daily.uv_index_max?.[i] ?? null,
          code: j.daily.weather_code[i],
          sunrise: j.daily.sunrise[i],
          sunset: j.daily.sunset[i]
        }));
      const past = dIdx.filter(({ d }) => d < today).map(({ d, i }) => ({ date: d, rain: Math.round((j.daily.precipitation_sum[i] ?? 0) * 10) / 10 }));
      this.forecast.set({
        current: {
          temperature: Math.round(c['temperature_2m']),
          feelsLike: Math.round(c['apparent_temperature']),
          humidity: Math.round(c['relative_humidity_2m']),
          precipitation: c['precipitation'],
          wind: Math.round(c['wind_speed_10m']),
          gusts: Math.round(c['wind_gusts_10m']),
          direction: c['wind_direction_10m'],
          code: c['weather_code'],
          uv: c['uv_index'] ?? null
        },
        hourly: j.hourly.time.slice(start, start + 48).map((t, k) => ({
          time: t,
          temp: Math.round(j.hourly.temperature_2m[start + k]),
          rain: j.hourly.precipitation[start + k] ?? 0,
          prob: j.hourly.precipitation_probability?.[start + k] ?? null
        })),
        daily,
        past,
        alerts: this.alertsFor(daily)
      });
    }, 'Forecast');
  }

  /** Warnings from the daily forecast — rainfall per IMD categories. */
  private alertsFor(daily: Forecast['daily']): Alert[] {
    const alerts: Alert[] = [];
    const day = (d: string) => new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    for (const d of daily) {
      if (d.rain >= 204.5) alerts.push({ level: 'red', text: `Extremely heavy rain ${day(d.date)}: ${d.rain} mm — flooding likely.` });
      else if (d.rain >= 115.6) alerts.push({ level: 'orange', text: `Very heavy rain ${day(d.date)}: ${d.rain} mm — waterlogging risk.` });
      else if (d.rain >= 64.5) alerts.push({ level: 'yellow', text: `Heavy rain ${day(d.date)}: ${d.rain} mm.` });
      if (d.max >= 45) alerts.push({ level: 'red', text: `Severe heat ${day(d.date)}: up to ${d.max}°C.` });
      else if (d.max >= 40) alerts.push({ level: 'orange', text: `Heat wave conditions ${day(d.date)}: up to ${d.max}°C.` });
      if (d.gusts >= 75) alerts.push({ level: 'red', text: `Damaging wind ${day(d.date)}: gusts ${d.gusts} km/h.` });
      else if (d.gusts >= 50) alerts.push({ level: 'yellow', text: `Strong wind ${day(d.date)}: gusts ${d.gusts} km/h.` });
      if (d.code >= 95) alerts.push({ level: 'orange', text: `Thunderstorms ${day(d.date)} — lightning risk.` });
      if (d.min <= 4) alerts.push({ level: 'yellow', text: `Cold ${day(d.date)}: down to ${d.min}°C.` });
    }
    const rank = { red: 0, orange: 1, yellow: 2 };
    return alerts.sort((a, b) => rank[a.level] - rank[b.level]);
  }

  // ----- Air quality -----
  private loadAir(): Promise<void> {
    const p = this.place();
    if (!p) return Promise.resolve();
    return this.run(async () => {
      const j = await this.getJson<{
        current: Record<string, number | null>;
        hourly: { time: string[]; pm2_5: (number | null)[]; pm10: (number | null)[] };
      }>(
        `${AIR_API}?latitude=${p[1].toFixed(4)}&longitude=${p[0].toFixed(4)}&timezone=auto&past_days=1&forecast_days=3` +
          `&current=us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,sulphur_dioxide,carbon_monoxide&hourly=pm2_5,pm10`
      );
      const now = Date.now();
      const times = j.hourly.time.map((t) => new Date(t).getTime());
      const lastDay = times.map((t, i) => ({ t, i })).filter(({ t }) => t <= now && t > now - 86_400_000);
      const avg = (vals: (number | null)[]) => {
        const v = lastDay.map(({ i }) => vals[i]).filter((x): x is number => x !== null);
        return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
      };
      const pm25Avg = avg(j.hourly.pm2_5);
      const pm10Avg = avg(j.hourly.pm10);
      let indian: AirQuality['indianAqi'] = null;
      if (pm25Avg !== null || pm10Avg !== null) {
        const s25 = pm25Avg !== null ? naqiSubIndex(pm25Avg, [0, 30, 60, 90, 120, 250, 380]) : 0;
        const s10 = pm10Avg !== null ? naqiSubIndex(pm10Avg, [0, 50, 100, 250, 350, 430, 510]) : 0;
        const value = Math.round(Math.max(s25, s10));
        const cat = NAQI_CATEGORIES.find(([max]) => value <= max) ?? NAQI_CATEGORIES[NAQI_CATEGORIES.length - 1];
        indian = { value, category: cat[1], color: cat[2], driver: s25 >= s10 ? 'PM2.5' : 'PM10' };
      }
      const r = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
      this.air.set({
        usAqi: r(j.current['us_aqi']),
        pm25: r(j.current['pm2_5']),
        pm10: r(j.current['pm10']),
        no2: r(j.current['nitrogen_dioxide']),
        o3: r(j.current['ozone']),
        so2: r(j.current['sulphur_dioxide']),
        co: r(j.current['carbon_monoxide']),
        pm25Avg24: pm25Avg,
        pm10Avg24: pm10Avg,
        indianAqi: indian,
        hourly: times
          .map((t, i) => ({ t, i }))
          .filter(({ t }) => t >= now - 3_600_000)
          .slice(0, 72)
          .map(({ i }) => ({ time: j.hourly.time[i], pm25: Math.round(j.hourly.pm2_5[i] ?? 0) }))
      });
    }, 'Air quality');
  }

  // ----- River -----
  private loadRiver(): Promise<void> {
    const p = this.place();
    if (!p) return Promise.resolve();
    return this.run(async () => {
      const j = await this.getJson<{ daily: { time: string[]; river_discharge: (number | null)[] } }>(
        `${FLOOD_API}?latitude=${p[1].toFixed(4)}&longitude=${p[0].toFixed(4)}&daily=river_discharge&past_days=60&forecast_days=30`
      );
      const today = new Date().toISOString().slice(0, 10);
      const days = j.daily.time
        .map((d, i) => ({ date: d, flow: j.daily.river_discharge[i], forecast: d >= today }))
        .filter((d): d is { date: string; flow: number; forecast: boolean } => d.flow !== null);
      if (!days.length || days.every((d) => d.flow === 0)) throw new Error('no river here — pick a point on a river');
      const pastDays = days.filter((d) => !d.forecast);
      const mean = pastDays.reduce((s, d) => s + d.flow, 0) / Math.max(1, pastDays.length);
      const future = days.filter((d) => d.forecast);
      const peakDay = future.reduce((best, d) => (d.flow > best.flow ? d : best), future[0] ?? days[days.length - 1]);
      const ratio = mean > 0 ? peakDay.flow / mean : 1;
      const status =
        ratio >= 3
          ? { text: 'Flood risk — flow expected far above normal', color: '#dc2626' }
          : ratio >= 1.8
            ? { text: 'Rising — flow expected well above normal', color: '#ea580c' }
            : ratio >= 1.2
              ? { text: 'Slightly above normal', color: '#ca8a04' }
              : { text: 'Normal flow expected', color: '#16a34a' };
      this.river.set({ days, mean, peak: peakDay.flow, peakDate: peakDay.date, status });
    }, 'River flow');
  }

  // ----- Radar -----
  async toggleRadar(on: boolean): Promise<void> {
    this.radarOn.set(on);
    if (!on) {
      this.pause();
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      this.map.setOverlayTiles('radar', null);
      return;
    }
    await this.loadFrames();
    this.refreshTimer = setInterval(() => void this.loadFrames(), 10 * 60_000);
  }

  private async loadFrames(): Promise<void> {
    this.radarError.set(null);
    try {
      const json = await this.getJson<{ host: string; radar: { past?: { time: number; path: string }[]; nowcast?: { time: number; path: string }[] } }>(
        'https://api.rainviewer.com/public/weather-maps.json'
      );
      this.radarHost = json.host;
      const frames = [...(json.radar.past ?? []).map((f) => ({ ...f, forecast: false })), ...(json.radar.nowcast ?? []).map((f) => ({ ...f, forecast: true }))];
      if (!frames.length) throw new Error('no radar frames');
      this.frames.set(frames);
      this.showFrame(Math.max(0, (json.radar.past?.length ?? frames.length) - 1));
    } catch (e) {
      this.radarError.set(`Rain radar unavailable (${(e as Error).message}).`);
    }
  }

  showFrame(index: number): void {
    const f = this.frames()[index];
    if (!f || !this.radarOn()) return;
    this.frameIndex.set(index);
    this.map.setWeatherRadar(`${this.radarHost}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, this.radarOpacity());
  }

  play(): void {
    this.pause();
    this.playing.set(true);
    this.playTimer = setInterval(() => this.showFrame((this.frameIndex() + 1) % Math.max(1, this.frames().length)), 800);
  }

  pause(): void {
    if (this.playTimer) clearInterval(this.playTimer);
    this.playTimer = null;
    this.playing.set(false);
  }

  // ----- Satellite -----
  applySatellite(): void {
    if (!this.satOn() || !this.satDate()) {
      this.map.setOverlayTiles('satellite', null);
      return;
    }
    this.map.setOverlayTiles(
      'satellite',
      `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${this.satLayer()}/default/${this.satDate()}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
      { opacity: this.satOpacity(), maxZoom: 9, attribution: 'Imagery: NASA GIBS / EOSDIS', zIndex: 430 }
    );
  }


}
