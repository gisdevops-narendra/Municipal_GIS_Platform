import { Component, WritableSignal, computed, effect, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { MessageModule } from 'primeng/message';
import { TooltipModule } from 'primeng/tooltip';
import { SiteHeaderComponent } from '../../shared/components/site-header/site-header.component';
import { GisWorkspaceService } from '../../core/services/gis-workspace.service';
import { GisLayersService } from '../../core/services/gis-layers.service';
import { CurrentUserService } from '../../core/services/current-user.service';
import { ModuleAccessService } from '../../core/services/module-access.service';
import { GisWorkspace } from '../../core/models/gis-workspace.model';
import { GisLayer } from '../../core/models/gis-layer.model';
import { GisSearchFeatureMatch, GisSearchLayerMatch } from '../../core/models/gis-dashboard.model';
import { MapService, FeatureInfoResult } from './services/map.service';
import { MunicipalMapComponent } from './components/municipal-map/municipal-map.component';
import { LayerPanelComponent } from './components/layer-panel/layer-panel.component';
import { MapControlsComponent } from './components/map-controls/map-controls.component';
import { GisSearchComponent } from './components/gis-search/gis-search.component';
import {
  AttributeExternalFilter,
  AttributeTableComponent,
  MapClickFeatureRef,
  SelectMode,
  SelectShape
} from './components/attribute-table/attribute-table.component';
import { QueryBuilderComponent } from './components/query-builder/query-builder.component';
import { MeasureComponent } from './components/measure/measure.component';
import { BookmarksComponent } from './components/bookmarks/bookmarks.component';
import { BufferOverlayComponent } from './components/buffer-overlay/buffer-overlay.component';
import {
  AdvancedToolsComponent,
  BASIC_ROUTING_MODULE_ID,
  NEAREST_FACILITY_MODULE_ID,
  NETWORK_TRACING_MODULE_ID
} from './components/advanced-tools/advanced-tools.component';
import { RasterAnalysisComponent, RASTER_TOOL_MODULE_IDS } from './components/raster-analysis/raster-analysis.component';
import { AiChatComponent } from './components/ai-chat/ai-chat.component';
import { PrintLayoutComponent } from './components/print-layout/print-layout.component';
import { ExportDataComponent } from './components/export-data/export-data.component';
import { SketchComponent } from './components/sketch/sketch.component';
import { LayerStatisticsComponent } from './components/layer-statistics/layer-statistics.component';
import { LayerReportComponent, TableSelection } from './components/layer-report/layer-report.component';
import { ANALYTICS_MODULE_ID, DATA_VISUALISATION_MODULE_ID } from '../../core/models/layer-analytics.model';
import {
  AI_ASSISTANT_MODULE_ID,
  BASEMAP_MODULE_ID,
  FREE_SEARCH_MODULE_ID,
  INFORMATION_TOOL_MODULE_ID,
  LAYER_STYLING_MODULE_ID,
  PAN_MODULE_ID,
  WORKSPACE_DETAILS_MODULE_ID
} from '../../core/models/module-access.model';
import { SketchService } from './services/sketch.service';
import { DRAW_MODULE_ID, MARKING_TOOL_MODULE_ID } from './models/sketch.model';
import { StyleEditorComponent } from './components/style-editor/style-editor.component';
import { StyleGeometry } from '../../core/models/layer-style.model';

const CRS_PATTERN = /^EPSG:\d{4,6}$/;

/** A tool exposed on the workspace's left rail. New GIS functionality is
 *  added by appending an entry here — the rail groups and renders itself
 *  from this list, so growing to 100+ tools never means touching the
 *  layout, only this array (and a `@case` for tools that ship). */
export interface WsTool {
  id: string;
  label: string;
  icon: string;
  group: WsToolGroup;
  dock: 'left' | 'bottom';
  available: boolean;
  /** Module Access catalog id this tool is gated on — see
   *  GisWorkspaceComponent's `visibleTools`. Omitted for a tool with no
   *  catalog equivalent (Workspace Details, AI Assistant): those stay
   *  ungated rather than being hidden due to a data-modeling gap. */
  moduleId?: number;
  /** Alternative to `moduleId` for a tool that bundles several catalog
   *  modules: shown when ANY of them is granted (the tool then gates each
   *  part itself). */
  anyModuleIds?: number[];
}

type WsToolGroup = 'data' | 'explore' | 'analysis' | 'output' | 'admin';

const GROUP_ORDER: { id: WsToolGroup; label: string }[] = [
  { id: 'data', label: 'Data' },
  { id: 'explore', label: 'Explore' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'output', label: 'Output' },
  { id: 'admin', label: 'Workspace' }
];

/** moduleId values are Module Access catalog ids (see
 *  backend/prisma/seed-modules.ts) — Layer Switcher=1, Query Module=2,
 *  Print=3, Bookmark=4, Buffer=6 (child of Query Module), Measure=11,
 *  Attribute Table=15, Export Data=226 (formats gated by its children),
 *  AI Assistant=900, Workspace Details=960. */
const TOOLS: WsTool[] = [
  { id: 'layers', label: 'Layers', icon: 'pi pi-clone', group: 'data', dock: 'left', available: true, moduleId: 1 },
  // Legend lives inside the Layers panel (per-visible-layer swatch) — no
  // separate tool needed. Identify shows feature info in an on-map popup
  // (see MunicipalMapComponent), so it isn't a dock tool either.
  { id: 'attributes', label: 'Attribute Table', icon: 'pi pi-table', group: 'explore', dock: 'bottom', available: true, moduleId: 15 },
  { id: 'assistant', label: 'AI Assistant', icon: 'pi pi-comments', group: 'explore', dock: 'left', available: true, moduleId: AI_ASSISTANT_MODULE_ID },
  { id: 'bookmarks', label: 'Bookmarks', icon: 'pi pi-bookmark', group: 'explore', dock: 'left', available: true, moduleId: 4 },
  { id: 'query', label: 'Query Builder', icon: 'pi pi-filter', group: 'analysis', dock: 'left', available: true, moduleId: 2 },
  { id: 'measure', label: 'Measure', icon: 'pi pi-arrows-h', group: 'analysis', dock: 'left', available: true, moduleId: 11 },
  { id: 'buffer', label: 'Buffer & Overlay', icon: 'pi pi-circle', group: 'analysis', dock: 'left', available: true, moduleId: 6 },
  { id: 'sketch', label: 'Draw & Mark', icon: 'pi pi-pencil', group: 'analysis', dock: 'left', available: true, anyModuleIds: [DRAW_MODULE_ID, MARKING_TOOL_MODULE_ID] },
  { id: 'advanced', label: 'Advanced Tools', icon: 'pi pi-directions', group: 'analysis', dock: 'left', available: true, anyModuleIds: [BASIC_ROUTING_MODULE_ID, NEAREST_FACILITY_MODULE_ID, NETWORK_TRACING_MODULE_ID] },
  { id: 'raster', label: 'Raster Analysis', icon: 'pi pi-images', group: 'analysis', dock: 'left', available: true, anyModuleIds: RASTER_TOOL_MODULE_IDS },
  { id: 'statistics', label: 'Statistics', icon: 'pi pi-chart-bar', group: 'analysis', dock: 'bottom', available: true, anyModuleIds: [ANALYTICS_MODULE_ID, DATA_VISUALISATION_MODULE_ID] },
  { id: 'print', label: 'Print Layout', icon: 'pi pi-print', group: 'output', dock: 'left', available: true, moduleId: 3 },
  { id: 'reports', label: 'Reports', icon: 'pi pi-file', group: 'output', dock: 'bottom', available: true, moduleId: 251 },
  { id: 'export', label: 'Export Data', icon: 'pi pi-download', group: 'output', dock: 'left', available: true, moduleId: 226 },
  { id: 'workspace', label: 'Workspace Details', icon: 'pi pi-server', group: 'admin', dock: 'left', available: true, moduleId: WORKSPACE_DETAILS_MODULE_ID }
];

@Component({
  selector: 'app-gis-workspace',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    FormsModule,
    ButtonModule,
    DialogModule,
    InputTextModule,
    TextareaModule,
    SelectModule,
    TagModule,
    MessageModule,
    TooltipModule,
    SiteHeaderComponent,
    MunicipalMapComponent,
    LayerPanelComponent,
    MapControlsComponent,
    GisSearchComponent,
    AttributeTableComponent,
    QueryBuilderComponent,
    MeasureComponent,
    BookmarksComponent,
    BufferOverlayComponent,
    AdvancedToolsComponent,
    RasterAnalysisComponent,
    AiChatComponent,
    PrintLayoutComponent,
    ExportDataComponent,
    SketchComponent,
    LayerStatisticsComponent,
    LayerReportComponent,
    StyleEditorComponent
  ],
  // One OpenLayers Map per visit, shared by the map surface and every dock
  // panel — see MapService's own doc comment for why this is a
  // component-level provider, not root.
  providers: [MapService],
  templateUrl: './gis-workspace.component.html',
  styleUrl: './gis-workspace.component.scss'
})
export class GisWorkspaceComponent {
  private readonly gisWorkspaceService = inject(GisWorkspaceService);
  private readonly gisLayersService = inject(GisLayersService);
  private readonly currentUserService = inject(CurrentUserService);
  private readonly moduleAccessService = inject(ModuleAccessService);
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly mapService = inject(MapService);
  private readonly sketchService = inject(SketchService);
  /** Signal twin of `mapIsReady`, so effects can wait for the map. */
  private readonly mapReady = signal(false);

