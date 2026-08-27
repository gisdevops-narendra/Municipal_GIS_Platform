import {
  Component,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  computed,
  inject,
  signal
} from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import { TableModule } from 'primeng/table';
import { PaginatorModule, PaginatorState } from 'primeng/paginator';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { TooltipModule } from 'primeng/tooltip';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { MapService } from '../../services/map.service';
import { AttributeTableService } from '../../services/attribute-table.service';
import {
  ATTRIBUTE_PAGE_SIZES,
  AttributeField,
  AttributeQuery,
  AttributeRow,
  DEFAULT_ATTRIBUTE_QUERY,
  GeoJsonGeometry
} from '../../models/attribute-table.model';

/** Feature clicked on the map, forwarded by the workspace so the table can
 *  mirror the selection (and vice versa). */
export interface MapClickFeatureRef {
  layerId: string;
  featureId: string;
}

/** A Query Builder result applied to the table as a locked filter. */
export interface AttributeExternalFilter {
  layerId: string;
  cql: string;
  label: string;
}

/**
 * ArcMap / ArcGIS Pro-style attribute table for one published GIS layer.
 *
 * Data comes straight from GeoServer WFS (live from PostGIS) with all
 * paging / sorting / text-search done server-side, so it stays fast on
 * large layers. Selection is kept as a set of stable feature ids and
 * synchronised both ways with the map's highlight overlay via MapService.
 *
 * Extension points: new toolbar actions slot into `.attr-table__tools`;
 * new bulk operations (export, statistics, spatial query) can reuse
 * `AttributeTableService` and the `selectedIds` set without touching this
 * component's rendering.
 */
@Component({
  selector: 'app-attribute-table',
  standalone: true,
  imports: [
    NgClass,
    FormsModule,
    TableModule,
    PaginatorModule,
    ButtonModule,
    SelectModule,
    CheckboxModule,
    TooltipModule,
    InputTextModule,
    MessageModule
  ],
  templateUrl: './attribute-table.component.html',
  styleUrl: './attribute-table.component.scss'
})
export class AttributeTableComponent implements OnChanges, OnDestroy {
  private readonly service = inject(AttributeTableService);
  private readonly mapService = inject(MapService);

  @Input() layers: GisLayer[] = [];
  /** Preferred layer to open (e.g. the one highlighted from a deep link). */
  @Input() initialLayerId: string | null = null;
  /** Features just clicked on the map — toggles them in the selection. */
  @Input() mapClickFeatures: MapClickFeatureRef[] = [];
  /** A locked base CQL filter driven by the Query Builder — ANDed with the
   *  in-table search; shown as a removable chip. */
  @Input() externalFilter: AttributeExternalFilter | null = null;
  @Output() externalFilterCleared = new EventEmitter<void>();

  readonly baseFilter = signal<AttributeExternalFilter | null>(null);

  readonly pageSizes = ATTRIBUTE_PAGE_SIZES;

  readonly activeLayerId = signal<string | null>(null);
  readonly fields = signal<AttributeField[]>([]);
  readonly hiddenFields = signal<Set<string>>(new Set());
  readonly rows = signal<AttributeRow[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly first = signal(0);
  readonly pageSize = signal(DEFAULT_ATTRIBUTE_QUERY.pageSize);
  readonly sortField = signal<string | null>(null);
  readonly sortDir = signal<'asc' | 'desc'>('asc');
  readonly searchInput = signal('');
  readonly search = signal('');

  readonly selectedIds = signal<Set<string>>(new Set());
  readonly fieldsMenuOpen = signal(false);

  private readonly geomCache = new Map<string, GeoJsonGeometry | null>();
  private readonly search$ = new Subject<string>();
  private loadToken = 0;
  private lastClickedIndex = -1;

  readonly visibleFields = computed(() =>
    this.fields().filter((field) => !this.hiddenFields().has(field.name))
  );

  readonly layerOptions = computed(() =>
    this.layers
      .filter((layer) => layer.layerType === 'VECTOR')
      .map((layer) => ({ label: layer.name, value: layer.id }))
  );

  readonly hasLayers = computed(() => this.layerOptions().length > 0);

  readonly pageReport = computed(() => {
    const total = this.total();
    if (total === 0) {
      return this.loading() ? 'Loading…' : '0 records';
    }
    const from = this.first() + 1;
    const to = Math.min(this.first() + this.pageSize(), total);
    const selected = this.selectedIds().size;
    const base = `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`;
    return selected > 0 ? `${base} · ${selected.toLocaleString()} selected` : base;
  });

  constructor() {
    this.search$
      .pipe(debounceTime(300), distinctUntilChanged())
      .subscribe((value) => {
        this.search.set(value.trim());
        this.first.set(0);
        this.load();
      });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['externalFilter']) {
      this.applyExternalFilter();
      return;
    }
    if (changes['layers'] || changes['initialLayerId']) {
      this.pickDefaultLayer();
    }
    if (changes['mapClickFeatures'] && this.mapClickFeatures?.length) {
      this.syncFromMapClick();
    }
  }

