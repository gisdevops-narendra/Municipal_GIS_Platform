import { Component, EventEmitter, Input, Output } from '@angular/core';
import { LegendModel, LegendRamp } from './legend-model';
import { LegendSwatchComponent } from './legend-swatch.component';

/** A layer's full legend, drawn natively from GeoServer's JSON legend. */
@Component({
  selector: 'app-layer-legend',
  standalone: true,
  imports: [LegendSwatchComponent],
  template: `
    @if (model.entries.length) {
      @if (canToggle()) {
        <div class="lg__bulk">
          <span>{{ toggleableCount() - hidden.length }} of {{ toggleableCount() }} classes</span>
          <button type="button" (click)="setAll.emit(hidden.length > 0)">{{ hidden.length ? 'Show all' : 'Hide all' }}</button>
        </div>
      }
      <ul class="lg__rows">
        @for (e of model.entries; track $index; let i = $index) {
          @if (canToggle() && e.filter) {
            <li class="lg__row lg__row--toggle" [class.is-off]="hidden.includes(i)">
              <label class="lg__check" [title]="e.label">
                <input type="checkbox" [checked]="!hidden.includes(i)" (change)="toggleEntry.emit(i)"
                       [attr.aria-label]="(hidden.includes(i) ? 'Show ' : 'Hide ') + e.label" />
                <app-legend-swatch [symbols]="e.symbols" />
                <span class="lg__label">{{ niceLabel(e.label) }}</span>
              </label>
            </li>
          } @else {
            <li class="lg__row">
              <app-legend-swatch [symbols]="e.symbols" />
              <span class="lg__label" [class.lg__label--muted]="model.single">{{ e.label }}</span>
            </li>
          }
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
    .lg__row--toggle { padding: 0; }
    .lg__check { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 26px; padding: 0 6px; margin: 0 -6px;
      border-radius: 6px; cursor: pointer; transition: background .12s; }
    .lg__check:hover { background: color-mix(in srgb, var(--color-ink-900) 5%, transparent); }
    .lg__check input { appearance: none; position: relative; width: 15px; height: 15px; margin: 0; flex-shrink: 0; cursor: pointer;
      border: 1.5px solid color-mix(in srgb, var(--color-ink-500) 55%, transparent); border-radius: 4px; background: var(--color-surface);
      transition: background .12s, border-color .12s; }
    .lg__check input:checked { border-color: var(--color-primary-600); background: var(--color-primary-600); }
    .lg__check input:checked::after { content: ''; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px;
      border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
    .lg__check input:focus-visible { outline: 2px solid color-mix(in srgb, var(--color-primary-600) 45%, transparent); outline-offset: 2px; }
    .lg__check .lg__label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .lg__row.is-off app-legend-swatch { opacity: .35; filter: grayscale(.6); }
    .lg__row.is-off .lg__label { color: var(--color-ink-500); }
    .lg__bulk { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 4px; font-size: 11px; color: var(--color-ink-500); }
    .lg__bulk button { padding: 1px 6px; margin-right: -6px; border: 0; border-radius: 5px; background: none; color: var(--color-primary-600);
      font: inherit; font-weight: 600; cursor: pointer; }
    .lg__bulk button:hover { background: color-mix(in srgb, var(--color-primary-600) 10%, transparent); }
    .lg__ramp { padding: 4px 0 2px; }
    .lg__bar { height: 10px; border-radius: 5px; box-shadow: inset 0 0 0 1px rgba(127,127,127,.25); }
    .lg__ticks { display: flex; justify-content: space-between; margin-top: 4px;
      font-family: var(--font-mono); font-size: 10.5px; color: var(--color-ink-500); }
  `]
})
export class LayerLegendComponent {
  @Input({ required: true }) model!: LegendModel;
  /** QGIS-style class switches: each filtered entry gets a checkbox. */
  @Input() toggleable = false;
  /** Entry indexes switched off. */
  @Input() hidden: number[] = [];
  @Output() readonly toggleEntry = new EventEmitter<number>();
  /** true = show every class, false = hide every class. */
  @Output() readonly setAll = new EventEmitter<boolean>();

  /** "3283895.601545 – 27684959.69" → "3.28M – 27.68M" (full text on hover). */
  niceLabel(label: string): string {
    const m = /^\s*(-?\d+(?:\.\d+)?(?:E[+-]?\d+)?)\s*[–-]\s*(-?\d+(?:\.\d+)?(?:E[+-]?\d+)?)\s*$/i.exec(label);
    if (!m) return label;
    const fmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 });
    return `${fmt.format(Number(m[1]))} – ${fmt.format(Number(m[2]))}`;
  }

  canToggle(): boolean {
    return this.toggleable && !this.model.single && this.toggleableCount() > 1;
  }

  toggleableCount(): number {
    return this.model.entries.filter((e) => !!e.filter).length;
  }

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
