import { Component, Input } from '@angular/core';
import { LegendSymbol } from './legend-model';
import { clampW, fillInset, linePath, markPath, pointSize, scaleDash } from './legend-svg';

/** One legend symbol drawn as crisp SVG, for any geometry. */
@Component({
  selector: 'app-legend-swatch',
  standalone: true,
  template: `
    <svg [attr.width]="w" [attr.height]="h" [attr.viewBox]="'0 0 ' + w + ' ' + h" aria-hidden="true">
      @for (s of symbols; track $index) {
        @switch (s.kind) {
          @case ('fill') {
            <svg:rect
              [attr.x]="inset(s)" [attr.y]="inset(s)" [attr.width]="w - 2 * inset(s)" [attr.height]="h - 2 * inset(s)" rx="2"
              [attr.fill]="s.fill ?? 'none'" [attr.fill-opacity]="s.fillOpacity"
              [attr.stroke]="s.stroke ?? 'none'" [attr.stroke-width]="clampW(s.strokeWidth, 3)"
              [attr.stroke-opacity]="s.strokeOpacity" [attr.stroke-dasharray]="scaleDash(s.dash)" />
          }
          @case ('line') {
            <svg:path
              [attr.d]="path" fill="none"
              [attr.stroke]="s.stroke" [attr.stroke-width]="clampW(s.strokeWidth, h * 0.4)"
              [attr.stroke-opacity]="s.strokeOpacity" [attr.stroke-dasharray]="scaleDash(s.dash)"
              [attr.stroke-linecap]="s.linecap" stroke-linejoin="round" />
          }
          @case ('point') {
            @if (s.image) {
              <svg:image [attr.href]="s.image" [attr.x]="(w - pt(s)) / 2" [attr.y]="(h - pt(s)) / 2"
                [attr.width]="pt(s)" [attr.height]="pt(s)" />
            } @else {
              <svg:path
                [attr.d]="mark(s.mark, pt(s))"
                [attr.fill]="s.fill ?? 'none'" [attr.fill-opacity]="s.fillOpacity"
                [attr.stroke]="s.stroke ?? (s.fill ? 'none' : '#808080')" [attr.stroke-width]="clampW(s.strokeWidth, 2)"
                stroke-linejoin="round" />
            }
          }
        }
      }
    </svg>
  `,
  styles: [':host { display: inline-flex; flex-shrink: 0; } svg { display: block; overflow: visible; }']
})
export class LegendSwatchComponent {
  @Input({ required: true }) symbols: LegendSymbol[] = [];
  @Input() w = 26;
  @Input() h = 16;

  readonly clampW = clampW;
  readonly scaleDash = scaleDash;

  get path(): string {
    return linePath(this.w, this.h);
  }

  inset(s: { strokeWidth: number }): number {
    return fillInset(s.strokeWidth);
  }

  pt(s: { size: number }): number {
    return pointSize(s.size, this.h);
  }

  mark(name: string, size: number): string {
    return markPath(name, size, this.w, this.h);
  }
}
