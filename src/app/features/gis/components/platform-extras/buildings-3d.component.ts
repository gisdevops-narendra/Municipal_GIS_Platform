import { Component, DestroyRef, Input, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../../../environments/environment';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { AnalyticsField } from '../../../../core/models/layer-analytics.model';
import { GisLayersService } from '../../../../core/services/gis-layers.service';
import { MapService } from '../../services/map.service';
import type { GlobeBuilding } from '../../services/globe-3d';

type HeightMode = 'field' | 'floors' | 'fixed';

const MAX_BUILDINGS = 5000;
/** Low → high, so taller blocks read darker. */
const RAMP = ['#efe7d6', '#e0c9a0', '#cfa06c', '#b8734a', '#8f4a35', '#5f2e2a'];

interface FeatureCollection {
  numberMatched?: number;
  features: { geometry: { type: string; coordinates: unknown } | null; properties: Record<string, unknown> }[];
}

/** 3D Buildings: extrude a polygon layer by a height / floors field in the
 *  3D view. */
@Component({
  selector: 'app-buildings-3d',
  standalone: true,
  imports: [FormsModule, ButtonModule],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      <p class="px__intro">Raise building footprints in the 3D view by a height or floor-count field. Buildings in the current view are loaded (up to {{ max }}).</p>

      @if (!polygonLayers().length) {
        <p class="px__hint">No polygon layer to extrude.</p>
      } @else {
        <label class="px__field">
          <span class="px__label">Building layer</span>
          <select class="px__native-select" [ngModel]="layerId()" (ngModelChange)="pickLayer($event)">
            @for (l of polygonLayers(); track l.id) { <option [value]="l.id">{{ l.name }}</option> }
          </select>
        </label>

        <div class="px__field">
          <span class="px__label">Height from</span>
          <div class="px__seg">
            <button type="button" class="px__seg-btn" [class.is-active]="mode() === 'field'" (click)="mode.set('field')">Height field</button>
            <button type="button" class="px__seg-btn" [class.is-active]="mode() === 'floors'" (click)="mode.set('floors')">Floors field</button>
            <button type="button" class="px__seg-btn" [class.is-active]="mode() === 'fixed'" (click)="mode.set('fixed')">Same height</button>
          </div>
        </div>

        @if (mode() !== 'fixed') {
          <label class="px__field">
            <span class="px__label">{{ mode() === 'field' ? 'Height field (metres)' : 'Floors field' }}</span>
            <select class="px__native-select" [ngModel]="field()" (ngModelChange)="field.set($event)">
              @for (f of numericFields(); track f.name) { <option [value]="f.name">{{ f.name }}</option> }
              @empty { <option value="">No number field</option> }
            </select>
          </label>
        }

        <div class="px__row">
          @if (mode() === 'floors') {
            <label class="px__field">
              <span class="px__label">Floor height (m)</span>
              <input class="px__input" type="number" min="1" max="10" step="0.1" [ngModel]="floorHeight()" (ngModelChange)="floorHeight.set(+$event)" />
            </label>
          }
          <label class="px__field">
            <span class="px__label">{{ mode() === 'fixed' ? 'Height (m)' : 'If empty (m)' }}</span>
            <input class="px__input" type="number" min="0" max="1000" step="0.5" [ngModel]="fallback()" (ngModelChange)="fallback.set(+$event)" />
          </label>
        </div>

        <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-box" label="Show buildings in 3D"
                [loading]="busy()" [disabled]="!layerId() || (mode() !== 'fixed' && !field())" (click)="show()"></button>

        @if (error(); as message) { <p class="px__error" role="alert">{{ message }}</p> }

        @if (shown(); as info) {
          <div class="px__card">
            <dl class="px__kv">
              <dt>Buildings</dt><dd>{{ info.count.toLocaleString() }}@if (info.total > info.count) { <span class="px__item-sub"> of {{ info.total.toLocaleString() }}</span> }</dd>
              <dt>Height</dt><dd>{{ info.min }}–{{ info.max }} m</dd>
            </dl>
            @if (info.total > info.count) { <p class="px__hint">Zoom in and reload to see the rest.</p> }
            <div class="px__links">
              <button pButton type="button" class="p-button-sm p-button-outlined" icon="pi pi-refresh" label="Reload view" (click)="show()"></button>
              <button pButton type="button" class="p-button-sm p-button-text" icon="pi pi-times" label="Clear" (click)="clear()"></button>
            </div>
          </div>
        }
      }
    </div>
  `
})
export class Buildings3dComponent {
  private readonly map = inject(MapService);
  private readonly http = inject(HttpClient);
  private readonly layersApi = inject(GisLayersService);

  @Input() set layers(value: GisLayer[] | null) {
    this.layersSignal.set(value ?? []);
    if (!this.layerId() && this.polygonLayers().length) this.pickLayer(this.polygonLayers()[0].id);
  }
  private readonly layersSignal = signal<GisLayer[]>([]);

  readonly max = MAX_BUILDINGS;
  readonly polygonLayers = computed(() =>
    this.layersSignal().filter((l) => l.layerType === 'VECTOR' && l.geometryType === 'POLYGON')
  );
  readonly layerId = signal<string>('');
  readonly fields = signal<AnalyticsField[]>([]);
  readonly numericFields = computed(() => this.fields().filter((f) => f.kind === 'number'));
  readonly mode = signal<HeightMode>('field');
  readonly field = signal('');
  readonly floorHeight = signal(3.2);
  readonly fallback = signal(6);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly shown = signal<{ count: number; total: number; min: number; max: number } | null>(null);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.map.setGlobeBuildings(null));
  }

  pickLayer(id: string): void {
    this.layerId.set(id);
    this.fields.set([]);
    this.field.set('');
    this.layersApi.analyticsFields(id).subscribe((fields) => {
      this.fields.set(fields);
      const numeric = fields.filter((f) => f.kind === 'number');
      const guess = (re: RegExp) => numeric.find((f) => re.test(f.name))?.name;
      const height = guess(/height|hgt|elev|ht$/i);
      const floors = guess(/floor|storey|story|levels?/i);
      if (height) {
        this.mode.set('field');
        this.field.set(height);
      } else if (floors) {
        this.mode.set('floors');
        this.field.set(floors);
      } else {
        this.field.set(numeric[0]?.name ?? '');
        if (!numeric.length) this.mode.set('fixed');
      }
    });
  }

  async show(): Promise<void> {
    const extent = this.map.currentExtent4326();
    if (!extent) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const bbox = extent.map((n) => n.toFixed(6)).join(',');
      const fc = await firstValueFrom(
        this.http.get<FeatureCollection>(`${environment.apiUrl}/gis/ogc/collections/${this.layerId()}/items`, {
          params: { bbox, limit: MAX_BUILDINGS }
        })
      );
      const heightOf = (props: Record<string, unknown>): number => {
        if (this.mode() === 'fixed') return this.fallback();
        const raw = Number(props[this.field()]);
        if (!Number.isFinite(raw) || raw <= 0) return this.fallback();
        return this.mode() === 'floors' ? raw * this.floorHeight() : raw;
      };
      const items: { rings: number[][][]; height: number }[] = [];
      for (const f of fc.features) {
        if (!f.geometry) continue;
        const h = Math.min(heightOf(f.properties), 1000);
        const polygons =
          f.geometry.type === 'Polygon'
            ? [f.geometry.coordinates as number[][][]]
            : f.geometry.type === 'MultiPolygon'
              ? (f.geometry.coordinates as number[][][][])
              : [];
        for (const rings of polygons) items.push({ rings, height: h });
      }
      if (!items.length) throw new Error('No building footprints in the current view.');
      const heights = items.map((i) => i.height);
      const min = Math.min(...heights);
      const max = Math.max(...heights);
      const color = (h: number) => RAMP[max > min ? Math.min(RAMP.length - 1, Math.floor(((h - min) / (max - min)) * RAMP.length)) : 2];
      const buildings: GlobeBuilding[] = items.map((i) => ({ ...i, color: color(i.height) }));
      this.map.setGlobeBuildings(buildings);
      if (!this.map.is3d()) await this.map.set3d(true);
      this.shown.set({
        count: fc.features.length,
        total: fc.numberMatched ?? fc.features.length,
        min: Math.round(min * 10) / 10,
        max: Math.round(max * 10) / 10
      });
    } catch (error) {
      const e = error as { error?: { message?: string }; message?: string };
      this.error.set(e.error?.message ?? e.message ?? 'Could not load the buildings.');
    } finally {
      this.busy.set(false);
    }
  }

  clear(): void {
    this.map.setGlobeBuildings(null);
    this.shown.set(null);
  }
}
