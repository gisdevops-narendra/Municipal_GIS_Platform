import { AnalysisReportComponent } from './components/analysis-report/analysis-report.component';
import { NotificationService } from '../../core/services/notification.service';
import { RasterService } from './services/raster.service';

/** Raster Analysis → Raster Styling (seed-modules.ts). */
const RASTER_STYLE_MODULE_ID = 912;
import { SettingsService } from '../../core/services/settings.service';
import { Component, DestroyRef, ElementRef, HostListener, WritableSignal, computed, effect, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, NavigationEnd, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { UploadWizardComponent } from './components/upload-wizard/upload-wizard.component';
import { UploadHistoryComponent } from './components/upload-history/upload-history.component';
import { GisUpload } from '../../core/models/gis-upload.model';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { SelectModule } from 'primeng/select';
import { MessageModule } from 'primeng/message';
import { TooltipModule } from 'primeng/tooltip';
import { SiteHeaderComponent } from '../../shared/components/site-header/site-header.component';
import { GisWorkspaceService } from '../../core/services/gis-workspace.service';
import { GisLayersService } from '../../core/services/gis-layers.service';
import { CurrentUserService } from '../../core/services/current-user.service';
import { ALL_MODULES } from '../../core/utils/all-modules';
import { GisWorkspace } from '../../core/models/gis-workspace.model';
import { GisLayer, GisRenderMode } from '../../core/models/gis-layer.model';
import { formatInfo } from './services/render-formats';
import { GisSearchFeatureMatch, GisSearchLayerMatch } from '../../core/models/gis-dashboard.model';
import { MapService, FeatureInfoResult, CoordFormat } from './services/map.service';
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
import { GeoprocessingComponent, GEOPROCESS_OPERATIONS, GEOPROCESS_GROUP_MODULE } from './components/geoprocessing/geoprocessing.component';
import { DataToolsComponent, DATA_TOOL_LIST } from './components/data-tools/data-tools.component';
import { DATA_TOOL_MODULE_IDS } from './services/data-tools.service';
import { CrsPickerComponent } from './components/crs-picker/crs-picker.component';
import { EDIT_PANEL_MODULE_ID, GEOPROCESSING_MODULE_ID } from './services/vector-tools.service';
import {
  AdvancedToolsComponent,
  BASIC_ROUTING_MODULE_ID,
  NEAREST_FACILITY_MODULE_ID,
  NETWORK_TRACING_MODULE_ID,
  SERVICE_AREA_MODULE_ID
} from './components/advanced-tools/advanced-tools.component';
import { RasterAnalysisComponent, RASTER_TOOL_MODULE_IDS, RASTER_TOOLS } from './components/raster-analysis/raster-analysis.component';
import { AiChatComponent } from './components/ai-chat/ai-chat.component';
import { PrintLayoutComponent } from './components/print-layout/print-layout.component';
import { ExportDataComponent } from './components/export-data/export-data.component';
import { AddServiceComponent, loadSavedExternalLayers, saveExternalLayers } from './components/platform-extras/add-service.component';
import { WhatsHereComponent } from './components/platform-extras/whats-here.component';
import { ShareMapComponent } from './components/platform-extras/share-map.component';
import { IntegrationsComponent } from './components/platform-extras/integrations.component';
import { PlatformExtrasService } from './services/platform-extras.service';
import { NetworkPlanningComponent } from './components/platform-extras/network-planning.component';
import { LiveSensorsComponent, hasSavedSensorFeeds } from './components/platform-extras/live-sensors.component';
import { Buildings3dComponent } from './components/platform-extras/buildings-3d.component';
import { WeatherComponent } from './components/platform-extras/weather.component';
import { OsmImportComponent } from './components/platform-extras/osm-import.component';
import { DataCatalogComponent } from './components/platform-extras/data-catalog.component';
import { StorageUsageComponent } from './components/platform-extras/storage-usage.component';
import { GroundwaterComponent } from './components/platform-extras/groundwater.component';
import { OutbreakComponent } from './components/platform-extras/outbreak.component';
import { EvChargingComponent } from './components/platform-extras/ev-charging.component';
import { TourismComponent } from './components/platform-extras/tourism.component';
import { ThemeService } from '../../core/theme/theme.service';
import { BasemapSwitcherComponent } from './components/basemap-switcher/basemap-switcher.component';
import { HazardsComponent } from './components/platform-extras/hazards.component';
import { AirStationsComponent } from './components/platform-extras/air-stations.component';
import { SketchComponent } from './components/sketch/sketch.component';
import { LayerStatisticsComponent } from './components/layer-statistics/layer-statistics.component';
import { DensityMapComponent } from './components/density-map/density-map.component';
import { LayerReportComponent, TableSelection } from './components/layer-report/layer-report.component';
import { ANALYTICS_MODULE_ID, DATA_VISUALISATION_MODULE_ID, HEATMAP_MODULE_ID } from '../../core/models/layer-analytics.model';
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
  /** Role needed beyond module access: 'manager' = Owner or Department
   *  Head (e.g. making data public), 'owner' = Municipality Owner. */
  minRole?: 'manager' | 'owner';
}

type WsToolGroup = 'data' | 'explore' | 'analysis' | 'output' | 'admin';

const GROUP_ORDER: { id: WsToolGroup; label: string }[] = [
  { id: 'data', label: 'Data' },
  { id: 'explore', label: 'Explore' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'output', label: 'Output' },
  { id: 'admin', label: 'Workspace' }
];

/** Rail icon + one-line hint for each tool group's menu. */
const GROUP_META: Record<WsToolGroup, { icon: string; hint: string }> = {
  data: { icon: 'pi pi-database', hint: 'Add, download and browse data' },
  explore: { icon: 'pi pi-compass', hint: 'Look up places and live information' },
  analysis: { icon: 'pi pi-chart-line', hint: 'Measure, query and analyse' },
  output: { icon: 'pi pi-file-export', hint: 'Print, report, export and share' },
  admin: { icon: 'pi pi-cog', hint: 'Workspace settings and limits' }
};

/** One-line description and (for big groups) a menu section per tool. */
/** `keywords`: extra search terms (sub-features, synonyms) the tool search matches. */
const TOOL_INFO: Record<string, { hint: string; section?: string; keywords?: string }> = {
  layers: { hint: 'Turn layers on, style and order them' },
  attributes: { hint: 'Browse and edit feature records' },
  'add-service': { hint: 'Add WMS, WMTS, XYZ, ArcGIS or WFS layers' },
  'osm-import': { hint: 'Download OpenStreetMap features as a layer' },
  catalog: { hint: 'Search all layers with their metadata' },
  'whats-here': { hint: 'Address and areas at any point', section: 'Look up' },
  bookmarks: { hint: 'Save and jump to map views', section: 'Look up' },
  assistant: { hint: 'Ask questions about your data', section: 'Look up' },
  weather: { hint: 'Forecast, radar, air and river levels', section: 'Live data' },
  'air-stations': { hint: 'Live AQI, city ranking and trends', section: 'Live data' },
  hazards: { hint: 'Earthquakes and disaster alerts', section: 'Live data' },
  sensors: { hint: 'Live readings from sensor feeds', section: 'Live data' },
  tourism: { hint: 'Attractions, trails and city guide', section: 'Places' },
  'buildings-3d': { hint: 'Extruded buildings on the 3D globe', section: 'Places' },
  query: { hint: 'Filter features by attributes', section: 'Measure & query' },
  measure: { hint: 'Distance, area and coordinates', section: 'Measure & query' },
  statistics: { hint: 'Summaries and charts of any field', section: 'Measure & query' },
  heatmap: { hint: 'Density heatmaps and clusters', section: 'Measure & query' },
  buffer: { hint: 'Buffers, intersect, union, clip', section: 'Geoprocessing' },
  geoprocessing: { hint: 'Dissolve, merge and spatial joins', section: 'Geoprocessing' },
  data: { hint: 'Fields, joins and data cleanup', section: 'Geoprocessing' },
  sketch: { hint: 'Draw shapes and markers on the map', section: 'Geoprocessing' },
  advanced: { hint: 'Routing, service areas and more', section: 'Geoprocessing' },
  raster: { hint: 'Terrain, indices and raster maths', section: 'Geoprocessing' },
  'network-planning': { hint: 'Fleet routes, OD matrix, site selection', section: 'Planning' },
  'ev-charging': { hint: 'Charger coverage and gaps', section: 'Planning' },
  groundwater: { hint: 'Well levels and trends', section: 'Planning' },
  outbreak: { hint: 'Disease cases, clusters and zones', section: 'Planning' },
  print: { hint: 'Map layout to PDF or image' },
  reports: { hint: 'Ready-made reports from your data' },
  export: { hint: 'Download layers in many formats' },
  share: { hint: 'Public link to a map view' },
  storage: { hint: 'Space used and limits' },
  integrations: { hint: 'API keys and webhooks' },
  workspace: { hint: 'Workspace name, map projection and settings' }
};

