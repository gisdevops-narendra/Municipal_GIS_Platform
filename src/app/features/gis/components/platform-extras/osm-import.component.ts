import { Component, EventEmitter, Output, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { environment } from '../../../../../environments/environment';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { NotificationService } from '../../../../core/services/notification.service';
import { MapService } from '../../services/map.service';

type Geom = 'POINT' | 'LINE' | 'POLYGON';

const PRESETS: { id: string; label: string; geometry: Geom; icon: string }[] = [
  { id: 'buildings', label: 'Buildings', geometry: 'POLYGON', icon: 'pi-building' },
  { id: 'roads', label: 'Roads', geometry: 'LINE', icon: 'pi-directions' },
  { id: 'schools', label: 'Schools & colleges', geometry: 'POINT', icon: 'pi-book' },
  { id: 'health', label: 'Hospitals & clinics', geometry: 'POINT', icon: 'pi-heart' },
  { id: 'water', label: 'Water bodies', geometry: 'POLYGON', icon: 'pi-circle' },
  { id: 'waterways', label: 'Rivers, canals & drains', geometry: 'LINE', icon: 'pi-sliders-h' },
  { id: 'worship', label: 'Places of worship', geometry: 'POINT', icon: 'pi-star' },
  { id: 'parks', label: 'Parks & playgrounds', geometry: 'POLYGON', icon: 'pi-sun' },
  { id: 'landuse', label: 'Land use', geometry: 'POLYGON', icon: 'pi-th-large' },
  { id: 'shops', label: 'Shops & markets', geometry: 'POINT', icon: 'pi-shopping-cart' },
  { id: 'custom', label: 'Custom tag…', geometry: 'POINT', icon: 'pi-tag' }
];

/** Rough box area in km² from a lon/lat extent. */
function areaKm2([minX, minY, maxX, maxY]: number[]): number {
  const midLat = ((minY + maxY) / 2) * (Math.PI / 180);
  return (maxX - minX) * 111.32 * Math.cos(midLat) * (maxY - minY) * 110.54;
}

/** OSM Download: OpenStreetMap features in the current view as a new layer. */
@Component({
  selector: 'app-osm-import',
  standalone: true,
  imports: [FormsModule, ButtonModule, DecimalPipe],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      <p class="px__intro">Download OpenStreetMap data for the area on screen and save it as a new layer. Zoom to your ward or town first.</p>

      <div class="px__field">
        <span class="px__label">What to download</span>
        <div class="px__list" style="max-height: 230px">
          @for (p of presets; track p.id) {
            <div class="px__item px__item--click" [style.background]="preset() === p.id ? 'var(--color-surface-alt)' : null" (click)="pickPreset(p.id)">
              <i class="pi" [class]="'pi ' + p.icon" [style.color]="preset() === p.id ? 'var(--color-primary-600)' : 'var(--color-ink-500)'" aria-hidden="true"></i>
              <div class="px__item-main"><span class="px__item-title">{{ p.label }}</span></div>
              @if (preset() === p.id) { <i class="pi pi-check" style="color: var(--color-primary-600)"></i> }
            </div>
          }
        </div>
      </div>

      @if (preset() === 'custom') {
        <div class="px__row">
          <label class="px__field"><span class="px__label">Tag key</span>
            <input class="px__input" [ngModel]="customKey()" (ngModelChange)="customKey.set($event)" placeholder="amenity" /></label>
          <label class="px__field"><span class="px__label">Value (optional)</span>
            <input class="px__input" [ngModel]="customValue()" (ngModelChange)="customValue.set($event)" placeholder="bank" /></label>
        </div>
      }

      <div class="px__field">
        <span class="px__label">Save as</span>
        <div class="px__seg">
          <button type="button" class="px__seg-btn" [class.is-active]="geometry() === 'POINT'" (click)="geometry.set('POINT')">Points</button>
          <button type="button" class="px__seg-btn" [class.is-active]="geometry() === 'LINE'" (click)="geometry.set('LINE')">Lines</button>
          <button type="button" class="px__seg-btn" [class.is-active]="geometry() === 'POLYGON'" (click)="geometry.set('POLYGON')">Areas</button>
        </div>
      </div>

      <label class="px__field">
        <span class="px__label">Layer name</span>
        <input class="px__input" [ngModel]="name()" (ngModelChange)="name.set($event)" maxlength="120" [placeholder]="defaultName()" />
      </label>

      <div class="px__card">
        <dl class="px__kv">
          <dt>Area</dt>
          <dd>{{ area() === null ? '—' : area()! < 1 ? '< 1 km²' : (area()! | number) + ' km²' }}</dd>
        </dl>
        @if (tooLarge()) { <p class="px__warn">The view is too large — zoom in to about 80 × 80 km or less.</p> }
      </div>

      <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-cloud-download" label="Download to new layer"
              [loading]="busy()" [disabled]="tooLarge() || area() === null || (preset() === 'custom' && !customKey().trim())" (click)="run()"></button>
      @if (busy()) { <p class="px__hint">Fetching from OpenStreetMap — large areas can take a minute.</p> }
      @if (error(); as e) { <p class="px__error" role="alert">{{ e }}</p> }
      @if (done(); as d) {
        <div class="px__card">
          <span class="px__item-title">“{{ d.name }}” added</span>
          <span class="px__item-sub">{{ d.count.toLocaleString() }} features · licence ODbL (© OpenStreetMap contributors)</span>
        </div>
      }
    </div>
  `
})
export class OsmImportComponent {
  private readonly map = inject(MapService);
  private readonly http = inject(HttpClient);
  private readonly notify = inject(NotificationService);

  @Output() readonly layerCreated = new EventEmitter<GisLayer>();

  readonly presets = PRESETS;
  readonly preset = signal('buildings');
  readonly geometry = signal<Geom>('POLYGON');
  readonly customKey = signal('');
  readonly customValue = signal('');
  readonly name = signal('');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly done = signal<{ name: string; count: number } | null>(null);

  readonly extent = computed(() => {
    this.map.viewRevision();
    return this.map.currentExtent4326();
  });
  readonly area = computed(() => {
    const e = this.extent();
    return e ? Math.round(areaKm2(e)) : null;
  });
  readonly tooLarge = computed(() => {
    const e = this.extent();
    return !!e && (e[2] - e[0]) * (e[3] - e[1]) > 0.6;
  });
  readonly defaultName = computed(() => {
    if (this.preset() === 'custom') return `OSM ${this.customKey() || 'features'}${this.customValue() ? ' ' + this.customValue() : ''}`;
    return `OSM ${PRESETS.find((p) => p.id === this.preset())?.label ?? ''}`;
  });

  pickPreset(id: string): void {
    this.preset.set(id);
    this.geometry.set(PRESETS.find((p) => p.id === id)?.geometry ?? 'POINT');
  }

  run(): void {
    const e = this.extent();
    if (!e) return;
    const name = this.name().trim() || this.defaultName();
    this.busy.set(true);
    this.error.set(null);
    this.done.set(null);
    this.http
      .post<{ layer: GisLayer; featureCount: number }>(`${environment.apiUrl}/gis/osm-import`, {
        name,
        preset: this.preset(),
        ...(this.preset() === 'custom' ? { customKey: this.customKey().trim(), customValue: this.customValue().trim() || undefined } : {}),
        geometryType: this.geometry(),
        bbox: e.map((n) => Math.round(n * 1e6) / 1e6)
      })
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.done.set({ name, count: res.featureCount });
          this.name.set('');
          this.layerCreated.emit(res.layer);
          this.notify.success(`${res.featureCount.toLocaleString()} features saved to “${name}”.`);
        },
        error: (err) => {
          this.busy.set(false);
          const m = err?.error?.message;
          this.error.set(Array.isArray(m) ? m.join(', ') : m ?? 'The download failed.');
        }
      });
  }
}