  readonly municipalityName = signal<string | null>(null);
  readonly workspace = signal<GisWorkspace | null>(null);
  readonly isOwner = signal(false);
  readonly loading = signal(true);
  readonly pageError = signal<string | null>(null);
  readonly geoserverReachable = signal<boolean | null>(null);

  readonly layers = signal<GisLayer[]>([]);
  readonly layersLoading = signal(true);
  readonly layersError = signal<string | null>(null);
  readonly layersReady = computed(() => !this.layersLoading() && !this.layersError() && this.layers().length > 0);

  /** The caller's own resolved Module Access set (GET /api/module-access/me)
   *  — hierarchical module assignment (Owner -> Department -> Department
   *  User). Starts empty (nothing extra shown) until it loads, then
   *  gates which tools appear via hasModuleAccess — a tool with no
   *  moduleId (see WsTool) is never gated. Never used to gate anything
   *  the backend doesn't independently re-check itself (each tool's own
   *  API calls are authorized server-side regardless of the rail).  */
  readonly myModuleIds = signal<Set<number>>(new Set());

  /** Layer Styling module — whether the Layers panel offers the style
   *  editor at all (saving a style is still MANAGE-checked server-side). */
  readonly canStyleLayers = computed(() => this.myModuleIds().has(LAYER_STYLING_MODULE_ID));
  readonly canSearch = computed(() => this.myModuleIds().has(FREE_SEARCH_MODULE_ID));
  readonly canPickBasemap = computed(() => this.myModuleIds().has(BASEMAP_MODULE_ID));
  /** Pan (map drag) and Identify (click popup) are map behaviours, not
   *  dock tools — switched on/off directly on the map. */
  private readonly applyMapGates = effect(() => {
    const allowed = this.myModuleIds();
    this.mapService.setPanEnabled(allowed.has(PAN_MODULE_ID));
    this.mapService.setIdentifyEnabled(allowed.has(INFORMATION_TOOL_MODULE_ID));
  });

