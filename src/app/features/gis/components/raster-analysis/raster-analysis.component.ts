import { InsightClass, rasterInsights, resultInsights } from './raster-insights';
import { NotificationService } from '../../../../core/services/notification.service';
import { Component, EventEmitter, Input, OnDestroy, Output, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { Observable, Subscription, retry, switchMap, takeWhile, throwError, timer } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { Department } from '../../../../core/models/department.model';
import { DepartmentService } from '../../../../core/services/department.service';
import { MapService } from '../../services/map.service';
import { GisAiService } from '../../services/gis-ai.service';
import { SettingsService } from '../../../../core/services/settings.service';
import { environment } from '../../../../../environments/environment';
import { Terrain3dComponent, TerrainMesh } from './terrain-3d.component';
import {
  GeoJsonGeometry,
  LayerResult,
  LonLat,
  ProfilePoint,
  RASTER_RAMP_NAMES,
  RasterInfo,
  RasterJob,
  RasterMonitor,
  RasterHistoryEntry,
  RasterStorage,
  RasterWorkflow,
  RasterService,
  RasterStatistics,
  RasterStyleSpec,
  SentinelScene,
  VectorField,
  ZonalResult,
  ZoneRow
} from '../../services/raster.service';

export type RasterToolId =
  | 'upload' | 'online' | 'style' | 'identify' | 'stats' | 'download' | 'mosaic' | 'resample' | 'rasterize'
  | 'profile' | 'slope' | 'aspect' | 'hillshade' | 'contour' | 'rugged' | 'cutfill' | 'fillsinks'
  | 'watershed' | 'flood' | 'los' | 'viewshed'
  | 'calc' | 'reclass' | 'clip' | 'polygonize' | 'zonal' | 'idw' | 'heatmap' | 'proximity'
  | 'suitability' | 'encroach' | 'greencover' | 'monitor' | 'floodrisk' | 'exposure' | 'report'
  | 'extract' | 'leastcost' | 'hotspot' | 'airquality' | 'water' | 'curvature' | 'fillnodata' | 'heights'
  | 'workflows' | 'history' | 'timeslider' | 'storage'
  | 'streams' | 'view3d' | 'swipe' | 'change' | 'changematrix' | 'series' | 'ndvi' | 'indices' | 'heat' | 'classify' | 'supervised';

interface ToolDef {
  id: RasterToolId;
  label: string;
  group: string;
  /** Module Access catalog id (seed-modules.ts, under Raster Analysis 69). */
  moduleId: number;
  icon: string;
  /** Sub-heading inside a large category (Terrain). */
  section?: string;
  /** One line shown under the tool's name. */
  description: string;
}

/** Raster Analysis (69) and its sub-modules, in catalog order. */
export const RASTER_TOOLS: ToolDef[] = [
  { id: 'upload', label: 'Raster Upload & Publish', group: 'Raster Data', section: 'Get Data', moduleId: 911, icon: 'pi pi-upload', description: 'Publish a GeoTIFF (DEM, satellite or drone image) as a map layer.' },
  { id: 'online', label: 'Download from Online Sources', group: 'Raster Data', section: 'Get Data', moduleId: 919, icon: 'pi pi-cloud-download', description: 'Free elevation (Copernicus DEM), land cover (ESA WorldCover) or Sentinel-2 imagery for any area.' },
  { id: 'style', label: 'Raster Styling', group: 'Raster Data', section: 'Inspect & Export', moduleId: 912, icon: 'pi pi-palette', description: 'Colour a raster with a ramp, stretch and opacity.' },
  { id: 'identify', label: 'Pixel Identify', group: 'Raster Data', section: 'Inspect & Export', moduleId: 913, icon: 'pi pi-info-circle', description: 'Click the map to read pixel values from every band.' },
  { id: 'stats', label: 'Statistics & Histogram', group: 'Raster Data', section: 'Inspect & Export', moduleId: 914, icon: 'pi pi-chart-bar', description: 'Value distribution, percentiles and NoData coverage of a band.' },
  { id: 'download', label: 'Download Raster', group: 'Raster Data', section: 'Inspect & Export', moduleId: 918, icon: 'pi pi-download', description: 'Export a raster as GeoTIFF — whole layer or just the current view.' },
  { id: 'fillnodata', label: 'Fill NoData / Smooth', group: 'Raster Data', section: 'Transform', moduleId: 986, icon: 'pi pi-pencil', description: 'Repair gaps in drone, composite or DEM rasters; optional smoothing.' },
  { id: 'mosaic', label: 'Mosaic / Merge', group: 'Raster Data', section: 'Transform', moduleId: 915, icon: 'pi pi-objects-column', description: 'Stitch several raster tiles into one seamless layer.' },
  { id: 'resample', label: 'Resample / Reproject', group: 'Raster Data', section: 'Transform', moduleId: 916, icon: 'pi pi-expand', description: 'Change the pixel size and/or coordinate system.' },
  { id: 'rasterize', label: 'Rasterize Vector', group: 'Raster Data', section: 'Transform', moduleId: 917, icon: 'pi pi-table', description: 'Burn a vector layer (or one of its fields) into a raster grid.' },
  { id: 'profile', label: 'Elevation Profile', group: 'Terrain Analysis', section: 'Surface', moduleId: 921, icon: 'pi pi-chart-line', description: 'Draw a line to plot the elevation profile along it.' },
  { id: 'slope', label: 'Slope', group: 'Terrain Analysis', section: 'Surface', moduleId: 922, icon: 'pi pi-sort-amount-up', description: 'Steepness of the terrain from a DEM, in degrees or percent.' },
  { id: 'aspect', label: 'Aspect', group: 'Terrain Analysis', section: 'Surface', moduleId: 923, icon: 'pi pi-compass', description: 'Direction each slope faces (0–360°).' },
  { id: 'hillshade', label: 'Hillshade', group: 'Terrain Analysis', section: 'Surface', moduleId: 924, icon: 'pi pi-sun', description: 'Shaded relief from a light source for 3D-looking terrain.' },
  { id: 'contour', label: 'Contour Generation', group: 'Terrain Analysis', section: 'Surface', moduleId: 925, icon: 'pi pi-wave-pulse', description: 'Generate contour lines at a fixed elevation interval.' },
  { id: 'curvature', label: 'Curvature', group: 'Terrain Analysis', section: 'Surface', moduleId: 985, icon: 'pi pi-wave-pulse', description: 'Concave (valleys, water collects) vs. convex (ridges) ground.' },
  { id: 'rugged', label: 'Terrain Ruggedness', group: 'Terrain Analysis', section: 'Surface', moduleId: 931, icon: 'pi pi-chart-scatter', description: 'Roughness, Terrain Ruggedness Index (TRI) or Topographic Position (TPI).' },
  { id: 'fillsinks', label: 'Fill Sinks', group: 'Terrain Analysis', section: 'Hydrology & Earthwork', moduleId: 932, icon: 'pi pi-filter-fill', description: 'Remove pits from a DEM so water can drain — run before watershed.' },
  { id: 'streams', label: 'Stream Network', group: 'Terrain Analysis', section: 'Hydrology & Earthwork', moduleId: 933, icon: 'pi pi-share-alt', description: 'Extract drainage lines with Strahler order from a DEM.' },
  { id: 'heights', label: 'Object Heights (DSM − DTM)', group: 'Terrain Analysis', section: 'Visualise', moduleId: 987, icon: 'pi pi-building', description: 'Building / tree heights from a drone or LiDAR surface and ground model.' },
  { id: 'view3d', label: '3D Terrain View', group: 'Terrain Analysis', section: 'Visualise', moduleId: 934, icon: 'pi pi-video', description: 'Rotate a DEM in 3D, draped with imagery or any layer.' },
  { id: 'cutfill', label: 'Cut & Fill / Volume', group: 'Terrain Analysis', section: 'Hydrology & Earthwork', moduleId: 926, icon: 'pi pi-box', description: 'Earthwork volumes to bring an area to a target height.' },
  { id: 'watershed', label: 'Drainage / Watershed', group: 'Terrain Analysis', section: 'Hydrology & Earthwork', moduleId: 927, icon: 'pi pi-share-alt', description: 'Flow paths and catchment area draining to a point.' },
  { id: 'flood', label: 'Flood Inundation', group: 'Terrain Analysis', section: 'Hydrology & Earthwork', moduleId: 928, icon: 'pi pi-cloud', description: 'Area flooded at a given water level.' },
  { id: 'los', label: 'Line of Sight', group: 'Terrain Analysis', section: 'Visibility', moduleId: 929, icon: 'pi pi-eye', description: 'Is the target visible from the observer along a line?' },
  { id: 'viewshed', label: 'Viewshed', group: 'Terrain Analysis', section: 'Visibility', moduleId: 930, icon: 'pi pi-bullseye', description: 'Everything visible from an observer point.' },
  { id: 'calc', label: 'Raster Calculator', group: 'Raster Analytics', section: 'Map Algebra', moduleId: 942, icon: 'pi pi-calculator', description: 'Map algebra across rasters, e.g. (A - B) / (A + B).' },
  { id: 'reclass', label: 'Reclassify', group: 'Raster Analytics', section: 'Map Algebra', moduleId: 943, icon: 'pi pi-sliders-h', description: 'Group pixel values into new classes.' },
  { id: 'clip', label: 'Clip to Boundary', group: 'Raster Analytics', section: 'Map Algebra', moduleId: 944, icon: 'pi pi-stop', description: 'Cut a raster to a drawn or chosen boundary.' },
  { id: 'polygonize', label: 'Raster to Vector', group: 'Raster Analytics', section: 'Map Algebra', moduleId: 945, icon: 'pi pi-th-large', description: 'Convert raster zones into vector polygons.' },
  { id: 'zonal', label: 'Zonal Statistics', group: 'Raster Analytics', section: 'Spatial Statistics', moduleId: 946, icon: 'pi pi-chart-pie', description: 'Min / max / mean / sum of a raster per ward, zone or polygon.' },
  { id: 'idw', label: 'IDW Interpolation', group: 'Raster Analytics', section: 'Spatial Statistics', moduleId: 947, icon: 'pi pi-sitemap', description: 'Continuous surface from point measurements (e.g. levels, readings).' },
  { id: 'heatmap', label: 'Heatmap (Kernel Density)', group: 'Raster Analytics', section: 'Spatial Statistics', moduleId: 948, icon: 'pi pi-map-marker', description: 'Hotspots of point features such as trees, complaints or incidents.' },
  { id: 'proximity', label: 'Proximity / Distance', group: 'Raster Analytics', section: 'Spatial Statistics', moduleId: 949, icon: 'pi pi-arrows-alt', description: 'Distance to the nearest feature — road, hospital, garden…' },
  { id: 'suitability', label: 'Site Suitability', group: 'Decision Support', section: 'Planning', moduleId: 971, icon: 'pi pi-star', description: 'Weighted overlay of criteria (slope, distance, land cover…) → best sites, scored 0–100.' },
  { id: 'floodrisk', label: 'Flood Risk (HAND)', group: 'Decision Support', section: 'Planning', moduleId: 975, icon: 'pi pi-cloud', description: 'Flood-prone land from height above the nearest drainage — no water level needed.' },
  { id: 'exposure', label: 'Population Exposure', group: 'Decision Support', section: 'Planning', moduleId: 976, icon: 'pi pi-users', description: 'How many people live in flood, heat or other hazard areas — per ward.' },
  { id: 'greencover', label: 'Green Cover Report', group: 'Decision Support', section: 'Monitoring', moduleId: 973, icon: 'pi pi-sparkles', description: 'Green cover % per ward from Sentinel-2, with year-on-year change.' },
  { id: 'encroach', label: 'Encroachment Monitor', group: 'Decision Support', section: 'Monitoring', moduleId: 972, icon: 'pi pi-exclamation-triangle', description: 'New construction inside protected zones (green belts, lake buffers, govt. land).' },
  { id: 'monitor', label: 'Automatic Monitoring', group: 'Decision Support', section: 'Monitoring', moduleId: 974, icon: 'pi pi-bell', description: 'Re-run green cover / encroachment checks weekly or monthly and get alerts.' },
  { id: 'report', label: 'Area Report', group: 'Decision Support', section: 'Reports', moduleId: 977, icon: 'pi pi-file-pdf', description: 'One-page printable report of a ward or area: elevation, land cover, NDVI, heat, population…' },
  { id: 'extract', label: 'Extract Values to Points', group: 'Raster Analytics', section: 'Sampling & Routing', moduleId: 980, icon: 'pi pi-map-marker', description: 'Add raster values (elevation, NDVI, heat…) as fields of every point or polygon.' },
  { id: 'leastcost', label: 'Least-cost Path', group: 'Raster Analytics', section: 'Sampling & Routing', moduleId: 981, icon: 'pi pi-directions', description: 'Cheapest route across a cost surface — pipelines, drains, cables.' },
  { id: 'hotspot', label: 'Hotspot Analysis (Gi*)', group: 'Raster Analytics', section: 'Spatial Statistics', moduleId: 982, icon: 'pi pi-bullseye', description: 'Statistically significant hot and cold spots of points (90 / 95 / 99 %).' },
  { id: 'airquality', label: 'Air Quality (NO₂)', group: 'Imagery Analysis', section: 'Environment', moduleId: 983, icon: 'pi pi-cloud', description: 'Tropospheric NO₂ from Sentinel-5P, averaged over a period (~5 km).' },
  { id: 'water', label: 'Water Body Monitor', group: 'Imagery Analysis', section: 'Environment', moduleId: 984, icon: 'pi pi-chart-bar', description: 'Water area of a lake or pond on every clear Sentinel-2 date.' },
  { id: 'workflows', label: 'Saved Workflows', group: 'Workspace', section: 'Automation', moduleId: 991, icon: 'pi pi-sitemap', description: 'Chain tools you ran (e.g. DEM → Fill Sinks → Streams) and re-run them in one click.' },
  { id: 'history', label: 'Job History', group: 'Workspace', section: 'Automation', moduleId: 992, icon: 'pi pi-history', description: 'Every past run with its settings — open the result or run it again.' },
  { id: 'timeslider', label: 'Time Slider', group: 'Workspace', section: 'Viewing', moduleId: 993, icon: 'pi pi-play', description: 'Animate a series of rasters (e.g. NDVI by month, built-up by year).' },
  { id: 'storage', label: 'Storage Manager', group: 'Workspace', section: 'Admin', moduleId: 994, icon: 'pi pi-server', description: 'Disk used by raster results per department; clean temporary files.' },
  { id: 'swipe', label: 'Swipe / Compare', group: 'Imagery Analysis', section: 'Compare', moduleId: 951, icon: 'pi pi-arrows-h', description: 'Slide between two layers to compare them.' },
  { id: 'change', label: 'Change Detection', group: 'Imagery Analysis', section: 'Compare', moduleId: 953, icon: 'pi pi-sync', description: 'Difference between two dates of a continuous raster.' },
  { id: 'changematrix', label: 'Land-cover Change Matrix', group: 'Imagery Analysis', section: 'Compare', moduleId: 959, icon: 'pi pi-table', description: 'From → to areas between two classified rasters (e.g. cropland → built-up).' },
  { id: 'series', label: 'Index Time Series', group: 'Imagery Analysis', section: 'Compare', moduleId: 956, icon: 'pi pi-chart-line', description: 'NDVI / NDWI / NDBI over months for a point or area, from Sentinel-2.' },
  { id: 'ndvi', label: 'NDVI / Vegetation Index', group: 'Imagery Analysis', section: 'Spectral', moduleId: 952, icon: 'pi pi-sparkles', description: 'Vegetation health from red and near-infrared bands.' },
  { id: 'indices', label: 'Spectral Indices', group: 'Imagery Analysis', section: 'Spectral', moduleId: 954, icon: 'pi pi-palette', description: 'NDWI (water), NDBI (built-up) or SAVI (vegetation on bare soil).' },
  { id: 'heat', label: 'Urban Heat Island', group: 'Imagery Analysis', section: 'Spectral', moduleId: 957, icon: 'pi pi-sun', description: 'Land surface temperature (°C) from Landsat 8/9 — find hotspots.' },
  { id: 'classify', label: 'Unsupervised Classification', group: 'Imagery Analysis', section: 'Classification', moduleId: 955, icon: 'pi pi-clone', description: 'K-means land-cover classes from multi-band imagery.' },
  { id: 'supervised', label: 'Supervised Classification', group: 'Imagery Analysis', section: 'Classification', moduleId: 958, icon: 'pi pi-pencil', description: 'Draw examples of each class and classify the image, with accuracy.' }
];
export const RASTER_TOOL_MODULE_IDS = RASTER_TOOLS.map((t) => t.moduleId);

/** Tools that publish a new layer and so need an output name. */
const OUTPUT_TOOLS: RasterToolId[] = [
  'slope', 'aspect', 'hillshade', 'contour', 'rugged', 'fillsinks', 'watershed', 'flood', 'viewshed',
  'calc', 'reclass', 'clip', 'polygonize', 'ndvi', 'change', 'mosaic', 'resample', 'rasterize',
  'idw', 'heatmap', 'proximity', 'indices', 'classify', 'online', 'streams', 'heat', 'supervised', 'changematrix', 'suitability', 'floodrisk', 'extract', 'leastcost', 'hotspot', 'airquality', 'curvature', 'fillnodata', 'heights'
];

/** Tools that may also publish their result (a checkbox). */
const OPTIONAL_OUTPUT: RasterToolId[] = ['encroach', 'greencover', 'exposure'];

/** Tools whose main input is a vector layer instead of a raster. */
const VECTOR_TOOLS: RasterToolId[] = ['rasterize', 'idw', 'heatmap', 'proximity', 'extract', 'hotspot'];
/** Tools that pick their own rasters (no single "input raster" picker). */
const NO_RASTER_INPUT: RasterToolId[] = ['upload', 'online', 'series', 'heat', 'suitability', 'encroach', 'greencover', 'monitor', 'report', 'airquality', 'water', 'workflows', 'history', 'timeslider', 'storage', 'calc', 'swipe', 'mosaic', ...VECTOR_TOOLS];

type Slot = 'a' | 'b' | 'line' | 'polygon' | 'observer' | 'training';

/** Rail icon + short caption per tool category. */
const GROUP_META: Record<string, { short: string; icon: string }> = {
  'Raster Data': { short: 'Data', icon: 'pi pi-database' },
  'Terrain Analysis': { short: 'Terrain', icon: 'pi pi-chart-line' },
  'Raster Analytics': { short: 'Analytics', icon: 'pi pi-calculator' },
  'Imagery Analysis': { short: 'Imagery', icon: 'pi pi-globe' },
  'Decision Support': { short: 'Planning', icon: 'pi pi-briefcase' },
  Workspace: { short: 'Workspace', icon: 'pi pi-cog' }
};

/**
 * Raster Analysis — raster data management, terrain analysis, raster
 * analytics and imagery analysis in one left-dock panel. Processing runs on
 * the backend (GDAL); tools that produce a raster or vector output publish
 * it as a new layer and emit `layerCreated` so the workspace reloads.
 */
@Component({
  selector: 'app-raster-analysis',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet, DatePipe, ButtonModule, SelectModule, MultiSelectModule, Terrain3dComponent],
  templateUrl: './raster-analysis.component.html',
  styleUrls: ['../buffer-overlay/buffer-overlay.component.scss', './raster-analysis.component.scss']
})
export class RasterAnalysisComponent implements OnDestroy {
  private readonly notify = inject(NotificationService);
  private readonly mapService = inject(MapService);
  private readonly api = inject(RasterService);
  private readonly gisAi = inject(GisAiService);
  private readonly departmentService = inject(DepartmentService);
  private readonly settings = inject(SettingsService);

