import { Component, ElementRef, Input, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { SelectModule } from 'primeng/select';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import {
  ANALYTICS_MODULE_ID,
  AnalyticsField,
  DATA_VISUALISATION_MODULE_ID,
  FieldSummary
} from '../../../../core/models/layer-analytics.model';
import { GisLayersService } from '../../../../core/services/gis-layers.service';

interface StatTile {
  label: string;
  value: string;
  /** Exact value for the tooltip/title when `value` is compacted. */
  exact?: string;
}

/** One bar/column: `share` is 0..1 of the axis maximum. */
interface ChartBar {
  key: string;
  label: string;
  count: number;
  share: number;
  muted?: boolean;
}

interface Tip {
  text: string;
  x: number;
  y: number;
}

/**
 * Statistics dock — Analytics (summary figures) and Data Visualisation
 * (chart) for one field of one layer, computed server-side over the whole
 * layer (GET /api/gis/layers/:id/analytics/*, VIEW-gated). Numeric fields
 * get count/min/max/mean/median/sum and a 10-bin histogram; other fields
 * their most frequent values as sorted bars. Each half shows only with its
 * own module.
 */
@Component({
  selector: 'app-layer-statistics',
  standalone: true,
  imports: [FormsModule, SelectModule],
  templateUrl: './layer-statistics.component.html',
  styleUrl: './layer-statistics.component.scss'
})
export class LayerStatisticsComponent {
  private readonly gisLayersService = inject(GisLayersService);

  @Input() set layers(value: GisLayer[]) {
    this.layersSignal.set(value ?? []);
    this.ensureLayer();
  }
  private readonly layersSignal = signal<GisLayer[]>([]);

  @Input() set allowedModuleIds(value: ReadonlySet<number>) {
    this.allowed.set(value ?? new Set());
  }
  private readonly allowed = signal<ReadonlySet<number>>(new Set());

  @ViewChild('chartArea') private chartArea?: ElementRef<HTMLElement>;

  readonly showStats = computed(() => this.allowed().has(ANALYTICS_MODULE_ID));
  readonly showChart = computed(() => this.allowed().has(DATA_VISUALISATION_MODULE_ID));

  readonly layerId = signal<string | null>(null);
  readonly fields = signal<AnalyticsField[]>([]);
  readonly field = signal<string | null>(null);
  readonly summary = signal<FieldSummary | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly showTable = signal(false);
  readonly tip = signal<Tip | null>(null);

  readonly layerOptions = computed(() =>
    this.layersSignal()
      .filter((l) => l.layerType === 'VECTOR')
      .map((l) => ({ label: l.name, value: l.id }))
  );
  readonly fieldOptions = computed(() => this.fields().map((f) => ({ label: f.name, value: f.name })));

  readonly tiles = computed((): StatTile[] => {
    const s = this.summary();
    if (!s) return [];
    const tiles: StatTile[] = [
      { label: 'Features', value: compact(s.total), exact: exact(s.total) },
      { label: 'With a value', value: compact(s.nonNull), exact: exact(s.nonNull) }
    ];
    if (s.numeric) {
      const n = s.numeric;
      tiles.push(
        { label: 'Minimum', value: compact(n.min), exact: exact(n.min) },
        { label: 'Maximum', value: compact(n.max), exact: exact(n.max) },
        { label: 'Mean', value: compact(n.mean), exact: exact(n.mean) },
        { label: 'Median', value: compact(n.median), exact: exact(n.median) },
        { label: 'Sum', value: compact(n.sum), exact: exact(n.sum) }
      );
    } else if (s.categories) {
      tiles.push({ label: 'Distinct values', value: compact(s.distinctCount ?? 0), exact: exact(s.distinctCount ?? 0) });
      const top = s.categories[0];
      // "Most common" is meaningless when every value occurs once.
      if (top && top.count > 1) {
        tiles.push({ label: 'Most common', value: top.value, exact: `${top.value} (${exact(top.count)})` });
      }
    }
    return tiles;
  });

  /** Histogram columns (numeric) or category bars (everything else). */
  readonly bars = computed((): ChartBar[] => {
    const s = this.summary();
    if (!s) return [];
    if (s.numeric) {
      const max = Math.max(...s.numeric.histogram.map((b) => b.count), 0);
      const axis = niceMax(max);
      return s.numeric.histogram.map((b, i) => ({
        key: String(i),
        label: `${exact(b.from)} – ${exact(b.to)}`,
        count: b.count,
        share: axis ? b.count / axis : 0
      }));
    }
    const rows: ChartBar[] = (s.categories ?? []).map((c) => ({
      key: `c:${c.value}`,
      label: c.value,
      count: c.count,
      share: 0
    }));
    if ((s.otherCount ?? 0) > 0) {
      const others = Math.max((s.distinctCount ?? 0) - rows.length, 0);
      rows.push({ key: 'other', label: `Other (${exact(others)} values)`, count: s.otherCount ?? 0, share: 0, muted: true });
    }
    const axis = niceMax(Math.max(...rows.map((r) => r.count), 0));
    return rows.map((r) => ({ ...r, share: axis ? r.count / axis : 0 }));
  });

  /** Y-axis ticks for the histogram: 0, half and the rounded maximum. */
  readonly histogramTicks = computed(() => {
    const s = this.summary();
    if (!s?.numeric) return [];
    const axis = niceMax(Math.max(...s.numeric.histogram.map((b) => b.count), 0));
    return axis ? [axis, axis / 2, 0].map((v) => ({ value: compact(v), share: v / axis })) : [];
  });

  readonly isNumeric = computed(() => !!this.summary()?.numeric);
  readonly histogramEnds = computed(() => {
    const n = this.summary()?.numeric;
    return n ? { from: compact(n.min), to: compact(n.max) } : null;
  });

  selectLayer(id: string | null): void {
    this.layerId.set(id);
    this.fields.set([]);
    this.field.set(null);
    this.summary.set(null);
    this.error.set(null);
    if (!id) return;
    this.loading.set(true);
    this.gisLayersService.analyticsFields(id).subscribe({
      next: (fields) => {
        if (this.layerId() !== id) return;
        this.fields.set(fields);
        this.loading.set(false);
        // Prefer a real measurement (numeric, not an id) — the richest first
        // view; then any other non-id field; ids last. Fields with no data
        // are skipped (see selectField's `fallbacks`).
        const ranked = [
          ...fields.filter((f) => f.kind === 'number' && !isIdLike(f.name)),
          ...fields.filter((f) => f.kind !== 'number' && !isIdLike(f.name)),
          ...fields.filter((f) => isIdLike(f.name))
        ].map((f) => f.name);
        if (ranked.length) this.selectField(ranked[0], ranked.slice(1, MAX_AUTO_TRIES));
      },
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  /** `fallbacks` is only passed for the automatic default: when the field
   *  turns out to have no values, the next candidate is tried instead. */
  selectField(name: string | null, fallbacks: string[] = []): void {
    this.field.set(name);
    this.summary.set(null);
    this.error.set(null);
    this.tip.set(null);
    const id = this.layerId();
    if (!id || !name) return;
    this.loading.set(true);
    this.gisLayersService.analyticsSummary(id, name).subscribe({
      next: (summary) => {
        if (this.layerId() !== id || this.field() !== name) return;
        if (summary.nonNull === 0 && fallbacks.length) {
          this.selectField(fallbacks[0], fallbacks.slice(1));
          return;
        }
        this.summary.set(summary);
        this.loading.set(false);
      },
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  showTip(bar: ChartBar, event: Event): void {
    const host = this.chartArea?.nativeElement;
    const target = event.currentTarget as HTMLElement | null;
    if (!host || !target) return;
    const a = host.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    this.tip.set({
      text: `${exact(bar.count)} feature${bar.count === 1 ? '' : 's'} · ${bar.label}`,
      x: b.left - a.left + b.width / 2,
      y: b.top - a.top
    });
  }

  hideTip(): void {
    this.tip.set(null);
  }

  private ensureLayer(): void {
    const options = this.layersSignal().filter((l) => l.layerType === 'VECTOR');
    const current = this.layerId();
    if (options.length && !options.some((l) => l.id === current)) {
      this.selectLayer(options[0].id);
    }
  }

  private fail(err: HttpErrorResponse): void {
    this.loading.set(false);
    this.error.set(
      err.status === 403
        ? 'You do not have permission to view this layer.'
        : ((err.error as { message?: string } | null)?.message ?? 'Could not load statistics for this layer.')
    );
  }
}

/** How many fields the automatic default tries before settling. */
const MAX_AUTO_TRIES = 6;

const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const exactFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function compact(value: number): string {
  return Math.abs(value) < 10000 ? exactFormat.format(value) : compactFormat.format(value);
}

function exact(value: number): string {
  return exactFormat.format(value);
}

/** Identifier columns (objectid, fid, valve_id …) — counting or averaging
 *  them says nothing, so they are never the default field. */
export function isIdLike(name: string): boolean {
  return /(^|_)(id|fid|gid|gisid|ogc_fid|objectid|uuid)$/i.test(name) || /^object_?id$/i.test(name);
}

/** Rounds an axis maximum up to a clean 1 / 2 / 5 × 10ⁿ step. */
export function niceMax(value: number): number {
  if (value <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((m) => m * magnitude >= value) ?? 10;
  return step * magnitude;
}
