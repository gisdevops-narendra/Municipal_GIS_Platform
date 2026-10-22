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
  effect,
  inject,
  signal,
  untracked
} from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, Subscription, debounceTime, filter as rxFilter } from 'rxjs';
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
 *  mirror the selection (and vice versa). The Selection Tool buttons live
 *  in MapControlsComponent and call startMapSelect(). */
export interface MapClickFeatureRef {
  layerId: string;
  featureId: string;
}

/** Most features one map selection adds (ids + geometry are fetched). */
const MAP_SELECT_LIMIT = 2000;

export type SelectShape = 'Rectangle' | 'Polygon' | 'Lasso';
export type SelectMode = 'new' | 'add' | 'remove';

/** A Query Builder result applied to the table as a locked filter. */
export interface AttributeExternalFilter {
  layerId: string;
  cql: string;
  label: string;
  /** false = filter the layer but leave the Attribute Table closed. */
  openTable?: boolean;
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
/** Integer fields that hold labels rather than quantities (shapefile names
 *  are often cut to 10 chars: census_yea, election_w). */
const IDENTIFIER_FIELD = /(^|_)(id|fid|gid|objectid|code|no|num|number|year|yea|yr|pin|pincode|zip|phone|mobile|srid)$/i;

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

  /** Backed by a signal so `layerOptions` recomputes when the list arrives
   *  or changes — a plain field would be read once by `computed()` and
   *  cached, leaving the picker empty if the table opened before the
   *  layers had loaded. */
  @Input() set layers(value: GisLayer[]) {
    this.layersSignal.set(value ?? []);
  }
  get layers(): GisLayer[] {
    return this.layersSignal();
  }
  private readonly layersSignal = signal<GisLayer[]>([]);
  /** Preferred layer to open (e.g. the one highlighted from a deep link). */
  @Input() initialLayerId: string | null = null;
  /** Features just clicked on the map — toggles them in the selection. */
  @Input() mapClickFeatures: MapClickFeatureRef[] = [];
  /** A locked base CQL filter driven by the Query Builder — ANDed with the
   *  in-table search; shown as a removable chip. */
  @Input() externalFilter: AttributeExternalFilter | null = null;
  @Output() externalFilterCleared = new EventEmitter<void>();
  /** The current selection (ids of the active layer), for Report Generation. */
  @Output() selectionChange = new EventEmitter<{ layerId: string; featureIds: string[] }>();

  readonly baseFilter = signal<AttributeExternalFilter | null>(null);

  readonly selectShapes: { shape: SelectShape; icon: string; label: string; hint: string }[] = [
    { shape: 'Rectangle', icon: 'pi pi-stop', label: 'Select by rectangle', hint: 'Click one corner on the map, then the opposite corner.' },
    { shape: 'Polygon', icon: 'pi pi-share-alt', label: 'Select by polygon', hint: 'Click to add corners; double-click to finish.' },
    { shape: 'Lasso', icon: 'pi pi-pencil', label: 'Select by lasso', hint: 'Press and drag around the features; release to finish.' }
  ];
  readonly selectMode = signal<SelectMode>('new');
  readonly selectingShape = signal<SelectShape | null>(null);
  readonly selectNote = signal<string | null>(null);
  readonly selectHint = computed(
    () => this.selectShapes.find((s) => s.shape === this.selectingShape())?.hint ?? null
  );
  private selectSub?: Subscription;

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
  private selectionToken = 0;
  private lastClickedIndex = -1;

  readonly visibleFields = computed(() =>
    this.fields().filter((field) => !this.hiddenFields().has(field.name))
  );