/** Tools and tabs that live inside a panel, listed as their own
 *  tool-search results; picking one opens the panel on that tool/tab.
 *  `moduleId` gates the entry itself; the parent panel's access always
 *  applies too. */
type SubTool = WsTool & { parent: string; sub: string; hint: string; keywords?: string };
const sub = (parent: string, subId: string, label: string, icon: string, hint: string, keywords?: string, moduleId?: number): SubTool => ({
  id: `${parent}:${subId}`, parent, sub: subId, label, icon, group: 'analysis', dock: 'left', available: true, moduleId, hint, keywords
});
const SUB_TOOLS: SubTool[] = [
  sub('advanced', 'route', 'Routing', 'pi pi-directions', 'Advanced Tools · shortest route between stops', 'route directions shortest path navigation', BASIC_ROUTING_MODULE_ID),
  sub('advanced', 'nearest', 'Nearest Facility', 'pi pi-map-marker', 'Advanced Tools · closest facilities to a point', 'closest facility', NEAREST_FACILITY_MODULE_ID),
  sub('advanced', 'trace', 'Tracing', 'pi pi-sitemap', 'Advanced Tools · trace connected network lines', 'trace network upstream downstream pipeline', NETWORK_TRACING_MODULE_ID),
  sub('advanced', 'service', 'Service Area', 'pi pi-bullseye', 'Advanced Tools · area reachable within a distance', 'isochrone drive time reach catchment', SERVICE_AREA_MODULE_ID),
  ...RASTER_TOOLS.map((t) => sub('raster', t.id, t.label, t.icon, `Raster Analysis · ${t.description}`, `${t.group} ${t.section ?? ''}`, t.moduleId)),
  ...GEOPROCESS_OPERATIONS.map((o) => sub('geoprocessing', o.value, o.label, 'pi pi-cog', `Geoprocessing · ${o.hint}`, o.group, GEOPROCESS_GROUP_MODULE[o.value])),
  ...DATA_TOOL_LIST.map((t) => sub('data', t.value, t.label, 'pi pi-wrench', `Data Tools · ${t.group}`, undefined, t.moduleId)),
  sub('buffer', 'buffer', 'Buffer', 'pi pi-circle', 'Buffer & Overlay · zone around a drawn shape'),
  sub('buffer', 'overlay', 'Overlay', 'pi pi-clone', 'Buffer & Overlay · intersection, union, difference, clip of two shapes', 'intersect intersection union difference clip'),
  sub('measure', 'distance', 'Measure Distance', 'pi pi-arrows-h', 'Measure · length of a line', 'length ruler'),
  sub('measure', 'area', 'Measure Area', 'pi pi-stop', 'Measure · area and perimeter', 'perimeter polygon'),
  sub('measure', 'radius', 'Radius / Circle', 'pi pi-circle', 'Measure · circle from a centre and radius'),
  sub('measure', 'bearing', 'Bearing / Direction', 'pi pi-compass', 'Measure · bearing and back bearing between points', 'azimuth angle direction compass heading'),
  sub('sketch', 'create', 'Create Features', 'pi pi-plus-circle', 'Draw & Mark · add features to a layer', 'digitize digitise add edit new feature'),
  sub('sketch', 'modify', 'Modify Features', 'pi pi-pencil', 'Draw & Mark · reshape, move or delete features', 'edit reshape move delete vertex'),
  sub('sketch', 'sketch', 'Sketches', 'pi pi-pencil', 'Draw & Mark · draw shapes, markers and text on the map', 'draw marker annotation'),
  sub('heatmap', 'heatmap', 'Heatmap', 'pi pi-map', 'Heatmap & Clusters · point density heatmap', 'density hotspot'),
  sub('heatmap', 'clusters', 'Clusters', 'pi pi-th-large', 'Heatmap & Clusters · group nearby points', 'cluster'),
  sub('network-planning', 'fleet', 'Fleet Routes', 'pi pi-truck', 'Network Planning · vehicle routes for many stops', 'vehicle vrp fleet'),
  sub('network-planning', 'matrix', 'Travel Matrix', 'pi pi-table', 'Network Planning · origin–destination travel times', 'od matrix origin destination'),
  sub('network-planning', 'sites', 'Site Selection', 'pi pi-map-marker', 'Network Planning · best sites for facilities', 'location allocation'),
  sub('weather', 'forecast', 'Weather Forecast', 'pi pi-cloud', 'Weather · forecast and warnings'),
  sub('weather', 'layers', 'Weather Radar & Satellite', 'pi pi-globe', 'Weather · radar and satellite on the map', 'rain radar satellite'),
  sub('weather', 'air', 'Air Quality (Weather)', 'pi pi-cloud', 'Weather · air quality', 'aqi pollution'),
  sub('weather', 'river', 'River Flow & Flood Outlook', 'pi pi-chart-line', 'Weather · river flow and flood outlook', 'flood discharge'),
  sub('air-stations', 'stations', 'AQI Stations', 'pi pi-chart-scatter', 'Air Quality Stations · live stations around the map', 'aqi pollution'),
  sub('air-stations', 'point', 'AQI at a Point', 'pi pi-map-marker', 'Air Quality Stations · estimated AQI at any point', 'aqi pollution'),
  sub('air-stations', 'cities', 'City AQI Ranking', 'pi pi-list', 'Air Quality Stations · all-India city ranking', 'aqi pollution'),
  sub('air-stations', 'exposure', 'Pollution Exposure', 'pi pi-users', 'Air Quality Stations · features near polluted stations', 'aqi'),
  sub('tourism', 'explore', 'Attractions Nearby', 'pi pi-ticket', 'Tourism · attractions around the map', 'poi sightseeing'),
  sub('tourism', 'trail', 'Plan a Trail', 'pi pi-directions', 'Tourism · plan a walking trail', 'walk hike'),
  sub('tourism', 'facilities', 'Visitor Facilities', 'pi pi-check-square', 'Tourism · visitor facilities check', 'toilet parking'),
  sub('tourism', 'guide', 'City Guide', 'pi pi-book', 'Tourism · Wikivoyage city guide', 'wikivoyage'),
  sub('hazards', 'quakes', 'Earthquakes', 'pi pi-exclamation-triangle', 'Hazard Alerts · recent earthquakes', 'seismic'),
  sub('hazards', 'alerts', 'Disaster Alerts', 'pi pi-exclamation-circle', 'Hazard Alerts · disaster alerts', 'gdacs cyclone flood'),
  sub('integrations', 'keys', 'API Keys', 'pi pi-key', 'API & Webhooks · manage API keys', 'token'),
  sub('integrations', 'hooks', 'Webhooks', 'pi pi-link', 'API & Webhooks · manage webhooks', 'callback'),
  sub('share', 'new', 'New Share Link', 'pi pi-share-alt', 'Share Map · public link to this view', 'public link'),
  sub('share', 'links', 'My Share Links', 'pi pi-list', 'Share Map · links you have shared', 'public link')
];

/** Shown directly on the rail — everything else lives in group menus. */
const PRIMARY_TOOL_IDS = ['layers', 'attributes'];

/** moduleId values are Module Access catalog ids (see
 *  backend/prisma/seed-modules.ts) — Layer Switcher=1, Query Module=2,
 *  Print=3, Bookmark=4, Buffer=6 (child of Query Module), Measure=11,
 *  Attribute Table=15, Export Data=226 (formats gated by its children),
 *  AI Assistant=900, Workspace Details=960. */
