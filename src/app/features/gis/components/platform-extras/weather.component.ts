import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { MapService } from '../../services/map.service';

interface RadarFrame {
  time: number;
  path: string;
  forecast: boolean;
}

interface Forecast {
  place: [number, number];
  current: { temperature: number; humidity: number; precipitation: number; wind: number; code: number; time: string };
  hourly: { time: string; precipitation: number; probability: number | null }[];
  daily: { date: string; max: number; min: number; rain: number; code: number }[];
}

/** WMO weather codes (Open-Meteo). */
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

/** Weather: live rain radar on the map (RainViewer, last ~2 h + short
 *  nowcast, animated) and the forecast at the map centre (Open-Meteo). */
@Component({
  selector: 'app-weather',
  standalone: true,
  imports: [FormsModule, ButtonModule, DatePipe],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      <div class="px__section">
        <h4>Rain radar</h4>
        <label class="px__check">
          <input type="checkbox" [ngModel]="radarOn()" (ngModelChange)="toggleRadar($event)" /> Show rain radar on the map
        </label>
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
              @if (frame(); as f) {
                <span class="px__item-sub">
                  {{ f.time * 1000 | date: 'shortTime' }} · {{ f.forecast ? 'forecast (nowcast)' : 'observed' }}
                </span>
              }
              <label class="px__field">
                <span class="px__label">Opacity</span>
                <input type="range" min="0.2" max="1" step="0.05" [ngModel]="opacity()" (ngModelChange)="setOpacity(+$event)" />
              </label>
            </div>
            <p class="px__hint">Radar is coarse when zoomed in close. Blue → yellow → red = light → heavy rain.</p>
          } @else {
            <p class="px__hint">Loading radar…</p>
          }
        }
      </div>

      <div class="px__section">
        <h4>Forecast at map centre</h4>
        <button pButton type="button" class="p-button-sm p-button-outlined px__btn-block" icon="pi pi-refresh"
                [label]="forecast() ? 'Update for current view' : 'Get forecast'" [loading]="loadingForecast()" (click)="loadForecast()"></button>
        @if (forecastError(); as e) { <p class="px__error">{{ e }}</p> }
        @if (forecast(); as f) {
          <div class="px__card">
            <div class="px__secret" style="align-items: center">
              <i class="pi" [class]="'pi ' + icon(f.current.code)" style="font-size: 26px; color: var(--color-primary-600)"></i>
              <div class="px__item-main">
                <span class="px__item-title" style="font-size: 20px">{{ f.current.temperature }}°C</span>
                <span class="px__item-sub">{{ describe(f.current.code) }}</span>
              </div>
            </div>
            <dl class="px__kv">
              <dt>Rain now</dt><dd>{{ f.current.precipitation }} mm</dd>
              <dt>Humidity</dt><dd>{{ f.current.humidity }} %</dd>
              <dt>Wind</dt><dd>{{ f.current.wind }} km/h</dd>
              <dt>Next 24 h rain</dt><dd>{{ rain24() }} mm</dd>
            </dl>
            <span class="px__item-sub px__mono">{{ f.place[1].toFixed(3) }}, {{ f.place[0].toFixed(3) }}</span>
          </div>

          <div class="px__section">
            <h4>Rain, next 24 hours</h4>
            <div style="display: flex; align-items: flex-end; gap: 2px; height: 64px; padding: 4px 0; border-bottom: 1px solid var(--color-line)" role="img" [attr.aria-label]="'Hourly rain, total ' + rain24() + ' mm'">
              @for (h of f.hourly; track h.time) {
                <div [title]="(h.time | date: 'shortTime') + ': ' + h.precipitation + ' mm' + (h.probability !== null ? ' (' + h.probability + ' %)' : '')"
                     [style.height.%]="barHeight(h.precipitation)"
                     style="flex: 1; min-width: 2px; background: #2563eb; border-radius: 2px 2px 0 0; min-height: 1px"></div>
              }
            </div>
            @if (f.hourly.length) {
            <div class="px__secret" style="justify-content: space-between">
              <span class="px__item-sub">{{ f.hourly[0].time | date: 'shortTime' }}</span>
              <span class="px__item-sub">peak {{ maxHourly() }} mm/h</span>
              <span class="px__item-sub">{{ f.hourly[f.hourly.length - 1].time | date: 'shortTime' }}</span>
            </div>
            }
          </div>

          <div class="px__list">
            @for (d of f.daily; track d.date) {
              <div class="px__item">
                <i class="pi" [class]="'pi ' + icon(d.code)" style="color: var(--color-ink-500)"></i>
                <div class="px__item-main">
                  <span class="px__item-title">{{ d.date | date: 'EEE d MMM' }}</span>
                  <span class="px__item-sub">{{ describe(d.code) }} · {{ d.rain }} mm</span>
                </div>
                <span class="px__mono">{{ d.min }}° / {{ d.max }}°</span>
              </div>
            }
          </div>
          <p class="px__hint">Forecast: Open-Meteo. Radar: RainViewer.</p>
        }
      </div>
    </div>
  `
})
export class WeatherComponent {
  private readonly map = inject(MapService);

  readonly radarOn = signal(false);
  readonly frames = signal<RadarFrame[]>([]);
  readonly frameIndex = signal(0);
  readonly frame = computed(() => this.frames()[this.frameIndex()] ?? null);
  readonly playing = signal(false);
  readonly opacity = signal(0.7);
  readonly radarError = signal<string | null>(null);
  private host = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  readonly forecast = signal<Forecast | null>(null);
  readonly loadingForecast = signal(false);
  readonly forecastError = signal<string | null>(null);
  readonly rain24 = computed(() => Math.round((this.forecast()?.hourly ?? []).reduce((s, h) => s + h.precipitation, 0) * 10) / 10);
  readonly maxHourly = computed(() => Math.max(0, ...(this.forecast()?.hourly ?? []).map((h) => h.precipitation)));

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.pause();
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      this.map.setWeatherRadar(null);
    });
  }

  describe = (code: number) => WMO[code]?.[0] ?? 'Unknown';
  icon = (code: number) => WMO[code]?.[1] ?? 'pi-cloud';
  barHeight = (mm: number) => (this.maxHourly() > 0 ? Math.max(2, (mm / this.maxHourly()) * 100) : 2);

  async toggleRadar(on: boolean): Promise<void> {
    this.radarOn.set(on);
    if (!on) {
      this.pause();
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      this.map.setWeatherRadar(null);
      return;
    }
    await this.loadFrames();
    // New radar frames every 10 minutes.
    this.refreshTimer = setInterval(() => void this.loadFrames(), 10 * 60_000);
  }

  private async loadFrames(): Promise<void> {
    this.radarError.set(null);
    try {
      const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        host: string;
        radar: { past?: { time: number; path: string }[]; nowcast?: { time: number; path: string }[] };
      };
      this.host = json.host;
      const frames: RadarFrame[] = [
        ...(json.radar.past ?? []).map((f) => ({ ...f, forecast: false })),
        ...(json.radar.nowcast ?? []).map((f) => ({ ...f, forecast: true }))
      ];
      if (!frames.length) throw new Error('no radar frames');
      this.frames.set(frames);
      // Latest observed frame.
      this.showFrame(Math.max(0, (json.radar.past?.length ?? frames.length) - 1));
    } catch (error) {
      this.radarError.set(`Rain radar unavailable (${(error as Error).message}).`);
    }
  }

  showFrame(index: number): void {
    const f = this.frames()[index];
    if (!f || !this.radarOn()) return;
    this.frameIndex.set(index);
    this.map.setWeatherRadar(`${this.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, this.opacity());
  }

  setOpacity(value: number): void {
    this.opacity.set(value);
    this.showFrame(this.frameIndex());
  }

  play(): void {
    this.pause();
    this.playing.set(true);
    this.timer = setInterval(() => this.showFrame((this.frameIndex() + 1) % Math.max(1, this.frames().length)), 800);
  }

  pause(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.playing.set(false);
  }

  async loadForecast(): Promise<void> {
    const view = this.map.viewSnapshot();
    if (!view) return;
    const [lon, lat] = view.center;
    this.loadingForecast.set(true);
    this.forecastError.set(null);
    try {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
        `&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code` +
        `&hourly=precipitation,precipitation_probability&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum` +
        `&timezone=auto&forecast_days=3`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as {
        current: { time: string; temperature_2m: number; relative_humidity_2m: number; precipitation: number; wind_speed_10m: number; weather_code: number };
        hourly: { time: string[]; precipitation: number[]; precipitation_probability?: (number | null)[] };
        daily: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_sum: number[] };
      };
      const now = j.current.time.slice(0, 13);
      const start = Math.max(0, j.hourly.time.findIndex((t) => t.slice(0, 13) >= now));
      this.forecast.set({
        place: [lon, lat],
        current: {
          time: j.current.time,
          temperature: Math.round(j.current.temperature_2m),
          humidity: Math.round(j.current.relative_humidity_2m),
          precipitation: j.current.precipitation,
          wind: Math.round(j.current.wind_speed_10m),
          code: j.current.weather_code
        },
        hourly: j.hourly.time.slice(start, start + 24).map((t, i) => ({
          time: t,
          precipitation: j.hourly.precipitation[start + i] ?? 0,
          probability: j.hourly.precipitation_probability?.[start + i] ?? null
        })),
        daily: j.daily.time.map((d, i) => ({
          date: d,
          max: Math.round(j.daily.temperature_2m_max[i]),
          min: Math.round(j.daily.temperature_2m_min[i]),
          rain: Math.round(j.daily.precipitation_sum[i] * 10) / 10,
          code: j.daily.weather_code[i]
        }))
      });
    } catch (error) {
      this.forecastError.set(`Forecast unavailable (${(error as Error).message}).`);
    } finally {
      this.loadingForecast.set(false);
    }
  }
}