  /** Only the vector layers switched ON on the map — the table follows
   *  what the user is looking at (an AI / query result switches its layer
   *  on, so it is always listed). */
  readonly layerOptions = computed(() => {
    const visible = this.mapService.layerVisibility();
    return this.layers
      .filter((layer) => layer.layerType === 'VECTOR' && visible[layer.id] === true)
      .map((layer) => ({ label: layer.name, value: layer.id }));
  });

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
    // A layer switched on/off on the map updates the list; if the shown
    // layer was switched off, move to another visible one (or none).
    effect(() => {
      this.layerOptions();
      untracked(() => this.pickDefaultLayer());
    });
    this.search$
      // Compared with the search actually applied (not the last value typed):
      // switching layers clears `search`, and typing the same text again on
      // the new layer must still filter it.
      .pipe(debounceTime(300), rxFilter((value) => value.trim() !== this.search()))
      .subscribe((value) => {
        this.search.set(value.trim());
        this.first.set(0);
        this.load();
      });
  }

  ngOnChanges(changes: SimpleChanges): void {
    // The first change set contains every bound input — including a null
    // externalFilter — so only treat it as a filter change when there is
    // a real filter or it changed later; otherwise fall through and pick
    // the default layer.
    const filterChange = changes['externalFilter'];
    if (filterChange && (!filterChange.firstChange || this.externalFilter)) {
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
      this.geomCache.clear();
      this.lastClickedIndex = -1;
      this.applySelection(new Set());
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
    this.cancelMapSelect();
    this.mapService.clearSelectionHighlight();
  }

  // ----- layer selection -----

  private pickDefaultLayer(): void {
    const options = this.layerOptions();
    if (options.length === 0) {
      if (this.activeLayerId()) this.selectLayer(null);
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
    this.cancelMapSelect();
    this.selectNote.set(null);
    this.activeLayerId.set(layerId);
    this.first.set(0);
    this.sortField.set(null);
    this.sortDir.set('asc');
    this.searchInput.set('');
    this.search.set('');
    this.hiddenFields.set(new Set());
    this.fields.set((layerId && this.service.getFields(layerId)) || []);
    this.geomCache.clear();
    this.lastClickedIndex = -1;
    // Emits too, so Report Generation drops the previous layer's selection.
    this.applySelection(new Set());
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
        // Row indexes now refer to a different page / order.
        this.lastClickedIndex = -1;
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

  // ----- selection tool: select on the map by shape -----

  /** Draw a shape on the map; features of the active layer intersecting it
   *  become the selection (New), join it (Add) or leave it (Remove). */
  /** Entry point for the map's Selection Tool controls (the buttons live
   *  in MapControlsComponent; the selection itself is owned here). */
  startMapSelect(shape: SelectShape, mode: SelectMode): void {
    this.selectMode.set(mode);
    this.selectOnMap(shape);
  }

  selectOnMap(shape: SelectShape): void {
    const layer = this.activeLayer();
    if (!layer) return;
    this.cancelMapSelect();
    this.selectNote.set(null);
    this.selectingShape.set(shape);
    this.selectSub = this.mapService.beginDraw(shape).subscribe({
      next: (geometry) => {
        // OpenLayers adds the drawn feature to the draw layer only after
        // 'drawend' has fired, so clearing now would leave the shape on
        // the map — clear on the next tick instead.
        setTimeout(() => this.mapService.clearDraw());
        this.selectingShape.set(null);
        this.selectSub = this.service.loadMetadata(layer).subscribe({
          next: ({ geometryField }) => {
            const wkt = this.mapService.shapeToQueryWkt(geometry);
            this.selectSub = this.service.fetchIdsInShape(layer, geometryField, wkt, MAP_SELECT_LIMIT).subscribe({
              next: ({ rows, total }) => this.applyMapSelection(layer.id, rows, total),
              error: () => this.selectNote.set('Could not select features in that area.')
            });
          },
          error: () => this.selectNote.set('Could not select features in that area.')
        });
      },
      complete: () => this.selectingShape.set(null)
    });
  }

  cancelMapSelect(): void {
    this.selectSub?.unsubscribe();
    this.selectSub = undefined;
    if (this.selectingShape()) {
      this.mapService.clearDraw();
      this.selectingShape.set(null);
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.selectingShape()) this.cancelMapSelect();
  }

  private applyMapSelection(layerId: string, rows: AttributeRow[], total: number): void {
    if (this.activeLayerId() !== layerId) return;
    for (const row of rows) {
      this.geomCache.set(row.featureId, row.geometry);
    }
    const found = rows.map((r) => r.featureId);
    const mode = this.selectMode();
    const ids = mode === 'new' ? new Set<string>() : new Set(this.selectedIds());
    for (const id of found) {
      if (mode === 'remove') ids.delete(id);
      else ids.add(id);
    }
    this.applySelection(ids);
    const verb = mode === 'remove' ? 'Removed' : mode === 'add' ? 'Added' : 'Selected';
    const capped = total > rows.length ? ` (first ${rows.length.toLocaleString()} of ${total.toLocaleString()})` : '';
    this.selectNote.set(
      found.length === 0
        ? 'No features in that area.'
        : `${verb} ${found.length.toLocaleString()} feature${found.length === 1 ? '' : 's'}${capped}.`
    );
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
    const token = ++this.selectionToken;
    this.selectedIds.set(ids);
    const layerId = this.activeLayerId();
    if (layerId) this.selectionChange.emit({ layerId, featureIds: [...ids] });
    if (ids.size === 0) {
      this.mapService.clearSelectionHighlight();
      return;
    }
    this.withGeometries([...ids], (geometries) => {
      // A newer selection may have been made while geometries loaded.
      if (token === this.selectionToken) this.mapService.setSelectionHighlight(geometries);
    });
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
        if (!Number.isFinite(num)) return String(value);
        // Years, ids and codes are labels, not amounts: 2011, not "2,011".
        return IDENTIFIER_FIELD.test(field.name) ? String(num) : num.toLocaleString();
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
