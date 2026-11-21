import { Component, Input, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { environment } from '../../../../../environments/environment';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { NotificationService } from '../../../../core/services/notification.service';
import { MapService } from '../../services/map.service';

interface LayerMetadata {
  source?: string;
  licence?: string;
  keywords?: string[];
  contact?: string;
  updateFrequency?: string;
  dataDate?: string;
  notes?: string;
}

interface CatalogEntry {
  id: string;
  name: string;
  code: string;
  description: string | null;
  layerType: 'VECTOR' | 'RASTER';
  geometryType: 'POINT' | 'LINE' | 'POLYGON' | null;
  status: string;
  ownershipType: string;
  featureCount: number | null;
  bbox: [number, number, number, number] | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  aiGenerated: boolean;
  drawnLayer: boolean;
  metadata: LayerMetadata;
  canEdit: boolean;
}

const FREQUENCIES = [
  { value: '', label: 'Not set' },
  { value: 'once', label: 'One-off' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'as-needed', label: 'As needed' }
];

/** Data Catalog: every layer you can see, searchable, with its source,
 *  licence, keywords, contact and update details. */
@Component({
  selector: 'app-data-catalog',
  standalone: true,
  imports: [FormsModule, ButtonModule, DatePipe, DecimalPipe],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      @if (selected(); as e) {
        <!-- ===== Detail ===== -->
        <button type="button" class="px__link-btn" style="align-self: flex-start" (click)="back()"><i class="pi pi-arrow-left"></i>All layers</button>

        <div>
          <div class="px__item-title" style="font-size: 15px; white-space: normal">{{ e.name }}</div>
          <span class="px__item-sub">{{ typeLabel(e) }}</span>
        </div>

        @if (!editing()) {
          @if (e.description) { <p class="px__intro" style="color: var(--color-ink-700)">{{ e.description }}</p> }
          @else { <p class="px__hint">No description yet.</p> }

          @if (e.metadata.keywords?.length) {
            <div style="display: flex; flex-wrap: wrap; gap: 4px">
              @for (k of e.metadata.keywords; track k) { <span class="px__badge">{{ k }}</span> }
            </div>
          }

          <div class="px__section">
            <h4>About the data</h4>
            <dl class="px__kv">
              <dt>Source</dt><dd>{{ e.metadata.source || '—' }}</dd>
              <dt>Licence</dt><dd>{{ e.metadata.licence || '—' }}</dd>
              <dt>Contact</dt><dd>{{ e.metadata.contact || '—' }}</dd>
              <dt>Updated</dt><dd>{{ freqLabel(e.metadata.updateFrequency) }}</dd>
              <dt>Data date</dt><dd>{{ e.metadata.dataDate || '—' }}</dd>
            </dl>
            @if (e.metadata.notes) { <p class="px__intro" style="white-space: pre-line">{{ e.metadata.notes }}</p> }
          </div>

          <div class="px__section">
            <h4>Facts</h4>
            <dl class="px__kv">
              @if (e.featureCount !== null) { <dt>Features</dt><dd>~{{ e.featureCount | number }}</dd> }
              <dt>Added by</dt><dd>{{ e.createdBy ?? '—' }}</dd>
              <dt>Added</dt><dd>{{ e.createdAt | date: 'mediumDate' }}</dd>
              <dt>Last changed</dt><dd>{{ e.updatedAt | date: 'mediumDate' }}</dd>
              <dt>Code</dt><dd class="px__mono">{{ e.code }}</dd>
              @if (e.bbox) { <dt>Extent</dt><dd class="px__mono">{{ e.bbox[0].toFixed(3) }}, {{ e.bbox[1].toFixed(3) }} → {{ e.bbox[2].toFixed(3) }}, {{ e.bbox[3].toFixed(3) }}</dd> }
            </dl>
          </div>

          <div class="px__links">
            <button pButton type="button" class="p-button-sm p-button-outlined" icon="pi pi-search-plus" label="Zoom to" [disabled]="!mapLayer(e)" (click)="zoom(e)"></button>
            <button pButton type="button" class="p-button-sm p-button-outlined" [icon]="visible(e) ? 'pi pi-eye-slash' : 'pi pi-eye'"
                    [label]="visible(e) ? 'Hide' : 'Show on map'" [disabled]="!mapLayer(e)" (click)="toggleVisible(e)"></button>
          </div>
          @if (e.canEdit) {
            <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-pencil" label="Edit catalog record" (click)="startEdit(e)"></button>
          }
        } @else {
          <!-- ===== Edit ===== -->
          <label class="px__field"><span class="px__label">Description</span>
            <textarea class="px__textarea" rows="3" maxlength="2000" [(ngModel)]="draft.description"></textarea></label>
          <label class="px__field"><span class="px__label">Source</span>
            <input class="px__input" maxlength="300" [(ngModel)]="draft.source" placeholder="e.g. 2025 ward survey, Census 2011" /></label>
          <label class="px__field"><span class="px__label">Licence</span>
            <input class="px__input" maxlength="200" [(ngModel)]="draft.licence" placeholder="e.g. Internal use only, CC BY 4.0" /></label>
          <label class="px__field"><span class="px__label">Keywords (comma separated)</span>
            <input class="px__input" maxlength="600" [(ngModel)]="draft.keywords" placeholder="roads, transport, ward 12" /></label>
          <label class="px__field"><span class="px__label">Contact</span>
            <input class="px__input" maxlength="200" [(ngModel)]="draft.contact" placeholder="Person or office responsible" /></label>
          <div class="px__row">
            <label class="px__field"><span class="px__label">Update frequency</span>
              <select class="px__native-select" [(ngModel)]="draft.updateFrequency">
                @for (f of frequencies; track f.value) { <option [value]="f.value">{{ f.label }}</option> }
              </select></label>
            <label class="px__field"><span class="px__label">Data date</span>
              <input class="px__input" type="date" [(ngModel)]="draft.dataDate" /></label>
          </div>
          <label class="px__field"><span class="px__label">Notes</span>
            <textarea class="px__textarea" rows="3" maxlength="2000" [(ngModel)]="draft.notes" placeholder="Accuracy, known gaps, how it was made…"></textarea></label>
          <div class="px__links">
            <button pButton type="button" class="p-button-sm p-button-text" label="Cancel" (click)="editing.set(false)"></button>
            <button pButton type="button" class="p-button-sm" icon="pi pi-check" label="Save" [loading]="saving()" (click)="save(e)"></button>
          </div>
        }
      } @else {
        <!-- ===== List ===== -->
        <input class="px__input" type="search" placeholder="Search name, description, keyword, source…" [ngModel]="query()" (ngModelChange)="query.set($event)" aria-label="Search the catalog" />
        <div class="px__row">
          <select class="px__native-select" [ngModel]="typeFilter()" (ngModelChange)="typeFilter.set($event)" aria-label="Type">
            <option value="">All types</option>
            <option value="POINT">Points</option>
            <option value="LINE">Lines</option>
            <option value="POLYGON">Areas</option>
            <option value="RASTER">Rasters</option>
          </select>
        </div>
        <div class="px__secret" style="justify-content: space-between">
          <span class="px__item-sub">{{ filtered().length }} of {{ entries().length }} layers</span>
          <select class="px__native-select" style="width: auto" [ngModel]="sort()" (ngModelChange)="sort.set($event)" aria-label="Sort">
            <option value="name">Name A–Z</option>
            <option value="updated">Recently changed</option>
            <option value="size">Most features</option>
          </select>
        </div>

        @if (loading()) {
          <p class="px__hint">Loading catalog…</p>
        } @else {
          <div class="px__list" style="max-height: none">
            @for (e of filtered(); track e.id) {
              <div class="px__item px__item--click" (click)="selectedId.set(e.id)">
                <i class="pi" [class]="'pi ' + typeIcon(e)" style="color: var(--color-ink-500)" aria-hidden="true"></i>
                <div class="px__item-main">
                  <span class="px__item-title" [title]="e.name">{{ e.name }}</span>
                  <span class="px__item-sub" [title]="e.description ?? ''">
                    @if (e.featureCount !== null) { {{ e.featureCount | number }} features · }{{ e.updatedAt | date: 'd MMM y' }}
                  </span>
                </div>
                @if (!e.metadata.source && !e.description) { <span class="px__badge" title="No description or source yet">incomplete</span> }
                <i class="pi pi-angle-right" style="color: var(--color-ink-300)"></i>
              </div>
            } @empty {
              <p class="px__hint px__hint--center">No layer matches.</p>
            }
          </div>
        }
      }
    </div>
  `
})
export class DataCatalogComponent {
  private readonly http = inject(HttpClient);
  private readonly map = inject(MapService);
  private readonly notify = inject(NotificationService);

  @Input() set layers(value: GisLayer[] | null) {
    this.mapLayers.set(value ?? []);
    this.reload();
  }
  private readonly mapLayers = signal<GisLayer[]>([]);

  readonly frequencies = FREQUENCIES;
  readonly entries = signal<CatalogEntry[]>([]);
  readonly loading = signal(false);
  readonly query = signal('');
  readonly typeFilter = signal('');
  readonly sort = signal<'name' | 'updated' | 'size'>('name');
  readonly selectedId = signal<string | null>(null);
  readonly selected = computed(() => this.entries().find((e) => e.id === this.selectedId()) ?? null);
  readonly editing = signal(false);
  readonly saving = signal(false);
  draft = { description: '', source: '', licence: '', keywords: '', contact: '', updateFrequency: '', dataDate: '', notes: '' };

  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const type = this.typeFilter();
    const list = this.entries().filter((e) => {
      if (type === 'RASTER' ? e.layerType !== 'RASTER' : type && e.geometryType !== type) return false;
      if (!q) return true;
      const m = e.metadata;
      return [e.name, e.description, e.code, m.source, m.licence, m.contact, m.notes, ...(m.keywords ?? [])]
        .filter(Boolean)
        .some((t) => String(t).toLowerCase().includes(q));
    });
    const sort = this.sort();
    return list.sort((a, b) =>
      sort === 'updated'
        ? b.updatedAt.localeCompare(a.updatedAt)
        : sort === 'size'
          ? (b.featureCount ?? -1) - (a.featureCount ?? -1)
          : a.name.localeCompare(b.name)
    );
  });

  private reload(): void {
    this.loading.set(!this.entries().length);
    this.http.get<CatalogEntry[]>(`${environment.apiUrl}/gis/catalog`).subscribe({
      next: (list) => {
        this.entries.set(list);
        this.loading.set(false);
      },
      error: () => this.loading.set(false)
    });
  }

  back(): void {
    this.selectedId.set(null);
    this.editing.set(false);
  }

  typeLabel(e: CatalogEntry): string {
    return e.layerType === 'RASTER' ? 'Raster' : e.geometryType === 'POINT' ? 'Point layer' : e.geometryType === 'LINE' ? 'Line layer' : 'Area layer';
  }

  typeIcon(e: CatalogEntry): string {
    return e.layerType === 'RASTER' ? 'pi-image' : e.geometryType === 'POINT' ? 'pi-map-marker' : e.geometryType === 'LINE' ? 'pi-minus' : 'pi-stop';
  }

  freqLabel(value: string | undefined): string {
    return FREQUENCIES.find((f) => f.value === (value ?? ''))?.label ?? '—';
  }

  mapLayer(e: CatalogEntry): GisLayer | null {
    return this.mapLayers().find((l) => l.id === e.id) ?? null;
  }

  visible(e: CatalogEntry): boolean {
    return !!this.map.layerVisibility()[e.id];
  }

  zoom(e: CatalogEntry): void {
    const layer = this.mapLayer(e);
    if (layer) this.map.zoomToLayer(layer);
  }

  toggleVisible(e: CatalogEntry): void {
    this.map.setLayerVisibility(e.id, !this.visible(e));
  }

  startEdit(e: CatalogEntry): void {
    const m = e.metadata;
    this.draft = {
      description: e.description ?? '',
      source: m.source ?? '',
      licence: m.licence ?? '',
      keywords: (m.keywords ?? []).join(', '),
      contact: m.contact ?? '',
      updateFrequency: m.updateFrequency ?? '',
      dataDate: m.dataDate ?? '',
      notes: m.notes ?? ''
    };
    this.editing.set(true);
  }

  save(e: CatalogEntry): void {
    this.saving.set(true);
    const d = this.draft;
    this.http
      .patch<CatalogEntry>(`${environment.apiUrl}/gis/catalog/${e.id}`, {
        ...d,
        keywords: d.keywords.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 30)
      })
      .subscribe({
        next: (updated) => {
          this.entries.update((list) => list.map((x) => (x.id === updated.id ? updated : x)));
          this.saving.set(false);
          this.editing.set(false);
          this.notify.success('Catalog record saved.');
        },
        error: (err) => {
          this.saving.set(false);
          const m = err?.error?.message;
          this.notify.error(Array.isArray(m) ? m.join(', ') : m ?? 'Could not save.');
        }
      });
  }
}
