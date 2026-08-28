import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CheckboxModule } from 'primeng/checkbox';
import { ButtonModule } from 'primeng/button';
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
  imports: [FormsModule, CheckboxModule, ButtonModule, MessageModule],
  template: `
    @if (loading()) {
      <p class="muted">Loading layers…</p>
    } @else if (error()) {
      <p-message severity="error" [text]="error()!" />
    } @else if (layers().length === 0) {
      <p class="muted">This municipality has no active GIS layers yet.</p>
    } @else {
      <ul class="rows">
        @for (l of layers(); track l.id) {
          <li class="row">
            <p-checkbox
              [binary]="true"
              [inputId]="l.id"
              [ngModel]="effective(l)"
              (ngModelChange)="set(l, $event)"
            />
            <label [for]="l.id" class="row__label">
              <span class="row__name">{{ l.name }}</span>
              <span class="row__meta">
                {{ l.code }}
                @if (isOverridden(l)) {
                  · <span class="row__flag">overridden</span>
                }
              </span>
            </label>
          </li>
        }
      </ul>
      <div class="actions">
        <button
          pButton
          type="button"
          class="p-button-text p-button-sm"
          label="Reset to layer defaults"
          (click)="resetAll()"
        ></button>
      </div>
    }
  `,
  styles: [
    `
      .muted {
        font-size: 13px;
        color: var(--color-ink-500);
      }
      .rows {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .row {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 10px 0;
        border-bottom: 1px solid var(--color-line);
      }
      .row__label {
        display: flex;
        flex-direction: column;
        gap: 2px;
        cursor: pointer;
      }
      .row__name {
        font-size: 13.5px;
        font-weight: 600;
        color: var(--color-ink-900);
      }
      .row__meta {
        font-size: 11.5px;
        font-family: var(--font-mono);
        color: var(--color-ink-500);
      }
      .row__flag {
        color: var(--color-accent-600);
      }
      .actions {
        margin-top: 12px;
      }
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

  set(layer: GisLayer, visible: boolean): void {
    this.s.patch({ map: { layerVisibility: { [layer.code]: visible } } });
  }

  resetAll(): void {
    const cleared: Record<string, boolean> = {};
    for (const l of this.layers()) {
      cleared[l.code] = l.visibleByDefault;
    }
    this.s.patch({ map: { layerVisibility: cleared } });
  }
}
