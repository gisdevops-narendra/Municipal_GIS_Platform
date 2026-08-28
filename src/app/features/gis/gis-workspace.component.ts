import { Component, computed, inject, signal } from '@angular/core';
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
import { GisWorkspace } from '../../core/models/gis-workspace.model';
import { GisLayer } from '../../core/models/gis-layer.model';
import { GisSearchFeatureMatch, GisSearchLayerMatch } from '../../core/models/gis-dashboard.model';
import { MapService, FeatureInfoResult } from './services/map.service';
import { MunicipalMapComponent } from './components/municipal-map/municipal-map.component';
import { LayerPanelComponent } from './components/layer-panel/layer-panel.component';
import { MapControlsComponent } from './components/map-controls/map-controls.component';
import { GisSearchComponent } from './components/gis-search/gis-search.component';
import { AttributeExternalFilter, AttributeTableComponent, MapClickFeatureRef } from './components/attribute-table/attribute-table.component';
import { QueryBuilderComponent } from './components/query-builder/query-builder.component';
import { MeasureComponent } from './components/measure/measure.component';
import { BookmarksComponent } from './components/bookmarks/bookmarks.component';
import { BufferOverlayComponent } from './components/buffer-overlay/buffer-overlay.component';
import { PrintLayoutComponent } from './components/print-layout/print-layout.component';
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
}

type WsToolGroup = 'data' | 'explore' | 'analysis' | 'output' | 'admin';

const GROUP_ORDER: { id: WsToolGroup; label: string }[] = [
  { id: 'data', label: 'Data' },
  { id: 'explore', label: 'Explore' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'output', label: 'Output' },
  { id: 'admin', label: 'Workspace' }
];

const TOOLS: WsTool[] = [
  { id: 'layers', label: 'Layers', icon: 'pi pi-clone', group: 'data', dock: 'left', available: true },
  // Legend lives inside the Layers panel (per-visible-layer swatch) — no
  // separate tool needed. Identify shows feature info in an on-map popup
  // (see MunicipalMapComponent), so it isn't a dock tool either.
  { id: 'attributes', label: 'Attribute Table', icon: 'pi pi-table', group: 'explore', dock: 'bottom', available: true },
  { id: 'bookmarks', label: 'Bookmarks', icon: 'pi pi-bookmark', group: 'explore', dock: 'left', available: true },
  { id: 'query', label: 'Query Builder', icon: 'pi pi-filter', group: 'analysis', dock: 'left', available: true },
  { id: 'measure', label: 'Measure', icon: 'pi pi-arrows-h', group: 'analysis', dock: 'left', available: true },
  { id: 'buffer', label: 'Buffer & Overlay', icon: 'pi pi-circle', group: 'analysis', dock: 'left', available: true },
  { id: 'statistics', label: 'Statistics', icon: 'pi pi-chart-bar', group: 'analysis', dock: 'bottom', available: false },
  { id: 'print', label: 'Print Layout', icon: 'pi pi-print', group: 'output', dock: 'left', available: true },
  { id: 'reports', label: 'Reports', icon: 'pi pi-file', group: 'output', dock: 'bottom', available: false },
  { id: 'export', label: 'Export Data', icon: 'pi pi-download', group: 'output', dock: 'left', available: false },
  { id: 'workspace', label: 'Workspace Details', icon: 'pi pi-server', group: 'admin', dock: 'left', available: true }
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
    PrintLayoutComponent,
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
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly mapService = inject(MapService);

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

  // ----- dock state -----
  readonly groups = GROUP_ORDER;
  readonly toolsByGroup = computed(() =>
    GROUP_ORDER.map((group) => ({
      ...group,
      tools: TOOLS.filter((tool) => tool.group === group.id)
    })).filter((group) => group.tools.length > 0)
  );

  readonly leftTool = signal<string | null>('layers');
  readonly bottomTool = signal<string | null>(null);
  readonly leftWidth = signal(300);
  readonly bottomHeight = signal(240);

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
  private deepLinkApplied = false;

  /** Active Query Builder result — drives the WMS filter, the map highlight,
   *  and the Attribute Table's locked filter. */
  readonly activeQueryFilter = signal<AttributeExternalFilter | null>(null);

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

    this.loadWorkspace();
    this.loadLayers();

    this.gisWorkspaceService.getGeoServerHealth().subscribe({
      next: () => this.geoserverReachable.set(true),
      error: () => this.geoserverReachable.set(false)
    });
  }

  get f() {
    return this.form.controls;
  }

  // ----- dock actions -----
  activateTool(tool: WsTool): void {
    if (tool.dock === 'left') {
      this.leftTool.update((current) => (current === tool.id ? null : tool.id));
    } else {
      this.bottomTool.update((current) => (current === tool.id ? null : tool.id));
    }
    this.refreshMapSize();
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
    this.tryApplyDeepLink();
  }

  private tryApplyDeepLink(): void {
    if (this.deepLinkApplied || !this.mapIsReady || this.layers().length === 0) {
      return;
    }
    this.deepLinkApplied = true;

    const params = this.route.snapshot.queryParamMap;
    const layerId = params.get('layer');
    const departmentId = params.get('department');

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
