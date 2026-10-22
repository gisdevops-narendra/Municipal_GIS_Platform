import { Component, ElementRef, EventEmitter, Input, OnDestroy, Output, ViewChild, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { SelectModule } from 'primeng/select';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import {
  ANALYTICS_MODULE_ID,
  AnalyticsField,
  DATA_VISUALISATION_MODULE_ID,
  FieldSummary,
  GroupMeasure,
  GroupResult,
  LayerProfile
} from '../../../../core/models/layer-analytics.model';
import { GisLayersService } from '../../../../core/services/gis-layers.service';
import { AttributeTableService } from '../../services/attribute-table.service';
import { MapService } from '../../services/map.service';
import { AttributeExternalFilter } from '../attribute-table/attribute-table.component';

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

interface OverviewBar {
  key: string;
  label: string;
  countLabel: string;
  share: number;
  muted?: boolean;
}

interface GroupBar {
  key: string | null;
  label: string;
  valueLabel: string;
  share: number;
  muted?: boolean;
  /** false for rows a map filter can't express (outside every area, "Other"). */
  filterable: boolean;
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
 *
 * The Overview tab needs no choices: the server profiles every field
 * (role inferred from its values — category / measure / date / id / text)
 * and the cards are built from whatever the layer turns out to hold.
 *
 * Group by measures count / sum / average / length / area per value of a
 * field, or per feature of any polygon layer the user picks as the area
 * layer. Clicking a bar (here or in the Overview) filters the layer on the
 * map through the workspace's single query-filter slot. Area groups can
 * also be drawn as a choropleth: quantile classes on a one-hue ramp.
 */
@Component({
  selector: 'app-layer-statistics',
  standalone: true,
  imports: [FormsModule, SelectModule],
  templateUrl: './layer-statistics.component.html',
  styleUrl: './layer-statistics.component.scss'
})
export class LayerStatisticsComponent implements OnDestroy {
  private readonly gisLayersService = inject(GisLayersService);
  private readonly attributeTables = inject(AttributeTableService);
  private readonly mapService = inject(MapService);

  @Input() set layers(value: GisLayer[]) {
    this.layersSignal.set(value ?? []);
    this.ensureLayer();
  }
  private readonly layersSignal = signal<GisLayer[]>([]);

  @Input() set allowedModuleIds(value: ReadonlySet<number>) {
    this.allowed.set(value ?? new Set());
  }
  private readonly allowed = signal<ReadonlySet<number>>(new Set());

  /** The workspace's active map filter — shown as a chip when it is on
   *  this layer. */
  @Input() set queryFilter(value: AttributeExternalFilter | null) {
    this.activeFilter.set(value ?? null);
  }
  readonly activeFilter = signal<AttributeExternalFilter | null>(null);

  @Output() filterApply = new EventEmitter<AttributeExternalFilter>();
  @Output() filterClear = new EventEmitter<void>();

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

  readonly mode = signal<'overview' | 'group' | 'field'>('overview');
  readonly profile = signal<LayerProfile | null>(null);
  readonly profileError = signal<string | null>(null);

  /** Headline figures: feature count, geometry total, field mix. */
  readonly kpis = computed((): StatTile[] => {
    const p = this.profile();
    if (!p) return [];
    const kpis: StatTile[] = [{ label: 'Features', value: compact(p.total), exact: exact(p.total) }];
    if (p.geometry.lengthKm != null) {
      kpis.push({ label: 'Total length', value: `${compact(p.geometry.lengthKm)} km`, exact: `${exact(p.geometry.lengthKm)} km` });
    }
    if (p.geometry.areaHa != null) {
      const ha = p.geometry.areaHa;
      kpis.push(
        ha >= 1000
          ? { label: 'Total area', value: `${compact(ha / 100)} km²`, exact: `${exact(ha)} ha` }
          : { label: 'Total area', value: `${compact(ha)} ha`, exact: `${exact(ha)} ha` }
      );
    }
    if (p.geometry.kind) {
      kpis.push({ label: 'Geometry', value: GEOMETRY_LABEL[p.geometry.kind] });
    }
    const useful = p.fields.filter((f) => f.role !== 'empty' && f.role !== 'constant' && f.role !== 'id').length;
    kpis.push({ label: 'Fields', value: `${useful} / ${p.fields.length}`, exact: `${useful} informative of ${p.fields.length}` });
    const filled = p.fields.length && p.total ? p.fields.reduce((sum, f) => sum + f.nonNull, 0) / (p.fields.length * p.total) : 1;
    kpis.push({ label: 'Completeness', value: `${Math.round(filled * 100)}%` });
    return kpis;
  });

  readonly categoryCards = computed(() =>
    (this.profile()?.categories ?? []).map((c) => {
      const rows: OverviewBar[] = c.values.map((v) => ({
        key: `c:${v.value}`,
        label: v.value,
        countLabel: compact(v.count),
        share: v.count
      }));
      if (c.otherCount > 0) {
        rows.push({ key: 'other', label: `Other (${exact(c.distinct - c.values.length)})`, countLabel: compact(c.otherCount), share: c.otherCount, muted: true });
      }
      const max = Math.max(...rows.map((r) => r.share), 1);
      return { field: c.field, distinct: c.distinct, bars: rows.map((r) => ({ ...r, share: r.share / max })) };
    })
  );

  readonly timelineCards = computed(() =>
    (this.profile()?.timelines ?? [])
      .filter((t) => t.points.length > 0)
      .map((t) => {
        const max = Math.max(...t.points.map((p) => p.count), 1);
        const first = t.points[0].period;
        const last = t.points[t.points.length - 1].period;
        return {
          field: t.field,
          unit: t.unit,
          range: first === last ? first : `${first} – ${last}`,
          points: t.points.map((p) => ({ period: p.period, countLabel: exact(p.count), share: p.count / max }))
        };
      })
  );

  /** Best-filled measures first, a handful at most. */
  readonly measureCards = computed(() =>
    (this.profile()?.fields ?? [])
      .filter((f) => f.role === 'measure' && f.numeric)
      .sort((a, b) => b.nonNull - a.nonNull)
      .slice(0, MAX_MEASURE_CARDS)
      .map((f) => {
        const n = f.numeric!;
        return {
          field: f.name,
          sum: compact(n.sum),
          sumExact: exact(n.sum),
          mean: compact(n.mean),
          meanExact: exact(n.mean),
          range: `${compact(n.min)} – ${compact(n.max)}`
        };
      })
  );

  /** Fields that are not fully filled, emptiest first. */
  readonly quality = computed(() => {
    const p = this.profile();
    if (!p?.total) return [];
    return p.fields
      .filter((f) => f.nonNull < p.total)
      .map((f) => ({ field: f.name, share: f.nonNull / p.total, missing: p.total - f.nonNull }))
      .sort((a, b) => a.share - b.share)
      .slice(0, MAX_QUALITY_ROWS)
      .map((q) => ({
        ...q,
        percent: `${Math.floor(q.share * 100)}%`,
        note: `${exact(q.missing)} of ${exact(p.total)} features empty`
      }));
  });

  /** Says which fields were left out of the overview and why. */
  readonly skipped = computed(() => {
    const fields = this.profile()?.fields ?? [];
    const parts = [
      ['identifier', fields.filter((f) => f.role === 'id')],
      ['free text', fields.filter((f) => f.role === 'text')],
      ['single value', fields.filter((f) => f.role === 'constant')],
      ['empty', fields.filter((f) => f.role === 'empty')]
    ] as const;
    const text = parts
      .filter(([, list]) => list.length)
      .map(([label, list]) => `${label}: ${list.map((f) => f.name).join(', ')}`)
      .join(' · ');
    return text ? `Not charted — ${text}` : null;
  });

  // ----- group by -----
  readonly groupSource = signal<'field' | 'area'>('field');
  readonly groupField = signal<string | null>(null);
  readonly areaLayerId = signal<string | null>(null);
  readonly areaFields = signal<AnalyticsField[]>([]);
  readonly areaField = signal<string | null>(null);
  readonly measure = signal<GroupMeasure>('count');
  readonly measureField = signal<string | null>(null);
  readonly groupResult = signal<GroupResult | null>(null);
  readonly groupLoading = signal(false);
  readonly groupError = signal<string | null>(null);
  readonly filtering = signal(false);
  /** The bar whose filter is on the map (cleared when the filter changes). */
  private readonly appliedFilter = signal<{ cql: string; key: string } | null>(null);

  readonly filterOnLayer = computed(() => {
    const f = this.activeFilter();
    return f && f.layerId === this.layerId() ? f : null;
  });

  readonly groupFieldOptions = computed(() =>
    (this.profile()?.fields ?? [])
      .filter((f) => f.role === 'category' || f.role === 'text' || f.role === 'date')
      .map((f) => ({ label: f.name, value: f.name }))
  );

  readonly areaLayerOptions = computed(() =>
    this.layersSignal()
      .filter((l) => l.layerType === 'VECTOR' && l.geometryType === 'POLYGON' && l.id !== this.layerId())
      .map((l) => ({ label: l.name, value: l.id }))
  );

  readonly areaFieldOptions = computed(() => this.areaFields().map((f) => ({ label: f.name, value: f.name })));

  readonly measureFieldOptions = computed(() =>
    (this.profile()?.fields ?? []).filter((f) => f.role === 'measure').map((f) => ({ label: f.name, value: f.name }))
  );

  /** Measures that make sense for this layer's data. */
  readonly measureOptions = computed(() => {
    const p = this.profile();
    const options: { label: string; value: GroupMeasure }[] = [{ label: 'Count', value: 'count' }];
    if (this.measureFieldOptions().length) {
      options.push({ label: 'Sum of', value: 'sum' }, { label: 'Average of', value: 'avg' });
    }
    if (p?.geometry.kind === 'line') options.push({ label: 'Length (km)', value: 'length' });
    if (p?.geometry.kind === 'polygon') options.push({ label: 'Area (ha)', value: 'area' });
    return options;
  });

  readonly groupBars = computed((): GroupBar[] => {
    const r = this.groupResult();
    if (!r) return [];
    const unit = r.measure === 'length' ? ' km' : r.measure === 'area' ? ' ha' : '';
    const byArea = this.groupSource() === 'area';
    const rows: GroupBar[] = r.groups.map((g) => ({
      key: g.key,
      label: g.key ?? (byArea ? 'Outside every area' : '(no value)'),
      valueLabel: compact(g.value) + unit,
      share: g.value,
      muted: g.key === null,
      filterable: !(byArea && g.key === null)
    }));
    if (r.other && r.other.count > 0) {
      rows.push({
        key: '\u0000other',
        label: `Other (${exact(r.other.groups)})`,
        valueLabel: compact(r.other.value) + unit,
        share: r.other.value,
        muted: true,
        filterable: false
      });
    }
    const max = Math.max(...rows.map((b) => Math.abs(b.share)), 0) || 1;
    return rows.map((b) => ({ ...b, share: Math.max(b.share, 0) / max }));
  });

  readonly groupTitle = computed(() => {
    const m = this.measure();
    const what =
      m === 'count'
        ? 'Features'
        : m === 'length'
          ? 'Length'
          : m === 'area'
            ? 'Area'
            : `${m === 'sum' ? 'Total' : 'Average'} ${this.measureField() ?? ''}`;
    const by =
      this.groupSource() === 'area'
        ? (this.areaLayerOptions().find((o) => o.value === this.areaLayerId())?.label ?? 'area')
        : (this.groupField() ?? '');
    return `${what} by ${by}`;
  });

  /** Choropleth of the area grouping on the map. */
  readonly choroplethOn = signal(false);

  /** Up to five quantile classes over the areas' values (null key and
   *  "outside" excluded), each with its ramp colour and range. */
  readonly choroplethClasses = computed(() => {
    const r = this.groupResult();
    if (!r?.shapes?.length || this.groupSource() !== 'area') return [];
    const values = r.groups
      .filter((g) => g.key !== null)
      .map((g) => g.value)
      .sort((a, b) => a - b);
    if (!values.length) return [];
    const distinct = [...new Set(values)];
    const k = Math.min(CHOROPLETH_RAMP.length, distinct.length);
    const breaks: number[] = [];
    for (let i = 1; i < k; i++) breaks.push(values[Math.floor((i * values.length) / k)]);
    const edges = [...new Set([values[0], ...breaks, values[values.length - 1]])];
    const classes = edges.length === 1 ? [[edges[0], edges[0]]] : edges.slice(0, -1).map((from, i) => [from, edges[i + 1]]);
    // Spread the used steps across the ramp so 2–3 classes still contrast.
    const step = (CHOROPLETH_RAMP.length - 1) / Math.max(classes.length - 1, 1);
    return classes.map(([from, to], i) => ({
      from,
      to,
      color: CHOROPLETH_RAMP[Math.round(i * step)],
      label: from === to ? compact(from) : `${compact(from)} – ${compact(to)}`
    }));
  });

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

  constructor() {
    // Redraw the choropleth whenever its data or the toggle changes.
    effect(() => {
      const classes = this.choroplethClasses();
      const r = this.groupResult();
      if (!this.choroplethOn() || !classes.length || !r?.shapes) {
        if (!this.groupLoading()) this.mapService.setChoropleth(null);
        return;
      }
      const unit = r.measure === 'length' ? ' km' : r.measure === 'area' ? ' ha' : '';
      const values = new Map(r.groups.filter((g) => g.key !== null).map((g) => [g.key!, g.value]));
      this.mapService.setChoropleth(
        r.shapes
          .filter((s) => s.key !== null)
          .map((s) => {
            const value = values.get(s.key!) ?? 0;
            const cls = classes.find((c) => value <= c.to) ?? classes[classes.length - 1];
            return { geometry: s.geometry, color: cls.color, label: `${s.key}\n${compact(value)}${unit}` };
          })
      );
    });
  }

  ngOnDestroy(): void {
    this.mapService.setChoropleth(null);
  }

  toggleChoropleth(): void {
    this.choroplethOn.set(!this.choroplethOn());
  }

  selectLayer(id: string | null): void {
    this.layerId.set(id);
    this.fields.set([]);
    this.field.set(null);
    this.summary.set(null);
    this.error.set(null);
    this.profile.set(null);
    this.profileError.set(null);
    if (!id) return;
    this.gisLayersService.analyticsProfile(id).subscribe({
      next: (profile) => {
        if (this.layerId() !== id) return;
        this.profile.set(profile);
        this.resetGroup();
      },
      error: (err: HttpErrorResponse) => {
        if (this.layerId() === id) this.profileError.set(this.errorText(err));
      }
    });
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

  // ----- group by -----

  setGroupSource(source: 'field' | 'area'): void {
    this.groupSource.set(source);
    if (source === 'field') this.choroplethOn.set(false);
    if (source === 'area' && !this.areaLayerId() && this.areaLayerOptions().length) {
      this.setAreaLayer(this.areaLayerOptions()[0].value);
      return;
    }
    this.runGroup();
  }

  setGroupField(name: string | null): void {
    this.groupField.set(name);
    this.runGroup();
  }

  setAreaLayer(id: string | null): void {
    this.areaLayerId.set(id);
    this.areaFields.set([]);
    this.areaField.set(null);
    this.groupResult.set(null);
    if (!id) return;
    this.gisLayersService.analyticsFields(id).subscribe({
      next: (fields) => {
        if (this.areaLayerId() !== id) return;
        const named = fields.filter((f) => f.kind !== 'geometry');
        this.areaFields.set(named);
        // A name-like text field reads best; any non-id field otherwise.
        const pick =
          named.find((f) => f.kind === 'string' && !isIdLike(f.name)) ?? named.find((f) => !isIdLike(f.name)) ?? named[0];
        this.areaField.set(pick?.name ?? null);
        this.runGroup();
      },
      error: (err: HttpErrorResponse) => this.groupError.set(this.errorText(err))
    });
  }

  setAreaField(name: string | null): void {
    this.areaField.set(name);
    this.runGroup();
  }

  setMeasure(measure: GroupMeasure): void {
    this.measure.set(measure);
    if ((measure === 'sum' || measure === 'avg') && !this.measureField()) {
      this.measureField.set(this.measureFieldOptions()[0]?.value ?? null);
    }
    this.runGroup();
  }

  setMeasureField(name: string | null): void {
    this.measureField.set(name);
    this.runGroup();
  }

  /** Filters the map to one group's features. */
  applyGroupFilter(bar: GroupBar): void {
    if (!bar.filterable) return;
    if (this.groupSource() === 'field') {
      const field = this.groupField();
      if (field) this.applyValueFilter(field, bar.key);
      return;
    }
    const layer = this.currentLayer();
    const areaLayer = this.areaLayerId();
    const areaField = this.areaField();
    if (!layer || !areaLayer || !areaField || bar.key === null) return;
    const key = bar.key;
    this.filtering.set(true);
    this.groupError.set(null);
    this.gisLayersService.analyticsAreaShape(areaLayer, areaField, key).subscribe({
      next: ({ wkt }) => {
        if (!wkt) {
          this.filtering.set(false);
          return;
        }
        this.attributeTables.loadMetadata(layer).subscribe({
          next: ({ geometryField }) => {
            this.filtering.set(false);
            const cql = `INTERSECTS("${geometryField}", SRID=4326;${wkt})`;
            this.emitFilter(cql, `${layer.name} · in ${key}`, `a:${key}`);
          },
          error: () => {
            this.filtering.set(false);
            this.groupError.set('Could not read this layer to filter it.');
          }
        });
      },
      error: (err: HttpErrorResponse) => {
        this.filtering.set(false);
        this.groupError.set(this.errorText(err));
      }
    });
  }

  /** Filters the map to features whose `field` equals `value` (null = empty). */
  applyValueFilter(field: string, value: string | null): void {
    const layer = this.currentLayer();
    if (!layer) return;
    const kind = this.profile()?.fields.find((f) => f.name === field)?.kind;
    const col = `"${field.replace(/"/g, '')}"`;
    const cql =
      value === null
        ? `${col} IS NULL`
        : kind === 'number' || kind === 'boolean'
          ? `${col} = ${value}`
          : `${col} = '${value.replace(/'/g, "''")}'`;
    this.emitFilter(cql, `${layer.name} · ${field} = ${value ?? '(no value)'}`, `f:${field}:${value ?? ''}`);
  }

  /** Whether `key` is the bar behind the active map filter. */
  isApplied(key: string): boolean {
    const applied = this.appliedFilter();
    return !!applied && applied.key === key && this.filterOnLayer()?.cql === applied.cql;
  }

  clearFilter(): void {
    this.appliedFilter.set(null);
    this.filterClear.emit();
  }

  private emitFilter(cql: string, label: string, key: string): void {
    const layerId = this.layerId();
    if (!layerId) return;
    if (this.isApplied(key)) {
      this.clearFilter();
      return;
    }
    this.appliedFilter.set({ cql, key });
    this.filterApply.emit({ layerId, cql, label, openTable: false });
  }

  private currentLayer(): GisLayer | null {
    return this.layersSignal().find((l) => l.id === this.layerId()) ?? null;
  }

  private resetGroup(): void {
    this.groupResult.set(null);
    this.groupError.set(null);
    this.groupField.set(this.groupFieldOptions()[0]?.value ?? null);
    this.measureField.set(this.measureFieldOptions()[0]?.value ?? null);
    if (!this.measureOptions().some((o) => o.value === this.measure())) this.measure.set('count');
    if (this.areaLayerId() && !this.areaLayerOptions().some((o) => o.value === this.areaLayerId())) {
      this.areaLayerId.set(null);
      this.areaFields.set([]);
      this.areaField.set(null);
      this.groupSource.set('field');
    }
    this.runGroup();
  }

  private runGroup(): void {
    const id = this.layerId();
    const measure = this.measure();
    const byArea = this.groupSource() === 'area';
    const request = {
      by: byArea ? undefined : (this.groupField() ?? undefined),
      areaLayer: byArea ? (this.areaLayerId() ?? undefined) : undefined,
      areaField: byArea ? (this.areaField() ?? undefined) : undefined,
      measure,
      measureField: measure === 'sum' || measure === 'avg' ? (this.measureField() ?? undefined) : undefined,
      shapes: byArea ? ('true' as const) : undefined
    };
    this.groupResult.set(null);
    this.groupError.set(null);
    const ready =
      !!id &&
      (byArea ? !!request.areaLayer && !!request.areaField : !!request.by) &&
      (measure === 'sum' || measure === 'avg' ? !!request.measureField : true);
    if (!ready) return;
    this.groupLoading.set(true);
    this.gisLayersService.analyticsGroup(id, request).subscribe({
      next: (result) => {
        if (!this.sameRequest(id, request)) return;
        this.groupLoading.set(false);
        this.groupResult.set(result);
      },
      error: (err: HttpErrorResponse) => {
        if (!this.sameRequest(id, request)) return;
        this.groupLoading.set(false);
        this.groupError.set(this.errorText(err));
      }
    });
  }

  /** Drops responses for a request that has since been replaced. */
  private sameRequest(id: string, request: { by?: string; areaLayer?: string; areaField?: string; measure: GroupMeasure; measureField?: string }): boolean {
    const byArea = this.groupSource() === 'area';
    return (
      this.layerId() === id &&
      this.measure() === request.measure &&
      (byArea
        ? this.areaLayerId() === request.areaLayer && this.areaField() === request.areaField
        : this.groupField() === request.by) &&
      (request.measureField ?? null) === (request.measure === 'sum' || request.measure === 'avg' ? this.measureField() : null)
    );
  }

  /** Opens a card's field in the Field explorer. */
  exploreField(name: string): void {
    this.mode.set('field');
    this.selectField(name);
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
    this.error.set(this.errorText(err));
  }

  private errorText(err: HttpErrorResponse): string {
    return err.status === 403
      ? 'You do not have permission to view this layer.'
      : ((err.error as { message?: string } | null)?.message ?? 'Could not load statistics for this layer.');
  }
}

/** How many fields the automatic default tries before settling. */
const MAX_AUTO_TRIES = 6;
const MAX_MEASURE_CARDS = 4;

/** Sequential one-hue ramp (teal 100 → 900, light = least) around the
 *  bars' #0d9488; drawn over the basemap, so the same in both themes. */
const CHOROPLETH_RAMP = ['#ccfbf1', '#5eead4', '#14b8a6', '#0f766e', '#134e4a'];
const MAX_QUALITY_ROWS = 8;

const GEOMETRY_LABEL: Record<string, string> = {
  point: 'Points',
  line: 'Lines',
  polygon: 'Polygons',
  mixed: 'Mixed'
};

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
