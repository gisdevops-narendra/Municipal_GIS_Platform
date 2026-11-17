import { Component, DestroyRef, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { Subscription } from 'rxjs';
import { environment } from '../../../../../environments/environment';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { NotificationService } from '../../../../core/services/notification.service';
import { MapService } from '../../services/map.service';
import { NetworkService } from '../../services/network.service';

type LonLat = [number, number];
type Tab = 'explore' | 'trail' | 'facilities' | 'guide';

interface Place {
  key: string;
  name: string;
  kind: string;
  category: string;
  point: LonLat;
  distanceM: number;
  source: 'osm' | 'wiki';
  summary?: string;
  thumb?: string;
  url?: string;
  website?: string;
  hours?: string;
}

interface Facility {
  type: FacilityType;
  point: LonLat;
  name: string;
}

type FacilityType = 'toilets' | 'parking' | 'atm' | 'food' | 'water' | 'bus' | 'stay' | 'medical' | 'police';

const FACILITY_LABELS: Record<FacilityType, [string, string]> = {
  toilets: ['Toilets', 'pi-users'],
  parking: ['Parking', 'pi-car'],
  atm: ['ATM / bank', 'pi-wallet'],
  food: ['Food', 'pi-shop'],
  water: ['Drinking water', 'pi-filter'],
  bus: ['Bus stop', 'pi-directions'],
  stay: ['Stay', 'pi-home'],
  medical: ['Medical', 'pi-heart'],
  police: ['Police', 'pi-shield']
};
const CHECKED: FacilityType[] = ['toilets', 'parking', 'food', 'water', 'atm', 'bus', 'medical'];

const CATEGORY_COLORS: Record<string, string> = {
  Heritage: '#b45309',
  Museum: '#7c3aed',
  Viewpoint: '#0891b2',
  Nature: '#16a34a',
  Religious: '#db2777',
  Attraction: '#2563eb',
  Wikipedia: '#475569'
};

const LANGS = [
  { id: 'en', label: 'English' },
  { id: 'hi', label: 'हिन्दी' },
  { id: 'mr', label: 'मराठी' },
  { id: 'gu', label: 'ગુજરાતી' },
  { id: 'ta', label: 'தமிழ்' },
  { id: 'te', label: 'తెలుగు' },
  { id: 'kn', label: 'ಕನ್ನಡ' },
  { id: 'ml', label: 'മലയാളം' },
  { id: 'bn', label: 'বাংলা' }
];

const OVERPASS = 'https://overpass-api.de/api/interpreter';

function haversine(a: LonLat, b: LonLat): number {
  const r = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/** OSM element → tourism category. */
function categorize(tags: Record<string, string>): [string, string] {
  const t = tags['tourism'];
  const h = tags['historic'];
  if (t === 'museum' || t === 'gallery') return ['Museum', t];
  if (t === 'viewpoint') return ['Viewpoint', 'viewpoint'];
  if (h) return ['Heritage', h.replace(/_/g, ' ')];
  if (tags['amenity'] === 'place_of_worship') return ['Religious', tags['religion'] ?? 'place of worship'];
  if (tags['leisure'] || tags['natural'] || t === 'zoo') return ['Nature', (tags['leisure'] ?? tags['natural'] ?? t).replace(/_/g, ' ')];
  return ['Attraction', (t ?? 'attraction').replace(/_/g, ' ')];
}

function facilityType(tags: Record<string, string>): FacilityType | null {
  const a = tags['amenity'];
  if (a === 'toilets') return 'toilets';
  if (a === 'parking' || a === 'parking_space') return 'parking';
  if (a === 'atm' || a === 'bank') return 'atm';
  if (a === 'restaurant' || a === 'cafe' || a === 'fast_food' || a === 'food_court') return 'food';
  if (a === 'drinking_water') return 'water';
  if (a === 'bus_station' || tags['highway'] === 'bus_stop') return 'bus';
  if (a === 'hospital' || a === 'clinic' || a === 'pharmacy' || a === 'doctors') return 'medical';
  if (a === 'police') return 'police';
  if (/^(hotel|guest_house|hostel|motel)$/.test(tags['tourism'] ?? '')) return 'stay';
  return null;
}

/**
 * Tourism: attractions around a point (OpenStreetMap + Wikipedia, with
 * photos and summaries), a trail through chosen places, visitor-facility
 * gaps near each attraction and the Wikivoyage city guide. All from free
 * services that need no key or sign-in.
 */
@Component({
  selector: 'app-tourism',
  standalone: true,
  imports: [FormsModule, ButtonModule],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      <div class="px__tabs" style="grid-template-columns: repeat(4, 1fr)" role="tablist">
        @for (t of tabs; track t.id) {
          <button type="button" role="tab" class="px__tab" [class.is-active]="tab() === t.id" [title]="t.title" (click)="openTab(t.id)">{{ t.label }}</button>
        }
      </div>

      @if (tab() !== 'guide') {
        <div class="px__card" style="flex-direction: row; align-items: center; gap: 8px">
          <i class="pi pi-map-marker" style="color: var(--color-primary-600)"></i>
          <div class="px__item-main">
            <span class="px__item-title">{{ placeIsCentre() ? 'Map centre' : 'Picked point' }}</span>
            @if (centre(); as c) { <span class="px__item-sub px__mono">{{ c[1].toFixed(4) }}, {{ c[0].toFixed(4) }}</span> }
          </div>
          <button type="button" class="px__icon-btn" title="Use the map centre" (click)="useCentre()"><i class="pi pi-compass"></i></button>
          <button type="button" class="px__icon-btn" [title]="picking() ? 'Cancel' : 'Pick a point on the map'" (click)="picking() ? cancelPick() : pick()">
            <i class="pi" [class.pi-map]="!picking()" [class.pi-times]="picking()"></i>
          </button>
        </div>
      }

      @switch (tab()) {
        <!-- ================= Explore ================= -->
        @case ('explore') {
          <div class="px__row">
            <label class="px__field"><span class="px__label">Within</span>
              <select class="px__native-select" [ngModel]="radiusKm()" (ngModelChange)="radiusKm.set(+$event)">
                @for (r of [1, 2, 5, 10]; track r) { <option [value]="r">{{ r }} km</option> }
              </select></label>
            <label class="px__field"><span class="px__label">Wikipedia language</span>
              <select class="px__native-select" [ngModel]="lang()" (ngModelChange)="lang.set($event)">
                @for (l of langs; track l.id) { <option [value]="l.id">{{ l.label }}</option> }
              </select></label>
          </div>
          <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-search" label="Find attractions" [loading]="loading()" (click)="explore()"></button>
          @if (error(); as e) { <p class="px__error">{{ e }}</p> }

          @if (places().length) {
            <div class="px__secret" style="flex-wrap: wrap; gap: 6px">
              @for (c of categories(); track c.name) {
                <button type="button" class="px__badge" style="cursor: pointer" [style.border-color]="color(c.name)" [style.color]="color(c.name)"
                        [style.font-weight]="catFilter() === c.name ? 700 : 400" (click)="catFilter.set(catFilter() === c.name ? '' : c.name)">{{ c.name }} {{ c.count }}</button>
              }
            </div>
            <div class="px__list" style="max-height: none">
              @for (p of filteredPlaces(); track p.key) {
                <div class="px__item" style="align-items: flex-start">
                  <input type="checkbox" style="margin-top: 3px" [checked]="chosen().has(p.key)" (change)="toggleChosen(p)" [attr.aria-label]="'Add ' + p.name + ' to the trail'" title="Add to trail" />
                  @if (p.thumb) { <img [src]="p.thumb" alt="" style="width: 54px; height: 54px; object-fit: cover; border-radius: 6px; flex: none" loading="lazy" /> }
                  <div class="px__item-main" style="cursor: pointer" (click)="zoomTo(p)">
                    <span class="px__item-title" style="white-space: normal">{{ p.name }}</span>
                    <span class="px__item-sub"><span [style.color]="color(p.category)">●</span> {{ p.kind }} · {{ dist(p.distanceM) }}@if (p.hours) { · {{ p.hours }} }</span>
                    @if (p.summary) { <span class="px__item-sub" style="white-space: normal; -webkit-line-clamp: 3; display: -webkit-box; -webkit-box-orient: vertical">{{ p.summary }}</span> }
                    <span style="display: flex; gap: 10px; font-size: 11px">
                      @if (p.url) { <a [href]="p.url" target="_blank" rel="noopener noreferrer" (click)="$event.stopPropagation()">Wikipedia</a> }
                      @if (p.website) { <a [href]="p.website" target="_blank" rel="noopener noreferrer" (click)="$event.stopPropagation()">Website</a> }
                      <a [href]="'https://www.openstreetmap.org/directions?to=' + p.point[1] + ',' + p.point[0]" target="_blank" rel="noopener noreferrer" (click)="$event.stopPropagation()">Directions</a>
                    </span>
                  </div>
                </div>
              }
            </div>
            <span class="px__item-sub">{{ chosen().size }} selected for the trail · tick places, then open Trail.</span>
            <button pButton type="button" class="p-button-sm p-button-outlined px__btn-block" icon="pi pi-save" label="Save attractions in view as a layer" [loading]="saving()" (click)="saveLayer()"></button>
          }
        }

        <!-- ================= Trail ================= -->
        @case ('trail') {
          @if (!chosenPlaces().length) {
            <p class="px__hint">Tick 2–25 places in Explore to plan a trail through them.</p>
          } @else {
            <p class="px__intro">Best visiting order for {{ chosenPlaces().length }} places, starting from the {{ placeIsCentre() ? 'map centre' : 'picked point' }}.</p>
            <div class="px__row">
              @if (roadLayers().length) {
                <label class="px__field"><span class="px__label">Road network</span>
                  <select class="px__native-select" [ngModel]="roadId()" (ngModelChange)="roadId.set($event)">
                    <option value="">Straight lines</option>
                    @for (l of roadLayers(); track l.id) { <option [value]="l.id">{{ l.name }}</option> }
                  </select></label>
              }
              <label class="px__field"><span class="px__label">Pace</span>
                <select class="px__native-select" [ngModel]="pace()" (ngModelChange)="pace.set($event)">
                  <option value="walk">Walking</option>
                  <option value="drive">Driving</option>
                </select></label>
            </div>
            <label class="px__check"><input type="checkbox" [ngModel]="roundTrip()" (ngModelChange)="roundTrip.set($event)" /> Return to the start</label>
            <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-directions" label="Plan trail" [loading]="loading()" (click)="planTrail()"></button>
            @if (error(); as e) { <p class="px__error">{{ e }}</p> }
            @if (trail(); as t) {
              <div class="px__card">
                <dl class="px__kv">
                  <dt>Distance</dt><dd>{{ dist(t.lengthM) }}{{ t.byRoad ? '' : ' (straight line)' }}</dd>
                  <dt>Travel time</dt><dd>{{ hm(t.lengthM / (pace() === 'walk' ? 75 : 400)) }}</dd>
                  <dt>With 30 min per place</dt><dd>{{ hm(t.lengthM / (pace() === 'walk' ? 75 : 400) + t.stops.length * 30) }}</dd>
                </dl>
              </div>
              <ol style="margin: 0; padding-left: 20px; font-size: 12.5px; display: flex; flex-direction: column; gap: 4px">
                @for (s of t.stops; track $index) { <li>{{ s.name }}</li> }
              </ol>
              <a class="px__link-btn" [href]="t.mapsUrl" target="_blank" rel="noopener noreferrer"><i class="pi pi-external-link"></i>Open in Google Maps</a>
            }
          }
        }

        <!-- ================= Facilities ================= -->
        @case ('facilities') {
          <p class="px__intro">Visitor facilities near each attraction — find tourist spots missing toilets, parking, food or water.</p>
          <label class="px__field"><span class="px__label">Counted if within</span>
            <select class="px__native-select" [ngModel]="facilityM()" (ngModelChange)="facilityM.set(+$event)">
              @for (m of [250, 500, 1000]; track m) { <option [value]="m">{{ m }} m</option> }
            </select></label>
          <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-check-square" label="Check facilities" [loading]="loading()"
                  [disabled]="!places().length" (click)="checkFacilities()"></button>
          @if (!places().length) { <p class="px__hint">Find attractions in Explore first.</p> }
          @if (error(); as e) { <p class="px__error">{{ e }}</p> }
          @if (facilityRows().length) {
            <div class="px__secret" style="flex-wrap: wrap; gap: 6px">
              @for (f of checked; track f) { <span class="px__item-sub"><i class="pi" [class]="'pi ' + facIcon(f)"></i> {{ facLabel(f) }}</span> }
            </div>
            <div class="px__list" style="max-height: none">
              @for (row of facilityRows(); track row.place.key) {
                <div class="px__item px__item--click" style="flex-wrap: wrap" (click)="zoomTo(row.place)">
                  <div class="px__item-main">
                    <span class="px__item-title" style="white-space: normal">{{ row.place.name }}</span>
                    <span class="px__item-sub" [style.color]="row.missing.length ? 'var(--color-error-600)' : 'var(--color-success-600)'">
                      {{ row.missing.length ? 'Missing: ' + row.missing.map(facLabel).join(', ') : 'All basic facilities nearby' }}
                    </span>
                  </div>
                  <span style="display: flex; gap: 6px; flex-basis: 100%">
                    @for (f of checked; track f) {
                      <span class="px__badge" [title]="facLabel(f) + ': ' + row.counts[f]" [style.opacity]="row.counts[f] ? 1 : 0.35">
                        <i class="pi" [class]="'pi ' + facIcon(f)" style="font-size: 10px"></i> {{ row.counts[f] }}
                      </span>
                    }
                  </span>
                </div>
              }
            </div>
            <span class="px__item-sub">{{ gapCount() }} of {{ facilityRows().length }} attractions miss at least one basic facility.</span>
          }
        }

        <!-- ================= Guide ================= -->
        @case ('guide') {
          <p class="px__intro">Free travel guide from Wikivoyage — what to see, do, eat and how to get around.</p>
          <div class="px__secret">
            <input class="px__input" style="flex: 1" [ngModel]="guideQuery()" (ngModelChange)="guideQuery.set($event)" (keydown.enter)="loadGuide()" placeholder="City or town name" />
            <button pButton type="button" class="p-button-sm" icon="pi pi-search" [loading]="loading()" (click)="loadGuide()" aria-label="Load guide"></button>
          </div>
          @if (error(); as e) { <p class="px__error">{{ e }}</p> }
          @if (guide(); as g) {
            <div class="px__item-title" style="font-size: 15px">{{ g.title }}</div>
            @for (s of g.sections; track s.title; let i = $index) {
              <details class="px__card" [open]="i === 0">
                <summary style="cursor: pointer; font-weight: 600; font-size: 12.5px">{{ s.title }}</summary>
                <p class="px__intro" style="white-space: pre-line; color: var(--color-ink-700)">{{ s.text }}</p>
              </details>
            }
            <a class="px__link-btn" [href]="g.url" target="_blank" rel="noopener noreferrer"><i class="pi pi-external-link"></i>Read on Wikivoyage</a>
          }
        }
      }
      <p class="px__hint" style="font-size: 10.5px">Data: © OpenStreetMap contributors (ODbL), Wikipedia & Wikivoyage (CC BY-SA).</p>
    </div>
  `
})
export class TourismComponent {
  private readonly map = inject(MapService);
  private readonly http = inject(HttpClient);
  private readonly network = inject(NetworkService);
  private readonly notify = inject(NotificationService);

  @Output() readonly layerCreated = new EventEmitter<GisLayer>();
  @Input() set layers(value: GisLayer[] | null) {
    this.layersSignal.set(value ?? []);
  }
  @Input() set municipalityName(value: string | null) {
    if (value && !this.guideQuery()) this.guideQuery.set(value);
  }
  private readonly layersSignal = signal<GisLayer[]>([]);
  readonly roadLayers = computed(() => this.layersSignal().filter((l) => l.layerType === 'VECTOR' && l.geometryType === 'LINE' && l.routingEnabled));

  readonly tabs: { id: Tab; label: string; title: string }[] = [
    { id: 'explore', label: 'Explore', title: 'Attractions nearby' },
    { id: 'trail', label: 'Trail', title: 'Plan a trail' },
    { id: 'facilities', label: 'Facilities', title: 'Visitor facilities check' },
    { id: 'guide', label: 'Guide', title: 'Wikivoyage city guide' }
  ];
  readonly langs = LANGS;
  readonly checked = CHECKED;

  readonly tab = signal<Tab>('explore');
  readonly centre = signal<LonLat | null>(null);
  readonly placeIsCentre = signal(true);
  readonly picking = signal(false);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  private pickSub: Subscription | null = null;

  readonly radiusKm = signal(5);
  readonly lang = signal('en');
  readonly places = signal<Place[]>([]);
  readonly catFilter = signal('');
  readonly chosen = signal<Set<string>>(new Set());
  readonly chosenPlaces = computed(() => this.places().filter((p) => this.chosen().has(p.key)));

  readonly roadId = signal('');
  readonly pace = signal<'walk' | 'drive'>('walk');
  readonly roundTrip = signal(false);
  readonly trail = signal<{ stops: Place[]; lengthM: number; byRoad: boolean; mapsUrl: string } | null>(null);

  readonly facilityM = signal(500);
  readonly facilityRows = signal<{ place: Place; counts: Record<FacilityType, number>; missing: FacilityType[] }[]>([]);
  readonly gapCount = computed(() => this.facilityRows().filter((r) => r.missing.length).length);

  readonly guideQuery = signal('');
  readonly guide = signal<{ title: string; url: string; sections: { title: string; text: string }[] } | null>(null);

  readonly categories = computed(() => {
    const counts = new Map<string, number>();
    for (const p of this.places()) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  });
  readonly filteredPlaces = computed(() => this.places().filter((p) => !this.catFilter() || p.category === this.catFilter()));

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.cancelPick();
      this.map.setFilledAreas(null);
      this.map.clearAnalysisGeometry();
      this.map.markLocation(null);
    });
    queueMicrotask(() => this.useCentre());
  }

  color = (category: string) => CATEGORY_COLORS[category] ?? '#2563eb';
  facLabel = (f: FacilityType) => FACILITY_LABELS[f][0];
  facIcon = (f: FacilityType) => FACILITY_LABELS[f][1];
  dist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
  hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${Math.round(min)} min`);

  openTab(tab: Tab): void {
    this.tab.set(tab);
    this.error.set(null);
  }

  useCentre(): void {
    const view = this.map.viewSnapshot();
    if (!view) return;
    this.cancelPick();
    this.placeIsCentre.set(true);
    this.centre.set(view.center);
    this.map.markLocation(null);
  }

  pick(): void {
    this.cancelPick();
    this.picking.set(true);
    this.pickSub = this.map.pickMapPoint().subscribe(({ lonLat }) => {
      this.picking.set(false);
      this.placeIsCentre.set(false);
      this.centre.set(lonLat);
      this.map.markLocation(lonLat);
    });
  }

  cancelPick(): void {
    this.pickSub?.unsubscribe();
    this.pickSub = null;
    if (this.picking()) this.map.cancelMapPick();
    this.picking.set(false);
  }

  private async overpass(query: string): Promise<{ elements: { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[] }> {
    const res = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: query }) });
    if (res.status === 429 || res.status === 504) throw new Error('OpenStreetMap is busy — try again in a minute');
    if (!res.ok) throw new Error(`OpenStreetMap HTTP ${res.status}`);
    return res.json();
  }

  // ----- Explore -----
  async explore(): Promise<void> {
    const c = this.centre();
    if (!c) return;
    const r = this.radiusKm() * 1000;
    this.loading.set(true);
    this.error.set(null);
    this.trail.set(null);
    this.facilityRows.set([]);
    try {
      const around = `(around:${r},${c[1]},${c[0]})`;
      const query =
        `[out:json][timeout:30];(` +
        `nwr["tourism"~"^(attraction|museum|viewpoint|gallery|zoo|theme_park|aquarium|artwork)$"]["name"]${around};` +
        `nwr["historic"~"^(monument|memorial|fort|castle|ruins|archaeological_site|palace|city_gate|heritage|tomb|temple)$"]["name"]${around};` +
        `nwr["amenity"="place_of_worship"]["wikidata"]${around};` +
        `nwr["leisure"~"^(park|garden|nature_reserve)$"]["name"]["wikidata"]${around};` +
        `nwr["natural"~"^(peak|waterfall|beach|cave_entrance)$"]["name"]${around};` +
        `);out center tags 300;`;
      const [osm, wiki] = await Promise.all([this.overpass(query), this.wikiNearby(c, Math.min(r, 10_000)).catch(() => [] as Place[])]);
      const osmPlaces: Place[] = osm.elements
        .map((el) => {
          const tags = el.tags ?? {};
          const lat = el.lat ?? el.center?.lat;
          const lon = el.lon ?? el.center?.lon;
          if (lat === undefined || lon === undefined || !tags['name']) return null;
          const [category, kind] = categorize(tags);
          const point: LonLat = [lon, lat];
          return {
            key: `osm-${el.type}-${el.id}`,
            name: tags[`name:${this.lang()}`] ?? tags['name'],
            kind,
            category,
            point,
            distanceM: haversine(c, point),
            source: 'osm' as const,
            website: tags['website'] ?? tags['contact:website'],
            hours: tags['opening_hours'],
            url: tags['wikipedia'] ? this.wikiUrlFromTag(tags['wikipedia']) : undefined
          };
        })
        .filter((p): p is NonNullable<typeof p> => !!p);
      // Merge: a Wikipedia article within 150 m of an OSM place with a
      // similar name enriches it; the rest are listed on their own.
      const merged = [...osmPlaces];
      for (const w of wiki) {
        const twin = merged.find((p) => p.source === 'osm' && haversine(p.point, w.point) < 150 && this.similar(p.name, w.name));
        if (twin) Object.assign(twin, { summary: w.summary, thumb: w.thumb, url: w.url ?? twin.url });
        else merged.push(w);
      }
      merged.sort((a, b) => a.distanceM - b.distanceM);
      this.places.set(merged.slice(0, 300));
      this.chosen.set(new Set());
      if (!merged.length) this.error.set('No attractions found here — try a bigger distance.');
      this.drawPlaces();
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  private similar(a: string, b: string): boolean {
    const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9ऀ-෿]/g, '');
    const x = n(a);
    const y = n(b);
    return !!x && !!y && (x.includes(y) || y.includes(x));
  }

  private wikiUrlFromTag(tag: string): string {
    const [lang, ...title] = tag.split(':');
    return title.length ? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.join(':').replace(/ /g, '_'))}` : `https://en.wikipedia.org/wiki/${encodeURIComponent(tag)}`;
  }

  /** Wikipedia articles near a point, with summary and photo. */
  private async wikiNearby(c: LonLat, radiusM: number): Promise<Place[]> {
    const base = `https://${this.lang()}.wikipedia.org/w/api.php`;
    const geo = await (
      await fetch(`${base}?action=query&list=geosearch&gscoord=${c[1]}|${c[0]}&gsradius=${Math.round(radiusM)}&gslimit=50&format=json&origin=*`)
    ).json();
    const hits = (geo?.query?.geosearch ?? []) as { pageid: number; title: string; lat: number; lon: number; dist: number }[];
    if (!hits.length) return [];
    const info = await (
      await fetch(
        `${base}?action=query&prop=extracts|pageimages|info&inprop=url&exintro=1&explaintext=1&exsentences=2&exlimit=20&piprop=thumbnail&pithumbsize=160&pilimit=50&pageids=${hits
          .slice(0, 50)
          .map((h) => h.pageid)
          .join('|')}&format=json&origin=*`
      )
    ).json();
    const pages = (info?.query?.pages ?? {}) as Record<string, { extract?: string; thumbnail?: { source: string }; fullurl?: string }>;
    return hits.map((h) => ({
      key: `wiki-${h.pageid}`,
      name: h.title,
      kind: 'Wikipedia article',
      category: 'Wikipedia',
      point: [h.lon, h.lat] as LonLat,
      distanceM: h.dist,
      source: 'wiki' as const,
      summary: pages[h.pageid]?.extract || undefined,
      thumb: pages[h.pageid]?.thumbnail?.source,
      url: pages[h.pageid]?.fullurl
    }));
  }

  private drawPlaces(): void {
    const byCat = new Map<string, LonLat[]>();
    for (const p of this.places()) byCat.set(p.category, [...(byCat.get(p.category) ?? []), p.point]);
    this.map.setFilledAreas(
      [...byCat.entries()].map(([cat, pts]) => ({ geometry: { type: 'MultiPoint', coordinates: pts }, color: this.color(cat), radius: cat === 'Wikipedia' ? 4 : 6 }))
    );
  }

  toggleChosen(p: Place): void {
    this.chosen.update((set) => {
      const next = new Set(set);
      if (next.has(p.key)) next.delete(p.key);
      else if (next.size < 25) next.add(p.key);
      else this.notify.info('A trail can have at most 25 places.');
      return next;
    });
  }

  zoomTo(p: Place): void {
    this.map.zoomToGeometries([{ type: 'Point', coordinates: p.point }]);
  }

  /** Attractions in the current view → a new point layer (server-side OSM download). */
  saveLayer(): void {
    const e = this.map.currentExtent4326();
    if (!e) return;
    this.saving.set(true);
    this.http
      .post<{ layer: GisLayer; featureCount: number }>(`${environment.apiUrl}/gis/osm-import`, {
        name: `Tourist attractions ${new Date().toISOString().slice(0, 10)}`,
        preset: 'custom',
        customKey: 'tourism',
        geometryType: 'POINT',
        bbox: e.map((n) => Math.round(n * 1e6) / 1e6)
      })
      .subscribe({
        next: (r) => {
          this.saving.set(false);
          this.layerCreated.emit(r.layer);
          this.notify.success(`${r.featureCount} tourism features saved as a layer.`);
        },
        error: (err) => {
          this.saving.set(false);
          const m = err?.error?.message;
          this.notify.error(Array.isArray(m) ? m.join(', ') : m ?? 'Could not save the layer.');
        }
      });
  }

  // ----- Trail -----
  async planTrail(): Promise<void> {
    const start = this.centre();
    const picks = this.chosenPlaces();
    if (!start || !picks.length) return;
    this.loading.set(true);
    this.error.set(null);
    const stops: LonLat[] = [start, ...picks.map((p) => p.point)];
    const finish = (order: number[], lengthM: number, path: LonLat[][] | null, byRoad: boolean) => {
      const visit = order.filter((i) => i > 0).map((i) => picks[i - 1]);
      const seq = [start, ...visit.map((p) => p.point), ...(this.roundTrip() ? [start] : [])];
      this.trail.set({
        stops: visit,
        lengthM,
        byRoad,
        mapsUrl: `https://www.google.com/maps/dir/${seq.map((p) => `${p[1]},${p[0]}`).join('/')}`
      });
      this.map.setAnalysisColoredGeometries([
        { geometry: { type: 'MultiLineString', coordinates: path ?? [seq] }, color: '#7c3aed' },
        { geometry: { type: 'MultiPoint', coordinates: visit.map((p) => p.point) }, color: '#7c3aed' },
        { geometry: { type: 'Point', coordinates: start }, color: '#111827' }
      ]);
      this.map.zoomToGeometries([{ type: 'MultiPoint', coordinates: seq }]);
      this.loading.set(false);
    };
    if (this.roadId() && stops.length >= 2) {
      this.network.route(this.roadId(), { stops, optimize: true, roundTrip: this.roundTrip() }).subscribe({
        next: (r) => finish(r.order, r.lengthM, r.path.coordinates, true),
        error: (e) => {
          this.loading.set(false);
          this.error.set(e?.error?.message ?? 'Routing failed — try straight lines.');
        }
      });
      return;
    }
    // Straight lines: nearest neighbour, then 2-opt.
    const d = (a: number, b: number) => haversine(stops[a], stops[b]);
    const order = [0];
    const left = new Set(stops.map((_, i) => i).slice(1));
    while (left.size) {
      const last = order[order.length - 1];
      let best = -1;
      for (const i of left) if (best < 0 || d(last, i) < d(last, best)) best = i;
      order.push(best);
      left.delete(best);
    }
    const total = (o: number[]) => o.slice(1).reduce((s, v, i) => s + d(o[i], v), 0) + (this.roundTrip() ? d(o[o.length - 1], 0) : 0);
    for (let improved = true, n = 0; improved && n < 50; n++) {
      improved = false;
      for (let i = 1; i < order.length - 1; i++) {
        for (let k = i + 1; k < order.length; k++) {
          const cand = [...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)];
          if (total(cand) < total(order) - 1) {
            order.splice(0, order.length, ...cand);
            improved = true;
          }
        }
      }
    }
    finish(order, total(order), null, false);
  }

  // ----- Facilities -----
  async checkFacilities(): Promise<void> {
    const c = this.centre();
    const list = this.places().filter((p) => p.source === 'osm').slice(0, 150);
    if (!c || !list.length) return;
    const reach = Math.max(...list.map((p) => p.distanceM)) + this.facilityM();
    this.loading.set(true);
    this.error.set(null);
    try {
      const around = `(around:${Math.round(reach)},${c[1]},${c[0]})`;
      const res = await this.overpass(
        `[out:json][timeout:40];(` +
          `nwr["amenity"~"^(toilets|parking|atm|bank|restaurant|cafe|fast_food|food_court|drinking_water|bus_station|hospital|clinic|pharmacy|doctors|police)$"]${around};` +
          `node["highway"="bus_stop"]${around};` +
          `nwr["tourism"~"^(hotel|guest_house|hostel|motel)$"]${around};` +
          `);out center tags 5000;`
      );
      const facilities: Facility[] = res.elements
        .map((el) => {
          const tags = el.tags ?? {};
          const type = facilityType(tags);
          const lat = el.lat ?? el.center?.lat;
          const lon = el.lon ?? el.center?.lon;
          return type && lat !== undefined && lon !== undefined ? { type, point: [lon, lat] as LonLat, name: tags['name'] ?? '' } : null;
        })
        .filter((f): f is Facility => !!f);
      const rows = list.map((place) => {
        const counts = Object.fromEntries(Object.keys(FACILITY_LABELS).map((k) => [k, 0])) as Record<FacilityType, number>;
        for (const f of facilities) if (haversine(place.point, f.point) <= this.facilityM()) counts[f.type]++;
        const missing = (['toilets', 'parking', 'food', 'water'] as FacilityType[]).filter((f) => !counts[f]);
        return { place, counts, missing };
      });
      this.facilityRows.set(rows.sort((a, b) => b.missing.length - a.missing.length));
      this.map.setFilledAreas([
        { geometry: { type: 'MultiPoint', coordinates: rows.filter((r) => r.missing.length).map((r) => r.place.point) }, color: '#dc2626', radius: 7 },
        { geometry: { type: 'MultiPoint', coordinates: rows.filter((r) => !r.missing.length).map((r) => r.place.point) }, color: '#16a34a', radius: 6 },
        { geometry: { type: 'MultiPoint', coordinates: facilities.filter((f) => f.type === 'toilets').map((f) => f.point) }, color: '#0891b2', radius: 3 }
      ]);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  // ----- Guide -----
  async loadGuide(): Promise<void> {
    const q = this.guideQuery().trim();
    if (!q) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      const base = 'https://en.wikivoyage.org/w/api.php';
      const search = await (await fetch(`${base}?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=1&format=json&origin=*`)).json();
      const title = search?.query?.search?.[0]?.title as string | undefined;
      if (!title) throw new Error(`No Wikivoyage guide for "${q}".`);
      const page = await (
        await fetch(`${base}?action=query&prop=extracts|info&inprop=url&explaintext=1&exsectionformat=wiki&titles=${encodeURIComponent(title)}&redirects=1&format=json&origin=*`)
      ).json();
      const p = Object.values(page?.query?.pages ?? {})[0] as { title: string; extract?: string; fullurl?: string } | undefined;
      if (!p?.extract) throw new Error('The guide is empty.');
      const parts = p.extract.split(/\n(?=== [^=])/);
      const sections = parts
        .map((part, i) => {
          const m = part.match(/^== (.+?) ==\n?([\s\S]*)$/);
          const title = i === 0 && !m ? 'Overview' : (m?.[1] ?? 'Overview');
          const text = (m ? m[2] : part).replace(/^=== (.+?) ===$/gm, '— $1 —').replace(/\n{3,}/g, '\n\n').trim();
          return { title, text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text };
        })
        .filter((s) => s.text.length > 30 && !/^(Go next|Connect|Stay safe)$/i.test(s.title));
      this.guide.set({ title: p.title, url: p.fullurl ?? `https://en.wikivoyage.org/wiki/${encodeURIComponent(p.title)}`, sections });
    } catch (e) {
      this.error.set((e as Error).message);
      this.guide.set(null);
    } finally {
      this.loading.set(false);
    }
  }
}