  private hasModuleAccess(tool: WsTool): boolean {
    const granted = this.myModuleIds();
    if (tool.anyModuleIds) {
      return tool.anyModuleIds.some((id) => granted.has(id));
    }
    return tool.moduleId === undefined || granted.has(tool.moduleId);
  }

  // ----- dock state -----
  readonly groups = GROUP_ORDER;
  /** Every tool group except 'admin' — rendered in the rail's scrollable
   *  area. 'admin' (Workspace Details, and any future workspace-level
   *  action) is rendered separately, pinned to the bottom of the rail —
   *  see pinnedToolGroup — so it's always reachable without scrolling
   *  even as the tool list above it grows toward the 100+ tools this
   *  rail is designed to scale to. Not-yet-shipped tools (`available:
   *  false`) are left out of the rail entirely rather than shown
   *  disabled — flip a tool to `available: true` in TOOLS to have it
   *  appear. A tool the caller has no Module Access to is left out the
   *  same way — see hasModuleAccess. */
  readonly toolsByGroup = computed(() =>
    GROUP_ORDER.filter((group) => group.id !== 'admin')
      .map((group) => ({
        ...group,
        tools: TOOLS.filter(
          (tool) => tool.group === group.id && tool.available && this.hasModuleAccess(tool)
        )
      }))
      .filter((group) => group.tools.length > 0)
  );

