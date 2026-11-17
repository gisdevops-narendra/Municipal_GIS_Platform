import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { MapService } from '../../services/map.service';
import { PlatformExtrasService } from '../../services/platform-extras.service';

type FeedKind = 'STA' | 'GEOJSON';

interface SensorFeed {
  id: string;
  name: string;
  kind: FeedKind;
  url: string;
  /** GeoJSON: property holding the reading (blank = first number). */
  valueField: string;
  /** Readings above this are alerts (blank = no alert). */
  alertAbove: number | null;
  intervalSec: number;
  enabled: boolean;
}

interface Reading {
  point: [number, number];
  label: string;
  value: string;
  numeric: number | null;
  unit: string;
  time: string | null;
  detail: string;
  alert: boolean;
}

interface FeedState {
  readings: Reading[];
  updatedAt: Date | null;
  error: string | null;
  loading: boolean;
}

const STORAGE_KEY = 'mgp.sensor-feeds.v1';
const MAX_READINGS = 500;

export function hasSavedSensorFeeds(): boolean {
  return loadFeeds().some((f) => f.enabled);
}

function loadFeeds(): SensorFeed[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as SensorFeed[];
    return Array.isArray(list) ? list.filter((f) => f?.id && f.url) : [];
  } catch {
    return [];
  }
}

function saveFeeds(list: SensorFeed[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage blocked */
  }
}

const EXAMPLES: Omit<SensorFeed, 'id' | 'enabled'>[] = [
  {
    name: 'Earthquakes, last hour (USGS)',
    kind: 'GEOJSON',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
    valueField: 'mag',
    alertAbove: 4.5,
    intervalSec: 60
  }
];

/**
 * Live Sensors: polls OGC SensorThings API servers or GeoJSON feeds and
 * shows each sensor's latest reading on the map, red above an alert
 * threshold. Feeds are kept in this browser.
 */