const TOOLS: WsTool[] = [
  { id: 'layers', label: 'Layers', icon: 'pi pi-clone', group: 'data', dock: 'left', available: true, moduleId: 1 },
  { id: 'add-service', label: 'Add Service', icon: 'pi pi-globe', group: 'data', dock: 'left', available: true },
  { id: 'osm-import', label: 'OSM Download', icon: 'pi pi-cloud-download', group: 'data', dock: 'left', available: true },
  { id: 'catalog', label: 'Data Catalog', icon: 'pi pi-book', group: 'data', dock: 'left', available: true },
  // Legend lives inside the Layers panel (per-visible-layer swatch) — no
  // separate tool needed. Identify shows feature info in an on-map popup
  // (see MunicipalMapComponent), so it isn't a dock tool either.
  { id: 'attributes', label: 'Attribute Table', icon: 'pi pi-table', group: 'explore', dock: 'bottom', available: true, moduleId: 15 },
  { id: 'assistant', label: 'AI Assistant', icon: 'pi pi-comments', group: 'explore', dock: 'left', available: true, moduleId: AI_ASSISTANT_MODULE_ID },
  { id: 'tourism', label: 'Tourism', icon: 'pi pi-ticket', group: 'explore', dock: 'left', available: true },
  { id: 'hazards', label: 'Hazard Alerts', icon: 'pi pi-exclamation-triangle', group: 'explore', dock: 'left', available: true },
  { id: 'air-stations', label: 'Air Quality Stations', icon: 'pi pi-chart-scatter', group: 'explore', dock: 'left', available: true },
  { id: 'weather', label: 'Weather', icon: 'pi pi-cloud', group: 'explore', dock: 'left', available: true },
  { id: 'sensors', label: 'Live Sensors', icon: 'pi pi-wifi', group: 'explore', dock: 'left', available: true },
  { id: 'buildings-3d', label: '3D Buildings', icon: 'pi pi-box', group: 'explore', dock: 'left', available: true },
  { id: 'whats-here', label: "What's Here", icon: 'pi pi-map-marker', group: 'explore', dock: 'left', available: true },
  { id: 'bookmarks', label: 'Bookmarks', icon: 'pi pi-bookmark', group: 'explore', dock: 'left', available: true, moduleId: 4 },
  { id: 'query', label: 'Query Builder', icon: 'pi pi-filter', group: 'analysis', dock: 'left', available: true, moduleId: 2 },
  { id: 'measure', label: 'Measure', icon: 'pi pi-arrows-h', group: 'analysis', dock: 'left', available: true, moduleId: 11 },
  { id: 'buffer', label: 'Buffer & Overlay', icon: 'pi pi-circle', group: 'analysis', dock: 'left', available: true, moduleId: 6 },
  { id: 'geoprocessing', label: 'Geoprocessing', icon: 'pi pi-cog', group: 'analysis', dock: 'left', available: true, moduleId: GEOPROCESSING_MODULE_ID },
  { id: 'data', label: 'Data Tools', icon: 'pi pi-database', group: 'analysis', dock: 'left', available: true, anyModuleIds: DATA_TOOL_MODULE_IDS },
  // Draw & Mark also hosts feature editing (Edit Panel module) — there is no separate Edit Features tool.
  { id: 'sketch', label: 'Draw & Mark', icon: 'pi pi-pencil', group: 'analysis', dock: 'left', available: true, anyModuleIds: [DRAW_MODULE_ID, MARKING_TOOL_MODULE_ID, EDIT_PANEL_MODULE_ID] },
  { id: 'advanced', label: 'Advanced Tools', icon: 'pi pi-directions', group: 'analysis', dock: 'left', available: true, anyModuleIds: [BASIC_ROUTING_MODULE_ID, NEAREST_FACILITY_MODULE_ID, NETWORK_TRACING_MODULE_ID, SERVICE_AREA_MODULE_ID] },
  { id: 'groundwater', label: 'Groundwater', icon: 'pi pi-filter-fill', group: 'analysis', dock: 'left', available: true },
  { id: 'outbreak', label: 'Disease Outbreaks', icon: 'pi pi-exclamation-circle', group: 'analysis', dock: 'left', available: true },
  { id: 'ev-charging', label: 'EV Charging', icon: 'pi pi-bolt', group: 'analysis', dock: 'left', available: true },
  { id: 'network-planning', label: 'Network Planning', icon: 'pi pi-sitemap', group: 'analysis', dock: 'left', available: true, anyModuleIds: [BASIC_ROUTING_MODULE_ID, NEAREST_FACILITY_MODULE_ID, SERVICE_AREA_MODULE_ID] },
  { id: 'raster', label: 'Raster Analysis', icon: 'pi pi-images', group: 'analysis', dock: 'left', available: true, anyModuleIds: RASTER_TOOL_MODULE_IDS },
  { id: 'heatmap', label: 'Heatmap & Clusters', icon: 'pi pi-sun', group: 'analysis', dock: 'left', available: true, moduleId: HEATMAP_MODULE_ID },
  { id: 'statistics', label: 'Statistics', icon: 'pi pi-chart-bar', group: 'analysis', dock: 'bottom', available: true, anyModuleIds: [ANALYTICS_MODULE_ID, DATA_VISUALISATION_MODULE_ID] },
  { id: 'print', label: 'Print Layout', icon: 'pi pi-print', group: 'output', dock: 'left', available: true, moduleId: 3 },
  { id: 'reports', label: 'Reports', icon: 'pi pi-file', group: 'output', dock: 'left', available: true, moduleId: 251 },
  { id: 'export', label: 'Export Data', icon: 'pi pi-download', group: 'output', dock: 'left', available: true, moduleId: 226 },
  { id: 'share', label: 'Share Map', icon: 'pi pi-share-alt', group: 'output', dock: 'left', available: true, minRole: 'manager' },
  { id: 'storage', label: 'Storage', icon: 'pi pi-database', group: 'admin', dock: 'left', available: true, minRole: 'manager' },
  { id: 'integrations', label: 'API & Webhooks', icon: 'pi pi-key', group: 'admin', dock: 'left', available: true, minRole: 'owner' },
  { id: 'workspace', label: 'Workspace Details', icon: 'pi pi-server', group: 'admin', dock: 'left', available: true, moduleId: WORKSPACE_DETAILS_MODULE_ID }
];

