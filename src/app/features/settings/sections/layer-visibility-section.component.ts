import { Component, computed, inject, signal } from '@angular/core';
import { MessageModule } from 'primeng/message';
import { SettingsService } from '../../../core/services/settings.service';
import { GisLayersService } from '../../../core/services/gis-layers.service';
import { GisLayer } from '../../../core/models/gis-layer.model';

/**
 * Settings → Default Layer Visibility. Per-layer override of each layer's
 * `visibleByDefault`, keyed by layer code in `map.layerVisibility`. "Reset"
 * rewrites every entry back to the layer's own default (settings are stored
 * as a deep-merged blob, so an entry is overwritten, never deleted).
 */
@Component({
  selector: 'app-layer-visibility-section',
  standalone: true,
  imports: [MessageModule],
  template: `
    @if (loading()) {
      <p class="muted">Loading layers…</p>
    } @else if (error()) {
      <p-message severity="error" [text]="error()!" />
    } @else if (layers().length === 0) {
      <p class="muted">You have no layers yet — upload data on the map first.</p>
    } @else {
      <div class="lv">
        <header class="lv__head">
          <span class="lv__count"><b>{{ shownCount() }}</b> of {{ layers().length }} layers shown when the map opens</span>
          <span class="lv__bulk">
            <button type="button" [disabled]="shownCount() === layers().length" (click)="setAll(true)">Show all</button>
            <button type="button" [disabled]="shownCount() === 0" (click)="setAll(false)">Hide all</button>
          </span>
        </header>

        <ul class="lv__rows">
          @for (l of layers(); track l.id) {
            @let on = effective(l);
            <li class="lv__row" [class.is-off]="!on">
              <span class="lv__icon" [class]="'lv__icon lv__icon--' + kind(l)"><i [class]="icon(l)" aria-hidden="true"></i></span>
              <label class="lv__text" [for]="'lv-' + l.id">
                <span class="lv__name">{{ l.name }}</span>
                <span class="lv__sub">
                  {{ on ? 'Shown' : 'Hidden' }} when the map opens
                  @if (isOverridden(l)) {
                    <button type="button" class="lv__changed" (click)="reset(l)"
                            [title]="'Changed from the layer default (' + (l.visibleByDefault ? 'shown' : 'hidden') + ') — click to undo'">
                      Changed <i class="pi pi-undo" aria-hidden="true"></i>
                    </button>
                  }
                </span>
              </label>
              <input type="checkbox" role="switch" class="lv__switch" [id]="'lv-' + l.id" [checked]="on"
                     [attr.aria-label]="(on ? 'Hide ' : 'Show ') + l.name + ' when the map opens'"
                     (change)="set(l, $any($event.target).checked)" />
            </li>
          }
        </ul>

        @if (anyOverridden()) {
          <footer class="lv__foot">
            <button type="button" class="lv__reset" (click)="resetAll()"><i class="pi pi-refresh" aria-hidden="true"></i> Reset all to layer defaults</button>
          </footer>
        }
      </div>
    }
  `,
  styles: [
    `
      .muted { font-size: 13px; color: var(--color-ink-500); }

      .lv { border: 1px solid var(--color-line); border-radius: 12px; overflow: hidden; background: var(--color-surface); }
      .lv__head {
        display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px;
        border-bottom: 1px solid var(--color-line); background: color-mix(in srgb, var(--color-ink-900) 3%, var(--color-surface));
      }
      .lv__count { font-size: 12.5px; color: var(--color-ink-500); }
      .lv__count b { color: var(--color-ink-900); font-weight: 600; }
      .lv__bulk { display: inline-flex; gap: 2px; }
      .lv__bulk button {
        height: 26px; padding: 0 9px; border: 0; border-radius: 6px; background: none; color: var(--color-primary-600);
        font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
      }
      .lv__bulk button:hover:not(:disabled) { background: color-mix(in srgb, var(--color-primary-600) 10%, transparent); }
      .lv__bulk button:disabled { color: var(--color-ink-500); opacity: .5; cursor: default; }

      .lv__rows { list-style: none; margin: 0; padding: 0; max-height: 360px; overflow-y: auto; }
      .lv__row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; transition: background .12s; }
      .lv__row + .lv__row { border-top: 1px solid color-mix(in srgb, var(--color-line) 70%, transparent); }
      .lv__row:hover { background: color-mix(in srgb, var(--color-ink-900) 3%, transparent); }

      .lv__icon { width: 30px; height: 30px; flex-shrink: 0; border-radius: 8px; display: grid; place-items: center; font-size: 12px; transition: opacity .12s, filter .12s; }
      .lv__icon--pt { background: color-mix(in srgb, #2563eb 13%, transparent); color: #2563eb; }
      .lv__icon--ln { background: color-mix(in srgb, #d97706 15%, transparent); color: #b45309; }
      .lv__icon--pg { background: color-mix(in srgb, #16a34a 14%, transparent); color: #15803d; }
      .lv__icon--rs { background: color-mix(in srgb, #7c3aed 13%, transparent); color: #6d28d9; }
      .lv__row.is-off .lv__icon { opacity: .45; filter: grayscale(.7); }

      .lv__text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; cursor: pointer; }
      .lv__name { font-size: 13.5px; font-weight: 600; color: var(--color-ink-900); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .lv__row.is-off .lv__name { color: var(--color-ink-500); }
      .lv__sub { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--color-ink-500); }
      .lv__changed {
        display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 7px; border: 0; border-radius: 999px; cursor: pointer;
        background: color-mix(in srgb, #d97706 14%, transparent); color: #b45309; font: inherit; font-size: 11px; font-weight: 600;
      }
      .lv__changed .pi { font-size: 9px; }
      .lv__changed:hover { background: color-mix(in srgb, #d97706 24%, transparent); }

      .lv__switch {
        appearance: none; position: relative; flex-shrink: 0; width: 38px; height: 22px; margin: 0; border-radius: 999px; cursor: pointer;
        background: color-mix(in srgb, var(--color-ink-500) 35%, transparent); transition: background .15s;
      }
      .lv__switch::after {
        content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%;
        background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .25); transition: transform .15s;
      }
      .lv__switch:checked { background: var(--color-primary-600); }
      .lv__switch:checked::after { transform: translateX(16px); }
      .lv__switch:focus-visible { outline: 2px solid color-mix(in srgb, var(--color-primary-600) 45%, transparent); outline-offset: 2px; }

      .lv__foot { display: flex; justify-content: flex-end; padding: 8px 14px; border-top: 1px solid var(--color-line); }
      .lv__reset {
        display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 0; border-radius: 7px; background: none;
        color: var(--color-primary-600); font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
      }
      .lv__reset .pi { font-size: 11px; }
      .lv__reset:hover { background: color-mix(in srgb, var(--color-primary-600) 10%, transparent); }
    `,
  ],
})
export class LayerVisibilitySectionComponent {
  private readonly s = inject(SettingsService);
  private readonly gisLayers = inject(GisLayersService);

