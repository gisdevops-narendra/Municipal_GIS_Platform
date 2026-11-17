import { Component, DestroyRef, Input, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { environment } from '../../../../../environments/environment';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { MapService } from '../../services/map.service';
import { PlatformExtrasService } from '../../services/platform-extras.service';

type LonLat = [number, number];
type Geo = Record<string, unknown>;

interface Hazard {
  id: string;
  title: string;
  sub: string;
  time: number;
  point: LonLat;
  distanceKm: number;
  color: string;
  /** Exposure area: the alert polygon(s), or the epicentre with a radius. */
  geometry: Geo;
  bufferKm: number;
  link: string | null;
  /** GDACS polygon to fetch on demand. */
  geometryUrl?: string | null;
}

interface Exposure {
  layerName: string;
  areas: { id: string; count: number; features: { id: number; label: string; distanceKm: number }[] }[];
}

const GDACS_TYPES: Record<string, string> = {
  EQ: 'Earthquake',
  TC: 'Tropical cyclone',
  FL: 'Flood',
  VO: 'Volcano',
  DR: 'Drought',
  WF: 'Wildfire'
};
const ALERT_COLOR: Record<string, string> = { Red: '#dc2626', Orange: '#f97316', Green: '#16a34a' };

/** Approximate radius (km) within which a quake of magnitude m is felt. */
const feltKm = (m: number) => Math.round(Math.min(500, Math.max(5, Math.pow(10, 0.5 * m - 1))));
const magColor = (m: number) => (m >= 6 ? '#dc2626' : m >= 5 ? '#f97316' : m >= 4 ? '#eab308' : '#0d9488');

function haversineKm(a: LonLat, b: LonLat): number {
  const r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r;
  const dLon = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Live earthquakes (USGS) and disaster alerts (GDACS) near the map
 *  centre — both free, no sign-in — plus which features of a layer fall
 *  inside each hazard area. */
@Component({
  selector: 'app-hazards',
  standalone: true,
  imports: [FormsModule, ButtonModule, DatePipe],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      <div class="px__tabs" style="grid-template-columns: repeat(2, 1fr)" role="tablist">
        <button type="button" role="tab" class="px__tab" [class.is-active]="tab() === 'quakes'" (click)="setTab('quakes')">Earthquakes</button>
        <button type="button" role="tab" class="px__tab" [class.is-active]="tab() === 'alerts'" (click)="setTab('alerts')">Disaster Alerts</button>
      </div>

      <p class="px__intro">
        @if (tab() === 'quakes') { Recent earthquakes from the USGS live feed around the map centre. Circles show the approximate area where each was felt. }
        @else { Current GDACS alerts (floods, cyclones, droughts, earthquakes, volcanoes, wildfires) around the map centre. }
      </p>

      <div class="px__row" [style.display]="'grid'" [style.grid-template-columns]="tab() === 'quakes' ? 'repeat(3, minmax(0, 1fr))' : '1fr'" style="gap: 8px">
        <label class="px__field" style="min-width: 0"><span class="px__label">Within</span>
          <select class="px__native-select" style="width: 100%" [ngModel]="radiusKm()" (ngModelChange)="radiusKm.set(+$event)">
            @for (r of radii; track r) { <option [value]="r">{{ r ? r + ' km' : 'World' }}</option> }
          </select>
        </label>
        @if (tab() === 'quakes') {
          <label class="px__field" style="min-width: 0"><span class="px__label">Period</span>
            <select class="px__native-select" style="width: 100%" [ngModel]="days()" (ngModelChange)="days.set(+$event)">
              <option [value]="1">24 hours</option><option [value]="7">7 days</option>
              <option [value]="30">30 days</option><option [value]="365">1 year</option>
            </select>
          </label>
          <label class="px__field" style="min-width: 0"><span class="px__label">Magnitude</span>
            <select class="px__native-select" style="width: 100%" [ngModel]="minMag()" (ngModelChange)="minMag.set(+$event)">
              @for (m of [1, 2.5, 4, 5, 6]; track m) { <option [value]="m">{{ m }}+</option> }
            </select>
          </label>
        }
      </div>

      <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-refresh" [loading]="busy()"
              [label]="tab() === 'quakes' ? 'Load earthquakes' : 'Load alerts'" (click)="load()"></button>

      @if (error(); as message) { <p class="px__error" role="alert">{{ message }}</p> }

      @if (loaded()) {
        <div class="px__section">
          <h4>{{ items().length }} {{ tab() === 'quakes' ? 'earthquake' : 'alert' }}{{ items().length === 1 ? '' : 's' }}</h4>
          @if (!items().length) { <p class="px__hint">Nothing in this area — good news.</p> }
          <div class="px__list">
            @for (h of items(); track h.id) {
              <div class="px__item" [class.is-active]="selected()?.id === h.id" style="cursor: pointer" (click)="select(h)">
                <span [style.color]="h.color" aria-hidden="true">●</span>
                <div class="px__item-main">
                  <span class="px__item-title" style="white-space: normal">{{ h.title }}</span>
                  <span class="px__item-sub">{{ h.sub }} · {{ h.time | date: 'd MMM y, HH:mm' }} · {{ h.distanceKm }} km away</span>
                </div>
                @if (h.link) {
                  <a class="px__icon-btn" [href]="h.link" target="_blank" rel="noopener" title="Details" (click)="$event.stopPropagation()"><i class="pi pi-external-link"></i></a>
                }
              </div>
            }
          </div>
        </div>
      }

      @if (items().length) {
        <div class="px__section">
          <h4>Exposed assets</h4>
          <p class="px__hint">Count the features of a layer inside {{ selected() ? 'the selected hazard area' : 'each hazard area' }}.</p>
          <div class="px__row">
            <label class="px__field"><span class="px__label">Layer</span>
              <select class="px__native-select" [ngModel]="layerId()" (ngModelChange)="layerId.set($event)">
                <option value="">Choose a layer…</option>
                @for (l of vectorLayers(); track l.id) { <option [value]="l.id">{{ l.name }}</option> }
              </select>
            </label>
          </div>
          <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-shield" label="Check exposure"
                  [disabled]="!layerId()" [loading]="checking()" (click)="checkExposure()"></button>

          @if (exposure(); as ex) {
            <div class="px__list" style="margin-top: 8px">
              @for (a of ex.areas; track a.id) {
                <div class="px__card">
                  <span class="px__item-title" style="white-space: normal">{{ titleOf(a.id) }}</span>
                  <span class="px__item-sub"><b>{{ a.count }}</b> {{ ex.layerName }} feature{{ a.count === 1 ? '' : 's' }} exposed</span>
                  @if (a.features.length) {
                    <dl class="px__kv" style="margin-top: 4px">
                      @for (f of a.features; track f.id) { <dt>{{ f.label }}</dt><dd>{{ f.distanceKm ? f.distanceKm + ' km' : 'inside' }}</dd> }
                    </dl>
                    @if (a.count > a.features.length) { <span class="px__item-sub">…and {{ a.count - a.features.length }} more</span> }
                  }
                </div>
              }
            </div>
          }
        </div>
      }
    </div>
  `
})
export class HazardsComponent {
  private readonly http = inject(HttpClient);
  private readonly map = inject(MapService);
  private readonly extras = inject(PlatformExtrasService);

  @Input() set layers(value: GisLayer[] | null) {
    this.layersSignal.set(value ?? []);
  }
  private readonly layersSignal = signal<GisLayer[]>([]);
  readonly vectorLayers = computed(() => this.layersSignal().filter((l) => l.layerType === 'VECTOR'));

  readonly radii = [100, 300, 500, 1000, 2000, 0];
  readonly tab = signal<'quakes' | 'alerts'>('quakes');
  readonly radiusKm = signal(500);
  readonly days = signal(30);
  readonly minMag = signal(2.5);
  readonly busy = signal(false);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);
  readonly items = signal<Hazard[]>([]);
  readonly selected = signal<Hazard | null>(null);
  readonly layerId = signal('');
  readonly checking = signal(false);
  readonly exposure = signal<Exposure | null>(null);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.map.setFilledAreas(null);
      this.map.markLocation(null);
    });
  }

  setTab(t: 'quakes' | 'alerts'): void {
    if (this.tab() === t) return;
    this.tab.set(t);
    this.reset();
  }

  private reset(): void {
    this.items.set([]);
    this.selected.set(null);
    this.exposure.set(null);
    this.loaded.set(false);
    this.error.set(null);
    this.map.setFilledAreas(null);
  }

  async load(): Promise<void> {
    const view = this.map.viewSnapshot();
    if (!view) return;
    this.reset();
    this.busy.set(true);
    try {
      const list = this.tab() === 'quakes' ? await this.loadQuakes(view.center) : await this.loadAlerts(view.center);
      this.items.set(list);
      this.loaded.set(true);
      this.draw();
      if (list.length) this.map.zoomToGeometries(list.map((h) => ({ type: 'Point', coordinates: h.point })));
    } catch {
      this.error.set(`Could not reach the ${this.tab() === 'quakes' ? 'USGS' : 'GDACS'} feed. Try again in a moment.`);
    } finally {
      this.busy.set(false);
    }
  }

  private async loadQuakes(centre: LonLat): Promise<Hazard[]> {
    const start = new Date(Date.now() - this.days() * 86_400_000).toISOString().slice(0, 19);
    const params = new URLSearchParams({ format: 'geojson', starttime: start, minmagnitude: String(this.minMag()), orderby: 'time', limit: '500' });
    if (this.radiusKm()) {
      params.set('latitude', centre[1].toFixed(4));
      params.set('longitude', centre[0].toFixed(4));
      params.set('maxradiuskm', String(this.radiusKm()));
    }
    const text = await this.extras.smartFetchText(`https://earthquake.usgs.gov/fdsnws/event/1/query?${params}`);
    const fc = JSON.parse(text) as { features: { id: string; geometry: { coordinates: number[] }; properties: Record<string, unknown> }[] };
    return fc.features.map((f) => {
      const p = f.properties;
      const point: LonLat = [f.geometry.coordinates[0], f.geometry.coordinates[1]];
      const mag = Number(p['mag'] ?? 0);
      const depth = f.geometry.coordinates[2];
      return {
        id: f.id,
        title: `M ${mag.toFixed(1)} — ${String(p['place'] ?? 'Unknown place')}`,
        sub: `depth ${Math.round(depth ?? 0)} km · felt ~${feltKm(mag)} km${p['tsunami'] ? ' · tsunami flag' : ''}`,
        time: Number(p['time']),
        point,
        distanceKm: Math.round(haversineKm(centre, point)),
        color: magColor(mag),
        geometry: { type: 'Point', coordinates: point },
        bufferKm: feltKm(mag),
        link: (p['url'] as string) ?? null
      };
    });
  }

  private async loadAlerts(centre: LonLat): Promise<Hazard[]> {
    const text = await this.extras.smartFetchText('https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP?eventlist=EQ;TC;FL;VO;DR;WF');
    const fc = JSON.parse(text) as { features: { geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }[] };
    const polygons = new Map<string, Geo[]>();
    const points: Hazard[] = [];
    for (const f of fc.features ?? []) {
      const p = f.properties;
      const key = `${p['eventtype']}-${p['eventid']}`;
      if (f.geometry?.type !== 'Point') {
        if (f.geometry) polygons.set(key, [...(polygons.get(key) ?? []), f.geometry as unknown as Geo]);
        continue;
      }
      if (points.some((h) => h.id === key)) continue;
      const point = f.geometry.coordinates as LonLat;
      const distanceKm = Math.round(haversineKm(centre, point));
      if (this.radiusKm() && distanceKm > this.radiusKm()) continue;
      const level = String(p['alertlevel'] ?? 'Green');
      const urls = (p['url'] ?? {}) as Record<string, string>;
      const severity = (p['severitydata'] as { severitytext?: string } | undefined)?.severitytext;
      points.push({
        id: key,
        title: String(p['name'] ?? p['description'] ?? GDACS_TYPES[String(p['eventtype'])] ?? 'Alert'),
        sub: `${level} alert · ${GDACS_TYPES[String(p['eventtype'])] ?? p['eventtype']}${p['country'] ? ' · ' + p['country'] : ''}${severity ? ' · ' + severity : ''}`,
        time: Date.parse(String(p['fromdate'] ?? '')) || Date.now(),
        point,
        distanceKm,
        color: ALERT_COLOR[level] ?? '#64748b',
        geometry: { type: 'Point', coordinates: point },
        bufferKm: 50,
        link: urls['report'] ?? null,
        geometryUrl: urls['geometry'] ?? null
      });
    }
    for (const h of points) {
      const polys = polygons.get(h.id);
      if (polys?.length) this.usePolygons(h, polys);
    }
    return points.sort((a, b) => a.distanceKm - b.distanceKm);
  }

  private usePolygons(h: Hazard, geoms: Geo[]): void {
    h.geometry = geoms.length === 1 ? geoms[0] : { type: 'GeometryCollection', geometries: geoms };
    h.bufferKm = 0;
    h.geometryUrl = null;
  }

  async select(h: Hazard): Promise<void> {
    this.selected.set(this.selected()?.id === h.id ? null : h);
    this.exposure.set(null);
    if (this.selected() && h.geometryUrl) {
      try {
        const fc = JSON.parse(await this.extras.smartFetchText(h.geometryUrl)) as { features?: { geometry: Geo }[] };
        const polys = (fc.features ?? []).map((f) => f.geometry).filter((g) => g && g['type'] !== 'Point');
        if (polys.length) this.usePolygons(h, polys);
      } catch {
        /* keep the point + radius */
      }
      h.geometryUrl = null;
    }
    this.draw();
    const s = this.selected();
    if (s) this.map.zoomToGeometries([s.geometry, this.circle(s.point, s.bufferKm)]);
  }

  private draw(): void {
    const sel = this.selected();
    const list = sel ? [sel] : this.items();
    this.map.setFilledAreas([
      ...list.map((h) => ({ geometry: h.bufferKm ? this.circle(h.point, h.bufferKm) : h.geometry, color: h.color, fill: 0.12 })),
      ...list.map((h) => ({ geometry: { type: 'Point', coordinates: h.point }, color: h.color, radius: sel ? 8 : 6 }))
    ]);
  }

  /** Geodesic circle as a polygon — for drawing the felt / buffer area. */
  private circle([lon, lat]: LonLat, km: number): Geo {
    const ring: LonLat[] = [];
    const r = km / 6371;
    const la = (lat * Math.PI) / 180;
    const lo = (lon * Math.PI) / 180;
    for (let i = 0; i <= 64; i++) {
      const b = (i / 64) * 2 * Math.PI;
      const la2 = Math.asin(Math.sin(la) * Math.cos(r) + Math.cos(la) * Math.sin(r) * Math.cos(b));
      const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(r) * Math.cos(la), Math.cos(r) - Math.sin(la) * Math.sin(la2));
      ring.push([(lo2 * 180) / Math.PI, (la2 * 180) / Math.PI]);
    }
    return { type: 'Polygon', coordinates: [ring] };
  }

  titleOf(id: string): string {
    return this.items().find((h) => h.id === id)?.title ?? id;
  }

  checkExposure(): void {
    const sel = this.selected();
    const areas = (sel ? [sel] : this.items().slice(0, 50)).map((h) => ({ id: h.id, geometry: h.geometry, bufferKm: h.bufferKm }));
    this.checking.set(true);
    this.error.set(null);
    this.http.post<Exposure>(`${environment.apiUrl}/gis/hazards/exposure`, { layerId: this.layerId(), areas }).subscribe({
      next: (r) => {
        r.areas.sort((a, b) => b.count - a.count);
        this.exposure.set(r);
        this.checking.set(false);
      },
      error: (e) => {
        this.error.set(e?.error?.message ?? 'Exposure check failed.');
        this.checking.set(false);
      }
    });
  }
}