  private applyExternalFilter(): void {
    const filter = this.externalFilter;
    this.baseFilter.set(filter);
    if (!filter) {
      this.first.set(0);
      this.load();
      return;
    }
    // switch to the queried layer, then load with the base filter applied
    if (filter.layerId !== this.activeLayerId()) {
      this.activeLayerId.set(filter.layerId);
      this.sortField.set(null);
      this.searchInput.set('');
      this.search.set('');
      this.hiddenFields.set(new Set());
      this.fields.set(this.service.getFields(filter.layerId) || []);
      this.selectedIds.set(new Set());
      this.geomCache.clear();
    }
    this.first.set(0);
    this.load();
  }

  clearExternalFilter(): void {
    this.baseFilter.set(null);
    this.externalFilterCleared.emit();
    this.first.set(0);
    this.load();
  }

  ngOnDestroy(): void {
    this.mapService.clearSelectionHighlight();
  }

  // ----- layer selection -----

  private pickDefaultLayer(): void {
    const options = this.layerOptions();
    if (options.length === 0) {
      return;
    }
    const current = this.activeLayerId();
    if (current && options.some((option) => option.value === current)) {
      return;
    }
    const preferred =
      (this.initialLayerId && options.find((option) => option.value === this.initialLayerId)) || options[0];
    this.selectLayer(preferred.value);
  }

  selectLayer(layerId: string | null): void {
    if (layerId === this.activeLayerId()) {
      return;
    }
    this.activeLayerId.set(layerId);
    this.first.set(0);
    this.sortField.set(null);
    this.sortDir.set('asc');
    this.searchInput.set('');
    this.search.set('');
    this.hiddenFields.set(new Set());
    this.fields.set((layerId && this.service.getFields(layerId)) || []);
    this.selectedIds.set(new Set());
    this.geomCache.clear();
    this.lastClickedIndex = -1;
    this.mapService.clearSelectionHighlight();
    if (this.baseFilter()) {
      // the query filter belonged to the previous layer
      this.baseFilter.set(null);
      this.externalFilterCleared.emit();
    }
    this.load();
  }

  private activeLayer(): GisLayer | null {
    return this.layers.find((layer) => layer.id === this.activeLayerId()) ?? null;
  }

  // ----- data loading -----

  private load(): void {
    const layer = this.activeLayer();
    if (!layer) {
      this.rows.set([]);
      this.total.set(0);
      return;
    }

    const token = ++this.loadToken;
    this.loading.set(true);
    this.error.set(null);

    const query: AttributeQuery = {
      page: Math.floor(this.first() / this.pageSize()),
      pageSize: this.pageSize(),
      sortField: this.sortField(),
      sortDir: this.sortDir(),
      search: this.search()
    };

    const base = this.baseFilter();
    this.service.fetchPage(layer, query, { baseFilter: base?.layerId === layer.id ? base.cql : null }).subscribe({
      next: (page) => {
        if (token !== this.loadToken) return;
        this.rows.set(page.rows);
        this.total.set(page.total);
        if (page.fields.length > 0) {
          this.fields.set(page.fields);
        }
        for (const row of page.rows) {
          this.geomCache.set(row.featureId, row.geometry);
        }
        this.loading.set(false);
      },
      error: (err: HttpErrorResponse) => {
        if (token !== this.loadToken) return;
        this.rows.set([]);
        this.total.set(0);
        this.error.set(this.describeError(err));
        this.loading.set(false);
      }
    });
  }

  refresh(): void {
    const id = this.activeLayerId();
    if (id) {
      this.service.clearCache(id);
    }
    this.load();
  }

  // ----- sorting / paging / search -----

