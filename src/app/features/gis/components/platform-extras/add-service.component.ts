import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { MapService } from '../../services/map.service';
import { PlatformExtrasService } from '../../services/platform-extras.service';
import {
  DiscoveredService,
  EXTERNAL_KIND_LABELS,
  ExternalKind,
  ExternalLayerDraft,
  ExternalLayerSpec,
  discoverService
} from '../../services/external-layers';

const STORAGE_KEY = 'mgp.external-layers.v1';

/** Outside layers the user added, kept in this browser between visits. */
export function loadSavedExternalLayers(): ExternalLayerSpec[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as ExternalLayerSpec[]) : [];
    return Array.isArray(list) ? list.filter((s) => s && s.id && s.kind && s.url) : [];
  } catch {
    return [];
  }
}

export function saveExternalLayers(list: ExternalLayerSpec[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage blocked — layers just won't survive a reload */
  }
}

const EXAMPLES: { label: string; kind: ExternalKind; url: string }[] = [
  { label: 'terrestris OSM WMS', kind: 'WMS', url: 'https://ows.terrestris.de/osm/service' },
  { label: 'OpenTopoMap tiles', kind: 'XYZ', url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png' },
  { label: 'Esri World Topo', kind: 'ARCGIS', url: 'https://services.arcgisonline.com/arcgis/rest/services/World_Topo_Map/MapServer' }
];

@Component({
  selector: 'app-add-service',
  standalone: true,
  imports: [FormsModule, ButtonModule],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      <p class="px__intro">Add a layer from an outside map service — WMS, WMTS, XYZ tiles, ArcGIS REST or WFS. It is shown on top of your own layers and saved in this browser.</p>

      <div class="px__field">
        <span class="px__label">Service type</span>
        <div class="px__seg" role="radiogroup" aria-label="Service type">
          @for (k of kinds; track k.value) {
            <button type="button" role="radio" class="px__seg-btn" [class.is-active]="kind() === k.value" [attr.aria-checked]="kind() === k.value" (click)="kind.set(k.value)">{{ k.label }}</button>
          }
        </div>
      </div>

      <label class="px__field">
        <span class="px__label">Service URL</span>
        <input class="px__input" type="url" [ngModel]="url()" (ngModelChange)="url.set($event)" (keydown.enter)="connect()"
               [placeholder]="kind() === 'XYZ' ? 'https://…/{z}/{x}/{y}.png' : 'https://…/wms'" />
      </label>

      <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-link" [label]="kind() === 'XYZ' ? 'Add tiles' : 'Connect'"
              [loading]="busy()" [disabled]="!url().trim()" (click)="connect()"></button>

      @if (error(); as message) { <p class="px__error" role="alert">{{ message }}</p> }

      @if (!discovered() && !added().length) {
        <div class="px__section">
          <h4>Try an example</h4>
          <div class="px__list">
            @for (ex of examples; track ex.url) {
              <div class="px__item px__item--click" (click)="useExample(ex)">
                <i class="pi pi-globe" aria-hidden="true"></i>
                <div class="px__item-main">
                  <span class="px__item-title">{{ ex.label }}</span>
                  <span class="px__item-sub">{{ ex.url }}</span>
                </div>
              </div>
            }
          </div>
        </div>
      }

      @if (discovered(); as svc) {
        <div class="px__section">
          <h4>{{ svc.title }} · {{ svc.layers.length }} layer{{ svc.layers.length === 1 ? '' : 's' }}</h4>
          @if (svc.layers.length > 8) {
            <input class="px__input" type="search" placeholder="Filter layers…" [ngModel]="filter()" (ngModelChange)="filter.set($event)" />
          }
          <div class="px__list">
            @for (layer of filteredLayers(); track layer.name + layer.title) {
              <div class="px__item">
                <div class="px__item-main">
                  <span class="px__item-title" [title]="layer.title">{{ layer.title }}</span>
                  @if (layer.name && layer.name !== layer.title) { <span class="px__item-sub px__mono">{{ layer.name }}</span> }
                </div>
                <button type="button" class="px__icon-btn" title="Add to map" (click)="add(layer.draft)"><i class="pi pi-plus"></i></button>
              </div>
            } @empty {
              <p class="px__hint px__hint--center">No layer matches.</p>
            }
          </div>
        </div>
      }

      @if (added().length) {
        <div class="px__section">
          <h4>On the map</h4>
          <div class="px__list">
            @for (spec of added(); track spec.id) {
              <div class="px__item">
                <input type="checkbox" [checked]="spec.visible" (change)="toggle(spec)" [attr.aria-label]="'Show ' + spec.title" />
                <div class="px__item-main">
                  <span class="px__item-title" [title]="spec.title">{{ spec.title }}</span>
                  <span class="px__item-sub">{{ labels[spec.kind] }}</span>
                </div>
                <input class="px__range" type="range" min="0" max="1" step="0.05" [value]="spec.opacity"
                       (input)="opacity(spec, $any($event.target).value)" [attr.aria-label]="'Opacity of ' + spec.title" />
                <button type="button" class="px__icon-btn px__icon-btn--danger" title="Remove" (click)="remove(spec)"><i class="pi pi-trash"></i></button>
              </div>
            }
          </div>
        </div>
      }
    </div>
  `
})
export class AddServiceComponent {
  private readonly map = inject(MapService);
  private readonly extras = inject(PlatformExtrasService);

  readonly kinds: { value: ExternalKind | 'AUTO'; label: string }[] = [
    { value: 'AUTO', label: 'Auto' },
    { value: 'WMS', label: 'WMS' },
    { value: 'WMTS', label: 'WMTS' },
    { value: 'XYZ', label: 'XYZ' },
    { value: 'ARCGIS', label: 'ArcGIS' },
    { value: 'WFS', label: 'WFS' }
  ];
  readonly labels = EXTERNAL_KIND_LABELS;
  readonly examples = EXAMPLES;

  readonly kind = signal<ExternalKind | 'AUTO'>('AUTO');
  readonly url = signal('');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly discovered = signal<DiscoveredService | null>(null);
  readonly filter = signal('');
  readonly added = this.map.externalLayers;

  readonly filteredLayers = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const layers = this.discovered()?.layers ?? [];
    return q ? layers.filter((l) => `${l.title} ${l.name}`.toLowerCase().includes(q)) : layers;
  });

  useExample(ex: { kind: ExternalKind; url: string }): void {
    this.kind.set(ex.kind);
    this.url.set(ex.url);
    void this.connect();
  }

  async connect(): Promise<void> {
    const url = this.url().trim();
    if (!url) return;
    this.busy.set(true);
    this.error.set(null);
    this.discovered.set(null);
    this.filter.set('');
    try {
      const svc = await discoverService(url, this.kind(), this.extras.proxyFetchText);
      if (!svc.layers.length) throw new Error('The service lists no layers.');
      // A single tile service needs no picking.
      if (svc.kind === 'XYZ') this.add(svc.layers[0].draft);
      else this.discovered.set(svc);
    } catch (error) {
      const e = error as { error?: string | { message?: string }; message?: string };
      const fromApi = typeof e.error === 'string' ? safeMessage(e.error) : e.error?.message;
      this.error.set(fromApi || e.message || 'Could not read the service.');
    } finally {
      this.busy.set(false);
    }
  }

  add(draft: ExternalLayerDraft): void {
    const spec: ExternalLayerSpec = { ...draft, id: crypto.randomUUID(), opacity: 1, visible: true };
    this.map.addExternalLayer(spec);
  }

  toggle(spec: ExternalLayerSpec): void {
    this.map.updateExternalLayer(spec.id, { visible: !spec.visible });
  }

  opacity(spec: ExternalLayerSpec, value: string): void {
    this.map.updateExternalLayer(spec.id, { opacity: Number(value) });
  }

  remove(spec: ExternalLayerSpec): void {
    this.map.removeExternalLayer(spec.id);
  }
}

function safeMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { message?: string | string[] };
    return Array.isArray(parsed.message) ? parsed.message.join(', ') : parsed.message;
  } catch {
    return undefined;
  }
}