  constructor() {
    // Settings → Units: lengths / areas / volumes in results follow it.
    effect(() => {
      imperial = this.settings.mapUnits() === 'imperial';
    });
  }

  @Input() set layers(value: GisLayer[]) {
    this.layersSignal.set(value ?? []);
    const rasters = this.layersSignal().filter((l) => l.layerType === 'RASTER');
    // A raster this panel just created becomes the input of the next tool;
    // otherwise start with the newest raster so tools are ready to run.
    const pending = this.pendingInputId;
    if (pending && rasters.some((l) => l.id === pending)) {
      this.pendingInputId = null;
      this.selectLayer(pending, true);
    } else if (!this.layerId() && rasters.length) {
      this.selectLayer(rasters.reduce((a, b) => (b.displayOrder > a.displayOrder ? b : a)).id, true);
    } else if (this.layerId() && !rasters.some((l) => l.id === this.layerId())) {
      this.selectLayer(null, true);
    }
  }
  private pendingInputId: string | null = null;
  private readonly layersSignal = signal<GisLayer[]>([]);

  @Input() set allowedModuleIds(value: ReadonlySet<number>) {
    this.allowedSignal.set(value ?? new Set());
    if (!this.tools().some((t) => t.id === this.tool())) {
      const first = this.tools()[0];
      if (first) this.selectTool(first.id);
    }
  }
  private readonly allowedSignal = signal<ReadonlySet<number>>(new Set());

  /** The owner may publish an upload into any department. */
  @Input() set isOwner(value: boolean) {
    this.owner = value;
    if (value && this.departments().length === 0) {
      this.departmentService.list().subscribe({
        next: (list: Department[]) =>
          this.departments.set(list.filter((d) => d.status === 'ACTIVE').map((d) => ({ label: d.name, value: d.id })))
      });
    }
  }
  get isOwner(): boolean {
    return this.owner;
  }
  private owner = false;

  @Input() set active(value: boolean) {
    if (!value && this.picking()) this.cancelPick();
  }

  @Output() layerCreated = new EventEmitter<GisLayer>();

  readonly ramps = RASTER_RAMP_NAMES;
  readonly tools = computed(() => RASTER_TOOLS.filter((t) => this.allowedSignal().has(t.moduleId)));
  readonly toolGroups = computed(() => {
    const groups: { label: string; short: string; icon: string; items: { label: string; value: RasterToolId; icon: string }[] }[] = [];
    for (const t of this.tools()) {
      let group = groups.find((g) => g.label === t.group);
      if (!group) groups.push((group = { label: t.group, ...GROUP_META[t.group], items: [] }));
      group.items.push({ label: t.label, value: t.id, icon: t.icon });
    }
    return groups;
  });
  /** Category picked in the left rail; its tools are listed beside it. */
  readonly activeGroup = signal('Raster Data');
  /** Catalog screen (category's tool cards) vs. the chosen tool's form. */
  readonly showCatalog = signal(true);
  /** The active category's tools, split by sub-heading ('' = none). */
  readonly activeSections = computed(() => {
    const sections: { label: string; items: ToolDef[] }[] = [];
    for (const t of this.tools()) {
      if (t.group !== this.activeToolGroup()?.label) continue;
      const label = t.section ?? '';
      let section = sections.find((x) => x.label === label);
      if (!section) sections.push((section = { label, items: [] }));
      section.items.push(t);
    }
    return sections;
  });
  /** Tool search across every category: each typed word must appear in
   *  the tool's name, description, category or sub-heading. */
  readonly toolSearch = signal('');
  readonly searchSections = computed(() => {
    const words = this.toolSearch().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const sections: { label: string; items: ToolDef[] }[] = [];
    for (const t of this.tools()) {
      const text = `${t.label} ${t.description} ${t.group} ${t.section ?? ''}`.toLowerCase();
      if (!words.every((w) => text.includes(w))) continue;
      let section = sections.find((x) => x.label === t.group);
      if (!section) sections.push((section = { label: t.group, items: [] }));
      section.items.push(t);
    }
    return sections;
  });
  readonly searchCount = computed(() => (this.searchSections() ?? []).reduce((n, s) => n + s.items.length, 0));
  /** What the catalog lists: search results, or the picked category. */
  readonly catalogSections = computed(() => this.searchSections() ?? this.activeSections());
  readonly activeToolDef = computed(() => RASTER_TOOLS.find((t) => t.id === this.tool()) ?? null);
  readonly activeToolGroup = computed(
    () => this.toolGroups().find((g) => g.label === this.activeGroup()) ?? this.toolGroups()[0] ?? null
  );
  readonly tool = signal<RasterToolId>('upload');
  readonly needsOutput = computed(() => OUTPUT_TOOLS.includes(this.tool()));

  readonly rasterLayers = computed(() =>
    this.layersSignal()
      .filter((l) => l.layerType === 'RASTER')
      .map((l) => ({ label: l.name, value: l.id }))
  );
  readonly vectorLayers = computed(() =>
    this.layersSignal()
      .filter((l) => l.layerType === 'VECTOR')
      .map((l) => ({ label: l.name, value: l.id, geometryType: l.geometryType }))
  );
  readonly polygonLayers = computed(() => this.vectorLayers().filter((l) => l.geometryType === 'POLYGON'));
  readonly needsRasterInput = computed(() => !NO_RASTER_INPUT.includes(this.tool()));
  readonly needsVectorInput = computed(() => VECTOR_TOOLS.includes(this.tool()));
  readonly departments = signal<{ label: string; value: string }[]>([]);

  // ----- input raster -----
  readonly layerId = signal<string | null>(null);
  readonly info = signal<RasterInfo | null>(null);
  band = 1;
  outputName = '';
  readonly bandOptions = computed(() =>
    (this.info()?.bands ?? []).map((b) => ({ label: `Band ${b.band}${bandName(b) ? ` · ${bandName(b)}` : ''}`, value: b.band }))
  );

  // ----- map input -----
  readonly pointA = signal<LonLat | null>(null);
  readonly pointB = signal<LonLat | null>(null);
  readonly line = signal<LonLat[] | null>(null);
  readonly polygon = signal<GeoJsonGeometry | null>(null);
  readonly picking = signal<Slot | null>(null);
  readonly selection = this.mapService.selectionGeometries;

  // ----- tool parameters -----
  uploadFile: File | null = null;
  uploadName = '';
  uploadDepartmentId: string | null = null;

  styleMode: 'ramp' | 'rgb' | 'values' = 'ramp';
  styleClasses: { value: number; color: string; label: string }[] = [];
  styleRamp = 'terrain';
  styleMin: number | null = null;
  styleMax: number | null = null;
  styleInvert = false;
  styleOpacity = 1;
  rgbBands: [number, number, number] = [1, 2, 3];
  rgbStretch: 'normalize' | 'histogram' = 'histogram';

  zFactor = 1;
  azimuth = 315;
  altitude = 45;
  slopePercent = false;
  contourInterval = 5;
  baseLevel: number | null = null;
  watershedMode: 'accumulation' | 'watershed' = 'watershed';
  floodLevel: number | null = null;
  floodConnected = true;
  observerHeight = 1.7;
  targetHeight = 0;
  maxDistance: number | null = null;

  calcInputs: { layerId: string | null; band: number }[] = [{ layerId: null, band: 1 }];
  expression = 'A * 1';
  reclassRules: { min: number; max: number; value: number; label: string }[] = [];
  redBand = 3;
  nirBand = 4;
  afterLayerId: string | null = null;
  afterBand = 1;
  changeThreshold = 0;

  // raster data
  mosaicIds: (string | null)[] = [null, null];
  resampling: 'nearest' | 'bilinear' | 'cubic' | 'average' | 'mode' = 'bilinear';
  resamplePixel: number | null = null;
  resampleCrs: 'same' | 'UTM' | 'EPSG:4326' | 'EPSG:3857' | 'custom' = 'same';
  resampleEpsg = '';
  downloadView = false;
  histogramBins = 32;

  // vector input (rasterize, zonal, idw, heatmap, proximity)
  readonly vectorLayerId = signal<string | null>(null);
  readonly vectorFields = signal<VectorField[]>([]);
  readonly numericFields = computed(() => this.vectorFields().filter((f) => f.numeric).map((f) => ({ label: f.name, value: f.name })));
  readonly allFields = computed(() => this.vectorFields().map((f) => ({ label: f.name, value: f.name })));
  field: string | null = null;
  gridPixel = 10;
  allTouched = false;
  idwPower = 2;
  heatRadius = 500;
  proximityMax = 2000;
  zonalPublish = false;
  /** Clip to Boundary: a polygon layer (default) or a drawn / selected shape. */
  clipSource: 'layer' | 'draw' = 'layer';
  boundaryValue = '';

  // online data
  onlineSource: 'dem' | 'landcover' | 'sentinel2' | 'population' | 'water' = 'dem';
  aoiMode: 'view' | 'draw' | 'layer' | 'point' = 'view';
  aoiLayerId: string | null = null;
  readonly extentLayers = computed(() =>
    this.layersSignal()
      .filter((l) => l.bbox)
      .map((l) => ({ label: l.name, value: l.id }))
  );
  s2From = isoDate(-90);
  s2To = isoDate(0);
  s2Cloud = 20;
  maskClouds = true;
  readonly scenes = signal<SentinelScene[] | null>(null);
  readonly sceneId = signal<string | null>(null);
  readonly searching = signal(false);
  /** Scene whose map preview is loading. */
  readonly previewing = signal<string | null>(null);
  private previewUrl: string | null = null;
  private previewSub?: Subscription;

  // v2: composite, series, heat, supervised, change matrix, streams, observers
  s2Mode: 'scene' | 'composite' = 'scene';
  compositeScenes = 8;
  seriesKind: 'ndvi' | 'ndwi' | 'ndbi' = 'ndvi';
  seriesFrom = isoDate(-365);
  seriesTo = isoDate(0);
  heatFrom = isoDate(-365);
  heatTo = isoDate(0);
  heatCloud = 30;
  readonly series = signal<{ date: string; mean: number; min: number; max: number }[] | null>(null);
  readonly transitions = signal<{ fromLabel: string; toLabel: string; areaM2: number }[] | null>(null);
  supervisedMethod: 'maxlike' | 'mindist' = 'maxlike';
  readonly training = signal<{ label: string; color: string; polygons: number[][][][] }[]>([
    { label: 'Water', color: '#2b83ba', polygons: [] },
    { label: 'Vegetation', color: '#1a9641', polygons: [] },
    { label: 'Built-up', color: '#d7191c', polygons: [] },
    { label: 'Bare soil', color: '#c49a6c', polygons: [] }
  ]);
  /** Class whose training area is being drawn. */
  trainingIndex = 0;
  streamThreshold = 1;
  readonly observers = signal<LonLat[]>([]);

  // ----- Decision Support -----
  readonly optionalOutput = computed(() => OPTIONAL_OUTPUT.includes(this.tool()));
  publishResult = false;
  /** Zones (polygon layer) shared by green cover, encroachment, exposure,
   *  monitoring and reports: label field + optional feature filter. */
  zoneLabelField: string | null = null;
  zoneFilterField: string | null = null;
  zoneFilterValue = '';
  criteria: { layerId: string | null; direction: 'higher' | 'lower'; weight: number }[] = [
    { layerId: null, direction: 'lower', weight: 50 },
    { layerId: null, direction: 'higher', weight: 50 }
  ];
  excludeLayerIds: string[] = [];
  encBeforeFrom = `${new Date().getFullYear() - 1}-01-01`;
  encBeforeTo = `${new Date().getFullYear() - 1}-03-31`;
  encAfterFrom = `${new Date().getFullYear()}-01-01`;
  encAfterTo = `${new Date().getFullYear()}-03-31`;
  encMinArea = 300;
  encSensitivity: 'low' | 'medium' | 'high' = 'medium';
  gcFrom = isoDate(-60);
  gcTo = isoDate(0);
  gcCompare = true;
  gcThreshold = 0.3;
  floodThreshold = 1;
  floodClasses: [number, number, number] = [1, 3, 6];
  populationLayerId: string | null = null;
  hazardOperator: '>' | '>=' | '<' | '<=' | '==' | 'between' = '<=';
  hazardThreshold = 1;
  hazardThreshold2: number | null = null;
  exposureByZone = true;
  reportArea: 'layer' | 'draw' = 'layer';
  reportRasterIds = new Set<string>();
  readonly monitors = signal<RasterMonitor[]>([]);
  monitorName = '';
  monitorKind: 'green-cover' | 'encroachment' = 'green-cover';
  monitorFrequency: 'weekly' | 'monthly' = 'monthly';
  monitorDropPct = 2;
  readonly monitorAlerts = computed(() => this.monitors().filter((m) => m.alert).length);
  /** Generic results table (zones, sites, exposure) — `coords` makes a row
   *  clickable to zoom the map to it. */
  readonly table = signal<{ title: string; headers: string[]; rows: string[][]; coords?: [number, number][] } | null>(null);

  // ----- v4 -----
  extractRasterIds = new Set<string>();
  costInvert = false;
  costBase = 1;
  hotCell = 200;
  hotDistance = 1000;
  aqFrom = isoDate(-30);
  aqTo = isoDate(0);
  aqOrbits = 20;
  multiDirectional = false;
  fillDistance = 50;
  smoothPasses = 0;
  dtmLayerId: string | null = null;
  minHeight = 2;
  stockpile = false;
  readonly rgbPresets = computed(() => {
    const bands = this.info()?.bands ?? [];
    const find = (re: RegExp) => bands.find((b) => re.test(bandName(b)))?.band;
    const [bl, g, r, nir, swir] = [find(/\bblue\b/i), find(/\bgreen\b/i), find(/\bred\b/i), find(/\bnir\b|near.?infra/i), find(/\bswir\b/i)];
    const all: { label: string; bands: (number | undefined)[]; hint: string }[] = [
      { label: 'True colour', bands: [r, g, bl], hint: 'As the eye sees it.' },
      { label: 'False colour (vegetation)', bands: [nir, r, g], hint: 'Healthy vegetation is bright red.' },
      { label: 'Urban', bands: [swir, nir, r], hint: 'Built-up purple / grey, vegetation green.' },
      { label: 'Agriculture', bands: [nir, swir, bl], hint: 'Crops bright green, bare soil brown.' },
      { label: 'Land / water', bands: [nir, swir, r], hint: 'Water dark blue, land orange / green.' }
    ];
    return all.filter((p) => p.bands.every((b) => b !== undefined)) as { label: string; bands: [number, number, number]; hint: string }[];
  });
  // workspace
  readonly workflows = signal<RasterWorkflow[]>([]);
  /** Layer-producing runs of this session — building blocks for a workflow. */
  readonly recorded = signal<{ tool: string; body: Record<string, unknown>; label: string; outputId?: string; inputId?: string }[]>([]);
  readonly pickedSteps = signal<Set<number>>(new Set());
  workflowName = '';
  workflowInputId: string | null = null;
  readonly history = signal<RasterHistoryEntry[]>([]);
  readonly storageInfo = signal<RasterStorage | null>(null);
  readonly sliderIds = signal<string[]>([]);
  readonly sliderIndex = signal(0);
  readonly playing = signal(false);
  private playTimer: ReturnType<typeof setInterval> | null = null;
  readonly pinnedLabels = signal<Set<string>>(new Set());