  onSort(fieldName: string): void {
    if (this.sortField() === fieldName) {
      this.sortDir.set(this.sortDir() === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortField.set(fieldName);
      this.sortDir.set('asc');
    }
    this.first.set(0);
    this.load();
  }

  onPage(event: PaginatorState): void {
    this.first.set(event.first ?? 0);
    if (event.rows) {
      this.pageSize.set(event.rows);
    }
    this.load();
  }

  onSearch(value: string): void {
    this.searchInput.set(value);
    this.search$.next(value);
  }

  // ----- selection (row click, ArcMap-style) -----

  onRowClick(row: AttributeRow, event: MouseEvent): void {
    const rows = this.rows();
    const index = rows.indexOf(row);
    const ids = new Set(this.selectedIds());

    if (event.shiftKey && this.lastClickedIndex >= 0) {
      const [a, b] = [Math.min(this.lastClickedIndex, index), Math.max(this.lastClickedIndex, index)];
      for (let i = a; i <= b; i++) {
        ids.add(rows[i].featureId);
      }
    } else if (event.ctrlKey || event.metaKey) {
      ids.has(row.featureId) ? ids.delete(row.featureId) : ids.add(row.featureId);
    } else {
      ids.clear();
      ids.add(row.featureId);
    }

    this.lastClickedIndex = index;
    this.applySelection(ids);
  }

  selectAllOnPage(): void {
    const ids = new Set(this.selectedIds());
    for (const row of this.rows()) {
      ids.add(row.featureId);
    }
    this.applySelection(ids);
  }

  clearSelection(): void {
    this.applySelection(new Set());
  }

  zoomToSelected(): void {
    const ids = [...this.selectedIds()];
    if (ids.length === 0) {
      return;
    }
    this.withGeometries(ids, (geometries) => this.mapService.zoomToGeometries(geometries));
  }

  isSelected(row: AttributeRow): boolean {
    return this.selectedIds().has(row.featureId);
  }

  private applySelection(ids: Set<string>): void {
    this.selectedIds.set(ids);
    if (ids.size === 0) {
      this.mapService.clearSelectionHighlight();
      return;
    }
    this.withGeometries([...ids], (geometries) => this.mapService.setSelectionHighlight(geometries));
  }

  /** Ensures every id has a cached geometry (fetching the missing ones by
   *  id via WFS), then runs `apply` with the full geometry list. */
  private withGeometries(ids: string[], apply: (geometries: (GeoJsonGeometry | null)[]) => void): void {
    const missing = ids.filter((id) => !this.geomCache.has(id));
    const layer = this.activeLayer();
    const run = () => apply(ids.map((id) => this.geomCache.get(id) ?? null));

    if (missing.length === 0 || !layer) {
      run();
      return;
    }
    this.service.fetchByIds(layer, missing).subscribe({
      next: (rows) => {
        for (const row of rows) {
          this.geomCache.set(row.featureId, row.geometry);
        }
        run();
      },
      error: () => run()
    });
  }

  private syncFromMapClick(): void {
    const layerId = this.activeLayerId();
    const relevant = this.mapClickFeatures.filter(
      (feature) => feature.layerId === layerId && !!feature.featureId
    );
    if (relevant.length === 0) {
      return;
    }
    const ids = new Set(this.selectedIds());
    for (const feature of relevant) {
      ids.has(feature.featureId) ? ids.delete(feature.featureId) : ids.add(feature.featureId);
    }
    this.applySelection(ids);
  }

  // ----- field visibility -----

  toggleFieldsMenu(): void {
    this.fieldsMenuOpen.update((open) => !open);
  }

  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: Event): void {
    if (!this.fieldsMenuOpen()) {
      return;
    }
    const target = event.target as HTMLElement;
    if (!target.closest('.attr-table__fields')) {
      this.fieldsMenuOpen.set(false);
    }
  }

  isFieldVisible(name: string): boolean {
    return !this.hiddenFields().has(name);
  }

  toggleField(name: string, visible: boolean): void {
    const hidden = new Set(this.hiddenFields());
    if (visible) {
      hidden.delete(name);
    } else {
      if (hidden.size + 1 >= this.fields().length) {
        return; // keep at least one column
      }
      hidden.add(name);
    }
    this.hiddenFields.set(hidden);
  }

  // ----- value formatting -----

  isNull(value: unknown): boolean {
    return value === null || value === undefined || value === '';
  }

  isNumeric(field: AttributeField): boolean {
    return field.type === 'integer' || field.type === 'number' || field.type === 'id';
  }

  formatValue(field: AttributeField, value: unknown): string {
    if (this.isNull(value)) {
      return '—';
    }
    switch (field.type) {
      case 'date': {
        const raw = String(value);
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) {
          return raw;
        }
        return /[T ]\d{2}:\d{2}/.test(raw)
          ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
          : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
      }
      case 'boolean':
        return value === true || value === 'true' ? 'Yes' : 'No';
      case 'integer': {
        const num = Number(value);
        return Number.isFinite(num) ? num.toLocaleString() : String(value);
      }
      case 'number': {
        const num = Number(value);
        return Number.isFinite(num) ? num.toLocaleString(undefined, { maximumFractionDigits: 6 }) : String(value);
      }
      case 'id':
        return String(value);
      default:
        return String(value);
    }
  }

  private describeError(err: HttpErrorResponse): string {
    if (err.status === 0) {
      return 'Could not reach the GIS server. Check that GeoServer is running.';
    }
    return `The GIS server returned an error (${err.status}). The layer may not be published for feature access.`;
  }
}