@Component({
  selector: 'app-gis-workspace',
  standalone: true,
  imports: [
    CrsPickerComponent,
    AnalysisReportComponent,
    ReactiveFormsModule,
    FormsModule,
    ButtonModule,
    DialogModule,
    UploadWizardComponent,
    UploadHistoryComponent,
    InputTextModule,
    TextareaModule,
    SelectModule,
    MessageModule,
    TooltipModule,
    SiteHeaderComponent,
    RouterLink,
    MunicipalMapComponent,
    LayerPanelComponent,
    MapControlsComponent,
    GisSearchComponent,
    AttributeTableComponent,
    QueryBuilderComponent,
    MeasureComponent,
    BookmarksComponent,
    BufferOverlayComponent,
    GeoprocessingComponent,
    DataToolsComponent,
    AdvancedToolsComponent,
    RasterAnalysisComponent,
    AiChatComponent,
    PrintLayoutComponent,
    ExportDataComponent,
    AddServiceComponent,
    WhatsHereComponent,
    ShareMapComponent,
    IntegrationsComponent,
    NetworkPlanningComponent,
    LiveSensorsComponent,
    Buildings3dComponent,
    WeatherComponent,
    OsmImportComponent,
    DataCatalogComponent,
    StorageUsageComponent,
    GroundwaterComponent,
    OutbreakComponent,
    EvChargingComponent,
    TourismComponent,
    HazardsComponent,
    BasemapSwitcherComponent,
    AirStationsComponent,
    SketchComponent,
    LayerStatisticsComponent,
    DensityMapComponent,
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
  private readonly notify = inject(NotificationService);
  private readonly rasterService = inject(RasterService);
  private readonly settingsService = inject(SettingsService);
  private readonly currentUserService = inject(CurrentUserService);
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly mapService = inject(MapService);
  private readonly sketchService = inject(SketchService);
  /** Signal twin of `mapIsReady`, so effects can wait for the map. */
  private readonly mapReady = signal(false);

  readonly municipalityName = signal<string | null>(null);
  readonly workspace = signal<GisWorkspace | null>(null);
  readonly isOwner = signal(false);
  /** Live Sensors keep polling saved feeds even before the panel is opened. */
  readonly sensorFeedsSaved = hasSavedSensorFeeds();
  /** Owner or Department Head. */
  readonly isManager = signal(false);
  /** Layer whose saved analysis report is open (layer More menu). */
  readonly reportLayer = signal<GisLayer | null>(null);
  readonly loading = signal(true);
  readonly pageError = signal<string | null>(null);
  readonly geoserverReachable = signal<boolean | null>(null);

  readonly layers = signal<GisLayer[]>([]);
  readonly layersLoading = signal(true);
  readonly layersError = signal<string | null>(null);
  /** Loaded, and the account has no layers yet — show the upload prompt. */
  readonly layersEmpty = computed(() => !this.layersLoading() && !this.layersError() && this.layers().length === 0);

  // ----- upload (the whole Upload → Process → View flow lives on the map) -----
  readonly uploadOpen = signal(false);
  /** Upload re-opened from the history to retry / finish (null = new). */
  readonly resumeUpload = signal<GisUpload | null>(null);
  readonly historyOpen = signal(false);

  openUpload(): void {
    this.closeMenu();
    this.resumeUpload.set(null);
    this.uploadOpen.set(true);
  }

  openHistory(): void {
    this.closeMenu();
    this.historyOpen.set(true);
  }

  /** Retry / finish an upload from the history in the upload wizard. */
  retryUpload(upload: GisUpload): void {
    this.historyOpen.set(false);
    this.resumeUpload.set(upload);
    this.uploadOpen.set(true);
  }

  showUploadedLayer(layerId: string): void {
    this.historyOpen.set(false);
    void this.router.navigate(['/gis'], { queryParams: { layer: layerId } }).then(() => this.loadLayers());
  }

  /** Processed and published: close the dialog, load the new layer and
   *  zoom to it (via the ?layer= deep link, which reloads if needed). */
  onUploadPublished(upload: GisUpload): void {
    this.uploadOpen.set(false);
    const layerId = upload.publish.layerId;
    // Always reload (the map may have had no layers at all, in which case
    // the deep link alone has nothing to re-check against), then zoom.
    if (layerId) {
      void this.router.navigate(['/gis'], { queryParams: { layer: layerId } }).then(() => this.loadLayers());
    } else {
      this.loadLayers();
    }
  }
  /** True once a layer list is loaded — and it stays true while the list is
   *  reloaded (after an analysis, rename, delete …). Tying it to "not
   *  loading" destroyed and rebuilt every open tool panel on each reload,
   *  wiping e.g. the Raster Analysis result the moment its layer appeared. */
  readonly layersReady = computed(() => this.layers().length > 0);

  /** The caller's own resolved Module Access set (GET /api/module-access/me)
   *  — hierarchical module assignment (Owner -> Department -> Department
   *  User). Starts empty (nothing extra shown) until it loads, then
   *  gates which tools appear via hasModuleAccess — a tool with no
   *  moduleId (see WsTool) is never gated. Never used to gate anything
   *  the backend doesn't independently re-check itself (each tool's own
   *  API calls are authorized server-side regardless of the rail).  */
  readonly myModuleIds = signal<ReadonlySet<number>>(ALL_MODULES);

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
    if (tool.minRole === 'owner' && !this.isOwner()) return false;
    if (tool.minRole === 'manager' && !this.isManager()) return false;
    const granted = this.myModuleIds();
    if (tool.anyModuleIds) {
      return tool.anyModuleIds.some((id) => granted.has(id));
    }
    return tool.moduleId === undefined || granted.has(tool.moduleId);
  }

  // ----- dock state -----
  readonly groups = GROUP_ORDER;
  // Not-yet-shipped tools (`available: false`) and tools the caller has
  // no Module Access to (see hasModuleAccess) never appear on the rail.

  // ----- rail menus -----
  private readonly visibleToolList = computed(() => TOOLS.filter((t) => t.available && this.hasModuleAccess(t)));
  readonly primaryTools = computed(() =>
    PRIMARY_TOOL_IDS.map((id) => this.visibleToolList().find((t) => t.id === id)).filter((t): t is WsTool => !!t)
  );
  readonly menuGroups = computed(() =>
    GROUP_ORDER.map((g) => ({
      ...g,
      ...GROUP_META[g.id],
      tools: this.visibleToolList().filter((t) => t.group === g.id && !PRIMARY_TOOL_IDS.includes(t.id))
    }))
      .filter((g) => g.tools.length > 0)
      .map((g) => {
        // Big groups become a wide menu with one column per section.
        const names = [...new Set(g.tools.map((t) => TOOL_INFO[t.id]?.section ?? 'More'))];
        const sections = names.map((name) => ({ name, tools: g.tools.filter((t) => (TOOL_INFO[t.id]?.section ?? 'More') === name) }));
        return { ...g, sections: g.tools.length > 6 && sections.length > 1 ? sections : null };
      })
  );

  toolHint = (tool: WsTool) => ('parent' in tool ? (tool as SubTool).hint : TOOL_INFO[tool.id]?.hint) ?? '';

  /** Last few tools opened, newest first — shown when the search box is focused. */
  readonly recentToolIds = signal<string[]>(this.readRecent());
  readonly recentTools = computed(() =>
    this.recentToolIds()
      .map((id) => this.visibleToolList().find((t) => t.id === id))
      .filter((t): t is WsTool => !!t)
      .slice(0, 5)
  );

  private readRecent(): string[] {
    try {
      const v = JSON.parse(localStorage.getItem('gis.recentTools') ?? '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private rememberRecent(id: string): void {
    const next = [id, ...this.recentToolIds().filter((x) => x !== id)].slice(0, 8);
    this.recentToolIds.set(next);
    try {
      localStorage.setItem('gis.recentTools', JSON.stringify(next));
    } catch {
      /* private mode */
    }
  }

  private readonly toolSearchInput = viewChild<ElementRef<HTMLInputElement>>('toolSearch');

  /** Ctrl/Cmd + K jumps to the tool search. */
  @HostListener('document:keydown', ['$event'])
  onShortcut(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.openToolSearch();
      return;
    }
    // Plain "F" toggles the full-screen map — never while typing.
    const target = event.target as HTMLElement | null;
    const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      this.toggleFocusMode();
    }
  }

  // ----- light / dark theme (same setting as Settings → Appearance) -----
  private readonly themeService = inject(ThemeService);
  readonly isDark = computed(() => {
    this.settingsService.theme();
    return this.themeService.resolvedTheme() === 'dark';
  });

  toggleTheme(): void {
    this.settingsService.patch({ appearance: { theme: this.isDark() ? 'light' : 'dark' } });
  }

  // ----- full-screen map -----
  /** Map + toolbar only: hides the site header and the side/bottom docks
   *  (their state is kept) and asks the browser for full screen. */
  readonly focusMode = signal(false);
  private readonly leaveFullscreenOnExit = inject(DestroyRef).onDestroy(() => {
    if (this.focusMode() && document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
  });

  toggleFocusMode(): void {
    const on = !this.focusMode();
    this.focusMode.set(on);
    this.closeMenu();
    try {
      if (on && !document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => undefined);
      if (!on && document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    } catch {
      /* fullscreen not allowed — the in-page mode still applies */
    }
    this.refreshMapSize();
  }

  /** Leaving browser full screen (Esc) also leaves the full-screen map. */
  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    if (!document.fullscreenElement && this.focusMode()) {
      this.focusMode.set(false);
      this.refreshMapSize();
    }
  }

  /** "Find a tool" icon: opens the tool-search popup with its box focused. */
  toggleToolSearch(): void {
    if (this.openMenu() === 'search') this.closeMenu();
    else this.openToolSearch();
  }

  openToolSearch(): void {
    this.openMenu.set('search');
    // The input is rendered with the popup — focus it once it exists.
    setTimeout(() => this.toolSearchInput()?.nativeElement.focus());
  }

  /** Arrow keys move between items of an open dropdown. */
  onMenuKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const root = (event.currentTarget as HTMLElement).closest('.gis-ws__bar-menu, .gis-ws__bar-search');
    const items = Array.from(root?.querySelectorAll<HTMLButtonElement>('.gis-ws__dropdown-item') ?? []);
    if (!items.length) return;
    event.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
    items[next].focus();
  }
  /** Which toolbar dropdown is open ('search' = the tool-search results). */
  readonly openMenu = signal<WsToolGroup | 'search' | 'layout' | 'all' | null>(null);
  readonly menuQuery = signal('');
  readonly openMenuGroup = computed(() => this.menuGroups().find((g) => g.id === this.openMenu()) ?? null);
  /** Searching looks through every tool. */
  readonly menuResults = computed(() => {
    const q = this.menuQuery().trim().toLowerCase();
    if (!q) return [];
    // Every word must appear in the tool's name, description or keywords;
    // name matches are listed first.
    const words = q.split(/\s+/);
    const visible = this.visibleToolList();
    const subTools = SUB_TOOLS.filter((t) => visible.some((p) => p.id === t.parent) && this.hasModuleAccess(t));
    const scored = [...this.visibleToolList(), ...subTools]
      .map((t) => {
        const label = t.label.toLowerCase();
        const info: { hint?: string; keywords?: string } | undefined = 'parent' in t ? (t as SubTool) : TOOL_INFO[t.id];
        const text = `${label} ${info?.hint ?? ''} ${info?.keywords ?? ''}`.toLowerCase();
        if (!words.every((w) => text.includes(w))) return null;
        return { t, rank: label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2 };
      })
      .filter((x): x is { t: WsTool; rank: number } => !!x);
    return scored.sort((a, b) => a.rank - b.rank).map((x) => x.t);
  });

  toggleMenu(id: WsToolGroup): void {
    this.openMenu.update((cur) => (cur === id ? null : id));
  }

  /** Phones: one "Tools" menu listing every tool group (the per-group
   *  menus don't fit the toolbar there). */
  toggleAllTools(): void {
    this.openMenu.update((cur) => (cur === 'all' ? null : 'all'));
  }

  /** Menu-bar behaviour: with one dropdown open, hovering another opens it. */
  hoverMenu(id: WsToolGroup): void {
    if (this.openMenu() && this.openMenu() !== 'search' && this.openMenu() !== id) this.openMenu.set(id);
  }

  onToolSearch(value: string): void {
    this.menuQuery.set(value);
    this.openMenu.set('search');
  }

  closeMenu(): void {
    this.openMenu.set(null);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.openMenu()) this.closeMenu();
  }

  /** Tool / tab inside a panel requested from the tool search; each panel
   *  reacts only to its own `parent` id. */
  readonly subRequest = signal<{ parent: string; sub: string } | null>(null);

  pickTool(tool: WsTool): void {
    const subTool = SUB_TOOLS.find((t) => t.id === tool.id);
    if (subTool) {
      const parent = TOOLS.find((t) => t.id === subTool.parent)!;
      if (!this.isToolActive(parent)) this.activateTool(parent);
      this.subRequest.set({ parent: subTool.parent, sub: subTool.sub });
    } else if (!this.isToolActive(tool)) this.activateTool(tool);
    this.closeMenu();
    this.menuQuery.set('');
    this.toolSearchInput()?.nativeElement.blur();
  }

  isGroupActive(group: { tools: WsTool[] }): boolean {
    return group.tools.some((t) => this.isToolActive(t));
  }

  readonly leftTool = signal<string | null>(this.readLayersDock() === 'right' ? null : 'layers');
  readonly bottomTool = signal<string | null>(null);
  readonly leftWidth = signal(300);
  /** Raster Analysis needs room for its category rail + tool list. */
  /** Width each tool was last given (drag or double-click snap). */
  readonly toolWidths = signal<Record<string, number>>(this.readToolWidths());

  private readToolWidths(): Record<string, number> {
    try {
      const v = JSON.parse(localStorage.getItem('gis.toolWidths') ?? '{}');
      if (!v || typeof v !== 'object') return {};
      return Object.fromEntries(
        Object.entries(v).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] >= 240 && e[1] <= 560)
      );
    } catch {
      return {};
    }
  }

  private setToolWidth(tool: string, width: number): void {
    this.toolWidths.update((m) => ({ ...m, [tool]: width }));
    try {
      localStorage.setItem('gis.toolWidths', JSON.stringify(this.toolWidths()));
    } catch {
      /* private mode */
    }
  }

  readonly leftPanelWidth = computed(() => {
    const tool = this.leftTool();
    if (tool === 'assistant' && this.assistantPanelMode() === 'floating') return 400;
    const saved = tool ? this.toolWidths()[tool] : undefined;
    if (saved) return saved;
    if (tool === 'raster') return Math.max(this.leftWidth(), 420);
    if (tool === 'catalog') return Math.max(this.leftWidth(), 380);
    if (tool === 'assistant' && this.assistantPanelMode() === 'wide') return Math.max(this.leftWidth(), 520);
    if (tool === 'assistant' && this.assistantPanelMode() === 'floating') return 400;
    return this.leftWidth();
  });
  /** AI Assistant setting: docked (normal), wide, or floating over the map. */
  readonly assistantPanelMode = computed(() => this.settingsService.assistant().panelMode);
  readonly assistantFloating = computed(
    () => this.leftTool() === 'assistant' && this.assistantPanelMode() === 'floating',
  );
  readonly bottomHeight = signal(240);

  /** Every tool panel that has been opened at least once. Panels are kept
   *  mounted (just hidden) after their first open so switching tools — or
   *  leaving and returning to the workspace — never loses their in-progress
   *  form / filter / result state. */
  readonly openedLeftTools = signal<ReadonlySet<string>>(new Set(this.readLayersDock() === 'right' ? [] : ['layers']));
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
  /** Deep-linked layer id we already reloaded the list for (avoids loops). */
  private deepLinkReloadedFor: string | null = null;
  private readonly router = inject(Router);
  /** The workspace is kept alive while other pages are open; true while
   *  /gis itself is the current page. */
  private onMapPage = true;

  /** Active Query Builder result — drives the WMS filter, the map highlight,
   *  and the Attribute Table's locked filter. */
  readonly activeQueryFilter = signal<AttributeExternalFilter | null>(null);
  /** Draw & Mark edit session: the layer being edited (its Attribute Table
   *  cells become editable), a tick when the edit panel writes features,
   *  and the cell edits saved in the table (for the open feature). */
  /** Status bar zoom readout. */
  readonly zoomLevel = this.mapService.zoomLevel;
  readonly scaleDenominator = this.mapService.scaleDenominator;
  readonly visibleLayerCount = computed(() => Object.values(this.mapService.layerVisibility()).filter(Boolean).length);
  /** Status bar cursor readout format, cycled by clicking its label. */
  readonly coordFormat = signal<CoordFormat>('dd');
  readonly coordKey = computed(() => {
    const format = this.coordFormat();
    return format === 'crs' ? `${this.workspace()?.displayCrs ?? 'CRS'} X, Y` : format === 'dms' ? 'Lon, Lat (DMS)' : 'Lon, Lat';
  });
  private readonly applyCoordFormat = effect(() =>
    this.mapService.setCoordFormat(this.coordFormat(), this.workspace()?.displayCrs ?? 'EPSG:4326')
  );
  readonly editingLayerId = signal<string | null>(null);
  readonly featuresWrittenTick = signal(0);
  readonly tableEdits = signal<{ layerId: string; changes: Record<number, Record<string, string>> } | null>(null);
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
    // Add Service: outside layers saved in this browser come back, and
    // every change is saved again. WFS goes via the API proxy when CORS
    // blocks it.
    this.mapService.externalFetchText = inject(PlatformExtrasService).smartFetchText;
    for (const spec of loadSavedExternalLayers()) this.mapService.addExternalLayer(spec);
    effect(() => saveExternalLayers(this.mapService.externalLayers()));

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
        this.isManager.set(user.systemRole === 'MUNICIPALITY_OWNER' || user.systemRole === 'DEPARTMENT_HEAD');
      }
    });

    // A raster job running (or finished unseen) from before a page reload:
    // open Raster Analysis, which reattaches to it.
    this.rasterService.pendingJobs().subscribe({
      next: (jobs) => {
        if (!jobs.length || (typeof window !== 'undefined' && window.innerWidth < 900)) return;
        this.leftTool.set('raster');
        this.rememberOpened(this.openedLeftTools, 'raster');
        this.refreshMapSize();
      },
      error: () => undefined
    });

    this.restoreLayout();

    this.loadWorkspace();
    this.loadLayers();

    this.gisWorkspaceService.getGeoServerHealth().subscribe({
      next: () => this.geoserverReachable.set(true),
      error: () => this.geoserverReachable.set(false)
    });

    // The workspace is kept alive across navigation, so `?layer=`
    // deep links (from the dashboard) arrive on re-navigation, not just at
    // construction — react to every change, not a one-shot snapshot read.
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe(() => this.tryApplyDeepLink());

    // Coming back to the (kept-alive) map from another page — e.g. right
    // after uploading on My Layers — reload the layer list so new or
    // changed layers show without a full page refresh.
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (!(event instanceof NavigationEnd)) return;
      const onMap = /^\/gis(?:[?#]|$)/.test(event.urlAfterRedirects);
      if (onMap && !this.onMapPage) this.loadLayers();
      this.onMapPage = onMap;
    });
  }

  get f() {
    return this.form.controls;
  }

  // ----- status bar -----
  cycleCoordFormat(): void {
    this.coordFormat.update((format) => (format === 'dd' ? 'dms' : format === 'dms' ? 'crs' : 'dd'));
  }

  // ----- quick-start card (shown when no panel is open) -----
  readonly quickStartHidden = signal(this.readQuickStartHidden());
  readonly quickStartTools = computed(() =>
    ['layers', 'add-service', 'measure', 'query', 'print']
      .map((id) => this.visibleToolList().find((t) => t.id === id))
      .filter((t): t is WsTool => !!t)
  );
  readonly showQuickStart = computed(
    () =>
      !this.quickStartHidden() &&
      this.layersReady() &&
      !this.focusMode() &&
      !this.activeLeftTool() &&
      !this.activeBottomTool() &&
      !this.styleTargetLayer() &&
      !(this.layersDock() === 'right' && this.rightOpen())
  );

  private readQuickStartHidden(): boolean {
    try {
      return localStorage.getItem('gis.quickStartHidden') === '1';
    } catch {
      return false;
    }
  }

  setQuickStartHidden(hidden: boolean): void {
    this.quickStartHidden.set(hidden);
    try {
      localStorage.setItem('gis.quickStartHidden', hidden ? '1' : '0');
    } catch {
      /* private mode */
    }
    this.closeMenu();
  }

  focusMapSearch(): void {
    document.querySelector<HTMLInputElement>('.gis-ws__place-search input')?.focus();
  }

  // ----- centre crosshair -----
  readonly crosshair = signal(this.readCrosshair());
  readonly crosshairText = computed(() => {
    this.mapService.centerRevision();
    this.coordFormat();
    this.workspace();
    return this.mapService.centerText() ?? '';
  });

  private readCrosshair(): boolean {
    try {
      return localStorage.getItem('gis.crosshair') === '1';
    } catch {
      return false;
    }
  }

  toggleCrosshair(): void {
    this.crosshair.update((v) => !v);
    try {
      localStorage.setItem('gis.crosshair', this.crosshair() ? '1' : '0');
    } catch {
      /* private mode */
    }
    this.closeMenu();
  }

  copyCenterCoords(): void {
    const text = this.mapService.centerText();
    if (!text) return;
    navigator.clipboard?.writeText(text).then(
      () => this.notify.success(`Copied ${text}`, 'Map centre'),
      () => this.notify.error('Could not copy to the clipboard.')
    );
  }

  copyCursorCoords(): void {
    const text = this.mapService.lastCursorText();
    if (!text) {
      this.notify.info('Move the cursor over the map first.');
      return;
    }
    navigator.clipboard?.writeText(text).then(
      () => this.notify.success(`Copied ${text}`, 'Coordinates'),
      () => this.notify.error('Could not copy to the clipboard.')
    );
  }

  applyStatusZoom(input: HTMLInputElement): void {
    const zoom = Number(input.value);
    if (input.value.trim() && Number.isFinite(zoom)) this.mapService.setZoom(Math.min(Math.max(zoom, 0), 22));
    input.value = String(this.zoomLevel() ?? '');
    input.blur();
  }

  readonly scalePresets = [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 1000000];

  applyScalePreset(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const scale = Number(select.value);
    if (scale > 0) this.mapService.zoomToScale(scale);
    select.value = '';
  }

  applyStatusScale(input: HTMLInputElement): void {
    const scale = Number(input.value.replace(/^1\s*:\s*/, '').replace(/[,\s]/g, ''));
    if (scale > 0) this.mapService.zoomToScale(scale);
    input.value = String(this.scaleDenominator() ?? '');
    input.blur();
  }

  // ----- dock actions -----
  activateTool(tool: WsTool): void {
    this.rememberRecent(tool.id);
    if (tool.id === 'layers' && this.layersDock() === 'right') {
      this.rightOpen.update((v) => !v);
      this.refreshMapSize();
      return;
    }
    // A minimised dock: picking its tool (or any tool for it) restores it
    // instead of toggling the tool closed.
    const minimised = tool.dock === 'left' ? this.leftMinimized : this.bottomMinimized;
    if (minimised()) {
      minimised.set(false);
      const current = tool.dock === 'left' ? this.leftTool() : this.bottomTool();
      if (current === tool.id) {
        this.refreshMapSize();
        return;
      }
    }
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
    // On a phone both docks are full-width overlays: the one just opened
    // would sit hidden under the other, so close the other one.
    if (typeof window !== 'undefined' && window.innerWidth < 900) {
      if (tool.dock === 'left' && this.leftTool()) this.bottomTool.set(null);
      if (tool.dock !== 'left' && this.bottomTool()) this.leftTool.set(null);
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
    if ('parent' in tool) return false;
    if (tool.id === 'layers' && this.layersDock() === 'right') return this.rightOpen();
    return tool.dock === 'left' ? this.leftTool() === tool.id : this.bottomTool() === tool.id;
  }

  closeLeft(): void {
    this.leftTool.set(null);
    this.leftMinimized.set(false);
    this.refreshMapSize();
  }

  // ----- saved layout & presets -----
  /** Open panels and dock sizes, remembered in this browser and restored
   *  on the next visit (once module access is known). */
  private layoutRestored = false;
  private readonly saveLayout = effect(() => {
    const layout = {
      left: this.leftTool(),
      bottom: this.bottomTool(),
      leftWidth: this.leftWidth(),
      bottomHeight: this.bottomHeight(),
      rightWidth: this.rightWidth(),
      rightOpen: this.rightOpen()
    };
    if (!this.layoutRestored) return;
    try {
      localStorage.setItem('gis.layout', JSON.stringify(layout));
    } catch {
      /* private mode */
    }
  });

  readonly layoutPresets: { id: 'map' | 'browse' | 'edit' | 'analysis'; label: string; hint: string; icon: string }[] = [
    { id: 'map', label: 'Map only', hint: 'Close every panel', icon: 'pi pi-map' },
    { id: 'browse', label: 'Viewer', hint: 'Layers beside the map', icon: 'pi pi-eye' },
    { id: 'edit', label: 'Editing', hint: 'Layers and the attribute table', icon: 'pi pi-pencil' },
    { id: 'analysis', label: 'Analysis', hint: 'Layers on the right, Query Builder and table', icon: 'pi pi-chart-line' }
  ];

  private restoreLayout(): void {
    if (this.layoutRestored) return;
    this.layoutRestored = true;
    let saved: { left?: string | null; bottom?: string | null; leftWidth?: number; bottomHeight?: number; rightWidth?: number; rightOpen?: boolean } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem('gis.layout') ?? 'null');
    } catch {
      saved = null;
    }
    if (!saved || typeof saved !== 'object') return;
    const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
    this.leftWidth.set(clamp(saved.leftWidth, 240, 560, this.leftWidth()));
    this.bottomHeight.set(clamp(saved.bottomHeight, 140, 900, this.bottomHeight()));
    this.rightWidth.set(clamp(saved.rightWidth, 240, 520, this.rightWidth()));
    if (this.layersDock() === 'right' && typeof saved.rightOpen === 'boolean') this.rightOpen.set(saved.rightOpen);
    if (saved.left !== undefined) {
      if (saved.left === null) this.leftTool.set(null);
      else this.openPanel(saved.left, 'left');
    }
    if (saved.bottom) this.openPanel(saved.bottom, 'bottom');
    this.refreshMapSize();
  }

  /** Opens a tool's panel if the caller may use it (no toggling). */
  private openPanel(id: string, dock: 'left' | 'bottom'): void {
    const tool = this.visibleToolList().find((t) => t.id === id && t.dock === dock);
    if (!tool) return;
    if (tool.id === 'layers' && this.layersDock() === 'right') {
      this.rightOpen.set(true);
      return;
    }
    if (dock === 'left') {
      this.leftTool.set(id);
      this.leftMinimized.set(false);
      this.rememberOpened(this.openedLeftTools, id);
    } else {
      this.bottomTool.set(id);
      this.bottomMinimized.set(false);
      this.rememberOpened(this.openedBottomTools, id);
    }
  }

  applyLayoutPreset(id: 'map' | 'browse' | 'edit' | 'analysis'): void {
    this.closeMenu();
    if (this.focusMode()) this.toggleFocusMode();
    this.bottomMaximized.set(false);
    this.leftTool.set(null);
    this.bottomTool.set(null);
    this.rightOpen.set(false);
    if (id === 'browse' || id === 'edit') {
      if (this.layersDock() === 'right') this.setLayersDock('left');
      else this.openPanel('layers', 'left');
    }
    if (id === 'edit') this.openPanel('attributes', 'bottom');
    if (id === 'analysis') {
      if (this.layersDock() !== 'right') this.setLayersDock('right');
      else this.rightOpen.set(true);
      this.openPanel('query', 'left');
      this.openPanel('attributes', 'bottom');
    }
    this.refreshMapSize();
  }

  resetPanelSizes(): void {
    this.closeMenu();
    this.leftWidth.set(300);
    this.bottomHeight.set(240);
    this.rightWidth.set(300);
    this.toolWidths.set({});
    try {
      localStorage.removeItem('gis.toolWidths');
    } catch {
      /* private mode */
    }
    this.refreshMapSize();
  }

  toggleLayoutMenu(): void {
    this.openMenu.update((cur) => (cur === 'layout' ? null : 'layout'));
  }

  // ----- right dock (Layers can live there, beside any left tool) -----
  readonly layersDock = signal<'left' | 'right'>(this.readLayersDock());
  readonly rightOpen = signal(this.readLayersDock() === 'right');
  readonly rightWidth = signal(300);

  private readLayersDock(): 'left' | 'right' {
    try {
      return localStorage.getItem('gis.layersDock') === 'right' ? 'right' : 'left';
    } catch {
      return 'left';
    }
  }

  setLayersDock(side: 'left' | 'right'): void {
    this.layersDock.set(side);
    try {
      localStorage.setItem('gis.layersDock', side);
    } catch {
      /* private mode */
    }
    if (side === 'right') {
      const next = new Set(this.openedLeftTools());
      next.delete('layers');
      this.openedLeftTools.set(next);
      if (this.leftTool() === 'layers') {
        const other = this.leftTabs().find((t) => t.id !== 'layers');
        if (other) this.leftTool.set(other.id);
        else this.leftTool.set(null);
      }
      this.rightOpen.set(true);
    } else {
      this.rightOpen.set(false);
      this.leftMinimized.set(false);
      this.leftTool.set('layers');
      this.rememberOpened(this.openedLeftTools, 'layers');
    }
    this.refreshMapSize();
  }

  startRightResize(event: PointerEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startW = this.rightWidth();
    const move = (e: PointerEvent) => this.rightWidth.set(Math.min(520, Math.max(240, startW - (e.clientX - startX))));
    this.dragUntilRelease(move);
  }

  refreshMap(): void {
    this.refreshMapSize();
  }

  /** The left dock shows ONE tool at a time — opening another tool
   *  replaces it (no tab strip). Panels opened earlier stay mounted but
   *  hidden (see openedLeftTools), so switching back keeps their state. */
  readonly leftTabs = computed(() => {
    const active = this.leftTool();
    return [...this.openedLeftTools()]
      .filter((id) => id === active)
      .map((id) => this.visibleToolList().find((t) => t.id === id && t.dock === 'left'))
      .filter((t): t is WsTool => !!t);
  });

  switchLeftTab(tool: WsTool): void {
    if (this.leftTool() === tool.id) return;
    this.leftTool.set(tool.id);
    this.rememberRecent(tool.id);
  }

  /** Closing a tab unmounts that panel (its state is dropped). */
  closeLeftTab(tool: WsTool, event?: Event): void {
    event?.stopPropagation();
    const tabs = this.leftTabs();
    const index = tabs.findIndex((t) => t.id === tool.id);
    const next = new Set(this.openedLeftTools());
    next.delete(tool.id);
    this.openedLeftTools.set(next);
    if (this.leftTool() === tool.id) {
      const fallback = tabs[index + 1] ?? tabs[index - 1] ?? null;
      if (fallback && fallback.id !== tool.id) this.leftTool.set(fallback.id);
      else this.closeLeft();
    }
  }

  /** Minimised docks fold to a thin edge tab; the panel stays mounted,
   *  so its state is exactly as left when restored. */
  readonly leftMinimized = signal(false);
  readonly bottomMinimized = signal(false);

  toggleLeftMinimized(): void {
    this.leftMinimized.update((v) => !v);
    this.refreshMapSize();
  }

  toggleBottomMinimized(): void {
    this.bottomMinimized.update((v) => !v);
    if (this.bottomMinimized()) this.bottomMaximized.set(false);
    this.refreshMapSize();
  }

  /** Bottom panel fills the whole map area (e.g. a big attribute table). */
  readonly bottomMaximized = signal(false);

  toggleBottomMaximized(): void {
    this.bottomMaximized.update((v) => !v);
    if (this.bottomMaximized()) this.bottomMinimized.set(false);
    this.refreshMapSize();
  }

  // ----- layer styling -----

  /** Raster Analysis → Raster Styling request (raster "Style layer"). */
  readonly rasterStyleRequest = signal<{ layerId: string; n: number } | null>(null);

  openStyleEditor(layer: GisLayer): void {
    // A raster's symbology (RGB band combination, stretched band, classes)
    // lives in Raster Styling; the generic style editor only has opacity.
    if (layer.layerType === 'RASTER' && this.myModuleIds().has(RASTER_STYLE_MODULE_ID)) {
      this.styleTargetLayer.set(null);
      this.leftTool.set('raster');
      this.rememberOpened(this.openedLeftTools, 'raster');
      this.rasterStyleRequest.set({ layerId: layer.id, n: (this.rasterStyleRequest()?.n ?? 0) + 1 });
      this.refreshMapSize();
      return;
    }
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

  /** SLD editor preview: render the layer with a draft style (null ends it). */
  onStylePreview(layer: GisLayer, style: string | null): void {
    if (style) this.mapService.setLayerVisibility(layer.id, true);
    this.mapService.previewLayerStyle(layer.id, style);
  }

  onStyleApplied(layer: GisLayer): void {
    this.mapService.previewLayerStyle(layer.id, null);
    this.mapService.setLayerVisibility(layer.id, true);
    this.mapService.refreshLayerStyle(layer.id);
  }

  // ----- rename / delete (Owner) -----

  renameLayer(layer: GisLayer, name: string): void {
    this.gisLayersService.rename(layer.id, name).subscribe({
      next: () => {
        this.layers.update((list) => list.map((l) => (l.id === layer.id ? { ...l, name } : l)));
        this.notify.success(`Renamed to "${name}".`);
      },
      error: (err: HttpErrorResponse) => this.notify.error(this.apiError(err, 'Could not rename the layer.'))
    });
  }

  deleteLayer(layer: GisLayer): void {
    this.notify.confirmDelete({
      message: `Delete "${layer.name}"? This unpublishes the layer and permanently removes its data and upload history. This cannot be undone.`,
      accept: () =>
        this.gisLayersService.delete(layer.id).subscribe({
          next: () => {
            this.mapService.setLayerVisibility(layer.id, false);
            if (this.styleTargetLayer()?.id === layer.id) this.closeStyleEditor();
            this.notify.success(`"${layer.name}" was deleted.`);
            this.loadLayers();
          },
          error: (err: HttpErrorResponse) => this.notify.error(this.apiError(err, 'Delete failed. Please try again.'))
        })
    });
  }

  /** Rendering mode of a layer: saved, then the map switches renderer. */
  setRenderMode(layer: GisLayer, mode: GisRenderMode): void {
    const label = mode === 'AUTO' ? 'the fastest available format' : formatInfo(mode).label;
    this.gisLayersService.setRenderMode(layer.id, mode).subscribe({
      next: (res) => {
        this.notify.success(
          res.pmtilesStatus === 'BUILDING'
            ? `"${layer.name}": building its PMTiles archive — live tiles are shown until it is ready.`
            : `"${layer.name}" now renders as ${label}.`
        );
        this.loadLayers();
        if (res.pmtilesStatus === 'BUILDING') this.watchTileArchive(layer.id);
      },
      error: (err: HttpErrorResponse) => this.notify.error(this.apiError(err, 'The rendering mode could not be changed.'))
    });
  }

  /** Rebuilds a layer's PMTiles archive. */
  rebuildTileArchive(layer: GisLayer): void {
    this.gisLayersService.rebuildTileArchive(layer.id).subscribe({
      next: () => {
        this.notify.success(`"${layer.name}": rebuilding its PMTiles archive.`);
        this.loadLayers();
        this.watchTileArchive(layer.id);
      },
      error: (err: HttpErrorResponse) => this.notify.error(this.apiError(err, 'The archive could not be rebuilt.'))
    });
  }

  /** Polls a building PMTiles archive; the map switches to it once READY. */
  private watchTileArchive(layerId: string, tries = 0): void {
    setTimeout(() => {
      this.gisLayersService.getById(layerId).subscribe({
        next: (layer) => {
          if (layer.pmtilesStatus === 'BUILDING' && tries < 180) {
            this.watchTileArchive(layerId, tries + 1);
            return;
          }
          if (layer.pmtilesStatus === 'READY') this.notify.success(`"${layer.name}": PMTiles archive ready.`);
          else if (layer.pmtilesStatus === 'FAILED') {
            this.notify.error(`"${layer.name}": PMTiles archive failed — ${layer.pmtilesError ?? 'unknown error'}. Live tiles are used.`);
          }
          this.loadLayers();
        }
      });
    }, 5000);
  }

  /** Layers uploaded before types were fixed at import: numbers / dates
   *  stored as text become real types (only when every value converts). */
  fixColumnTypes(layer: GisLayer): void {
    this.notify.info(`Checking the columns of "${layer.name}"… large layers can take a minute.`);
    this.gisLayersService.fixColumnTypes(layer.id).subscribe({
      next: ({ converted }) => {
        if (!converted.length) {
          this.notify.info(`"${layer.name}": no text column holds only numbers, dates or yes/no values.`);
          return;
        }
        const names = converted.slice(0, 6).map((c) => c.column).join(', ');
        this.notify.success(
          `${converted.length} column${converted.length === 1 ? '' : 's'} converted: ${names}${converted.length > 6 ? '…' : ''}`,
          layer.name
        );
        this.mapService.refreshLayerStyle(layer.id);
        this.loadLayers();
      },
      error: (err: HttpErrorResponse) => this.notify.error(this.apiError(err, 'Column types could not be changed.'))
    });
  }

  private apiError(err: HttpErrorResponse, fallback: string): string {
    const message = err.error?.message;
    return Array.isArray(message) ? message.join('. ') : (message ?? fallback);
  }

  onStyleRemoved(layer: GisLayer): void {
    this.mapService.refreshLayerStyle(layer.id);
  }

  closeBottom(): void {
    this.bottomTool.set(null);
    this.bottomMinimized.set(false);
    this.bottomMaximized.set(false);
    this.refreshMapSize();
  }

  startLeftResize(event: PointerEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    // The style editor uses the shared width; a tool panel its own.
    const tool = this.styleTargetLayer() ? null : this.leftTool();
    const startW = tool ? this.leftPanelWidth() : this.leftWidth();
    const move = (e: PointerEvent) => {
      const w = Math.min(560, Math.max(240, startW + (e.clientX - startX)));
      if (tool) this.setToolWidth(tool, w);
      else this.leftWidth.set(w);
    };
    this.dragUntilRelease(move);
  }

  /** Double-click on the resize edge: compact (300) ⇄ wide (480). */
  snapLeftWidth(): void {
    const tool = this.styleTargetLayer() ? null : this.leftTool();
    const current = tool ? this.leftPanelWidth() : this.leftWidth();
    const next = current < 390 ? 480 : 300;
    if (tool) this.setToolWidth(tool, next);
    else this.leftWidth.set(next);
    this.refreshMapSize();
  }

  snapRightWidth(): void {
    this.rightWidth.set(this.rightWidth() < 390 ? 480 : 300);
    this.refreshMapSize();
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
  /** Opens the Attribute Table on one layer (Draw & Mark). */
  openAttributeTable(layerId: string): void {
    this.highlightLayerId.set(layerId);
    this.bottomTool.set('attributes');
    this.rememberOpened(this.openedBottomTools, 'attributes');
    this.refreshMapSize();
  }

  onLayerCreated(layer: GisLayer | undefined): void {
    this.loadLayers();
    if (layer?.bbox) setTimeout(() => this.mapService.zoomToLayer(layer), 300);
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

    const key = layerId ?? '';
    if (key === this.lastDeepLinkKey) {
      return;
    }
    this.lastDeepLinkKey = key;

    if (layerId) {
      const layer = this.layers().find((candidate) => candidate.id === layerId);
      if (!layer && this.deepLinkReloadedFor !== layerId) {
        // A layer published since the list was loaded — fetch it, then retry.
        this.deepLinkReloadedFor = layerId;
        this.lastDeepLinkKey = null;
        this.loadLayers();
        return;
      }
      if (layer) {
        this.mapService.setLayerVisibility(layer.id, true);
        this.mapService.zoomToLayer(layer);
        this.highlightLayerId.set(layer.id);
      }
      return;
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

  /** Search × — drop the found feature's highlight and the layer emphasis. */
  onSearchCleared(): void {
    this.mapService.clearSelectionHighlight();
    this.highlightLayerId.set(null);
    this.featureInfoResults.set([]);
  }

  onSearchFeatureSelected(match: GisSearchFeatureMatch): void {
    const layer = this.layers().find((candidate) => candidate.id === match.layerId);
    if (match.bbox) {
      this.mapService.zoomToBbox4326(match.bbox);
    }
    // Outline the found feature itself, not just the area around it.
    this.mapService.setSelectionWms(null, []);
    this.mapService.setSelectionHighlight(match.geometry ? [match.geometry] : []);
    if (layer) {
      this.mapService.setLayerVisibility(layer.id, true);
      this.highlightLayerId.set(layer.id);
      // The feature's id (<layer>.<feat_id>) lets an open Attribute Table
      // select it — otherwise switching the table to this layer clears the
      // map selection and wipes the highlight just drawn.
      const featId = match.attributes?.['feat_id'];
      const id = featId !== undefined && featId !== null ? `${layer.geoserverLayer}.${featId}` : undefined;
      const results: FeatureInfoResult[] = [{ layer, features: [{ attributes: match.attributes, id }] }];
      // Search only zooms to and highlights the feature — no Identify
      // popup; clicking the feature still opens its info as usual.
      this.featureInfoResults.set(results);
      this.mapService.closeFeatureInfoPopup();
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

  // ----- floating selection bar -----
  canUseTool = (id: string) => this.visibleToolList().some((t) => t.id === id);

  selectionZoom(): void {
    this.attributeTable()?.zoomToSelected();
  }

  /** Opens the attribute table showing only the selected records. */
  selectionShowInTable(): void {
    this.openPanel('attributes', 'bottom');
    this.bottomMaximized.set(false);
    const table = this.attributeTable();
    if (table && !table.showSelectedOnly()) table.toggleShowSelected();
    this.refreshMapSize();
  }

  /** Buffer & Overlay can take the current selection as its input. */
  selectionBuffer(): void {
    this.openPanel('buffer', 'left');
    this.refreshMapSize();
  }

  /** The table's selection menu holds the export formats. */
  selectionExport(): void {
    this.openPanel('attributes', 'bottom');
    // After this click finishes — the table closes its menu on outside clicks.
    setTimeout(() => this.attributeTable()?.selectionMenuOpen.set(true));
    this.refreshMapSize();
  }

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

  // ----- reset -----

  onResetRequest(): void {
    this.notify.confirm({
      header: 'Reset the map?',
      message:
        'Clears every tool result, selection, filter, sketch, drawing and measurement, closes all panels and returns to the initial view. Saved layers and bookmarks are kept.',
      confirmLabel: 'Reset',
      destructive: true,
      accept: () => this.resetWorkspace()
    });
  }

  /** Tool panels are kept mounted to preserve their state, so a reset
   *  unmounts them all (each tidies up after itself) and starts fresh. */
  private resetWorkspace(): void {
    this.onMapClearSelection();
    this.activeQueryFilter.set(null);
    this.tableSelection.set(null);
    this.featureInfoResults.set([]);
    this.highlightLayerId.set(null);
    this.editingLayerId.set(null);
    this.tableEdits.set(null);
    this.reportLayer.set(null);
    this.styleTargetLayer.set(null);
    this.pendingSelect.set(null);
    this.leftTool.set(null);
    this.bottomTool.set(null);
    this.openedLeftTools.set(new Set());
    this.openedBottomTools.set(new Set());
    // Next tick: after the panels' own teardown has run.
    setTimeout(() => {
      this.sketchService.clearAll();
      this.mapService.resetMap();
      if (this.layersDock() === 'right') {
        this.rightOpen.set(true);
      } else {
        this.leftTool.set('layers');
        this.openedLeftTools.set(new Set(['layers']));
      }
      this.refreshMapSize();
    });
  }

  // ----- query builder -----

  onQueryRun(filter: AttributeExternalFilter): void {
    this.activeQueryFilter.set(filter);
    this.mapService.setLayerVisibility(filter.layerId, true);
    this.mapService.setLayerCqlFilter(filter.layerId, filter.cql);
    if (filter.openTable !== false) {
      this.bottomTool.set('attributes');
      // The panel only renders tools in openedBottomTools — without this the
      // first query of a session opened an empty Attribute Table.
      this.rememberOpened(this.openedBottomTools, 'attributes');
      this.refreshMapSize();
    }
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