  // terrain / imagery extras
  ruggedKind: 'roughness' | 'TRI' | 'TPI' = 'TRI';
  indexKind: 'ndwi' | 'ndbi' | 'savi' = 'ndwi';
  indexA = 2;
  indexB = 4;
  soilFactor = 0.5;
  classCount = 6;

  // usability: output department, reclass breaks, calculator, compare, 3D
  outputDepartmentId: string | null = null;
  breakMethod: 'equal' | 'quantile' | 'jenks' = 'jenks';
  breakCount = 5;
  readonly recipes = CALC_RECIPES;
  recipeHint = '';
  private readonly expressionSignal = signal('A * 1');
  readonly expressionError = computed(() => checkExpression(this.expressionSignal(), this.calcCount()));
  private readonly calcCount = signal(1);
  compareMode: 'swipe' | 'spyglass' = 'swipe';
  spyRadius = 120;
  readonly hoverX = signal<number | null>(null);
  readonly hoverReadout = signal<string | null>(null);
  readonly drapeLayers = computed(() => this.layersSignal().map((l) => ({ label: l.name, value: l.id })));
  drapeLayerId: string | null = null;
  meshSize = 140;
  readonly mesh = signal<TerrainMesh | null>(null);
  readonly drapeUrl = signal<string | null>(null);
  readonly meshTitle = signal('3D terrain');

  readonly swipeLayerId = signal<string | null>(null);
  swipeFraction = 50;

  // ----- results -----
  readonly running = signal(false);
  /** Upload: 0–100 while the file is sent, then null while it is processed. */
  readonly uploadProgress = signal<number | null>(null);
  /** The background job of the current run (layer-producing tools). */
  readonly job = signal<RasterJob | null>(null);
  private jobSub?: Subscription;
  readonly error = signal<string | null>(null);
  readonly message = signal<string | null>(null);
  readonly facts = signal<{ label: string; value: string }[]>([]);
  /** "Explain" — the local AI model's plain-language reading of the facts
   *  (and the zone / site table) of the current result. */
  readonly explanation = signal<string | null>(null);
  readonly explaining = signal(false);
  private explainSub?: Subscription;
  readonly profile = signal<ProfilePoint[] | null>(null);
  readonly statistics = signal<RasterStatistics | null>(null);
  /** Tool-specific reading of a new raster result (see raster-insights.ts). */
  readonly insightHeading = signal<string | null>(null);
  readonly insightClasses = signal<InsightClass[] | null>(null);
  readonly insightsLoading = signal(false);

  /** Results view: opens by itself when an analysis finishes, so the
   *  numbers, charts and AI report get the whole panel; "Settings" goes back. */
  readonly showResults = signal(false);
  /** Utility tools keep their result inline under the form. */
  private static readonly INLINE_RESULT_TOOLS = new Set([
    'style', 'download', 'monitor', 'swipe', 'workflows', 'history', 'timeslider', 'storage'
  ]);

  hasResultView(): boolean {
    return !RasterAnalysisComponent.INLINE_RESULT_TOOLS.has(this.tool());
  }

  private hasAnyResult(): boolean {
    return !!(
      this.message() || this.facts().length || this.statistics() || this.table() || this.zoneRows() ||
      this.series() || this.transitions() || this.profile() || this.insightClasses()
    );
  }

  private readonly resultViewEffect = (() => {
    let wasRunning = false;
    return effect(() => {
      const running = this.running();
      untracked(() => {
        if (wasRunning && !running && !this.error() && this.hasResultView() && this.hasAnyResult()) {
          this.showResults.set(true);
          // Raster outputs explain once their statistics arrive (loadInsights).
          if (!this.insightsLoading()) setTimeout(() => this.autoExplain());
        }
        wasRunning = running;
      });
    });
  })();
  readonly zoneRows = signal<ZoneRow[] | null>(null);

  private pickSub?: Subscription;

  ngOnDestroy(): void {
    this.pickSub?.unsubscribe();
    this.mapService.cancelDraw();
    this.mapService.setSwipe(null);
    this.mapService.setSpyglass(null);
    this.mapService.setHoverMarker(null);
    this.clearPreview();
    this.jobSub?.unsubscribe();
    this.stopSlider();
  }

  // ----- selection of tool / raster -----

  /** Rail click: shows that category's tool catalog. */
  selectGroup(label: string): void {
    this.activeGroup.set(label);
    this.showCatalog.set(true);
  }

  /** Card click in the catalog: switch to that tool's form. */
  openTool(id: RasterToolId): void {
    this.showResults.set(false);
    if (id !== this.tool()) this.selectTool(id);
    this.showCatalog.set(false);
  }

  selectTool(id: RasterToolId): void {
    if (this.tool() === 'swipe' && id !== 'swipe') {
      this.mapService.setSwipe(null);
      this.mapService.setSpyglass(null);
    }
    if (this.picking()) this.cancelPick();
    if (this.aoiMode === 'point' && id !== 'series') this.aoiMode = 'view';
    this.tool.set(id);
    const group = RASTER_TOOLS.find((t) => t.id === id)?.group;
    if (group) this.activeGroup.set(group);
    this.resetResult();
    this.clearInputs();
    this.clearPreview();
    this.zonalPublish = false;
    this.publishResult = false;
    if (id === 'monitor') this.loadMonitors();
    if (id === 'workflows') this.api.workflows().subscribe({ next: (w) => this.workflows.set(w), error: (e: HttpErrorResponse) => this.fail(e) });
    if (id === 'history') this.loadHistory();
    if (id === 'storage') this.loadStorage();
    if (id !== 'timeslider') this.stopSlider();
    if (id === 'water') this.seriesKind = 'ndwi';
    this.suggestOutputName();
  }

  /** `keepResult`: an automatic selection must not wipe the message of
   *  the run that just finished. */
  selectLayer(id: string | null, keepResult = false): void {
    this.layerId.set(id);
    this.info.set(null);
    this.band = 1;
    if (!keepResult) this.resetResult();
    if (this.calcInputs.length === 1 && !this.calcInputs[0].layerId) this.calcInputs[0].layerId = id;
    this.suggestOutputName();
    if (!id) return;
    this.api.info(id).subscribe({
      next: (info) => {
        // A late answer for the previously picked raster would set the
        // wrong band count / index bands for this one.
        if (this.layerId() !== id) return;
        this.info.set(info);
        this.applyInfoDefaults(info);
      },
      error: (err: HttpErrorResponse) => this.layerId() === id && this.fail(err)
    });
  }

  selectVector(id: string | null): void {
    this.vectorLayerId.set(id);
    this.vectorFields.set([]);
    this.field = null;
    this.resetResult();
    this.suggestOutputName();
    if (!id) return;
    this.api.vectorFields(id).subscribe({
      next: (fields) => this.vectorLayerId() === id && this.vectorFields.set(fields),
      error: (err: HttpErrorResponse) => this.vectorLayerId() === id && this.fail(err)
    });
  }

  /** Sensible band defaults per index for 4+ band imagery (B, G, R, NIR…). */
  setIndexKind(kind: 'ndwi' | 'ndbi' | 'savi'): void {
    this.indexKind = kind;
    const info = this.info();
    const count = info?.bandCount ?? 4;
    const named = (re: RegExp) => info?.bands.find((b) => re.test(bandName(b)))?.band;
    this.indexB = named(/\bnir\b|near.?infra/i) ?? Math.min(4, count);
    this.indexA =
      kind === 'ndwi'
        ? (named(/\bgreen\b/i) ?? Math.min(2, count))
        : kind === 'ndbi'
          ? (named(/\bswir\b/i) ?? Math.min(5, count))
          : (named(/\bred\b/i) ?? Math.min(3, count));
    this.suggestOutputName();
  }

  private applyInfoDefaults(info: RasterInfo): void {
    const b = info.bands[0];
    const min = b?.min ?? 0;
    const max = b?.max ?? 1;
    const current = info.styleSpec;
    this.styleClasses = (current?.classes ?? []).map((c) => ({ value: c.value, color: c.color, label: c.label ?? String(c.value) }));
    this.styleMode = current?.mode === 'values' ? 'values' : info.bandCount >= 3 ? 'rgb' : 'ramp';
    this.styleMin = round(min);
    this.styleMax = round(max);
    this.floodLevel = round(min + (max - min) * 0.1);
    this.contourInterval = niceInterval((max - min) / 20);
    const step = (max - min) / 3 || 1;
    this.reclassRules = [0, 1, 2].map((i) => ({
      min: round(min + step * i),
      max: round(i === 2 ? max + Math.abs(max) * 1e-6 + 1e-9 : min + step * (i + 1)),
      value: i + 1,
      label: ['Low', 'Medium', 'High'][i]
    }));
    this.classCount = Math.min(Math.max(this.classCount, 2), 12);
    if (info.bandCount >= 4) {
      this.redBand = 3;
      this.nirBand = 4;
    } else {
      this.redBand = 1;
      this.nirBand = Math.min(2, info.bandCount);
    }
    // Named bands (e.g. downloaded Sentinel-2) win over positional guesses.
    const named = (re: RegExp) => info.bands.find((b) => re.test(bandName(b)))?.band;
    this.redBand = named(/\bred\b|\bB0?4\b/i) ?? this.redBand;
    this.nirBand = named(/\bnir\b|near.?infra|\bB0?8\b/i) ?? this.nirBand;
    const r = named(/\bred\b/i), g = named(/\bgreen\b/i), bl = named(/\bblue\b/i);
    this.rgbBands = r && g && bl ? [r, g, bl] : info.bandCount >= 3 ? [1, 2, 3] : [1, 1, 1];
    this.setIndexKind(this.indexKind);
  }

  private suggestOutputName(): void {
    if (this.tool() === 'heat') {
      this.outputName = `Land surface temperature ${this.heatFrom.slice(0, 7)} – ${this.heatTo.slice(0, 7)}`;
      return;
    }
    if (this.tool() === 'online') {
      this.outputName = { dem: 'Elevation (Copernicus DEM)', landcover: 'Land cover (ESA WorldCover)', sentinel2: 'Sentinel-2 image', population: 'Population (Meta HRSL)', water: 'Surface water occurrence (JRC)' }[
        this.onlineSource
      ];
      return;
    }
    const sourceId = VECTOR_TOOLS.includes(this.tool()) ? this.vectorLayerId() : this.layerId();
    const layer = this.layersSignal().find((l) => l.id === sourceId);
    const label = RASTER_TOOLS.find((t) => t.id === this.tool())?.label.split(' /')[0] ?? '';
    this.outputName = layer ? `${layer.name} ${label}`.slice(0, 80) : label;
  }

  // ----- map picking -----

  pick(slot: Slot): void {
    this.picking.set(slot);
    this.error.set(null);
    this.pickSub?.unsubscribe();
    const kind = slot === 'line' ? 'Line' : slot === 'polygon' || slot === 'training' ? 'Polygon' : 'Point';
    this.pickSub = this.mapService.beginDraw(kind).subscribe({
      next: (geometry) => {
        const coords = geometry['coordinates'] as unknown;
        if (slot === 'a') this.pointA.set((coords as number[]).slice(0, 2) as LonLat);
        else if (slot === 'b') this.pointB.set((coords as number[]).slice(0, 2) as LonLat);
        else if (slot === 'line') this.line.set((coords as number[][]).map((c) => [c[0], c[1]] as LonLat));
        else if (slot === 'observer') {
          this.observers.update((list) => [...list, (coords as number[]).slice(0, 2) as LonLat]);
          this.showObservers();
        } else if (slot === 'training') {
          const i = this.trainingIndex;
          this.training.update((list) =>
            list.map((c, k) => (k === i ? { ...c, polygons: [...c.polygons, coords as number[][][]] } : c))
          );
          this.showTraining();
        }
        else if (slot === 'polygon') this.polygon.set(geometry);
        this.picking.set(null);
        if (slot === 'a' && this.tool() === 'identify') {
          this.runIdentify();
          // Stay in identify mode: every further map click reads a pixel.
          setTimeout(() => {
            if (this.tool() === 'identify' && !this.picking()) this.pick('a');
          });
        }
      },
      complete: () => this.picking.set(null)
    });
  }

  cancelPick(): void {
    this.mapService.cancelDraw();
    this.picking.set(null);
  }

  usePolygonSelection(): void {
    const polygons: unknown[] = [];
    for (const g of this.mapService.selectionGeometries()) {
      if (g['type'] === 'Polygon') polygons.push(g['coordinates']);
      else if (g['type'] === 'MultiPolygon') polygons.push(...(g['coordinates'] as unknown[]));
    }
    if (polygons.length === 0) {
      this.error.set('Select one or more polygon features on the map first.');
      return;
    }
    this.polygon.set({ type: 'MultiPolygon', coordinates: polygons });
    this.error.set(null);
  }

  pointLabel(p: LonLat | null): string {
    return p ? `${p[1].toFixed(5)}, ${p[0].toFixed(5)}` : 'not set';
  }

  onFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;
    this.uploadFile = file;
    if (file && !this.uploadName) this.uploadName = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  }

  // ----- list editors -----

  addCalcInput(): void {
    if (this.calcInputs.length < 6) this.calcInputs = [...this.calcInputs, { layerId: null, band: 1 }];
    this.calcCount.set(this.calcInputs.length);
  }

  removeCalcInput(index: number): void {
    this.calcInputs = this.calcInputs.filter((_, i) => i !== index);
    this.calcCount.set(this.calcInputs.length);
  }

  calcLetter(index: number): string {
    return 'ABCDEF'[index];
  }

  setOnlineSource(source: 'dem' | 'landcover' | 'sentinel2' | 'population' | 'water'): void {
    this.onlineSource = source;
    this.resetResult();
    this.suggestOutputName();
  }

  /** The area of interest as an EPSG:4326 bbox (+ exact polygon when drawn). */
  private aoi(): { bbox: [number, number, number, number]; polygon?: GeoJsonGeometry } | null {
    if (this.aoiMode === 'view') {
      const bbox = this.mapService.getViewExtent4326();
      return bbox ? { bbox } : null;
    }
    if (this.aoiMode === 'layer') {
      const b = this.layersSignal().find((l) => l.id === this.aoiLayerId)?.bbox;
      return b ? { bbox: [b.minX, b.minY, b.maxX, b.maxY] } : null;
    }
    if (this.aoiMode === 'point') {
      const p = this.pointA();
      // ~30 m around the clicked point (3 × 3 Sentinel-2 pixels).
      return p ? { bbox: [p[0] - 0.00015, p[1] - 0.00015, p[0] + 0.00015, p[1] + 0.00015] } : null;
    }
    const polygon = this.polygon();
    return polygon ? { bbox: geometryBbox(polygon), polygon } : null;
  }

  searchScenes(): void {
    const aoi = this.aoi();
    if (!aoi) return this.error.set(this.aoiHint());
    this.resetResult();
    this.scenes.set(null);
    this.sceneId.set(null);
    this.clearPreview();
    this.mapService.clearAnalysisGeometry();
    this.searching.set(true);
    this.api.sentinelSearch({ bbox: aoi.bbox, from: this.s2From, to: this.s2To, maxCloud: this.s2Cloud }).subscribe({
      next: (r) => {
        this.searching.set(false);
        this.scenes.set(r.scenes);
        if (r.scenes.length) this.pickScene(r.scenes[0]);
        else this.message.set('No scenes match — widen the dates or allow more cloud.');
      },
      error: (err: HttpErrorResponse) => {
        this.searching.set(false);
        this.fail(err);
      }
    });
  }

  /** Selecting a scene previews it on the map: its footprint outline and
   *  a true-colour quick-look over the chosen area. */
  pickScene(scene: SentinelScene): void {
    this.sceneId.set(scene.id);
    this.outputName = `Sentinel-2 ${scene.datetime?.slice(0, 10) ?? scene.id}`;
    const aoi = this.aoi();
    this.mapService.setAnalysisGeometry(scene.footprint);
    if (!aoi) return;
    if (this.aoiMode !== 'view') this.mapService.zoomToExtent4326(aoi.bbox);
    this.previewSub?.unsubscribe();
    this.previewing.set(scene.id);
    this.previewSub = this.api.sentinelPreview(scene.id, aoi.bbox).subscribe({
      next: (blob) => {
        if (this.sceneId() !== scene.id) return;
        this.previewing.set(null);
        this.revokePreview();
        this.previewUrl = URL.createObjectURL(blob);
        this.mapService.setPreviewImage(this.previewUrl, aoi.bbox);
      },
      error: (err: HttpErrorResponse) => {
        this.previewing.set(null);
        this.fail(err);
      }
    });
  }

  private clearPreview(): void {
    this.previewSub?.unsubscribe();
    this.previewing.set(null);
    this.mapService.clearPreviewImage();
    this.revokePreview();
  }

  private revokePreview(): void {
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = null;
  }

  private aoiHint(): string {
    if (this.aoiMode === 'point') return 'Pick the point on the map first.';
    return this.aoiMode === 'draw'
      ? 'Draw the area (or use selected polygons) first.'
      : this.aoiMode === 'layer'
        ? 'Choose a layer whose extent to use.'
        : 'The map view is not ready yet.';
  }

  // ----- training areas / observers -----

  drawTraining(index: number): void {
    this.trainingIndex = index;
    this.pick('training');
  }

  addTrainingClass(): void {
    if (this.training().length >= 12) return;
    const colors = ['#984ea3', '#ff7f00', '#a65628', '#f781bf', '#66c2a5', '#999999', '#4575b4', '#fee08b'];
    this.training.update((list) => [...list, { label: `Class ${list.length + 1}`, color: colors[list.length % colors.length], polygons: [] }]);
  }

  removeTrainingClass(index: number): void {
    this.training.update((list) => list.filter((_, i) => i !== index));
    this.showTraining();
  }

  clearTraining(index: number): void {
    this.training.update((list) => list.map((c, i) => (i === index ? { ...c, polygons: [] } : c)));
    this.showTraining();
  }

  renameTraining(index: number, label: string): void {
    this.training.update((list) => list.map((c, i) => (i === index ? { ...c, label } : c)));
  }

  private showTraining(): void {
    this.mapService.setAnalysisColoredGeometries(
      this.training()
        .filter((c) => c.polygons.length)
        .map((c) => ({ geometry: { type: 'MultiPolygon', coordinates: c.polygons }, color: c.color }))
    );
  }

  removeObserver(index: number): void {
    this.observers.update((list) => list.filter((_, i) => i !== index));
    this.showObservers();
  }

  private showObservers(): void {
    const list = this.observers();
    if (list.length) this.mapService.setAnalysisGeometry({ type: 'MultiPoint', coordinates: list });
    else this.mapService.clearAnalysisGeometry();
  }

  // ----- Decision Support -----

  /** Zones payload shared by the zone-based tools. */
  private zonesBody(): Record<string, unknown> {
    return {
      zonesLayerId: this.vectorLayerId(),
      labelField: this.zoneLabelField || undefined,
      filterField: this.zoneFilterField || undefined,
      filterValue: this.zoneFilterField ? this.zoneFilterValue.trim() : undefined
    };
  }

  addCriterion(): void {
    if (this.criteria.length < 8) this.criteria = [...this.criteria, { layerId: null, direction: 'higher', weight: 25 }];
  }

  removeCriterion(index: number): void {
    this.criteria = this.criteria.filter((_, i) => i !== index);
  }

  weightPct(weight: number): string {
    const total = this.criteria.reduce((a, c) => a + (c.weight || 0), 0) || 1;
    return `${Math.round(((weight || 0) * 100) / total)} %`;
  }

  toggleReportRaster(id: string, on: boolean): void {
    const next = new Set(this.reportRasterIds);
    if (on) next.add(id);
    else next.delete(id);
    this.reportRasterIds = next;
  }

  zoomToRow(index: number): void {
    const c = this.table()?.coords?.[index];
    if (!c) return;
    const d = 0.004;
    this.mapService.zoomToExtent4326([c[0] - d, c[1] - d, c[0] + d, c[1] + d]);
    this.mapService.setHoverMarker(c);
  }

  exportTable(): void {
    const t = this.table();
    if (t) downloadCsv(`${this.tool()}_${t.title.toLowerCase().replace(/\W+/g, '_')}.csv`, [t.headers, ...t.rows]);
  }

  loadMonitors(): void {
    this.api.monitors().subscribe({ next: (list) => this.monitors.set(list), error: (err: HttpErrorResponse) => this.fail(err) });
  }

  createMonitor(): void {
    if (!this.monitorName.trim()) return this.error.set('Give the monitor a name.');
    if (!this.vectorLayerId()) return this.error.set('Choose the zones (polygon) layer to watch.');
    const params: Record<string, unknown> = { ...this.zonesBody() };
    if (this.monitorKind === 'green-cover') {
      params['threshold'] = this.gcThreshold;
      params['alertDropPct'] = this.monitorDropPct;
    } else {
      params['minAreaM2'] = this.encMinArea;
      params['sensitivity'] = this.encSensitivity;
    }
    this.execute(
      this.api.createMonitor({ name: this.monitorName.trim(), kind: this.monitorKind, frequency: this.monitorFrequency, params }),
      (m) => {
        this.monitors.update((list) => [m, ...list]);
        this.message.set(`"${m.name}" created — its first run starts within 10 minutes.`);
        this.monitorName = '';
      }
    );
  }

  monitorAction(m: RasterMonitor, action: 'run' | 'pause' | 'resume' | 'ack' | 'delete', confirmed = false): void {
    if (action === 'delete' && !confirmed) {
      this.notify.confirmDelete({
        header: 'Delete monitor',
        message: `Delete the monitor "${m.name}"? Its schedule and alerts stop. This cannot be undone.`,
        accept: () => this.monitorAction(m, 'delete', true)
      });
      return;
    }
    const request =
      action === 'run'
        ? this.api.runMonitor(m.id)
        : action === 'ack'
          ? this.api.acknowledgeMonitor(m.id)
          : action === 'delete'
            ? this.api.deleteMonitor(m.id)
            : this.api.setMonitorActive(m.id, action === 'resume');
    (request as Observable<RasterMonitor | void>).subscribe({
      next: (updated) =>
        this.monitors.update((list) =>
          action === 'delete' ? list.filter((x) => x.id !== m.id) : list.map((x) => (x.id === m.id ? (updated as RasterMonitor) : x))
        ),
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  /** Opens a printable one-page report (browser "Save as PDF"). */
  private printReport(r: AreaReport): void {
    const layers = this.layersSignal();
    const [minX, minY, maxX, maxY] = r.bbox;
    const pad = Math.max(maxX - minX, maxY - minY) * 0.06;
    const bb = [minX - pad, minY - pad, maxX + pad, maxY + pad];
    const W = 520;
    const H = Math.round((W * (bb[3] - bb[1])) / ((bb[2] - bb[0]) * Math.cos(((minY + maxY) / 2) * (Math.PI / 180))));
    const outline = svgOutline(r.geometry, bb, W, H);
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const sections = r.sections
      .map((sec) => {
        const layer = layers.find((l) => l.id === sec.layerId);
        const img = layer
          ? `${environment.geoserverUrl}/${layer.geoserverWorkspace}/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${encodeURIComponent(
              `${layer.geoserverWorkspace}:${layer.geoserverLayer}`
            )}&STYLES=&SRS=EPSG:4326&BBOX=${bb.join(',')}&WIDTH=${W}&HEIGHT=${H}&FORMAT=image/png&TRANSPARENT=true`
          : '';
        const body = sec.empty
          ? '<p class="muted">No data inside the area.</p>'
          : sec.classes
            ? `<table><tr><th>Class</th><th>Area</th><th>Share</th></tr>${sec.classes
                .map((c) => `<tr><td>${esc(c.label)}</td><td>${formatArea(c.areaM2)}</td><td>${c.pct.toFixed(1)} %</td></tr>`)
                .join('')}</table>`
            : `<table><tr><th>Min</th><th>Mean</th><th>Median</th><th>Max</th></tr><tr><td>${fmt(sec.min)}</td><td>${fmt(sec.mean)}</td><td>${fmt(
                sec.median
              )}</td><td>${fmt(sec.max)}</td></tr></table>${/popul/i.test(sec.name) ? `<p>Total: <b>${fmtInt(sec.sum ?? 0)}</b> people</p>` : ''}`;
        return `<section><h2>${esc(sec.name)}</h2><div class="map"><img src="${img}" alt="">${outline}</div>${body}</section>`;
      })
      .join('');
    const title = this.reportTitle();
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
      body{font:13px/1.45 system-ui,sans-serif;color:#1f2937;margin:28px}h1{font-size:20px;margin:0 0 4px}
      h2{font-size:14px;margin:0 0 6px}.muted{color:#6b7280}.facts{display:flex;gap:24px;margin:10px 0 18px}
      .facts b{display:block;font-size:16px}section{break-inside:avoid;margin-bottom:22px}
      .map{position:relative;width:${W}px;height:${H}px;border:1px solid #d1d5db;background:#f3f4f6;margin-bottom:6px}
      .map img,.map svg{position:absolute;inset:0;width:100%;height:100%}
      table{border-collapse:collapse;min-width:${W}px}td,th{border-bottom:1px solid #e5e7eb;padding:4px 8px;text-align:left}
      th{font-size:11px;text-transform:uppercase;color:#6b7280}@media print{button{display:none}}
    </style></head><body>
      <button onclick="print()" style="float:right">Print / Save as PDF</button>
      <h1>${esc(title)}</h1><p class="muted">Raster Analysis area report · ${new Date().toLocaleDateString()}</p>
      <div class="facts"><div>Area<b>${formatArea(r.areaM2)}</b></div><div>Perimeter<b>${formatLength(r.perimeterM)}</b></div></div>
      ${sections}</body></html>`;
    const win = window.open('', '_blank');
    if (!win) return this.error.set('Allow pop-ups for this site to open the report.');
    win.document.write(html);
    win.document.close();
  }

  private reportTitle(): string {
    const layer = this.layersSignal().find((l) => l.id === this.vectorLayerId());
    if (this.reportArea === 'layer' && layer) {
      return this.zoneFilterField ? `${layer.name} — ${this.zoneFilterField} ${this.zoneFilterValue}` : layer.name;
    }
    return 'Drawn area';
  }

  // ----- v4 helpers -----

  toggleExtract(id: string, on: boolean): void {
    const next = new Set(this.extractRasterIds);
    if (on) next.add(id);
    else next.delete(id);
    this.extractRasterIds = next;
  }

  applyPreset(bands: [number, number, number]): void {
    this.rgbBands = [...bands];
    this.rgbStretch = 'histogram';
  }

  /** Share: copy a link that opens the map on this layer. */
  shareLayer(layerId: string | null | undefined, kind: 'link' | 'image' = 'link'): void {
    const layer = this.layersSignal().find((l) => l.id === layerId);
    if (!layer) return;
    let text = `${location.origin}/gis?layer=${layer.id}`;
    if (kind === 'image' && layer.bbox) {
      const { minX, minY, maxX, maxY } = layer.bbox;
      const w = 1200;
      const h = Math.max(1, Math.round((w * (maxY - minY)) / ((maxX - minX) * Math.cos(((minY + maxY) / 2) * (Math.PI / 180)))));
      text =
        `${environment.geoserverUrl}/${layer.geoserverWorkspace}/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap` +
        `&LAYERS=${encodeURIComponent(`${layer.geoserverWorkspace}:${layer.geoserverLayer}`)}&STYLES=&SRS=EPSG:4326` +
        `&BBOX=${minX},${minY},${maxX},${maxY}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png&TRANSPARENT=true`;
    }
    navigator.clipboard?.writeText(text).then(
      () => this.message.set(kind === 'link' ? `Link to "${layer.name}" copied — it opens the map on this layer (sign-in required).` : 'Image URL copied (PNG of the whole layer).'),
      () => this.message.set(text)
    );
  }

  /** Dashboard Pins: show this result number on the Dashboard. */
  pinFact(f: { label: string; value: string }): void {
    const toolLabel = RASTER_TOOLS.find((t) => t.id === this.tool())?.label ?? 'Raster Analysis';
    const layer = this.layersSignal().find((l) => l.id === this.layerId() || l.id === this.vectorLayerId());
    this.api
      .createPin({ title: `${toolLabel} · ${f.label}`.slice(0, 120), value: f.value.slice(0, 80), detail: layer ? `${layer.name} · ${new Date().toLocaleDateString()}` : new Date().toLocaleDateString(), layerId: layer?.id })
      .subscribe({
        next: () => {
          this.pinnedLabels.update((s) => new Set(s).add(f.label));
          this.message.set(`Pinned "${f.label}" to the Dashboard.`);
        },
        error: (e: HttpErrorResponse) => this.fail(e)
      });
  }

  // workflows
  togglePick(i: number): void {
    this.pickedSteps.update((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  }

  saveWorkflow(): void {
    const picked = [...this.pickedSteps()].sort((a, b) => a - b).map((i) => this.recorded()[i]);
    if (!picked.length) return this.error.set('Tick the steps to include.');
    if (!this.workflowName.trim()) return this.error.set('Name the workflow.');
    const outputs = new Set<string>();
    const firstInput = picked[0].inputId;
    const steps = picked.map((st) => {
      const body = { ...st.body };
      const input = body['layerId'] as string | undefined;
      if (input && outputs.has(input)) body['layerId'] = '$prev';
      else if (input && input === firstInput) body['layerId'] = '$input';
      if (st.outputId) outputs.add(st.outputId);
      if (typeof body['outputName'] === 'string') body['outputName'] = `${this.workflowName.trim()} · ${String(body['outputName'])}`.slice(0, 80);
      return { tool: st.tool, body };
    });
    this.execute(this.api.createWorkflow(this.workflowName.trim(), steps), (wf) => {
      this.workflows.update((list) => [wf, ...list]);
      this.pickedSteps.set(new Set());
      this.workflowName = '';
      this.message.set(`Workflow "${wf.name}" saved with ${wf.steps.length} step${wf.steps.length === 1 ? '' : 's'}.`);
    });
  }

  workflowNeedsInput(wf: RasterWorkflow): boolean {
    return JSON.stringify(wf.steps).includes('$input');
  }

  runWorkflow(wf: RasterWorkflow): void {
    if (this.workflowNeedsInput(wf) && !this.workflowInputId) return this.error.set('Choose the input raster.');
    this.resetResult();
    this.running.set(true);
    this.jobSub?.unsubscribe();
    this.jobSub = this.api
      .runWorkflow(wf.id, this.workflowInputId)
      .pipe(
        switchMap((started) => {
          this.job.set(started);
          return timer(1500, 1500).pipe(
            switchMap(() => this.api.job<LayerResult>(started.id)),
            takeWhile((j) => j.status === 'queued' || j.status === 'running', true)
          );
        })
      )
      .subscribe({
        next: (j) => {
          this.job.set(j);
          if (j.status === 'queued' || j.status === 'running') return;
          this.running.set(false);
          this.job.set(null);
          if (j.status !== 'done') return void this.error.set(j.error ?? 'Cancelled.');
          const steps = ((j.result?.result as { steps?: { step: number; tool: string; layerName?: string }[] })?.steps ?? []);
          this.facts.set(steps.map((st) => ({ label: `Step ${st.step}: ${st.tool}`, value: st.layerName ?? 'done' })));
          if (j.result?.layer) {
            this.layerCreated.emit(j.result.layer);
            this.message.set(`Workflow finished — "${j.result.layer.name}" added to the map.`);
          }
        },
        error: (err: HttpErrorResponse) => this.fail(err)
      });
  }

  deleteWorkflow(wf: RasterWorkflow): void {
    this.notify.confirmDelete({
      header: 'Delete workflow',
      message: `Delete the saved workflow "${wf.name}"? This cannot be undone.`,
      accept: () =>
        this.api.deleteWorkflow(wf.id).subscribe({
          next: () => this.workflows.update((list) => list.filter((w) => w.id !== wf.id)),
          error: (e: HttpErrorResponse) => this.fail(e)
        })
    });
  }

  // history
  loadHistory(): void {
    this.api.history().subscribe({ next: (h) => this.history.set(h), error: (e: HttpErrorResponse) => this.fail(e) });
  }

  rerun(entry: RasterHistoryEntry): void {
    if (entry.tool.startsWith('workflow')) return this.error.set('Re-run workflows from Saved Workflows.');
    this.resetResult();
    this.runJob<LayerResult>(entry.tool, entry.body, (r) => {
      if (r?.layer) {
        this.layerCreated.emit(r.layer);
        this.message.set(`Re-run finished — "${r.layer.name}" added to the map.`);
      } else {
        this.message.set('Re-run finished.');
      }
      this.loadHistory();
    });
  }

  showLayer(id: string | null): void {
    const layer = this.layersSignal().find((l) => l.id === id);
    if (!layer) return this.error.set('That layer no longer exists.');
    this.mapService.setLayerVisibility(layer.id, true);
    this.mapService.zoomToLayer(layer);
  }

  // storage
  loadStorage(): void {
    this.api.storage().subscribe({ next: (s) => this.storageInfo.set(s), error: (e: HttpErrorResponse) => this.fail(e) });
  }

  cleanStorage(): void {
    this.execute(this.api.cleanupStorage(), (r) => {
      this.message.set(`Removed ${r.removed} file${r.removed === 1 ? '' : 's'}, freed ${bytes(r.freedBytes)}.`);
      this.loadStorage();
    });
  }

  bytes(n: number): string {
    return bytes(n);
  }

  // time slider
  toggleSlider(id: string, on: boolean): void {
    this.sliderIds.update((list) => (on ? [...list, id] : list.filter((x) => x !== id)));
    this.sliderIndex.set(0);
    this.showFrame();
  }

  setFrame(i: number): void {
    this.sliderIndex.set(Math.min(Math.max(i, 0), Math.max(this.sliderIds().length - 1, 0)));
    this.showFrame();
  }

  togglePlay(): void {
    if (this.playing()) return this.stopSlider();
    if (this.sliderIds().length < 2) return this.error.set('Tick at least two rasters.');
    this.playing.set(true);
    this.playTimer = setInterval(() => this.setFrame((this.sliderIndex() + 1) % this.sliderIds().length), 1500);
  }

  private stopSlider(): void {
    if (this.playTimer) clearInterval(this.playTimer);
    this.playTimer = null;
    this.playing.set(false);
  }

  /** Only the current frame is visible. */
  private showFrame(): void {
    const ids = this.sliderIds();
    ids.forEach((id, i) => this.mapService.setLayerVisibility(id, i === this.sliderIndex()));
  }

  layerName(id: string): string {
    return this.layersSignal().find((l) => l.id === id)?.name ?? '—';
  }

  addMosaicInput(): void {
    if (this.mosaicIds.length < 20) this.mosaicIds = [...this.mosaicIds, null];
  }

  removeMosaicInput(index: number): void {
    this.mosaicIds = this.mosaicIds.filter((_, i) => i !== index);
  }

  addRule(): void {
    const last = this.reclassRules[this.reclassRules.length - 1];
    this.reclassRules = [
      ...this.reclassRules,
      { min: last?.max ?? 0, max: (last?.max ?? 0) + 10, value: (last?.value ?? 0) + 1, label: '' }
    ];
  }

  removeRule(index: number): void {
    this.reclassRules = this.reclassRules.filter((_, i) => i !== index);
  }

  onSwipe(): void {
    const id = this.swipeLayerId();
    if (id) this.mapService.setLayerVisibility(id, true);
    if (this.compareMode === 'swipe') {
      this.mapService.setSpyglass(null);
      this.mapService.setSwipe(id, this.swipeFraction / 100);
    } else {
      this.mapService.setSwipe(null);
      this.mapService.setSpyglass(id, this.spyRadius);
    }
  }

  setCompareMode(mode: 'swipe' | 'spyglass'): void {
    this.compareMode = mode;
    this.onSwipe();
  }

  // ----- calculator -----

  setExpression(value: string): void {
    this.expression = value;
    this.expressionSignal.set(value);
  }

  useRecipe(expression: string): void {
    const recipe = CALC_RECIPES.find((r) => r.expression === expression);
    if (!recipe) return;
    const needed = recipe.inputs;
    while (this.calcInputs.length < needed) this.calcInputs = [...this.calcInputs, { layerId: this.layerId(), band: 1 }];
    this.calcCount.set(this.calcInputs.length);
    this.recipeHint = recipe.hint;
    this.setExpression(expression);
  }

  // ----- reclassify: automatic classes -----

  /** Builds `breakCount` ranges from the band's histogram by equal
   *  interval, quantile or Jenks natural breaks. */
  autoClasses(): void {
    const layerId = this.layerId();
    if (!layerId) return this.error.set('Choose a raster layer first.');
    const k = Math.min(Math.max(Math.round(this.breakCount) || 5, 2), 10);
    this.execute(this.api.statistics({ layerId, band: this.band, bins: 100 }), (r) => {
      const breaks = classBreaks(this.breakMethod, k, r.histogram.counts, r.histogram.edges);
      const names = k === 3 ? ['Low', 'Medium', 'High'] : k === 5 ? ['Very low', 'Low', 'Medium', 'High', 'Very high'] : [];
      this.reclassRules = breaks.slice(0, -1).map((lo, i) => ({
        min: round(lo),
        max: round(i === k - 1 ? breaks[i + 1] + Math.abs(breaks[i + 1]) * 1e-6 + 1e-9 : breaks[i + 1]),
        value: i + 1,
        label: names[i] ?? `Class ${i + 1}`
      }));
      this.message.set(`${k} classes by ${this.breakMethod === 'jenks' ? 'natural breaks' : this.breakMethod === 'quantile' ? 'quantile' : 'equal interval'}.`);
    });
  }

  // ----- styling: classes -----

  addStyleClass(): void {
    const last = this.styleClasses[this.styleClasses.length - 1];
    this.styleClasses = [...this.styleClasses, { value: (last?.value ?? 0) + 1, color: '#999999', label: '' }];
  }

  removeStyleClass(index: number): void {
    this.styleClasses = this.styleClasses.filter((_, i) => i !== index);
  }

  /** Fills the class list from the distinct whole values of the band. */
  detectClasses(): void {
    const layerId = this.layerId();
    if (!layerId) return this.error.set('Choose a raster layer first.');
    this.execute(this.api.statistics({ layerId, band: this.band, bins: 100 }), (r) => {
      const values = new Set<number>();
      r.histogram.counts.forEach((c, i) => {
        if (!c) return;
        for (let v = Math.ceil(r.histogram.edges[i]); v <= Math.floor(r.histogram.edges[i + 1]); v++) values.add(v);
      });
      if (values.size === 0 || values.size > 60) {
        this.error.set('This band does not look like classes (too many distinct values) — reclassify it first.');
        return;
      }
      const known = new Map(this.styleClasses.map((c) => [c.value, c]));
      const palette = ['#1a9850', '#fee08b', '#d73027', '#4575b4', '#984ea3', '#ff7f00', '#a65628', '#f781bf', '#66c2a5', '#999999'];
      this.styleClasses = [...values].sort((a, b) => a - b).map((v, i) => known.get(v) ?? { value: v, color: palette[i % palette.length], label: String(v) });
    });
  }

  // ----- profile chart hover -----

  onProfileHover(event: MouseEvent, svg: Element): void {
    const points = this.profile();
    const c = this.chart();
    if (!points || !c) return;
    const rect = svg.getBoundingClientRect();
    const fx = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    const total = points[points.length - 1].d || 1;
    let best = points[0];
    for (const p of points) if (Math.abs(p.d / total - fx) < Math.abs(best.d / total - fx)) best = p;
    this.hoverX.set((best.d / total) * c.w);
    this.hoverReadout.set(`${formatLength(best.d)} · ${best.z === null ? 'NoData' : fmt(best.z)}${best.visible === false ? ' · hidden' : ''}`);
    this.mapService.setHoverMarker([best.lon, best.lat]);
  }

  onProfileLeave(): void {
    this.hoverX.set(null);
    this.hoverReadout.set(null);
    this.mapService.setHoverMarker(null);
  }

  // ----- export -----

  explainResult(): void {
    if (this.explaining() || this.facts().length === 0) return;
    const title = RASTER_TOOLS.find((t) => t.id === this.tool())?.label ?? this.tool();
    const table = this.table();
    const classes = this.insightClasses();
    const rows: Record<string, unknown>[] | undefined = classes
      ? classes.map((c) => ({ class: c.label, share: `${c.pct.toFixed(1)} %`, area: formatArea(c.areaM2) }))
      : table
      ? table.rows.slice(0, 25).map((r) => Object.fromEntries(table.headers.map((h, i) => [h, r[i]])))
      : (this.zoneRows() as unknown as Record<string, unknown>[] | null)?.slice(0, 25) ??
        this.transitions()?.slice(0, 25).map((t) => ({ from: t.fromLabel, to: t.toLabel, area: formatArea(t.areaM2) }));
    this.explaining.set(true);
    this.explanation.set(null);
    this.explainSub = this.gisAi.explain(title, this.facts(), rows).subscribe({
      next: ({ text }) => {
        this.explaining.set(false);
        this.explanation.set(
          text ?? 'The AI model could not explain this result reliably — the numbers above are the result.'
        );
        this.saveReport();
      },
      error: (err: HttpErrorResponse) => {
        this.explaining.set(false);
        this.explanation.set(err.error?.message ?? 'The AI assistant is unavailable right now.');
      }
    });
  }

  exportFacts(): void {
    downloadCsv(`${this.tool()}_results.csv`, [['Measure', 'Value'], ...this.facts().map((f) => [f.label, f.value])]);
  }

  exportProfile(): void {
    const pts = this.profile() ?? [];
    downloadCsv(`${this.tool()}_profile.csv`, [
      ['distance_m', 'elevation', 'longitude', 'latitude', 'visible'],
      ...pts.map((p) => [p.d.toFixed(1), p.z ?? '', p.lon, p.lat, p.visible === undefined ? '' : p.visible ? 'yes' : 'no'])
    ]);
  }

  exportHistogram(): void {
    const s = this.statistics();
    if (!s) return;
    downloadCsv('histogram.csv', [
      ['from', 'to', 'pixels'],
      ...s.histogram.counts.map((c, i) => [s.histogram.edges[i], s.histogram.edges[i + 1], c])
    ]);
  }

  exportSeries(): void {
    downloadCsv(`${this.seriesKind}_time_series.csv`, [
      ['date', 'mean', 'p10', 'p90'],
      ...(this.series() ?? []).map((p) => [p.date, p.mean, p.min, p.max])
    ]);
  }

  exportZones(): void {
    downloadCsv('zonal_statistics.csv', [
      ['zone', 'pixels', 'mean', 'min', 'max', 'sum', 'area_m2'],
      ...(this.zoneRows() ?? []).map((r) => [r.zone, r.count, r.mean ?? '', r.min ?? '', r.max ?? '', r.sum ?? '', r.areaM2])
    ]);
  }

  exportTransitions(): void {
    downloadCsv('change_matrix.csv', [
      ['from', 'to', 'area_m2'],
      ...(this.transitions() ?? []).map((t) => [t.fromLabel, t.toLabel, t.areaM2])
    ]);
  }

  /** SVG chart → PNG (white background, 2× resolution). */
  exportChart(svg: Element): void {
    const rect = svg.getBoundingClientRect();
    const clone = svg.cloneNode(true) as Element;
    clone.setAttribute('width', String(rect.width));
    clone.setAttribute('height', String(rect.height));
    clone.setAttribute('color', getComputedStyle(svg).color);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = rect.width * 2;
      canvas.height = rect.height * 2;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `${this.tool()}_chart.png`;
      a.click();
    };
    img.src = url;
  }

  // ----- 3D view -----

  private open3d(layerId: string): void {
    const layer = this.layersSignal().find((l) => l.id === layerId);
    this.execute(this.api.mesh(layerId, this.band, this.meshSize), (m) => {
      const drape = this.layersSignal().find((l) => l.id === this.drapeLayerId);
      const [minX, minY, maxX, maxY] = m.bbox;
      this.drapeUrl.set(
        drape
          ? `${environment.geoserverUrl}/${drape.geoserverWorkspace}/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap` +
              `&LAYERS=${encodeURIComponent(`${drape.geoserverWorkspace}:${drape.geoserverLayer}`)}&STYLES=&SRS=EPSG:4326` +
              `&BBOX=${minX},${minY},${maxX},${maxY}&WIDTH=${m.width * 3}&HEIGHT=${m.height * 3}&FORMAT=image/png&TRANSPARENT=true`
          : null
      );
      this.meshTitle.set(`${layer?.name ?? 'DEM'}${drape ? ' · ' + drape.name : ''}`);
      this.mesh.set(m);
    });
  }

  // ----- run -----

  run(): void {
    const tool = this.tool();
    const layerId = this.layerId();
    this.resetResult();

    if (tool === 'upload') return this.runUpload();
    if (tool === 'swipe') return this.onSwipe();
    if (this.needsRasterInput() && !layerId) return this.error.set('Choose a raster layer first.');
    if (this.needsVectorInput() && !this.vectorLayerId()) return this.error.set('Choose a vector layer first.');
    if (this.needsOutput() && !this.outputName.trim()) return this.error.set('Enter a name for the new layer.');
    const base = { layerId, band: this.band, outputName: this.outputName.trim() };

    switch (tool) {
      case 'style':
        return this.runStyle(layerId!);
      case 'identify':
        return this.pointA() ? this.runIdentify() : this.pick('a');
      case 'profile': {
        const line = this.line();
        if (!line) return this.error.set('Draw the profile line on the map.');
        this.execute(this.api.profile({ layerId: layerId!, band: this.band, line }), (r) => {
          this.profile.set(r.points);
          this.mapService.setAnalysisGeometry({ type: 'LineString', coordinates: line });
          this.facts.set([
            { label: 'Length', value: formatLength(r.lengthM) },
            { label: 'Min / Max', value: `${fmt(r.min)} / ${fmt(r.max)}` },
            { label: 'Total climb', value: fmt(r.gain) },
            { label: 'Total descent', value: fmt(r.loss) }
          ]);
        });
        return;
      }
      case 'slope':
      case 'aspect':
      case 'hillshade':
        return this.runLayerTool('terrain', {
          ...base,
          kind: tool === 'hillshade' && this.multiDirectional ? 'multihillshade' : tool,
          zFactor: this.zFactor,
          azimuth: this.azimuth,
          altitude: this.altitude,
          percent: this.slopePercent
        });
      case 'contour':
        if (!(this.contourInterval > 0)) return this.error.set('Enter a contour interval greater than zero.');
        return this.runLayerTool('contour', { ...base, interval: this.contourInterval });
      case 'cutfill': {
        const polygon = this.polygon();
        if (!polygon) return this.error.set('Draw the area (or use selected polygons) first.');
        this.execute(
          this.api.cutFill({ layerId, band: this.band, polygon, baseLevel: this.stockpile ? undefined : (this.baseLevel ?? undefined), baseFromBoundary: this.stockpile }),
          (r) => {
            this.mapService.setAnalysisGeometry(polygon);
            this.facts.set([
              { label: 'Design level', value: fmt(r.baseLevel) },
              { label: 'Area', value: formatArea(r.areaM2) },
              { label: 'Cut volume', value: formatVolume(r.cutM3) },
              { label: 'Fill volume', value: formatVolume(r.fillM3) },
              { label: 'Net (cut − fill)', value: formatVolume(r.netM3) },
              { label: 'Ground min / mean / max', value: `${fmt(r.minZ)} / ${fmt(r.meanZ)} / ${fmt(r.maxZ)}` }
            ]);
          }
        );
        return;
      }
      case 'watershed':
        if (this.watershedMode === 'watershed' && !this.pointA()) return this.error.set('Pick the pour point (outlet) on the map.');
        return this.runLayerTool('watershed', { ...base, mode: this.watershedMode, point: this.pointA() ?? undefined });
      case 'flood':
        if (this.floodLevel === null) return this.error.set('Enter the water level.');
        if (this.floodConnected && !this.pointA()) return this.error.set('Pick a point in the flooded area, or untick "connected".');
        return this.runLayerTool('flood', {
          ...base,
          level: this.floodLevel,
          seed: this.floodConnected ? this.pointA() : undefined
        });
      case 'los': {
        const from = this.pointA();
        const to = this.pointB();
        if (!from || !to) return this.error.set('Pick the observer and the target on the map.');
        this.execute(
          this.api.lineOfSight({
            layerId,
            band: this.band,
            from,
            to,
            observerHeight: this.observerHeight,
            targetHeight: this.targetHeight
          }),
          (r) => {
            this.mapService.setAnalysisColoredGeometries([
              { geometry: r.visible, color: '#1a9641' },
              { geometry: r.hidden, color: '#d7191c' },
              { geometry: { type: 'MultiPoint', coordinates: [from, to] }, color: '#6b4fa8' }
            ]);
            this.profile.set(r.points);
            this.message.set(r.targetVisible ? 'The target IS visible from the observer.' : 'The target is NOT visible — the terrain blocks the view.');
            this.facts.set([{ label: 'Distance', value: formatLength(r.lengthM) }]);
          }
        );
        return;
      }
      case 'viewshed':
        if (this.observers().length > 1) {
          return this.runLayerTool('viewshed', {
            ...base,
            point: this.observers()[0],
            points: this.observers(),
            observerHeight: this.observerHeight,
            targetHeight: this.targetHeight,
            maxDistance: this.maxDistance || undefined
          });
        }
        if (!this.pointA() && this.observers().length === 1) this.pointA.set(this.observers()[0]);
        if (!this.pointA()) return this.error.set('Pick the observer point on the map.');
        return this.runLayerTool('viewshed', {
          ...base,
          point: this.pointA(),
          observerHeight: this.observerHeight,
          targetHeight: this.targetHeight,
          maxDistance: this.maxDistance || undefined
        });
      case 'calc': {
        const inputs = this.calcInputs.filter((i) => i.layerId);
        if (inputs.length !== this.calcInputs.length || inputs.length === 0) return this.error.set('Choose a raster for every input.');
        const problem = checkExpression(this.expression, inputs.length);
        if (problem) return this.error.set(problem);
        if (!this.outputName.trim()) return this.error.set('Enter a name for the new layer.');
        return this.runLayerTool('calculator', { inputs, expression: this.expression, outputName: this.outputName.trim() });
      }
      case 'reclass':
        if (this.reclassRules.length === 0) return this.error.set('Add at least one range.');
        return this.runLayerTool('reclassify', { ...base, rules: this.reclassRules });
      case 'clip':
        if (this.clipSource === 'layer') {
          if (!this.vectorLayerId()) return this.error.set('Choose the boundary (polygon) layer.');
          if (this.field && !this.boundaryValue.trim()) return this.error.set(`Enter the ${this.field} value to clip to, or clear the filter.`);
          return this.runLayerTool('clip', {
            layerId,
            boundaryLayerId: this.vectorLayerId(),
            boundaryField: this.field || undefined,
            boundaryValue: this.field ? this.boundaryValue.trim() : undefined,
            outputName: base.outputName
          });
        }
        if (!this.polygon()) return this.error.set('Draw the boundary (or use selected polygons) first.');
        return this.runLayerTool('clip', { layerId, polygon: this.polygon(), outputName: base.outputName });
      case 'polygonize':
        return this.runLayerTool('polygonize', base);
      case 'ndvi':
        return this.runLayerTool('ndvi', { layerId, redBand: this.redBand, nirBand: this.nirBand, outputName: base.outputName });
      case 'online': {
        const aoi = this.aoi();
        if (!aoi) return this.error.set(this.aoiHint());
        if (this.onlineSource === 'sentinel2' && this.s2Mode === 'scene' && !this.sceneId()) return this.error.set('Search and pick a Sentinel-2 scene first.');
        if (!this.outputName.trim()) return this.error.set('Enter a name for the new layer.');
        if (this.onlineSource === 'sentinel2' && this.s2Mode === 'composite') {
          return this.runLayerTool('online', {
            source: 'composite',
            ...aoi,
            from: this.s2From,
            to: this.s2To,
            maxCloud: Math.max(this.s2Cloud, 40),
            maxScenes: this.compositeScenes,
            outputName: this.outputName.trim()
          });
        }
        return this.runLayerTool('online', {
          source: this.onlineSource,
          ...aoi,
          sceneId: this.onlineSource === 'sentinel2' ? this.sceneId() : undefined,
          maskClouds: this.onlineSource === 'sentinel2' ? this.maskClouds : undefined,
          outputName: this.outputName.trim()
        });
      }
      case 'streams':
        if (!(this.streamThreshold > 0)) return this.error.set('Enter a catchment threshold greater than zero.');
        return this.runLayerTool('streams', { ...base, thresholdKm2: this.streamThreshold });
      case 'series': {
        const aoi = this.aoi();
        if (!aoi) return this.error.set(this.aoiHint());
        this.runJob<{ series: { date: string; mean: number; min: number; max: number }[]; first: number; last: number; change: number; observations: number }>(
          'index-series',
          { kind: this.seriesKind, ...aoi, from: this.seriesFrom, to: this.seriesTo },
          (r) => {
            this.series.set(r.series);
            this.facts.set([
              { label: 'Clear observations', value: fmtInt(r.observations) },
              { label: `First → last ${this.seriesKind.toUpperCase()}`, value: `${fmt(r.first)} → ${fmt(r.last)}` },
              { label: 'Change', value: `${r.change >= 0 ? '+' : ''}${fmt(r.change)}` }
            ]);
          }
        );
        return;
      }
      case 'heat': {
        const aoi = this.aoi();
        if (!aoi) return this.error.set(this.aoiHint());
        if (!this.outputName.trim()) return this.error.set('Enter a name for the new layer.');
        return this.runLayerTool('heat-island', {
          ...aoi,
          from: this.heatFrom,
          to: this.heatTo,
          maxCloud: this.heatCloud,
          outputName: this.outputName.trim()
        });
      }
      case 'supervised': {
        const classes = this.training().filter((c) => c.polygons.length);
        if (classes.length < 2) return this.error.set('Draw training areas for at least two classes.');
        return this.runLayerTool('supervised-classify', {
          layerId,
          outputName: base.outputName,
          method: this.supervisedMethod,
          classes: classes.map((c) => ({ label: c.label.trim() || 'Class', color: c.color, geometry: { type: 'MultiPolygon', coordinates: c.polygons } }))
        });
      }
      case 'changematrix':
        if (!this.afterLayerId) return this.error.set('Choose the "after" raster.');
        if (this.afterLayerId === layerId) return this.error.set('Choose two different rasters.');
        return this.runLayerTool('change-matrix', { beforeLayerId: layerId, afterLayerId: this.afterLayerId, outputName: base.outputName });
      case 'suitability': {
        const criteria = this.criteria.filter((c) => c.layerId);
        if (criteria.length < 2) return this.error.set('Choose at least two criteria rasters.');
        if (!this.outputName.trim()) return this.error.set('Enter a name for the new layer.');
        return this.runLayerTool('suitability', {
          criteria: criteria.map((c) => ({ layerId: c.layerId, direction: c.direction, weight: c.weight || 0 })),
          excludeLayerIds: this.excludeLayerIds.length ? this.excludeLayerIds : undefined,
          outputName: this.outputName.trim()
        });
      }
      case 'floodrisk':
        return this.runLayerTool('flood-risk', { ...base, thresholdKm2: this.floodThreshold, classes: this.floodClasses });
      case 'encroach':
      case 'greencover':
      case 'exposure':
      case 'report':
        return this.runDecision(tool);
      case 'monitor':
        return this.loadMonitors();
      case 'extract':
        if (this.extractRasterIds.size === 0) return this.error.set('Tick at least one raster to sample.');
        return this.runLayerTool('extract-values', { vectorLayerId: this.vectorLayerId(), rasterLayerIds: [...this.extractRasterIds], outputName: base.outputName });
      case 'leastcost': {
        const from = this.pointA();
        const to = this.pointB();
        if (!from || !to) return this.error.set('Pick the start and end points on the map.');
        return this.runLayerTool('least-cost', { ...base, from, to, invert: this.costInvert, baseCost: this.costBase });
      }
      case 'hotspot':
        return this.runLayerTool('hotspot', {
          vectorLayerId: this.vectorLayerId(),
          weightField: this.field || undefined,
          cellSize: this.hotCell,
          distance: this.hotDistance,
          outputName: base.outputName
        });
      case 'airquality': {
        const aoi = this.aoi();
        if (!aoi) return this.error.set(this.aoiHint());
        if (!this.outputName.trim()) return this.error.set('Enter a name for the new layer.');
        return this.runLayerTool('air-quality', { bbox: aoi.bbox, from: this.aqFrom, to: this.aqTo, maxOrbits: this.aqOrbits, outputName: this.outputName.trim() });
      }
      case 'water': {
        const aoi = this.aoi();
        if (!aoi) return this.error.set(this.aoiHint());
        this.runJob<{ series: { date: string; waterM2?: number }[]; observations: number }>(
          'index-series',
          { kind: 'ndwi', ...aoi, from: this.seriesFrom, to: this.seriesTo },
          (r) => {
            const pts = r.series.map((p) => ({ date: p.date, mean: (p.waterM2 ?? 0) / 1e4, min: (p.waterM2 ?? 0) / 1e4, max: (p.waterM2 ?? 0) / 1e4 }));
            this.series.set(pts);
            const first = pts[0]?.mean ?? 0;
            const last = pts[pts.length - 1]?.mean ?? 0;
            const peak = Math.max(...pts.map((p) => p.mean));
            this.facts.set([
              { label: 'Clear observations', value: fmtInt(r.observations) },
              { label: 'Water area first → last', value: `${first.toFixed(2)} → ${last.toFixed(2)} ha` },
              { label: 'Largest extent', value: `${peak.toFixed(2)} ha` },
              { label: 'Change', value: `${last - first >= 0 ? '+' : ''}${(last - first).toFixed(2)} ha (${first ? (((last - first) / first) * 100).toFixed(0) : '—'} %)` }
            ]);
          }
        );
        return;
      }
      case 'curvature':
        return this.runLayerTool('terrain', { ...base, kind: 'curvature' });
      case 'fillnodata':
        return this.runLayerTool('fill-nodata', { ...base, maxDistance: this.fillDistance, smoothPasses: this.smoothPasses });
      case 'heights':
        if (!this.dtmLayerId) return this.error.set('Choose the ground model (DTM).');
        return this.runLayerTool('object-heights', { dsmLayerId: layerId, dtmLayerId: this.dtmLayerId, minHeight: this.minHeight, outputName: base.outputName });
      case 'workflows':
      case 'history':
      case 'storage':
      case 'timeslider':
        return;
      case 'view3d':
        return this.open3d(layerId!);
      case 'stats':
        this.execute(this.api.statistics({ layerId: layerId!, band: this.band, bins: this.histogramBins }), (r) => {
          this.statistics.set(r);
          this.facts.set([
            { label: 'Min / Max', value: `${fmt(r.min)} / ${fmt(r.max)}` },
            { label: 'Mean ± std', value: `${fmt(r.mean)} ± ${fmt(r.std)}` },
            { label: 'Median (P25 – P75)', value: `${fmt(r.median)} (${fmt(r.p25)} – ${fmt(r.p75)})` },
            { label: 'P1 / P99', value: `${fmt(r.p1)} / ${fmt(r.p99)}` },
            { label: 'Valid pixels', value: `${fmtInt(r.validCells)} (${formatArea(r.areaM2)})` },
            { label: 'NoData pixels', value: fmtInt(r.nodataCells) }
          ]);
        });
        return;
      case 'download':
        return this.runDownload(layerId!);
      case 'mosaic': {
        const layerIds = this.mosaicIds.filter((id): id is string => !!id);
        if (new Set(layerIds).size < 2) return this.error.set('Choose at least two different rasters.');
        if (!this.outputName.trim()) return this.error.set('Enter a name for the new layer.');
        return this.runLayerTool('mosaic', { layerIds, resampling: this.resampling, outputName: this.outputName.trim() });
      }
      case 'resample': {
        const targetCrs = this.resampleCrs === 'custom' ? `EPSG:${this.resampleEpsg.replace(/\D/g, '')}` : this.resampleCrs;
        if (this.resampleCrs === 'custom' && !/^EPSG:\d{4,6}$/.test(targetCrs)) return this.error.set('Enter a valid EPSG code.');
        if (!this.resamplePixel && targetCrs === 'same') return this.error.set('Set a new pixel size and/or a different coordinate system.');
        return this.runLayerTool('resample', {
          layerId,
          outputName: base.outputName,
          pixelSize: this.resamplePixel || undefined,
          targetCrs,
          resampling: this.resampling
        });
      }
      case 'rasterize':
        return this.runLayerTool('rasterize', {
          vectorLayerId: this.vectorLayerId(),
          field: this.field || undefined,
          pixelSize: this.gridPixel,
          allTouched: this.allTouched,
          outputName: base.outputName
        });
      case 'rugged':
        return this.runLayerTool('terrain', { ...base, kind: this.ruggedKind });
      case 'fillsinks':
        return this.runLayerTool('fill-sinks', base);
      case 'zonal': {
        const zones = this.vectorLayerId();
        if (!zones) return this.error.set('Choose the zones (polygon) layer.');
        if (this.zonalPublish && !this.outputName.trim()) return this.error.set('Enter a name for the new layer.');
        this.runJob<{ layer?: GisLayer; result: ZonalResult }>(
          'zonal-statistics',
          {
            layerId,
            band: this.band,
            zonesLayerId: zones,
            labelField: this.field || undefined,
            allTouched: this.allTouched,
            outputName: this.zonalPublish ? this.outputName.trim() : undefined
          },
          (r) => {
            this.zoneRows.set(r.result.rows);
            this.facts.set([
              { label: 'Zones', value: fmtInt(r.result.zones) },
              { label: 'Zones with data', value: fmtInt(r.result.zonesWithData) }
            ]);
            if (r.result.truncated) this.message.set(`Showing the first ${r.result.rows.length} zones.`);
            if (r.layer) {
              this.message.set(`New layer "${r.layer.name}" added — style it by z_mean for a choropleth.`);
              this.layerCreated.emit(r.layer);
            }
          }
        );
        return;
      }
      case 'idw':
        if (!this.field) return this.error.set('Choose the numeric field to interpolate.');
        return this.runLayerTool('idw', {
          vectorLayerId: this.vectorLayerId(),
          field: this.field,
          pixelSize: this.gridPixel,
          power: this.idwPower,
          outputName: base.outputName
        });
      case 'heatmap':
        return this.runLayerTool('heatmap', {
          vectorLayerId: this.vectorLayerId(),
          weightField: this.field || undefined,
          pixelSize: this.gridPixel,
          radius: this.heatRadius,
          outputName: base.outputName
        });
      case 'proximity':
        return this.runLayerTool('proximity', {
          vectorLayerId: this.vectorLayerId(),
          pixelSize: this.gridPixel,
          maxDistance: this.proximityMax,
          outputName: base.outputName
        });
      case 'indices':
        return this.runLayerTool('spectral-index', {
          layerId,
          kind: this.indexKind,
          bandA: this.indexA,
          bandB: this.indexB,
          soilFactor: this.soilFactor,
          outputName: base.outputName
        });
      case 'classify':
        return this.runLayerTool('classify', { layerId, classes: this.classCount, outputName: base.outputName });
      case 'change':
        if (!this.afterLayerId) return this.error.set('Choose the "after" raster.');
        return this.runLayerTool('change-detection', {
          beforeLayerId: layerId,
          beforeBand: this.band,
          afterLayerId: this.afterLayerId,
          afterBand: this.afterBand,
          threshold: this.changeThreshold,
          outputName: base.outputName
        });
    }
  }

  clear(): void {
    this.showResults.set(false);
    this.cancelPick();
    this.observers.set([]);
    if (this.tool() === 'supervised') this.training.update((list) => list.map((c) => ({ ...c, polygons: [] })));
    this.clearPreview();
    this.scenes.set(null);
    this.sceneId.set(null);
    this.clearInputs();
    this.resetResult();
    if (this.tool() === 'swipe') {
      this.swipeLayerId.set(null);
      this.mapService.setSwipe(null);
      this.mapService.setSpyglass(null);
    }
  }

  private clearInputs(): void {
    this.pointA.set(null);
    this.pointB.set(null);
    this.line.set(null);
    this.polygon.set(null);
    this.mapService.clearDraw();
    this.mapService.clearAnalysisGeometry();
  }

  private runUpload(): void {
    if (!this.uploadFile) return this.error.set('Choose a GeoTIFF file.');
    if (!this.uploadName.trim()) return this.error.set('Enter a layer name.');
    this.running.set(true);
    this.uploadProgress.set(0);
    this.api.upload(this.uploadFile, this.uploadName.trim(), this.uploadDepartmentId).subscribe({
      next: (event) => {
        if (event.type === HttpEventType.UploadProgress) {
          this.uploadProgress.set(event.total ? Math.round((event.loaded * 100) / event.total) : null);
        } else if (event.type === HttpEventType.Response && event.body) {
          const layer = event.body;
          this.running.set(false);
          this.uploadProgress.set(null);
          this.message.set(`"${layer.name}" was published as a raster layer — it is now the input for the other tools.`);
          this.pendingInputId = layer.id;
          this.layerCreated.emit(layer);
          this.uploadFile = null;
          this.uploadName = '';
        }
      },
      error: (err: HttpErrorResponse) => {
        this.uploadProgress.set(null);
        this.fail(err);
      }
    });
  }

  private runStyle(layerId: string): void {
    if (this.styleMode === 'values') {
      if (this.styleClasses.length === 0) return this.error.set('Add at least one class.');
      return void this.execute(
        this.api.style(layerId, {
          mode: 'values',
          band: this.band,
          opacity: this.styleOpacity,
          classes: this.styleClasses.map((c) => ({ value: c.value, color: c.color, label: c.label.trim() || String(c.value) }))
        }),
        () => {
          this.mapService.setLayerVisibility(layerId, true);
          this.mapService.refreshLayerStyle(layerId);
          this.message.set('Classes applied — the legend is updated.');
        }
      );
    }
    const spec: RasterStyleSpec =
      this.styleMode === 'rgb'
        ? { mode: 'rgb', bands: this.rgbBands, stretch: this.rgbStretch, opacity: this.styleOpacity }
        : {
            mode: 'ramp',
            band: this.band,
            ramp: this.styleRamp,
            min: this.styleMin ?? undefined,
            max: this.styleMax ?? undefined,
            invert: this.styleInvert,
            opacity: this.styleOpacity
          };
    this.execute(this.api.style(layerId, spec), () => {
      this.mapService.setLayerVisibility(layerId, true);
      this.mapService.refreshLayerStyle(layerId);
      this.message.set('Style applied.');
    });
  }

  private runDecision(tool: 'encroach' | 'greencover' | 'exposure' | 'report'): void {
    const publish = this.publishResult && this.optionalOutput();
    if (publish && !this.outputName.trim()) return this.error.set('Enter a name for the new layer.');
    const outputName = publish ? this.outputName.trim() : undefined;
    const zoneTool = tool !== 'exposure' && !(tool === 'report' && this.reportArea === 'draw');
    if (zoneTool && !this.vectorLayerId()) return this.error.set('Choose the zones (polygon) layer.');
    if (this.zoneFilterField && !this.zoneFilterValue.trim() && zoneTool) return this.error.set(`Enter the ${this.zoneFilterField} value, or clear the filter.`);
    const done = (r: { layer?: GisLayer }) => {
      if (r.layer) {
        this.message.set(`New layer "${r.layer.name}" added to the map.`);
        this.layerCreated.emit(r.layer);
      }
    };
    if (tool === 'encroach') {
      return this.runJob<{ layer?: GisLayer; result: EncroachmentResult }>(
        'encroachment',
        { ...this.zonesBody(), beforeFrom: this.encBeforeFrom, beforeTo: this.encBeforeTo, afterFrom: this.encAfterFrom, afterTo: this.encAfterTo, minAreaM2: this.encMinArea, sensitivity: this.encSensitivity, outputName },
        (r) => {
          const x = r.result;
          this.facts.set([
            { label: 'New built-up sites', value: fmtInt(x.count) },
            { label: 'New built-up area', value: formatArea(x.newBuiltM2) },
            { label: 'Compared', value: `${x.beforeDates[0] ?? ''} … → ${x.afterDates[x.afterDates.length - 1] ?? ''}` }
          ]);
          this.table.set({
            title: 'Sites',
            headers: ['Zone', 'Area', 'Location'],
            rows: x.sites.map((s) => [s.zone, formatArea(s.areaM2), `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`]),
            coords: x.sites.map((s) => [s.lon, s.lat])
          });
          if (!x.count) this.message.set('No new construction found in the protected zones.');
          done(r);
        }
      );
    }
    if (tool === 'greencover') {
      return this.runJob<{ layer?: GisLayer; result: GreenCoverResult }>(
        'green-cover',
        {
          ...this.zonesBody(),
          from: this.gcFrom,
          to: this.gcTo,
          compareFrom: this.gcCompare ? shiftYear(this.gcFrom) : undefined,
          compareTo: this.gcCompare ? shiftYear(this.gcTo) : undefined,
          threshold: this.gcThreshold,
          outputName
        },
        (r) => {
          const x = r.result;
          this.facts.set([
            { label: 'Overall green cover', value: `${x.overallGreenPct.toFixed(1)} %` },
            { label: 'Zones', value: fmtInt(x.zones) },
            ...(x.zonesLosingGreen !== undefined ? [{ label: 'Zones losing > 2 points', value: fmtInt(x.zonesLosingGreen) }] : [])
          ]);
          this.table.set({
            title: 'Green cover by zone',
            headers: x.rows.some((z) => z.changePct !== undefined) ? ['Zone', 'Green %', 'Last year', 'Change'] : ['Zone', 'Green %', 'NDVI'],
            rows: x.rows.map((z) =>
              z.changePct !== undefined
                ? [z.zone, z.greenPct.toFixed(1), (z.prevPct ?? 0).toFixed(1), `${z.changePct >= 0 ? '+' : ''}${z.changePct.toFixed(1)}`]
                : [z.zone, z.greenPct.toFixed(1), z.ndviMean.toFixed(2)]
            )
          });
          done(r);
        }
      );
    }
    if (tool === 'exposure') {
      if (!this.populationLayerId) return this.error.set('Choose the population raster (download it with Online Sources → Population).');
      if (!this.layerId()) return this.error.set('Choose the hazard raster.');
      if (this.hazardOperator === 'between' && this.hazardThreshold2 === null) return this.error.set('Enter the upper limit.');
      return this.runJob<{ layer?: GisLayer; result: ExposureResult }>(
        'exposure',
        {
          populationLayerId: this.populationLayerId,
          hazardLayerId: this.layerId(),
          hazardBand: this.band,
          operator: this.hazardOperator,
          threshold: this.hazardThreshold,
          threshold2: this.hazardOperator === 'between' ? this.hazardThreshold2 : undefined,
          zonesLayerId: this.exposureByZone && this.vectorLayerId() ? this.vectorLayerId() : undefined,
          labelField: this.exposureByZone && this.zoneLabelField ? this.zoneLabelField : undefined,
          outputName
        },
        (r) => {
          const x = r.result;
          this.facts.set([
            { label: 'Population in the area', value: fmtInt(x.population) },
            { label: 'People exposed', value: `${fmtInt(x.exposed)} (${x.exposedPct.toFixed(1)} %)` }
          ]);
          if (x.rows) {
            this.table.set({
              title: 'Exposure by zone',
              headers: ['Zone', 'Population', 'Exposed', 'Share'],
              rows: x.rows.map((z) => [z.zone, fmtInt(z.population), fmtInt(z.exposed), `${z.exposedPct.toFixed(1)} %`])
            });
          }
          done(r);
        }
      );
    }
    // report
    if (this.reportRasterIds.size === 0) return this.error.set('Tick at least one raster to include.');
    const area =
      this.reportArea === 'draw'
        ? this.polygon()
          ? { polygon: this.polygon() }
          : null
        : { zonesLayerId: this.vectorLayerId(), filterField: this.zoneFilterField || undefined, filterValue: this.zoneFilterField ? this.zoneFilterValue.trim() : undefined };
    if (!area) return this.error.set('Draw the area first.');
    return this.runJob<{ result: AreaReport }>('area-report', { ...area, rasterLayerIds: [...this.reportRasterIds] }, (r) => {
      this.facts.set([
        { label: 'Area', value: formatArea(r.result.areaM2) },
        { label: 'Rasters summarised', value: fmtInt(r.result.sections.length) }
      ]);
      this.printReport(r.result);
      this.message.set('Report opened in a new tab — use "Print / Save as PDF".');
    });
  }

  private runDownload(layerId: string): void {
    const bbox = this.downloadView ? (this.mapService.getViewExtent4326() ?? undefined) : undefined;
    this.execute(this.api.download(layerId, bbox), (response) => {
      const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'raster.tif';
      const url = URL.createObjectURL(response.body as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.message.set(`Downloaded ${name}.`);
    });
  }

  /** Styling: stretch the ramp over the 1st–99th percentile of the band,
   *  so a few extreme pixels don't flatten the colours. */
  autoStretch(): void {
    const layerId = this.layerId();
    if (!layerId) return this.error.set('Choose a raster layer first.');
    this.execute(this.api.statistics({ layerId, band: this.band, bins: 10 }), (r) => {
      this.styleMin = round(r.p1);
      this.styleMax = round(r.p99);
      this.message.set(`Range set to the 1–99 % values: ${fmt(r.p1)} – ${fmt(r.p99)}.`);
    });
  }

  private runIdentify(): void {
    const layerId = this.layerId();
    const point = this.pointA();
    if (!layerId || !point) return;
    this.mapService.setAnalysisGeometry({ type: 'Point', coordinates: point });
    this.execute(this.api.identify(layerId, point), (r) => {
      if (!r.inside) {
        this.message.set('That point is outside the raster.');
        return;
      }
      this.facts.set(r.values.map((v) => ({ label: `Band ${v.band}`, value: v.value === null ? 'NoData' : fmt(v.value) })));
    });
  }

  private runLayerTool(tool: string, body: Record<string, unknown>): void {
    this.runJob<LayerResult>(tool, body, (r) => {
      this.message.set(`New layer "${r.layer.name}" added to the map.`);
      if (r.layer.layerType === 'RASTER') this.pendingInputId = r.layer.id;
      const t = (r.result as { transitions?: { fromLabel: string; toLabel: string; areaM2: number; from: number; to: number }[] })?.transitions;
      if (t) this.transitions.set(t.filter((x) => x.from !== x.to).slice(0, 30));
      if (this.tool() === 'online') this.clearPreview();
      this.facts.set(describe(r.result));
      this.mapService.clearAnalysisGeometry();
      this.layerCreated.emit(r.layer);
      // Every output layer gets a results screen and a saved report: rasters
      // via their statistics, vector outputs via the tool's own summary.
      this.reportLayerId = r.layer.id;
      if (r.layer.layerType === 'RASTER') {
        this.loadInsights(r.layer.id);
      } else {
        const insights = resultInsights(this.tool(), r.result as Record<string, unknown>);
        if (insights) {
          const labels = new Set(insights.facts.map((f) => f.label));
          this.facts.update((list) => [...list.filter((f) => !labels.has(f.label)), ...insights.facts]);
          this.insightHeading.set(insights.heading);
          this.insightClasses.set(insights.classes);
        }
        this.saveReport();
      }
    });
  }

  /** Statistics of a new raster output, read the way that tool's result
   *  should be read (terrain classes, compass directions, vegetation …). */
  /** Output layer of the result on screen — its report is saved there. */
  private reportLayerId: string | null = null;

  /** Keeps the results-screen report with the output layer, so it can be
   *  reopened later from the layer's More menu. Best effort. */
  private saveReport(): void {
    const layerId = this.reportLayerId;
    if (!layerId || this.facts().length === 0) return;
    const explanation = this.explanation();
    const stats = this.statistics();
    this.api
      .saveReport(layerId, {
        tool: this.tool(),
        toolLabel: RASTER_TOOLS.find((t) => t.id === this.tool())?.label ?? this.tool(),
        heading: this.insightHeading(),
        facts: this.facts(),
        classes: this.insightClasses(),
        histogram: stats ? stats.histogram : null,
        table: this.reportTable(),
        explanation: explanation && !explanation.startsWith('The AI') ? explanation : null
      })
      .subscribe({ error: () => undefined });
  }

  /** The result's table (zonal stats, transitions, …), first 50 rows. */
  private reportTable(): { headers: string[]; rows: string[][] } | null {
    const t = this.table();
    if (t) return { headers: t.headers.map(String), rows: t.rows.slice(0, 50).map((r) => r.map((v) => String(v ?? ''))) };
    const tr = this.transitions();
    if (tr?.length) return { headers: ['From', 'To', 'Area'], rows: tr.slice(0, 50).map((x) => [x.fromLabel, x.toLabel, formatArea(x.areaM2)]) };
    const z = this.zoneRows() as unknown as Record<string, unknown>[] | null;
    if (z?.length) {
      const headers = Object.keys(z[0]).filter((k) => typeof z[0][k] !== 'object');
      return { headers, rows: z.slice(0, 50).map((r) => headers.map((h) => String(r[h] ?? ''))) };
    }
    return null;
  }

  private loadInsights(layerId: string): void {
    this.reportLayerId = layerId;
    const tool = this.tool();
    this.insightsLoading.set(true);
    this.api.statistics({ layerId, band: 1, bins: 64 }).subscribe({
      next: (stats) => {
        this.insightsLoading.set(false);
        if (this.tool() !== tool) return; // another tool opened meanwhile
        const insights = rasterInsights(tool, stats);
        const labels = new Set(insights.facts.map((f) => f.label));
        this.facts.update((list) => [...list.filter((f) => !labels.has(f.label)), ...insights.facts]);
        this.statistics.set(stats);
        this.insightHeading.set(insights.heading);
        this.insightClasses.set(insights.classes);
        this.saveReport();
        this.autoExplain();
      },
      error: () => {
        this.insightsLoading.set(false);
        this.autoExplain(); // still explain the facts we have
      }
    });
  }

  /** AI insights generated by themselves once per result (the Explain
   *  button regenerates). Same /gis/ai/explain call as the button. */
  private autoExplained = false;

  private autoExplain(): void {
    if (this.autoExplained || this.insightsLoading() || this.facts().length === 0 || !this.showResults()) return;
    this.autoExplained = true;
    this.explainResult();
  }

  fmtArea(m2: number): string {
    return formatArea(m2);
  }

  /** Long tools run as a backend job: start it, poll its stage every
   *  1.5 s, and hand the result over when it is done. */
  private runJob<T>(tool: string, body: Record<string, unknown>, onResult: (result: T) => void): void {
    const record = (result: unknown) => {
      const out = (result as { layer?: GisLayer })?.layer;
      if (!out) return;
      const label = `${RASTER_TOOLS.find((t) => t.id === this.tool())?.label ?? tool} → ${out.name}`;
      this.recorded.update((list) => [...list.slice(-14), { tool, body, label, outputId: out.id, inputId: body['layerId'] as string | undefined }]);
    };
    this.jobSub?.unsubscribe();
    this.running.set(true);
    this.jobSub = this.api
      .startJob<T>(tool, body, this.isOwner ? this.outputDepartmentId : null)
      .pipe(
        switchMap((started) => {
          this.job.set(started);
          return timer(1500, 1500).pipe(
            switchMap(() =>
              this.api.job<T>(started.id).pipe(
                // The job keeps running on the server through a network
                // blip — retry the status check instead of giving up on it.
                retry({
                  count: 5,
                  delay: (err: HttpErrorResponse) =>
                    err.status === 0 || err.status >= 502 ? timer(3000) : throwError(() => err)
                })
              )
            ),
            takeWhile((j) => j.status === 'queued' || j.status === 'running', true)
          );
        })
      )
      .subscribe({
        next: (j) => {
          this.job.set(j);
          if (j.status === 'done') {
            this.running.set(false);
            this.job.set(null);
            record(j.result);
            onResult(j.result as T);
          } else if (j.status === 'failed' || j.status === 'cancelled') {
            this.running.set(false);
            this.job.set(null);
            if (j.status === 'failed') this.error.set(j.error ?? 'Raster processing failed.');
            else this.message.set('Cancelled.');
          }
        },
        error: (err: HttpErrorResponse) => {
          const polling = this.job() !== null;
          this.job.set(null);
          // 404 while polling = the backend restarted and lost the job.
          if (err.status === 404 && polling) {
            this.running.set(false);
            this.error.set('The job was lost (the server restarted). Please run it again.');
            return;
          }
          this.fail(err);
        }
      });
  }

  cancelJob(): void {
    const job = this.job();
    if (!job) return;
    this.api.cancelJob(job.id).subscribe({
      next: (j) => this.job.set({ ...job, ...j }),
      error: (err: HttpErrorResponse) => this.error.set(err.error?.message ?? 'Could not cancel.')
    });
  }

  private execute<T>(request: Observable<T>, onResult: (result: T) => void): void {
    this.running.set(true);
    request.subscribe({
      next: (result) => {
        this.running.set(false);
        onResult(result);
      },
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  private resetResult(): void {
    this.explainSub?.unsubscribe();
    this.explaining.set(false);
    this.explanation.set(null);
    this.error.set(null);
    this.message.set(null);
    this.facts.set([]);
    this.profile.set(null);
    this.statistics.set(null);
    this.insightHeading.set(null);
    this.insightClasses.set(null);
    this.insightsLoading.set(false);
    this.autoExplained = false;
    this.reportLayerId = null;
    this.zoneRows.set(null);
    this.series.set(null);
    this.transitions.set(null);
    this.table.set(null);
  }

  private fail(err: HttpErrorResponse): void {
    this.running.set(false);
    const message = err.error?.message;
    this.error.set(
      typeof message === 'string'
        ? message
        : Array.isArray(message)
          ? message.join(' ')
          : err.status === 0
            ? 'Could not reach the server.'
            : `Raster processing failed (${err.status || 'unknown'}).`
    );
  }

  elapsed(ms: number): string {
    const sec = Math.floor(ms / 1000);
    return sec >= 60 ? `${Math.floor(sec / 60)} min ${sec % 60} s` : `${sec} s`;
  }

  area(m2: number): string {
    return formatArea(m2);
  }

  fmtValue(v: number | null): string {
    return fmt(v);
  }

  // ----- time series chart -----

  readonly seriesChart = computed(() => {
    const pts = this.series();
    if (!pts || pts.length === 0) return null;
    const w = 300, h = 120;
    const t = pts.map((p) => new Date(p.date).getTime());
    const t0 = Math.min(...t), t1 = Math.max(...t);
    const lo = Math.min(...pts.map((p) => p.min)), hi = Math.max(...pts.map((p) => p.max));
    const x = (v: number) => (t1 > t0 ? ((v - t0) / (t1 - t0)) * (w - 10) + 5 : w / 2);
    const y = (v: number) => h - 8 - ((v - lo) / (hi - lo || 1)) * (h - 16);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y(p.mean).toFixed(1)}`).join(' ');
    const band =
      pts.map((p, i) => `${i ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y(p.max).toFixed(1)}`).join(' ') +
      ' ' +
      [...pts].reverse().map((p, i) => `L${x(t[pts.length - 1 - i]).toFixed(1)},${y(p.min).toFixed(1)}`).join(' ') +
      ' Z';
    const dots = pts.map((p, i) => ({ cx: x(t[i]), cy: y(p.mean), title: `${p.date}: ${fmt(p.mean)}` }));
    return { w, h, line, band, dots, first: pts[0].date, last: pts[pts.length - 1].date, lo: fmt(lo), hi: fmt(hi) };
  });

  // ----- histogram -----

  readonly histogram = computed(() => {
    const stats = this.statistics();
    if (!stats) return null;
    const { counts, edges } = stats.histogram;
    const peak = Math.max(...counts, 1);
    const w = 300;
    const h = 110;
    const bw = w / counts.length;
    const bars = counts.map((c, i) => {
      const bh = (c / peak) * (h - 4);
      return { x: i * bw + 0.5, y: h - bh, w: Math.max(bw - 1, 0.5), h: bh, title: `${fmt(edges[i])} – ${fmt(edges[i + 1])}: ${fmtInt(c)}` };
    });
    return { w, h, bars, min: fmt(edges[0]), max: fmt(edges[edges.length - 1]) };
  });

  // ----- profile chart -----

  readonly chart = computed(() => {
    const points = this.profile();
    if (!points || points.length < 2) return null;
    const zs = points.map((p) => p.z).filter((z): z is number => z !== null);
    if (zs.length === 0) return null;
    const w = 300;
    const h = 120;
    const min = Math.min(...zs);
    const max = Math.max(...zs);
    const range = max - min || 1;
    const total = points[points.length - 1].d || 1;
    const x = (d: number) => (d / total) * w;
    const y = (z: number) => h - ((z - min) / range) * (h - 10) - 5;
    let path = '';
    let pen = false;
    for (const p of points) {
      if (p.z === null) {
        pen = false;
        continue;
      }
      path += `${pen ? 'L' : 'M'}${x(p.d).toFixed(1)},${y(p.z).toFixed(1)} `;
      pen = true;
    }
    const hidden = points
      .filter((p) => p.visible === false && p.z !== null)
      .map((p) => ({ cx: x(p.d), cy: y(p.z as number) }));
    return { w, h, path, min: fmt(min), max: fmt(max), length: formatLength(total), hidden };
  });
}

// ----- formatting -----

const LABELS: Record<string, [string, (v: number) => string]> = {
  areaM2: ['Area', formatArea],
  visibleM2: ['Visible area', formatArea],
  increaseM2: ['Increase', formatArea],
  decreaseM2: ['Decrease', formatArea],
  unchangedM2: ['No change', formatArea],
  volumeM3: ['Water volume', formatVolume],
  maxDepth: ['Max depth', fmt],
  meanDepth: ['Mean depth', fmt],
  count: ['Features', fmtInt],
  polygons: ['Polygons', fmtInt],
  maxUpstreamKm2: ['Largest catchment', (v) => `${fmt(v)} km²`],
  vegetationPct: ['Dense vegetation (> 0.3)', (v) => `${v.toFixed(1)} %`],
  sparsePct: ['Sparse vegetation', (v) => `${v.toFixed(1)} %`],
  waterPct: ['Water / bare (< 0)', (v) => `${v.toFixed(1)} %`],
  openWaterPct: ['Open water (NDWI > 0)', (v) => `${v.toFixed(1)} %`],
  builtUpPct: ['Built-up (NDBI > 0)', (v) => `${v.toFixed(1)} %`],
  filledCells: ['Pits filled (cells)', fmtInt],
  filledAreaM2: ['Filled area', formatArea],
  fillVolumeM3: ['Fill volume', formatVolume],
  maxFillDepth: ['Deepest pit', (v) => `${fmt(v)} m`],
  points: ['Points used', fmtInt],
  peakPerKm2: ['Peak density', (v) => `${fmt(v)} / km²`],
  withinM2: ['Area within distance', formatArea],
  inputs: ['Rasters merged', fmtInt],
  tiles: ['Source tiles', fmtInt],
  maskedPct: ['Cloud / shadow masked', (v) => `${v.toFixed(1)} %`],
  scenes: ['Scenes used', fmtInt],
  highlySuitableM2: ['Highly suitable (≥ 80)', formatArea],
  lengthM: ['Route length', formatLength],
  straightM: ['Straight-line distance', formatLength],
  totalCost: ['Accumulated cost', fmt],
  hotM2: ['Hot spots (≥ 90 %)', formatArea],
  hot99M2: ['…of which 99 % confident', formatArea],
  coldM2: ['Cold spots (≥ 90 %)', formatArea],
  orbits: ['Satellite orbits averaged', fmtInt],
  meanUmol: ['Mean NO₂ over the area', (v) => `${v.toFixed(1)} µmol/m²`],
  maxUmol: ['Highest NO₂ in the region', (v) => `${v.toFixed(1)} µmol/m²`],
  objectAreaM2: ['Area covered by objects', formatArea],
  maxHeight: ['Tallest object', (v) => `${v.toFixed(1)} m`],
  meanHeight: ['Mean object height', (v) => `${v.toFixed(1)} m`],
  objectVolumeM3: ['Built / canopy volume', formatVolume],
  suitableM2: ['Suitable (60–80)', formatArea],
  unsuitableM2: ['Unsuitable (< 40)', formatArea],
  clearCoveragePct: ['Clear coverage', (v) => `${v.toFixed(1)} %`],
  meanClearObservations: ['Clear looks per pixel', fmt],
  population: ['Population', fmtInt],
  everWaterM2: ['Ever water (1984–2021)', formatArea],
  permanentWaterM2: ['Permanent water', formatArea],
  meanC: ['Mean surface temp.', (v) => `${v.toFixed(1)} °C`],
  maxC: ['Hottest', (v) => `${v.toFixed(1)} °C`],
  minC: ['Coolest', (v) => `${v.toFixed(1)} °C`],
  hotspotM2: ['Hotspots (> mean + 2 °C)', formatArea],
  accuracyPct: ['Training accuracy', (v) => `${v.toFixed(1)} %`],
  trainingPixels: ['Training pixels', fmtInt],
  changedM2: ['Changed area', formatArea],
  changedPct: ['Changed share', (v) => `${v.toFixed(1)} %`],
  observers: ['Observers', fmtInt],
  multiVisibleM2: ['Seen by 2+ observers', formatArea],
  maxOrder: ['Highest stream order', fmtInt],
  pixelSizeM: ['Pixel size', (v) => `${fmt(v)} m`]
};

function describe(result: Record<string, unknown>): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [];
  for (const [key, value] of Object.entries(result ?? {})) {
    if (typeof value === 'number' && LABELS[key]) facts.push({ label: LABELS[key][0], value: LABELS[key][1](value) });
  }
  const stats = result?.['stats'] as { min?: number; max?: number; mean?: number } | undefined;
  if (stats && stats.min !== undefined && stats.min !== null) {
    facts.push({ label: 'Min / Mean / Max', value: `${fmt(stats.min)} / ${fmt(stats.mean ?? null)} / ${fmt(stats.max ?? null)}` });
  }
  const classes = result?.['classes'] as { value: number; label?: string; areaM2: number }[] | undefined;
  for (const c of classes ?? []) {
    const label = c.label?.startsWith('Class') ? c.label : `Class ${c.label || c.value}`;
    facts.push({ label, value: formatArea(c.areaM2) });
  }
  for (const key of ['source', 'sceneId'] as const) {
    if (typeof result?.[key] === 'string') facts.push({ label: key === 'source' ? 'Source' : 'Scene', value: result[key] as string });
  }
  if (typeof result?.['cloud'] === 'number') facts.push({ label: 'Cloud cover', value: `${(result['cloud'] as number).toFixed(1)} %` });
  if (Array.isArray(result?.['dates']) && (result['dates'] as string[]).length) {
    const d = result['dates'] as string[];
    facts.push({ label: 'Dates', value: d.length > 1 ? `${d[0]} … ${d[d.length - 1]}` : d[0] });
  }
  if (Array.isArray(result?.['bands'])) facts.push({ label: 'Bands', value: (result['bands'] as string[]).join(' · ') });
  if (typeof result?.['crs'] === 'string') facts.push({ label: 'Coordinate system', value: result['crs'] as string });
  if (typeof result?.['width'] === 'number') facts.push({ label: 'Size', value: `${fmtInt(result['width'] as number)} × ${fmtInt(result['height'] as number)} px` });
  if (result?.['resampled']) facts.push({ label: 'Note', value: 'Large DEM — processed at reduced resolution' });
  return facts;
}

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2);
}

function fmtInt(v: number): string {
  return Math.round(v).toLocaleString();
}

function round(v: number): number {
  return Math.abs(v) >= 100 ? Math.round(v * 10) / 10 : Math.round(v * 1000) / 1000;
}

function niceInterval(raw: number): number {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

/** Settings → Units (set by the component's effect); results are
 *  computed in metres and converted only for display. */
let imperial = false;

function formatLength(m: number): string {
  if (imperial) {
    const ft = m * 3.28084;
    return ft >= 5280 ? `${(ft / 5280).toFixed(2)} mi` : `${Math.round(ft)} ft`;
  }
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function formatArea(m2: number): string {
  if (imperial) {
    const acres = m2 / 4046.856;
    if (acres >= 640) return `${(acres / 640).toFixed(2)} mi²`;
    if (acres >= 1) return `${acres.toFixed(2)} acres`;
    return `${Math.round(m2 * 10.7639)} ft²`;
  }
  if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(2)} km²`;
  if (m2 >= 1e4) return `${(m2 / 1e4).toFixed(2)} ha`;
  return `${Math.round(m2)} m²`;
}

function formatVolume(m3: number): string {
  return imperial ? `${fmtInt(m3 * 1.30795)} yd³` : `${fmtInt(m3)} m³`;
}

/** Raster Calculator presets. */
const CALC_RECIPES: { label: string; expression: string; inputs: number; hint: string }[] = [
  { label: 'Normalised difference (NDVI-style)', expression: '(A - B) / (A + B)', inputs: 2, hint: 'A = NIR band, B = Red band (same raster, different bands).' },
  { label: 'Difference (after − before)', expression: 'B - A', inputs: 2, hint: 'A = before, B = after.' },
  { label: 'Percent change', expression: '(B - A) / A * 100', inputs: 2, hint: 'A = before, B = after; result in %.' },
  { label: 'Threshold → 1 / 0', expression: 'where(A > 100, 1, 0)', inputs: 1, hint: 'Edit 100 to your threshold.' },
  { label: 'Keep A only where B > 0 (mask)', expression: 'where(B > 0, A, 0)', inputs: 2, hint: 'B is the mask raster.' },
  { label: 'Average of three', expression: '(A + B + C) / 3', inputs: 3, hint: 'Inputs are aligned to A\'s grid.' },
  { label: 'Metres → feet', expression: 'A * 3.28084', inputs: 1, hint: 'Unit conversion.' }
];

const CALC_FUNCTIONS = ['where', 'sqrt', 'log', 'log10', 'exp', 'abs', 'minimum', 'maximum', 'sin', 'cos', 'tan', 'logical_and', 'logical_or', 'logical_not'];

/** Same rules as the backend, checked as you type. */
function checkExpression(expression: string, inputs: number): string | null {
  const text = expression.trim();
  if (!text) return 'Enter an expression.';
  if (!/^[\w\s+\-*/%().,<>=!&|~]+$/.test(text) || text.includes('__')) return 'The expression contains characters that are not allowed.';
  let depth = 0;
  for (const ch of text) {
    depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    if (depth < 0) return 'A ")" has no matching "(".';
  }
  if (depth !== 0) return 'A "(" is not closed.';
  const letters = 'ABCDEF'.slice(0, inputs);
  for (const word of text.match(/[A-Za-z_]\w*/g) ?? []) {
    if (word.length === 1 && letters.includes(word)) continue;
    if (CALC_FUNCTIONS.includes(word)) continue;
    if (word.length === 1 && 'ABCDEF'.includes(word)) return `"${word}" is not an input — add more inputs or use ${letters.split('').join(', ')}.`;
    return `"${word}" is not allowed.`;
  }
  return null;
}

/** Class boundaries (k + 1 values) from a histogram. */
function classBreaks(method: 'equal' | 'quantile' | 'jenks', k: number, counts: number[], edges: number[]): number[] {
  const lo = edges[0];
  const hi = edges[edges.length - 1];
  if (method === 'equal') return Array.from({ length: k + 1 }, (_, i) => lo + ((hi - lo) * i) / k);
  const centres = counts.map((_, i) => (edges[i] + edges[i + 1]) / 2);
  if (method === 'quantile') {
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    const out = [lo];
    let cum = 0;
    let next = 1;
    counts.forEach((c, i) => {
      cum += c;
      while (next < k && cum >= (total * next) / k) {
        out.push(edges[i + 1]);
        next++;
      }
    });
    while (out.length < k) out.push(hi);
    out.push(hi);
    return out;
  }
  // Jenks natural breaks on the weighted histogram bins (Fisher's DP).
  const n = centres.length;
  const w = counts;
  const cost = (a: number, b: number) => {
    let sw = 0, s = 0, s2 = 0;
    for (let i = a; i <= b; i++) {
      sw += w[i];
      s += w[i] * centres[i];
      s2 += w[i] * centres[i] * centres[i];
    }
    return sw ? s2 - (s * s) / sw : 0;
  };
  const dp = Array.from({ length: k + 1 }, () => new Array<number>(n).fill(Infinity));
  const cut = Array.from({ length: k + 1 }, () => new Array<number>(n).fill(0));
  for (let j = 0; j < n; j++) dp[1][j] = cost(0, j);
  for (let c = 2; c <= k; c++) {
    for (let j = c - 1; j < n; j++) {
      for (let m = c - 2; m < j; m++) {
        const v = dp[c - 1][m] + cost(m + 1, j);
        if (v < dp[c][j]) {
          dp[c][j] = v;
          cut[c][j] = m;
        }
      }
    }
  }
  const out = [hi];
  let j = n - 1;
  for (let c = k; c >= 2; c--) {
    j = cut[c][j];
    out.unshift(edges[j + 1]);
  }
  out.unshift(lo);
  return out;
}

function downloadCsv(filename: string, rows: (string | number)[][]): void {
  const esc = (v: string | number) => {
    const t = String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const blob = new Blob(['\ufeff' + rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  // Local calendar date — toISOString() is UTC, a day behind before 5:30 am IST.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** EPSG:4326 bbox of a GeoJSON geometry. */
function geometryBbox(geometry: GeoJsonGeometry): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      minX = Math.min(minX, c[0] as number);
      maxX = Math.max(maxX, c[0] as number);
      minY = Math.min(minY, c[1] as number);
      maxY = Math.max(maxY, c[1] as number);
    } else if (Array.isArray(c)) c.forEach(walk);
  };
  walk(geometry['coordinates']);
  return [minX, minY, maxX, maxY];
}

/** A band's human name: its description (e.g. "Red (B4)") or colour role. */
function bandName(b: { description?: string | null; color: string }): string {
  if (b.description) return b.description;
  return b.color && b.color !== 'Undefined' && b.color !== 'Gray' ? b.color : '';
}

interface EncroachmentResult {
  count: number;
  newBuiltM2: number;
  sites: { zone: string; areaM2: number; lon: number; lat: number }[];
  beforeDates: string[];
  afterDates: string[];
}

interface GreenCoverResult {
  zones: number;
  overallGreenPct: number;
  zonesLosingGreen?: number;
  rows: { zone: string; greenPct: number; ndviMean: number; prevPct?: number; changePct?: number }[];
}

interface ExposureResult {
  population: number;
  exposed: number;
  exposedPct: number;
  rows?: { zone: string; population: number; exposed: number; exposedPct: number }[];
}

interface AreaReport {
  areaM2: number;
  perimeterM: number;
  bbox: [number, number, number, number];
  geometry: GeoJsonGeometry;
  sections: {
    layerId: string;
    name: string;
    empty: boolean;
    classes?: { label: string; areaM2: number; pct: number }[];
    min?: number;
    mean?: number;
    median?: number;
    max?: number;
    sum?: number;
  }[];
}

/** Same calendar dates one year earlier. */
function shiftYear(date: string): string {
  return `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
}

/** SVG outline of an EPSG:4326 (Multi)Polygon over the bbox, for reports. */
function svgOutline(geometry: GeoJsonGeometry, bbox: number[], w: number, h: number): string {
  const rings: number[][][] = [];
  const walk = (c: unknown, depth: number): void => {
    if (!Array.isArray(c)) return;
    if (depth === 0) rings.push(c as number[][]);
    else c.forEach((x) => walk(x, depth - 1));
  };
  walk(geometry['coordinates'], geometry['type'] === 'MultiPolygon' ? 2 : 1);
  const x = (lon: number) => (((lon - bbox[0]) / (bbox[2] - bbox[0])) * w).toFixed(1);
  const y = (lat: number) => (((bbox[3] - lat) / (bbox[3] - bbox[1])) * h).toFixed(1);
  const d = rings.map((r) => 'M' + r.map((p) => `${x(p[0])},${y(p[1])}`).join('L') + 'Z').join(' ');
  return `<svg viewBox="0 0 ${w} ${h}"><path d="${d}" fill="none" stroke="#111827" stroke-width="2"/></svg>`;
}

function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
  return `${n} B`;
}
