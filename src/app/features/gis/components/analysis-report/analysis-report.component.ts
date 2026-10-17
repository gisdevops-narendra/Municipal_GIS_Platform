import { Component, EventEmitter, Input, OnChanges, Output, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { DialogModule } from 'primeng/dialog';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { RasterService, SavedAnalysisReport } from '../../services/raster.service';

/**
 * Saved Raster Analysis report of an output layer — the statistics, class
 * chart, histogram and AI insights shown on the results screen, reopened
 * any time later from the layer's More menu.
 */
@Component({
  selector: 'app-analysis-report',
  standalone: true,
  imports: [DialogModule, DatePipe],
  template: `
    <p-dialog
      [visible]="!!layer"
      (visibleChange)="!$event && closed.emit()"
      [modal]="true"
      [header]="'Analysis report · ' + (layer?.name ?? '')"
      [style]="{ width: '560px' }"
      [breakpoints]="{ '600px': '95vw' }"
    >
      @if (loading()) {
        <p class="ar__muted"><i class="pi pi-spin pi-spinner"></i> Loading the report…</p>
      } @else if (!report()) {
        <p class="ar__muted">
          No saved report for this layer. Reports are saved for analysis results created from now on —
          run the tool again to get one.
        </p>
      } @else {
        @if (report(); as r) {
          <p class="ar__meta">{{ r.toolLabel }} · {{ savedAt() | date: 'd MMM y, h:mm a' }}</p>

          @if (r.explanation) {
            <section class="ar__insights">
              <span class="ar__title"><i class="pi pi-sparkles"></i> AI insights</span>
              <p>{{ r.explanation }}</p>
            </section>
          }

          <ul class="ar__facts">
            @for (f of r.facts; track f.label) {
              <li><span>{{ f.label }}</span><b>{{ f.value }}</b></li>
            }
          </ul>

          @if (r.classes?.length) {
            <section class="ar__classes">
              <span class="ar__title">{{ r.heading }}</span>
              @for (c of r.classes; track c.label) {
                <div class="ar__class">
                  <span class="ar__swatch" [style.background]="c.color"></span>
                  <span class="ar__label">{{ c.label }}</span>
                  <span class="ar__bar"><span [style.width.%]="c.pct" [style.background]="c.color"></span></span>
                  <span class="ar__pct">{{ c.pct.toFixed(1) }} %</span>
                </div>
              }
            </section>
          }

          @if (bars(); as hg) {
            <section>
              <span class="ar__title">Histogram</span>
              <svg [attr.viewBox]="'0 0 300 90'" preserveAspectRatio="none" class="ar__hist" role="img" aria-label="Histogram">
                @for (b of hg.bars; track $index) {
                  <rect [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h" />
                }
              </svg>
              <div class="ar__axis"><span>{{ hg.min }}</span><span>{{ hg.max }}</span></div>
            </section>
          }

          <div class="ar__actions">
            <button type="button" class="ar__btn" (click)="downloadCsv()"><i class="pi pi-download"></i> CSV</button>
          </div>
        }
      }
    </p-dialog>
  `,
  styles: [`
    .ar__muted { color: var(--color-ink-500); font-size: 13px; }
    .ar__meta { margin: 0 0 10px; font-size: 12px; color: var(--color-ink-500); }
    .ar__title { display: inline-flex; gap: 6px; align-items: center; margin-bottom: 6px; font-size: 12px; font-weight: 600; color: var(--color-ink-700); }
    .ar__insights { margin-bottom: 12px; padding: 10px 12px; border-left: 3px solid var(--color-primary-500); border-radius: var(--radius-md); background: var(--color-primary-100);
      p { margin: 0; font-size: 13px; line-height: 1.5; white-space: pre-line; color: var(--color-ink-700); } }
    .ar__facts { list-style: none; margin: 0 0 12px; padding: 0;
      li { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; font-size: 13px; border-bottom: 1px solid var(--color-line); }
      span { color: var(--color-ink-500); } b { font-weight: 600; text-align: right; } }
    .ar__classes { margin-bottom: 12px; }
    .ar__class { display: grid; grid-template-columns: 12px minmax(0, 1fr) 90px 52px; gap: 8px; align-items: center; padding: 3px 0; font-size: 12px; }
    .ar__swatch { width: 12px; height: 12px; border-radius: 2px; }
    .ar__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ar__bar { height: 8px; border-radius: 4px; background: var(--color-surface-alt); overflow: hidden; span { display: block; height: 100%; } }
    .ar__pct { text-align: right; font-variant-numeric: tabular-nums; }
    .ar__hist { width: 100%; height: 90px; color: var(--color-primary-600); rect { fill: currentColor; opacity: 0.85; } }
    .ar__axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--color-ink-500); }
    .ar__actions { display: flex; justify-content: flex-end; margin-top: 12px; }
    .ar__btn { display: inline-flex; gap: 6px; align-items: center; padding: 5px 10px; border: 1px solid var(--color-line-strong); border-radius: var(--radius-sm); background: transparent; color: var(--color-ink-700); cursor: pointer; font: inherit; font-size: 12px; }
  `]
})
export class AnalysisReportComponent implements OnChanges {
  private readonly api = inject(RasterService);

  @Input() layer: GisLayer | null = null;
  @Output() closed = new EventEmitter<void>();

  readonly loading = signal(false);
  readonly report = signal<SavedAnalysisReport | null>(null);
  readonly savedAt = signal<string | null>(null);

  readonly bars = computed(() => {
    const h = this.report()?.histogram;
    if (!h?.counts?.length) return null;
    const peak = Math.max(...h.counts, 1);
    const bw = 300 / h.counts.length;
    const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return {
      bars: h.counts.map((c, i) => {
        const bh = (c / peak) * 86;
        return { x: i * bw + 0.5, y: 90 - bh, w: Math.max(bw - 1, 0.5), h: bh };
      }),
      min: fmt(h.edges[0]),
      max: fmt(h.edges[h.edges.length - 1])
    };
  });

  ngOnChanges(): void {
    this.report.set(null);
    if (!this.layer) return;
    const id = this.layer.id;
    this.loading.set(true);
    this.api.getReport(id).subscribe({
      next: (row) => {
        if (this.layer?.id !== id) return;
        this.loading.set(false);
        this.report.set(row.report ?? null);
        this.savedAt.set(row.createdAt ?? null);
      },
      error: () => {
        this.loading.set(false);
        this.report.set(null);
      }
    });
  }

  downloadCsv(): void {
    const r = this.report();
    if (!r) return;
    const rows = [['Measure', 'Value'], ...r.facts.map((f) => [f.label, f.value]),
      ...(r.classes ?? []).map((c) => [c.label, `${c.pct.toFixed(1)} %`])];
    const csv = rows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${(this.layer?.name ?? 'report').replace(/[^\w-]+/g, '_')}_report.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