@Component({
  selector: 'app-live-sensors',
  standalone: true,
  imports: [FormsModule, ButtonModule, DatePipe],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      <p class="px__intro">Show live readings from sensors (water level, air quality, rain gauges…) on the map — from an OGC SensorThings API server or any GeoJSON feed. Readings refresh automatically.</p>

      <div class="px__card">
        <div class="px__seg">
          <button type="button" class="px__seg-btn" [class.is-active]="kind() === 'STA'" (click)="kind.set('STA')">SensorThings</button>
          <button type="button" class="px__seg-btn" [class.is-active]="kind() === 'GEOJSON'" (click)="kind.set('GEOJSON')">GeoJSON URL</button>
        </div>
        <label class="px__field">
          <span class="px__label">Name</span>
          <input class="px__input" [ngModel]="name()" (ngModelChange)="name.set($event)" maxlength="60" placeholder="e.g. Lake level gauges" />
        </label>
        <label class="px__field">
          <span class="px__label">{{ kind() === 'STA' ? 'Service root URL' : 'Feed URL' }}</span>
          <input class="px__input" type="url" [ngModel]="url()" (ngModelChange)="url.set($event)"
                 [placeholder]="kind() === 'STA' ? 'https://…/FROST-Server/v1.1' : 'https://…/feed.geojson'" />
        </label>
        <div class="px__row">
          @if (kind() === 'GEOJSON') {
            <label class="px__field">
              <span class="px__label">Value property</span>
              <input class="px__input" [ngModel]="valueField()" (ngModelChange)="valueField.set($event)" placeholder="auto" />
            </label>
          }
          <label class="px__field">
            <span class="px__label">Alert above</span>
            <input class="px__input" type="number" [ngModel]="alertAbove()" (ngModelChange)="alertAbove.set($event === '' || $event === null ? null : +$event)" placeholder="none" />
          </label>
          <label class="px__field">
            <span class="px__label">Refresh</span>
            <select class="px__native-select" [ngModel]="intervalSec()" (ngModelChange)="intervalSec.set(+$event)">
              @for (i of intervals; track i.sec) { <option [value]="i.sec">{{ i.label }}</option> }
            </select>
          </label>
        </div>
        <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-wifi" label="Add feed"
                [disabled]="!name().trim() || !url().trim()" (click)="add()"></button>
      </div>

      @if (!feeds().length) {
        <div class="px__section">
          <h4>Try an example</h4>
          <div class="px__list">
            @for (ex of examples; track ex.url) {
              <div class="px__item px__item--click" (click)="addFeed(ex)">
                <i class="pi pi-wifi" aria-hidden="true"></i>
                <div class="px__item-main">
                  <span class="px__item-title">{{ ex.name }}</span>
                  <span class="px__item-sub">{{ ex.url }}</span>
                </div>
              </div>
            }
          </div>
        </div>
      }

      @if (feeds().length) {
        <div class="px__section">
          <h4>Feeds</h4>
          <div class="px__list">
            @for (feed of feeds(); track feed.id) {
              <div class="px__item px__item--click" [style.background]="selectedId() === feed.id ? 'var(--color-surface-alt)' : null" (click)="selectedId.set(feed.id)">
                <input type="checkbox" [checked]="feed.enabled" (click)="$event.stopPropagation()" (change)="toggle(feed)" [attr.aria-label]="'Show ' + feed.name" />
                <div class="px__item-main">
                  <span class="px__item-title" [title]="feed.url">{{ feed.name }}</span>
                  <span class="px__item-sub">
                    @if (states()[feed.id]; as st) {
                      @if (st.error) { <span style="color: var(--color-error-600)">{{ st.error }}</span> }
                      @else if (st.updatedAt) { {{ st.readings.length }} sensors · {{ st.updatedAt | date: 'mediumTime' }} }
                      @else { Loading… }
                    } @else { Off }
                  </span>
                </div>
                @if (alertCount(feed.id); as n) { <span class="px__badge px__badge--bad">{{ n }} alert{{ n === 1 ? '' : 's' }}</span> }
                <button type="button" class="px__icon-btn" title="Refresh now" (click)="$event.stopPropagation(); poll(feed)"><i class="pi pi-refresh"></i></button>
                <button type="button" class="px__icon-btn px__icon-btn--danger" title="Remove" (click)="$event.stopPropagation(); remove(feed)"><i class="pi pi-trash"></i></button>
              </div>
            }
          </div>
        </div>
      }

      @if (selectedReadings().length) {
        <div class="px__section">
          <h4>Latest readings</h4>
          <div class="px__list">
            @for (r of selectedReadings(); track $index) {
              <div class="px__item px__item--click" (click)="zoomTo(r)">
                <i class="pi pi-circle-fill" [style.color]="r.alert ? 'var(--color-error-600)' : '#0d9488'" style="font-size: 9px" aria-hidden="true"></i>
                <div class="px__item-main">
                  <span class="px__item-title" [title]="r.label">{{ r.label }}</span>
                  <span class="px__item-sub" [title]="r.detail">{{ r.detail || '—' }}@if (r.time) { · {{ r.time | date: 'short' }} }</span>
                </div>
                <span class="px__mono" [style.color]="r.alert ? 'var(--color-error-600)' : null" style="font-weight: 600">{{ r.value }} {{ r.unit }}</span>
              </div>
            }
          </div>
        </div>
      }
    </div>
  `
})
export class LiveSensorsComponent {
  private readonly map = inject(MapService);
  private readonly extras = inject(PlatformExtrasService);

  readonly examples = EXAMPLES;
  readonly intervals = [
    { sec: 15, label: '15 s' },
    { sec: 30, label: '30 s' },
    { sec: 60, label: '1 min' },
    { sec: 300, label: '5 min' },
    { sec: 900, label: '15 min' }
  ];

  readonly kind = signal<FeedKind>('STA');
  readonly name = signal('');
  readonly url = signal('');
  readonly valueField = signal('');
  readonly alertAbove = signal<number | null>(null);
  readonly intervalSec = signal(60);

  readonly feeds = signal<SensorFeed[]>(loadFeeds());
  readonly states = signal<Record<string, FeedState>>({});
  readonly selectedId = signal<string | null>(this.feeds()[0]?.id ?? null);
  readonly selectedReadings = computed(() => {
    const id = this.selectedId();
    const list = id ? this.states()[id]?.readings ?? [] : [];
    return [...list].sort((a, b) => Number(b.alert) - Number(a.alert)).slice(0, 100);
  });
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor() {
    for (const feed of this.feeds()) if (feed.enabled) this.start(feed);
    inject(DestroyRef).onDestroy(() => {
      for (const t of this.timers.values()) clearInterval(t);
      for (const feed of this.feeds()) this.map.removeSensorLayer(feed.id);
    });
  }

  alertCount(id: string): number {
    return this.states()[id]?.readings.filter((r) => r.alert).length ?? 0;
  }

  add(): void {
    this.addFeed({
      name: this.name().trim(),
      kind: this.kind(),
      url: this.url().trim(),
      valueField: this.valueField().trim(),
      alertAbove: this.alertAbove(),
      intervalSec: this.intervalSec()
    });
    this.name.set('');
    this.url.set('');
    this.valueField.set('');
  }

  addFeed(spec: Omit<SensorFeed, 'id' | 'enabled'>): void {
    const feed: SensorFeed = { ...spec, id: crypto.randomUUID(), enabled: true };
    this.feeds.update((list) => [...list, feed]);
    saveFeeds(this.feeds());
    this.selectedId.set(feed.id);
    this.start(feed);
  }

  toggle(feed: SensorFeed): void {
    const enabled = !feed.enabled;
    this.feeds.update((list) => list.map((f) => (f.id === feed.id ? { ...f, enabled } : f)));
    saveFeeds(this.feeds());
    if (enabled) this.start({ ...feed, enabled });
    else this.stop(feed.id);
  }

  remove(feed: SensorFeed): void {
    this.stop(feed.id);
    this.feeds.update((list) => list.filter((f) => f.id !== feed.id));
    saveFeeds(this.feeds());
    if (this.selectedId() === feed.id) this.selectedId.set(this.feeds()[0]?.id ?? null);
  }

  zoomTo(r: Reading): void {
    this.map.zoomToGeometries([{ type: 'Point', coordinates: r.point }]);
  }

  private start(feed: SensorFeed): void {
    this.stop(feed.id);
    void this.poll(feed);
    this.timers.set(feed.id, setInterval(() => void this.poll(feed), Math.max(10, feed.intervalSec) * 1000));
  }

  private stop(id: string): void {
    const t = this.timers.get(id);
    if (t) clearInterval(t);
    this.timers.delete(id);
    this.map.removeSensorLayer(id);
    this.states.update((s) => {
      const { [id]: _gone, ...rest } = s;
      return rest;
    });
  }

  async poll(feed: SensorFeed): Promise<void> {
    this.patch(feed.id, { loading: true });
    try {
      const readings = feed.kind === 'STA' ? await this.readSta(feed) : await this.readGeoJson(feed);
      if (!this.timers.has(feed.id)) return;
      this.map.setSensorReadings(feed.id, readings);
      this.patch(feed.id, { readings, updatedAt: new Date(), error: null, loading: false });
    } catch (error) {
      this.patch(feed.id, { error: (error as Error).message || 'Feed unavailable', loading: false });
    }
  }

  private patch(id: string, change: Partial<FeedState>): void {
    this.states.update((s) => ({
      ...s,
      [id]: { ...(s[id] ?? { readings: [], updatedAt: null, error: null, loading: false }), ...change }
    }));
  }

  private isAlert(feed: SensorFeed, n: number | null): boolean {
    return feed.alertAbove !== null && n !== null && n > feed.alertAbove;
  }

  /** OGC SensorThings: each Thing's location and its streams' latest
   *  observation. */
  private async readSta(feed: SensorFeed): Promise<Reading[]> {
    const root = feed.url.replace(/\/+$/, '').replace(/\/Things.*$/i, '');
    const url =
      `${root}/Things?$top=${MAX_READINGS}&$expand=Locations($select=location),` +
      `Datastreams($select=name,unitOfMeasurement;$expand=Observations($orderby=phenomenonTime desc;$top=1;$select=result,phenomenonTime))`;
    const json = JSON.parse(await this.extras.smartFetchText(url)) as {
      value?: {
        name?: string;
        Locations?: { location?: { type?: string; coordinates?: number[]; geometry?: { coordinates?: number[] } } }[];
        Datastreams?: {
          name?: string;
          unitOfMeasurement?: { symbol?: string };
          Observations?: { result?: unknown; phenomenonTime?: string }[];
        }[];
      }[];
    };
    if (!Array.isArray(json.value)) throw new Error('Not a SensorThings API service.');
    const readings: Reading[] = [];
    for (const thing of json.value) {
      const loc = thing.Locations?.[0]?.location;
      const coords = loc?.type === 'Point' ? loc.coordinates : loc?.geometry?.coordinates;
      if (!coords || coords.length < 2) continue;
      const streams = (thing.Datastreams ?? []).filter((d) => d.Observations?.length);
      const first = streams[0];
      const obs = first?.Observations?.[0];
      const numeric = typeof obs?.result === 'number' ? obs.result : Number.isFinite(Number(obs?.result)) ? Number(obs?.result) : null;
      readings.push({
        point: [coords[0], coords[1]],
        label: thing.name ?? 'Sensor',
        value: obs ? formatValue(obs.result) : '—',
        numeric,
        unit: first?.unitOfMeasurement?.symbol ?? '',
        time: obs?.phenomenonTime?.split('/')[0] ?? null,
        detail: streams
          .slice(0, 4)
          .map((d) => `${d.name}: ${formatValue(d.Observations![0].result)}${d.unitOfMeasurement?.symbol ? ' ' + d.unitOfMeasurement.symbol : ''}`)
          .join(' · '),
        alert: this.isAlert(feed, numeric)
      });
    }
    return readings;
  }

  /** GeoJSON feed: point features (or the first vertex of others). */
  private async readGeoJson(feed: SensorFeed): Promise<Reading[]> {
    const json = JSON.parse(await this.extras.smartFetchText(feed.url)) as {
      type?: string;
      features?: { geometry?: { type: string; coordinates: unknown } | null; properties?: Record<string, unknown> | null }[];
    };
    if (!Array.isArray(json.features)) throw new Error('Not a GeoJSON FeatureCollection.');
    const readings: Reading[] = [];
    for (const f of json.features.slice(0, MAX_READINGS)) {
      const point = firstPosition(f.geometry?.coordinates);
      if (!point) continue;
      const props = f.properties ?? {};
      const key = feed.valueField || Object.keys(props).find((k) => typeof props[k] === 'number') || '';
      const raw = key ? props[key] : null;
      const numeric = typeof raw === 'number' ? raw : Number.isFinite(Number(raw)) && raw !== null && raw !== '' ? Number(raw) : null;
      const labelKey = Object.keys(props).find((k) => /^(name|title|place|label|station)/i.test(k) && props[k]);
      const timeKey = Object.keys(props).find((k) => /time|date|updated/i.test(k) && props[k]);
      const timeRaw = timeKey ? props[timeKey] : null;
      readings.push({
        point,
        label: labelKey ? String(props[labelKey]) : 'Sensor',
        value: raw === null || raw === undefined ? '—' : formatValue(raw),
        numeric,
        unit: '',
        time: typeof timeRaw === 'number' ? new Date(timeRaw).toISOString() : typeof timeRaw === 'string' ? timeRaw : null,
        detail: key ? key : '',
        alert: this.isAlert(feed, numeric)
      });
    }
    return readings;
  }
}

function formatValue(v: unknown): string {
  if (typeof v === 'number') return String(Math.round(v * 100) / 100);
  if (v === null || v === undefined) return '—';
  return typeof v === 'object' ? JSON.stringify(v).slice(0, 30) : String(v).slice(0, 30);
}

function firstPosition(coords: unknown): [number, number] | null {
  let c = coords;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number' ? [c[0], c[1]] : null;
}
