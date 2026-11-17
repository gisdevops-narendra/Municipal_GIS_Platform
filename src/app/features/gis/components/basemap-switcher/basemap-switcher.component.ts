import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { MapService } from '../../services/map.service';

/** Preview tile URL per basemap ({z}/{x}/{y} filled in for the map centre). */
const PREVIEW: Record<string, string> = {
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  'esri-imagery': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  'esri-clarity': 'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  'esri-hybrid': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  'esri-streets': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
  'carto-voyager': 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
  'carto-dark': 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
  topo: 'https://tile.opentopomap.org/{z}/{x}/{y}.png'
};

/** Short names for the thumbnails. */
const SHORT: Record<string, string> = {
  osm: 'Map',
  'esri-imagery': 'Satellite',
  'esri-clarity': 'Satellite HD',
  'esri-hybrid': 'Hybrid',
  'esri-streets': 'Streets',
  'carto-voyager': 'Voyager',
  'carto-dark': 'Dark',
  topo: 'Terrain'
};

/** Google-Maps-style basemap picker in the map's bottom-left corner: the
 *  current basemap as a thumbnail; click it to choose another. */
@Component({
  selector: 'app-basemap-switcher',
  standalone: true,
  template: `
    <div class="bms" [class.is-open]="open()">
      <button type="button" class="bms__current" [attr.aria-expanded]="open()" aria-label="Change basemap"
              [title]="'Basemap: ' + currentLabel()" (click)="toggle()">
        <img [src]="preview(active())" alt="" loading="lazy" />
        <span><i class="pi pi-clone" aria-hidden="true"></i> {{ short(active()) }}</span>
      </button>
      @if (open()) {
        <div class="bms__list" role="listbox" aria-label="Basemaps">
          @for (b of options; track b.id) {
            <button type="button" role="option" class="bms__item" [class.is-active]="b.id === active()"
                    [attr.aria-selected]="b.id === active()" [title]="b.label" (click)="pick(b.id)">
              <img [src]="preview(b.id)" alt="" loading="lazy" />
              <span>{{ short(b.id) }}</span>
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      position: absolute;
      left: 8px;
      bottom: 40px;
      z-index: 9;
    }
    .bms {
      display: flex;
      align-items: flex-end;
      gap: 8px;
    }
    .bms__current,
    .bms__item {
      position: relative;
      display: block;
      padding: 0;
      overflow: hidden;
      border: 2px solid var(--color-surface);
      border-radius: 8px;
      background: var(--color-surface-alt);
      box-shadow: var(--shadow-panel);
      cursor: pointer;
      img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      span {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        padding: 10px 4px 3px;
        background: linear-gradient(transparent, rgba(0, 0, 0, 0.65));
        color: #fff;
        font-size: 10.5px;
        font-weight: 600;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }
    .bms__current {
      width: 64px;
      height: 64px;
      .pi {
        font-size: 9px;
      }
      &:hover {
        border-color: var(--color-primary-600);
      }
    }
    .is-open .bms__current {
      border-color: var(--color-primary-600);
    }
    .bms__list {
      display: flex;
      gap: 6px;
      padding: 6px;
      background: var(--color-surface);
      border: 1px solid var(--color-line);
      border-radius: 10px;
      box-shadow: var(--shadow-panel);
      animation: bms-in 0.12s ease-out;
      max-width: calc(100vw - 120px);
      overflow-x: auto;
    }
    .bms__item {
      flex-shrink: 0;
      width: 58px;
      height: 58px;
      box-shadow: none;
      border-color: transparent;
      &:hover {
        border-color: var(--color-ink-300);
      }
      &.is-active {
        border-color: var(--color-primary-600);
      }
    }
    @keyframes bms-in {
      from {
        opacity: 0;
        transform: translateX(-6px);
      }
    }
  `
})
export class BasemapSwitcherComponent {
  private readonly map = inject(MapService);

  readonly options = this.map.basemapOptions;
  readonly active = this.map.activeBasemap;
  readonly open = signal(false);
  readonly currentLabel = computed(() => this.options.find((o) => o.id === this.active())?.label ?? '');
  /** Tile under the map centre, refreshed each time the picker opens. */
  private readonly tile = signal({ z: 11, x: 1440, y: 900 });

  constructor() {
    this.updateTile();
  }

  short = (id: string) => SHORT[id] ?? this.options.find((o) => o.id === id)?.label ?? id;

  preview(id: string): string {
    const { z, x, y } = this.tile();
    return (PREVIEW[id] ?? PREVIEW['osm']).replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  }

  toggle(): void {
    if (!this.open()) this.updateTile();
    this.open.update((v) => !v);
  }

  pick(id: string): void {
    this.map.setBasemap(id);
    this.open.set(false);
  }

  @HostListener('document:keydown.escape')
  close(): void {
    this.open.set(false);
  }

  /** Close when clicking anywhere else. */
  @HostListener('document:pointerdown', ['$event'])
  onOutside(event: PointerEvent): void {
    if (this.open() && !(event.target as HTMLElement | null)?.closest('app-basemap-switcher')) this.open.set(false);
  }

  private updateTile(): void {
    const view = this.map.viewSnapshot();
    const [lon, lat] = view?.center ?? [78.9, 22.5];
    const z = Math.max(3, Math.min(15, Math.round(view?.zoom ?? 11)));
    const n = 2 ** z;
    const latR = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
    const x = Math.floor(((lon + 180) / 360) * n);
    const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n);
    this.tile.set({ z, x: ((x % n) + n) % n, y: Math.max(0, Math.min(n - 1, y)) });
  }
}
