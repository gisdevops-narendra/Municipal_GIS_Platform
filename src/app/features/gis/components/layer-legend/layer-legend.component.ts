import { Component, Input } from '@angular/core';
import { LegendModel, LegendRamp } from './legend-model';
import { LegendSwatchComponent } from './legend-swatch.component';

/** A layer's full legend, drawn natively from GeoServer's JSON legend. */
@Component({
  selector: 'app-layer-legend',
  standalone: true,
  imports: [LegendSwatchComponent],
  template: `
    @if (model.entries.length) {
      <ul class="lg__rows">
        @for (e of model.entries; track $index) {
          <li class="lg__row">
            <app-legend-swatch [symbols]="e.symbols" />
            <span class="lg__label" [class.lg__label--muted]="model.single">{{ e.label }}</span>
          </li>
        }
      </ul>
    }

    @if (model.ramp; as ramp) {
      @if (ramp.type === 'ramp') {
        <div class="lg__ramp">
          <div class="lg__bar" [style.background]="gradient(ramp)"></div>
          <div class="lg__ticks">
            <span>{{ stopLabel(ramp.stops[0]) }}</span>
            @if (ramp.stops.length > 2) {
              <span>{{ stopLabel(ramp.stops[mid(ramp)]) }}</span>
            }
            <span>{{ stopLabel(ramp.stops[ramp.stops.length - 1]) }}</span>
          </div>
        </div>
      } @else {
        <ul class="lg__rows">
          @for (s of ramp.stops; track $index) {
            <li class="lg__row">
              <span class="lg__chip" [style.background]="s.color" [style.opacity]="s.opacity"></span>
              <span class="lg__label">{{ stopLabel(s) }}</span>
            </li>
          }
        </ul>
      }
    }

    @if (model.labels; as l) {
      <div class="lg__row lg__row--labels">
        <span
          class="lg__aa"
          [style.color]="l.color"
          [style.font-family]="l.fontFamily"
          [style.font-weight]="l.bold ? 700 : 500"
          [style.font-style]="l.italic ? 'italic' : 'normal'"
          [style.-webkit-text-stroke]="l.halo ? '2.5px ' + l.halo : null"
        >Aa</span>
        <span class="lg__label lg__label--muted">Labels · <code>{{ l.field }}</code></span>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .lg__rows { margin: 0; padding: 0; list-style: none; }
    .lg__row { display: flex; align-items: center; gap: 10px; min-height: 22px; padding: 2px 0; }
    .lg__label { font-size: 12.5px; color: var(--color-ink-900); overflow-wrap: anywhere; }
    .lg__label--muted { color: var(--color-ink-500); }
    .lg__label code { font-family: var(--font-mono); font-size: 11.5px; color: var(--color-ink-700); }
    .lg__chip { width: 26px; height: 14px; border-radius: 3px; flex-shrink: 0; box-shadow: inset 0 0 0 1px rgba(127,127,127,.25); }
    .lg__aa { width: 26px; text-align: center; font-size: 13px; line-height: 1; paint-order: stroke fill; flex-shrink: 0; }
    .lg__row--labels { margin-top: 2px; }
    .lg__ramp { padding: 4px 0 2px; }
    .lg__bar { height: 10px; border-radius: 5px; box-shadow: inset 0 0 0 1px rgba(127,127,127,.25); }
    .lg__ticks { display: flex; justify-content: space-between; margin-top: 4px;
      font-family: var(--font-mono); font-size: 10.5px; color: var(--color-ink-500); }
  `]
})
export class LayerLegendComponent {
  @Input({ required: true }) model!: LegendModel;

  gradient(ramp: LegendRamp): string {
    const s = ramp.stops;
    const lo = s[0].quantity, hi = s[s.length - 1].quantity, span = hi - lo || 1;
    const parts = s.map((x) => `${x.color} ${(((x.quantity - lo) / span) * 100).toFixed(1)}%`);
    return `linear-gradient(90deg, ${parts.join(', ')})`;
  }

  mid(ramp: LegendRamp): number {
    return Math.floor((ramp.stops.length - 1) / 2);
  }

  stopLabel(s: { label: string; quantity: number }): string {
    const n = parseFloat(s.label);
    if (s.label && !Number.isFinite(n)) return s.label;
    const v = Number.isFinite(n) ? n : s.quantity;
    return Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : String(Math.round(v * 100) / 100);
  }
}