  readonly pinnedToolGroup = computed(() => {
    const group = GROUP_ORDER.find((g) => g.id === 'admin')!;
    return {
      ...group,
      tools: TOOLS.filter(
        (tool) => tool.group === 'admin' && tool.available && this.hasModuleAccess(tool)
      )
    };
  });

  readonly leftTool = signal<string | null>('layers');
  readonly bottomTool = signal<string | null>(null);
  readonly leftWidth = signal(300);
  readonly bottomHeight = signal(240);

  /** Every tool panel that has been opened at least once. Panels are kept
   *  mounted (just hidden) after their first open so switching tools — or
   *  leaving and returning to the workspace — never loses their in-progress
   *  form / filter / result state. */
  readonly openedLeftTools = signal<ReadonlySet<string>>(new Set(['layers']));
  readonly openedBottomTools = signal<ReadonlySet<string>>(new Set());

  readonly activeLeftTool = computed(() => TOOLS.find((tool) => tool.id === this.leftTool()) ?? null);
  readonly activeBottomTool = computed(() => TOOLS.find((tool) => tool.id === this.bottomTool()) ?? null);

  /** GIS Layer Styling: when set, the left dock shows the style editor for
   *  this layer instead of the tool panel (no rail/layout change). */
  readonly styleTargetLayer = signal<GisLayer | null>(null);

  // ----- identify / feature info -----
  // The feature info itself is shown in an on-map popup (MunicipalMapComponent
  // + MapService). This signal is kept only so the Attribute Table can mirror
  // a map click as a selection (`mapClickFeatures`).
  readonly featureInfoResults = signal<FeatureInfoResult[]>([]);

  /** Flattened map-click hits (layer + stable feature id) for the attribute
   *  table to mirror as a selection. */
  readonly mapClickFeatures = computed<MapClickFeatureRef[]>(() =>
    this.featureInfoResults()
      .flatMap((result) =>
        result.features
          .filter((feature) => typeof feature.id === 'string')
          .map((feature) => ({ layerId: result.layer.id, featureId: feature.id as string }))
      )
  );

  readonly highlightLayerId = signal<string | null>(null);
  private mapIsReady = false;
  /** Signature of the query params the deep-link was last applied for — so a
   *  kept-alive workspace re-applies only when the params actually change. */
  private lastDeepLinkKey: string | null = null;

  /** Active Query Builder result — drives the WMS filter, the map highlight,
   *  and the Attribute Table's locked filter. */
  readonly activeQueryFilter = signal<AttributeExternalFilter | null>(null);
  /** The Attribute Table's current selection — a Report Generation scope. */
  readonly tableSelection = signal<TableSelection | null>(null);