  readonly layers = signal<GisLayer[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly overrides = computed(() => this.s.map().layerVisibility);
  readonly shownCount = computed(() => this.layers().filter((l) => this.effective(l)).length);
  readonly anyOverridden = computed(() => this.layers().some((l) => this.isOverridden(l)));

  constructor() {
    this.gisLayers.list().subscribe({
      next: (layers) => {
        this.layers.set([...layers].sort((a, b) => a.displayOrder - b.displayOrder));
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Could not load the layer list. Try again later.');
        this.loading.set(false);
      },
    });
  }

  effective(layer: GisLayer): boolean {
    const o = this.overrides();
    return layer.code in o ? o[layer.code] : layer.visibleByDefault;
  }

  isOverridden(layer: GisLayer): boolean {
    const o = this.overrides();
    return layer.code in o && o[layer.code] !== layer.visibleByDefault;
  }

  kind(layer: GisLayer): 'pt' | 'ln' | 'pg' | 'rs' {
    if (layer.layerType === 'RASTER') return 'rs';
    return layer.geometryType === 'POINT' ? 'pt' : layer.geometryType === 'LINE' ? 'ln' : 'pg';
  }

  icon(layer: GisLayer): string {
    return { pt: 'pi pi-map-marker', ln: 'pi pi-wave-pulse', pg: 'pi pi-stop', rs: 'pi pi-image' }[this.kind(layer)];
  }

  set(layer: GisLayer, visible: boolean): void {
    this.s.patch({ map: { layerVisibility: { [layer.code]: visible } } });
  }

  reset(layer: GisLayer): void {
    this.set(layer, layer.visibleByDefault);
  }

  setAll(visible: boolean): void {
    const next: Record<string, boolean> = {};
    for (const l of this.layers()) next[l.code] = visible;
    this.s.patch({ map: { layerVisibility: next } });
  }

  resetAll(): void {
    const cleared: Record<string, boolean> = {};
    for (const l of this.layers()) {
      cleared[l.code] = l.visibleByDefault;
    }
    this.s.patch({ map: { layerVisibility: cleared } });
  }
}
