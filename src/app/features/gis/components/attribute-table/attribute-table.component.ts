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
import { Subject, Subscription, concatMap, debounceTime, filter as rxFilter, from, toArray } from 'rxjs';
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
import { VectorToolsService } from '../../services/vector-tools.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { GisLayersService } from '../../../../core/services/gis-layers.service';
import { LAYER_EXPORT_FORMATS, LayerExportFormatOption } from '../../../../core/models/layer-export.model';
import { blobErrorMessage, downloadBlob } from '../../../../core/utils/download-blob';
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
/** Most features Switch Selection can select. */
const SWITCH_SELECT_LIMIT = 5000;

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
  private readonly vectorTools = inject(VectorToolsService);
  private readonly notify = inject(NotificationService);
  private readonly gisLayers = inject(GisLayersService);

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
  /** The layer in a Draw & Mark edit session — its cells become editable
   *  (double-click), with edits buffered until Save, as in QGIS. */
  @Input() editableLayerId: string | null = null;
  /** Bumped when features were written elsewhere (the edit panel). */
  @Input() refreshKey = 0;
  /** Saved cell edits, per feature id, for the edit panel's open feature. */
  @Output() featuresEdited = new EventEmitter<{ layerId: string; changes: Record<number, Record<string, string>> }>();

    @Output() selectionChange = new EventEmitter<{ layerId: string; featureIds: string[] }>();
  /** Module Access ids granted to the user — gates Export selected formats. */
  @Input() set allowedModuleIds(value: ReadonlySet<number>) {
    this.allowedSignal.set(value ?? new Set());
  }
  private readonly allowedSignal = signal<ReadonlySet<number>>(new Set());
  /** A layer made by Save selection as layer. */
  @Output() layerCreated = new EventEmitter<GisLayer>();

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
  /** List only the selected records (ArcGIS "Show selected records"). */
  readonly showSelectedOnly = signal(false);
  readonly switching = signal(false);
  readonly fieldsMenuOpen = signal(false);

  // ----- Export selected / Save selection as layer -----
  readonly selectionMenuOpen = signal(false);
  readonly exportFormats = computed(() =>
    LAYER_EXPORT_FORMATS.filter((f) => f.moduleId === undefined || this.allowedSignal().has(f.moduleId))
  );
  readonly selectionBusy = signal(false);
  readonly selectionError = signal<string | null>(null);
  selectionLayerName = '';

  // ----- cell editing (edit session) -----
  private readonly editableId = signal<string | null>(null);
  readonly canEditCells = computed(() => !!this.editableId() && this.editableId() === this.activeLayerId());
  readonly editingCell = signal<{ rowId: string; field: string } | null>(null);
  cellDraft = '';
  /** Unsaved cell values: feature id → field → value ('' = empty). */
  readonly pending = signal<ReadonlyMap<string, Record<string, string>>>(new Map());
  readonly pendingCount = computed(() => [...this.pending().values()].reduce((n, r) => n + Object.keys(r).length, 0));
  readonly savingEdits = signal(false);
  readonly editError = signal<string | null>(null);

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
    if (changes['editableLayerId']) {
      if (this.pendingCount() && this.editableLayerId !== this.editableId()) this.discardEdits();
      this.editableId.set(this.editableLayerId);
    }
    if (changes['refreshKey'] && !changes['refreshKey'].firstChange && !this.pendingCount()) {
      this.refresh();
    }
    // Opened for a specific layer (Draw & Mark → Table): show that one.
    const initial = changes['initialLayerId'];
    if (initial && !initial.firstChange && this.initialLayerId && this.layerOptions().some((o) => o.value === this.initialLayerId)) {
      this.selectLayer(this.initialLayerId);
    } else if (changes['layers'] || initial) {
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

  /** Layer picked in the toolbar — asks before dropping unsaved cell edits. */
  onLayerPick(layerId: string | null): void {
    if (!this.pendingCount()) return this.selectLayer(layerId);
    this.notify.confirm({
      header: 'Discard unsaved edits?',
      message: `${this.pendingCount()} cell edit(s) on this layer have not been saved.`,
      confirmLabel: 'Discard',
      destructive: true,
      accept: () => this.selectLayer(layerId)
    });
  }

  selectLayer(layerId: string | null): void {
    if (layerId === this.activeLayerId()) {
      return;
    }
    this.discardEdits();
    this.cancelMapSelect();
    this.selectNote.set(null);
    this.activeLayerId.set(layerId);
    this.first.set(0);
    this.sortField.set(null);
    this.sortDir.set('asc');
    this.searchInput.set('');
    this.search.set('');
    this.hiddenFields.set(new Set());
    this.showSelectedOnly.set(false);
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
    const onlySelected = this.showSelectedOnly() && this.selectedIds().size > 0;
    this.service
      .fetchPage(layer, query, {
        baseFilter: base?.layerId === layer.id ? base.cql : null,
        featureIds: onlySelected ? [...this.selectedIds()] : null
      })
      .subscribe({
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

  toggleShowSelected(): void {
    if (!this.showSelectedOnly() && this.selectedIds().size === 0) return;
    this.showSelectedOnly.update((on) => !on);
    this.first.set(0);
    this.load();
  }

  /** Switch Selection: selects every record the table lists (query filter
   *  and search applied) that is not selected now, and unselects the rest. */
  switchSelection(): void {
    const layer = this.activeLayer();
    if (!layer || this.switching()) return;
    const base = this.baseFilter();
    const cql = this.service.recordFilter(layer.id, this.search(), base?.layerId === layer.id ? base.cql : null);
    const current = this.selectedIds();
    this.switching.set(true);
    this.selectNote.set(null);
    this.service.loadMetadata(layer).subscribe({
      next: ({ geometryField }) => {
        this.service.fetchIds(layer, geometryField, cql, SWITCH_SELECT_LIMIT + current.size).subscribe({
          next: ({ rows, total }) => {
            this.switching.set(false);
            if (this.activeLayerId() !== layer.id) return;
            const ids = new Set<string>();
            for (const row of rows) {
              this.geomCache.set(row.featureId, row.geometry);
              if (!current.has(row.featureId) && ids.size < SWITCH_SELECT_LIMIT) ids.add(row.featureId);
            }
            const capped = total > rows.length || ids.size === SWITCH_SELECT_LIMIT;
            this.applySelection(ids);
            this.selectNote.set(
              ids.size === 0
                ? 'Nothing left to select — every record was selected.'
                : `Switched: ${ids.size.toLocaleString()} selected${capped ? ` (capped at ${SWITCH_SELECT_LIMIT.toLocaleString()})` : ''}.`
            );
          },
          error: () => {
            this.switching.set(false);
            this.selectNote.set('Could not switch the selection.');
          }
        });
      },
      error: () => {
        this.switching.set(false);
        this.selectNote.set('Could not switch the selection.');
      }
    });
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
    if (this.showSelectedOnly()) {
      // The list *is* the selection: follow it (or leave the view if empty).
      if (ids.size === 0) this.showSelectedOnly.set(false);
      this.first.set(0);
      this.load();
    }
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
    const target = event.target as HTMLElement;
    if (this.fieldsMenuOpen() && !target.closest('.attr-table__fields')) {
      this.fieldsMenuOpen.set(false);
    }
    if (this.selectionMenuOpen() && !target.closest('.attr-table__selection')) {
      this.selectionMenuOpen.set(false);
    }
  }

  toggleSelectionMenu(): void {
    const open = !this.selectionMenuOpen();
    this.selectionMenuOpen.set(open);
    if (open) {
      this.selectionError.set(null);
      const layer = this.layers.find((l) => l.id === this.activeLayerId());
      this.selectionLayerName = layer ? `${layer.name} (selected)` : '';
    }
  }

  /** The selection as feature keys (the "<n>" of "<layer>.<n>"), or null
   *  when a record has no numeric key. */
  private selectedKeys(): number[] | null {
    const keys = [...this.selectedIds()].map((id) => Number(id.split('.').pop()));
    return keys.length && keys.every((k) => Number.isInteger(k) && k > 0) ? keys : null;
  }

  exportSelected(format: LayerExportFormatOption): void {
    const layer = this.layers.find((l) => l.id === this.activeLayerId());
    const keys = this.selectedKeys();
    if (!layer || this.selectionBusy()) return;
    if (!keys) return this.selectionError.set('These records cannot be exported by selection.');
    this.selectionBusy.set(true);
    this.selectionError.set(null);
    this.gisLayers.exportSelected(layer.id, format.value, keys).subscribe({
      next: (blob) => {
        this.selectionBusy.set(false);
        this.selectionMenuOpen.set(false);
        downloadBlob(blob, `${layer.code.toLowerCase()}_selected.${format.extension}`);
        this.notify.success(`Exported ${keys.length.toLocaleString()} selected feature(s) as ${format.label}.`);
      },
      error: async (err: HttpErrorResponse) => {
        this.selectionBusy.set(false);
        this.selectionError.set(
          err.status === 403
            ? 'You do not have permission to export this layer.'
            : await blobErrorMessage(err, 'Export failed. Please try again.')
        );
      }
    });
  }

  saveSelectionAsLayer(): void {
    const layerId = this.activeLayerId();
    const keys = this.selectedKeys();
    const name = this.selectionLayerName.trim();
    if (!layerId || this.selectionBusy()) return;
    if (!keys) return this.selectionError.set('These records cannot be saved by selection.');
    if (!name) return this.selectionError.set('Enter a name for the new layer.');
    this.selectionBusy.set(true);
    this.selectionError.set(null);
    this.vectorTools.saveSelection(layerId, keys, name).subscribe({
      next: (layer) => {
        this.selectionBusy.set(false);
        this.selectionMenuOpen.set(false);
        this.notify.success(`Saved ${keys.length.toLocaleString()} feature(s) as layer "${layer.name}".`);
        this.layerCreated.emit(layer);
      },
      error: (err: HttpErrorResponse) => {
        this.selectionBusy.set(false);
        this.selectionError.set(err.error?.message ?? 'Could not save the selection as a layer.');
      }
    });
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

  // ----- cell editing -----

  /** Identifier columns are never edited. */
  isEditableField(field: AttributeField): boolean {
    return field.type !== 'id' && field.name !== 'ogc_fid' && field.name !== 'fid';
  }

  /** The value to show: an unsaved edit wins over the loaded value. */
  cellValue(row: AttributeRow, field: AttributeField): unknown {
    const edited = this.pending().get(row.featureId)?.[field.name];
    if (edited === undefined) return row.values[field.name];
    return edited === '' ? null : edited;
  }

  isCellDirty(row: AttributeRow, field: AttributeField): boolean {
    return this.pending().get(row.featureId)?.[field.name] !== undefined;
  }

  isEditingCell(row: AttributeRow, field: AttributeField): boolean {
    const cell = this.editingCell();
    return !!cell && cell.rowId === row.featureId && cell.field === field.name;
  }

  startCellEdit(row: AttributeRow, field: AttributeField, event: Event): void {
    if (!this.canEditCells() || !this.isEditableField(field) || this.savingEdits()) return;
    event.stopPropagation();
    this.editingCell.set({ rowId: row.featureId, field: field.name });
    this.cellDraft = this.toInput(field, this.cellValue(row, field));
    setTimeout(() => (document.querySelector('.attr-table__cell-input') as HTMLElement | null)?.focus());
  }

  commitCell(row: AttributeRow, field: AttributeField): void {
    if (!this.isEditingCell(row, field)) return;
    this.editingCell.set(null);
    const original = this.toInput(field, row.values[field.name]);
    const next = new Map(this.pending());
    const edits = { ...(next.get(row.featureId) ?? {}) };
    if (this.cellDraft === original) delete edits[field.name];
    else edits[field.name] = this.cellDraft;
    if (Object.keys(edits).length) next.set(row.featureId, edits);
    else next.delete(row.featureId);
    this.pending.set(next);
    this.editError.set(null);
  }

  cancelCell(): void {
    this.editingCell.set(null);
  }

  /** Writes every buffered edit (one request per feature, in order). */
  saveEdits(): void {
    const layerId = this.activeLayerId();
    const entries = [...this.pending().entries()];
    if (!layerId || !entries.length) return;
    const changes: Record<number, Record<string, string>> = {};
    for (const [rowId, props] of entries) {
      const fid = Number(rowId.split('.').pop());
      if (!Number.isInteger(fid)) {
        this.editError.set('These records cannot be edited here.');
        return;
      }
      changes[fid] = props;
    }
    this.savingEdits.set(true);
    this.editError.set(null);
    from(Object.entries(changes))
      .pipe(
        concatMap(([fid, properties]) => this.vectorTools.updateFeature(layerId, Number(fid), { properties })),
        toArray()
      )
      .subscribe({
        next: () => {
          this.savingEdits.set(false);
          this.pending.set(new Map());
          this.mapService.refreshLayerStyle(layerId);
          this.featuresEdited.emit({ layerId, changes });
          this.refresh();
        },
        error: (err: HttpErrorResponse) => {
          this.savingEdits.set(false);
          const message = err.error?.message;
          this.editError.set(
            (Array.isArray(message) ? message.join('. ') : message) ?? 'Could not save the edits. Nothing after the failed record was saved.'
          );
          this.refresh();
        }
      });
  }

  discardEdits(): void {
    this.editingCell.set(null);
    this.pending.set(new Map());
    this.editError.set(null);
  }

  /** A value as the edit input holds it (and as the Edit panel sends it). */
  private toInput(field: AttributeField, value: unknown): string {
    if (value === null || value === undefined) return '';
    if (field.type === 'date') return String(value).slice(0, 10);
    return String(value);
  }

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