  // ----- configure workspace dialog -----
  readonly dialogVisible = signal(false);
  readonly formSubmitting = signal(false);
  readonly formError = signal<string | null>(null);
  readonly retrying = signal(false);

  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(150)]],
    description: ['', [Validators.maxLength(500)]],
    defaultCrs: ['', [Validators.required, Validators.pattern(CRS_PATTERN)]],
    displayCrs: ['', [Validators.required, Validators.pattern(CRS_PATTERN)]]
  });

  constructor() {
    // Saved Draw & Mark sketches belong on the map from the start, not only
    // once their panel has been opened.
    effect(() => {
      const ws = this.workspace();
      if (this.mapReady() && ws) {
        this.mapService.setSketches(this.sketchService.list(ws.code));
      }
    });
    // On a phone the docks are overlays — start with the map unobstructed.
    if (typeof window !== 'undefined' && window.innerWidth < 900) {
      this.leftTool.set(null);
    }

    this.currentUserService.getMe().subscribe({
      next: (user) => {
        this.municipalityName.set(user.municipality.name);
        this.isOwner.set(user.systemRole === 'MUNICIPALITY_OWNER');
      }
    });

    this.moduleAccessService.getMyModuleIds().subscribe({
      next: ({ moduleIds }) => this.myModuleIds.set(new Set(moduleIds))
      // No error handler: if this fails, myModuleIds stays empty and every
      // moduleId-gated tool stays hidden — a safe fail-closed default
      // rather than fail-open (never show more than the caller actually
      // has just because the check itself broke).
    });

    this.loadWorkspace();
    this.loadLayers();

    this.gisWorkspaceService.getGeoServerHealth().subscribe({
      next: () => this.geoserverReachable.set(true),
      error: () => this.geoserverReachable.set(false)
    });

    // The workspace is kept alive across navigation, so `?layer=` / `?department=`
    // deep links (from the dashboard) arrive on re-navigation, not just at
    // construction — react to every change, not a one-shot snapshot read.
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe(() => this.tryApplyDeepLink());
  }

  get f() {
    return this.form.controls;
  }

  // ----- dock actions -----
  activateTool(tool: WsTool): void {
    if (tool.dock === 'left') {
      this.leftTool.update((current) => (current === tool.id ? null : tool.id));
      if (this.leftTool() === tool.id) {
        this.rememberOpened(this.openedLeftTools, tool.id);
      }
    } else {
      this.bottomTool.update((current) => (current === tool.id ? null : tool.id));
      if (this.bottomTool() === tool.id) {
        this.rememberOpened(this.openedBottomTools, tool.id);
      }
    }
    this.refreshMapSize();
  }

  private rememberOpened(
    store: WritableSignal<ReadonlySet<string>>,
    id: string,
  ): void {
    if (store().has(id)) return;
    store.set(new Set([...store(), id]));
  }

  isToolActive(tool: WsTool): boolean {
    return tool.dock === 'left' ? this.leftTool() === tool.id : this.bottomTool() === tool.id;
  }

  closeLeft(): void {
    this.leftTool.set(null);
    this.refreshMapSize();
  }

  // ----- layer styling -----

  openStyleEditor(layer: GisLayer): void {
    this.styleTargetLayer.set(layer);
    this.refreshMapSize();
  }

  closeStyleEditor(): void {
    this.styleTargetLayer.set(null);
    this.refreshMapSize();
  }

  styleGeometryOf(layer: GisLayer): StyleGeometry {
    if (layer.layerType === 'RASTER') return 'raster';
    if (layer.geometryType === 'POINT') return 'point';
    if (layer.geometryType === 'LINE') return 'line';
    return 'polygon';
  }

  onStyleApplied(layer: GisLayer): void {
    this.mapService.setLayerVisibility(layer.id, true);
    this.mapService.refreshLayerStyle(layer.id);
  }

  onStyleRemoved(layer: GisLayer): void {
    this.mapService.refreshLayerStyle(layer.id);
  }

  closeBottom(): void {
    this.bottomTool.set(null);
    this.refreshMapSize();
  }

  startLeftResize(event: PointerEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startW = this.leftWidth();
    const move = (e: PointerEvent) => this.leftWidth.set(Math.min(560, Math.max(240, startW + (e.clientX - startX))));
    this.dragUntilRelease(move);
  }

  startBottomResize(event: PointerEvent): void {
    event.preventDefault();
    const startY = event.clientY;
    const startH = this.bottomHeight();
    const max = Math.max(220, Math.round((window.innerHeight - 112) * 0.72));
    const move = (e: PointerEvent) =>
      this.bottomHeight.set(Math.min(max, Math.max(140, startH - (e.clientY - startY))));
    this.dragUntilRelease(move);
  }

  private dragUntilRelease(move: (e: PointerEvent) => void): void {
    document.body.style.userSelect = 'none';
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
      this.refreshMapSize();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private refreshMapSize(): void {
    // let the flex/grid layout settle before OL re-measures
    setTimeout(() => this.mapService.updateSize(), 60);
  }

  // ----- data loading -----
  loadWorkspace(): void {
    this.loading.set(true);
    this.pageError.set(null);
    this.gisWorkspaceService.getWorkspace().subscribe({
      next: (workspace) => {
        this.workspace.set(workspace);
        this.loading.set(false);
      },
      error: () => {
        this.pageError.set('Could not load the GIS workspace. Please try again.');
        this.loading.set(false);
      }
    });
  }

  /** Raster Analysis published a new layer (upload or tool output). */
  onLayerCreated(layer: GisLayer): void {
    this.loadLayers();
    if (layer.bbox) setTimeout(() => this.mapService.zoomToLayer(layer), 300);
  }

  loadLayers(): void {
    this.layersLoading.set(true);
    this.layersError.set(null);
    this.gisLayersService.list().subscribe({
      next: (layers) => {
        this.layers.set(layers);
        this.layersLoading.set(false);
        this.tryApplyDeepLink();
      },
      error: () => {
        this.layersError.set('Could not load GIS layers. Please try again.');
        this.layersLoading.set(false);
      }
    });
  }

  onMapReady(): void {
    this.mapIsReady = true;
    this.mapReady.set(true);
    this.tryApplyDeepLink();
  }

  private tryApplyDeepLink(): void {
    if (!this.mapIsReady || this.layers().length === 0) {
      return;
    }

    const params = this.route.snapshot.queryParamMap;
    const layerId = params.get('layer');
    const departmentId = params.get('department');

    const key = `${layerId ?? ''}|${departmentId ?? ''}`;
    if (key === this.lastDeepLinkKey) {
      return;
    }
    this.lastDeepLinkKey = key;

    if (layerId) {
      const layer = this.layers().find((candidate) => candidate.id === layerId);
      if (layer) {
        this.mapService.setLayerVisibility(layer.id, true);
        this.mapService.zoomToLayer(layer);
        this.highlightLayerId.set(layer.id);
      }
      return;
    }

    if (departmentId) {
      const matches = this.layers().filter((candidate) => candidate.departmentId === departmentId);
      for (const layer of matches) {
        this.mapService.setLayerVisibility(layer.id, true);
      }
      this.mapService.zoomToLayers(matches);
    }
  }

  onSearchLayerSelected(match: GisSearchLayerMatch): void {
    const layer = this.layers().find((candidate) => candidate.id === match.id);
    this.mapService.setLayerVisibility(match.id, true);
    if (layer) {
      this.mapService.zoomToLayer(layer);
    }
    this.highlightLayerId.set(match.id);
  }

  onSearchFeatureSelected(match: GisSearchFeatureMatch): void {
    const layer = this.layers().find((candidate) => candidate.id === match.layerId);
    if (match.bbox) {
      this.mapService.zoomToBbox4326(match.bbox);
    }
    if (layer) {
      this.mapService.setLayerVisibility(layer.id, true);
      this.highlightLayerId.set(layer.id);
      const results: FeatureInfoResult[] = [{ layer, features: [{ attributes: match.attributes }] }];
      this.featureInfoResults.set(results);
      // Show the searched feature's attributes in the on-map Identify popup,
      // anchored at the centre of its bounding box.
      if (match.bbox) {
        const centre: [number, number] = [
          (match.bbox[0] + match.bbox[2]) / 2,
          (match.bbox[1] + match.bbox[3]) / 2
        ];
        this.mapService.openFeatureInfoPopupAt4326(centre, { loading: false, error: null, results });
      }
    }
  }

  /** Map click / search hit — kept only so the Attribute Table can mirror
   *  the selection; the feature info shows in the on-map popup. */
  onFeatureInfoResults(results: FeatureInfoResult[]): void {
    this.featureInfoResults.set(results);
  }

  // ----- selection tool (map controls -> attribute table) -----

  private readonly attributeTable = viewChild(AttributeTableComponent);
  readonly selectingShape = computed(() => this.attributeTable()?.selectingShape() ?? null);
  readonly selectedCount = computed(() => this.attributeTable()?.selectedIds().size ?? 0);

  onMapClearSelection(): void {
    const table = this.attributeTable();
    if (!table) return;
    table.cancelMapSelect();
    table.clearSelection();
    table.selectNote.set(null);
  }
  /** A map selection requested while the Attribute Table was not yet
   *  rendered; started as soon as the table exists. */
  private readonly pendingSelect = signal<{ shape: SelectShape; mode: SelectMode } | null>(null);
  private readonly runPendingSelect = effect(() => {
    const request = this.pendingSelect();
    const table = this.attributeTable();
    if (!request || !table) return;
    this.pendingSelect.set(null);
    table.startMapSelect(request.shape, request.mode);
  });

  /** The Selection Tool sits on the map; its result is shown in the
   *  Attribute Table, so that panel is opened alongside. */
  onMapSelectRequest(request: { shape: SelectShape; mode: SelectMode }): void {
    this.bottomTool.set('attributes');
    this.rememberOpened(this.openedBottomTools, 'attributes');
    this.refreshMapSize();
    this.pendingSelect.set(request);
  }

  // ----- query builder -----

  onQueryRun(filter: AttributeExternalFilter): void {
    this.activeQueryFilter.set(filter);
    this.mapService.setLayerVisibility(filter.layerId, true);
    this.mapService.setLayerCqlFilter(filter.layerId, filter.cql);
    this.bottomTool.set('attributes');
    this.refreshMapSize();
  }

  onQueryCleared(): void {
    // Clear every layer's CQL filter, not just the one currently tracked:
    // `activeQueryFilter` is a single slot, so a buffer on layer A followed by
    // a query on layer B leaves A's WMS render filtered with nothing to undo
    // it. A blanket reset keeps "Clear" honest.
    this.mapService.clearAllLayerCqlFilters();
    this.mapService.clearQueryHighlight();
    this.activeQueryFilter.set(null);
  }

  // ----- configure workspace -----
  openEditDialog(): void {
    const current = this.workspace();
    if (!current) return;
    this.formError.set(null);
    this.form.reset({
      name: current.name,
      description: current.description ?? '',
      defaultCrs: current.defaultCrs,
      displayCrs: current.displayCrs
    });
    this.dialogVisible.set(true);
  }

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();
    this.formSubmitting.set(true);
    this.formError.set(null);

    this.gisWorkspaceService
      .updateWorkspace({
        name: value.name,
        description: value.description || undefined,
        defaultCrs: value.defaultCrs,
        displayCrs: value.displayCrs
      })
      .subscribe({
        next: (workspace) => {
          this.formSubmitting.set(false);
          this.workspace.set(workspace);
          this.dialogVisible.set(false);
        },
        error: (error: HttpErrorResponse) => {
          this.formSubmitting.set(false);
          this.formError.set(this.resolveErrorMessage(error));
        }
      });
  }

  retryProvisioning(): void {
    this.retrying.set(true);
    this.pageError.set(null);
    this.gisWorkspaceService.retryProvisioning().subscribe({
      next: (workspace) => {
        this.retrying.set(false);
        this.workspace.set(workspace);
      },
      error: (error: HttpErrorResponse) => {
        this.retrying.set(false);
        this.pageError.set(this.resolveErrorMessage(error));
      }
    });
  }

  private resolveErrorMessage(error: HttpErrorResponse): string {
    return error.error?.message ?? 'Something went wrong. Please try again.';
  }
}
