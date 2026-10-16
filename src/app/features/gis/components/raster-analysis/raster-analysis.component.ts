import { Component, EventEmitter, Input, OnDestroy, Output, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { Observable, Subscription, switchMap, takeWhile, timer } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { Department } from '../../../../core/models/department.model';
import { DepartmentService } from '../../../../core/services/department.service';
import { MapService } from '../../services/map.service';
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
  { id: 'mosaic', label: 'Mosaic / Merge', group: 'Raster Data', section: 'Transform', moduleId: 915, icon: 'pi pi-objects-column', description: 'Stitch several raster tiles into one seamless layer.' },
  { id: 'resample', label: 'Resample / Reproject', group: 'Raster Data', section: 'Transform', moduleId: 916, icon: 'pi pi-expand', description: 'Change the pixel size and/or coordinate system.' },
  { id: 'rasterize', label: 'Rasterize Vector', group: 'Raster Data', section: 'Transform', moduleId: 917, icon: 'pi pi-table', description: 'Burn a vector layer (or one of its fields) into a raster grid.' },
  { id: 'profile', label: 'Elevation Profile', group: 'Terrain Analysis', section: 'Surface', moduleId: 921, icon: 'pi pi-chart-line', description: 'Draw a line to plot the elevation profile along it.' },
  { id: 'slope', label: 'Slope', group: 'Terrain Analysis', section: 'Surface', moduleId: 922, icon: 'pi pi-sort-amount-up', description: 'Steepness of the terrain from a DEM, in degrees or percent.' },
  { id: 'aspect', label: 'Aspect', group: 'Terrain Analysis', section: 'Surface', moduleId: 923, icon: 'pi pi-compass', description: 'Direction each slope faces (0–360°).' },
  { id: 'hillshade', label: 'Hillshade', group: 'Terrain Analysis', section: 'Surface', moduleId: 924, icon: 'pi pi-sun', description: 'Shaded relief from a light source for 3D-looking terrain.' },
  { id: 'contour', label: 'Contour Generation', group: 'Terrain Analysis', section: 'Surface', moduleId: 925, icon: 'pi pi-wave-pulse', description: 'Generate contour lines at a fixed elevation interval.' },
  { id: 'rugged', label: 'Terrain Ruggedness', group: 'Terrain Analysis', section: 'Surface', moduleId: 931, icon: 'pi pi-chart-scatter', description: 'Roughness, Terrain Ruggedness Index (TRI) or Topographic Position (TPI).' },
  { id: 'fillsinks', label: 'Fill Sinks', group: 'Terrain Analysis', section: 'Hydrology & Earthwork', moduleId: 932, icon: 'pi pi-filter-fill', description: 'Remove pits from a DEM so water can drain — run before watershed.' },
  { id: 'streams', label: 'Stream Network', group: 'Terrain Analysis', section: 'Hydrology & Earthwork', moduleId: 933, icon: 'pi pi-share-alt', description: 'Extract drainage lines with Strahler order from a DEM.' },
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
  'idw', 'heatmap', 'proximity', 'indices', 'classify', 'online', 'streams', 'heat', 'supervised', 'changematrix'
];

/** Tools whose main input is a vector layer instead of a raster. */
const VECTOR_TOOLS: RasterToolId[] = ['rasterize', 'idw', 'heatmap', 'proximity'];
/** Tools that pick their own rasters (no single "input raster" picker). */
const NO_RASTER_INPUT: RasterToolId[] = ['upload', 'online', 'series', 'heat', 'calc', 'swipe', 'mosaic', ...VECTOR_TOOLS];

type Slot = 'a' | 'b' | 'line' | 'polygon' | 'observer' | 'training';

/** Rail icon + short caption per tool category. */
const GROUP_META: Record<string, { short: string; icon: string }> = {
  'Raster Data': { short: 'Data', icon: 'pi pi-database' },
  'Terrain Analysis': { short: 'Terrain', icon: 'pi pi-chart-line' },
  'Raster Analytics': { short: 'Analytics', icon: 'pi pi-calculator' },
  'Imagery Analysis': { short: 'Imagery', icon: 'pi pi-globe' }
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
  imports: [FormsModule, NgTemplateOutlet, ButtonModule, SelectModule, Terrain3dComponent],
  templateUrl: './raster-analysis.component.html',
  styleUrls: ['../buffer-overlay/buffer-overlay.component.scss', './raster-analysis.component.scss']
})
export class RasterAnalysisComponent implements OnDestroy {
  private readonly mapService = inject(MapService);
  private readonly api = inject(RasterService);
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
  readonly profile = signal<ProfilePoint[] | null>(null);
  readonly statistics = signal<RasterStatistics | null>(null);
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
  }

  // ----- selection of tool / raster -----

  /** Rail click: shows that category's tool catalog. */
  selectGroup(label: string): void {
    this.activeGroup.set(label);
    this.showCatalog.set(true);
  }

  /** Card click in the catalog: switch to that tool's form. */
  openTool(id: RasterToolId): void {
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
        this.info.set(info);
        this.applyInfoDefaults(info);
      },
      error: (err: HttpErrorResponse) => this.fail(err)
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
      next: (fields) => this.vectorFields.set(fields),
      error: (err: HttpErrorResponse) => this.fail(err)
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
          kind: tool,
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
          this.api.cutFill({ layerId, band: this.band, polygon, baseLevel: this.baseLevel ?? undefined }),
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
    });
  }

  /** Long tools run as a backend job: start it, poll its stage every
   *  1.5 s, and hand the result over when it is done. */
  private runJob<T>(tool: string, body: Record<string, unknown>, onResult: (result: T) => void): void {
    this.jobSub?.unsubscribe();
    this.running.set(true);
    this.jobSub = this.api
      .startJob<T>(tool, body, this.isOwner ? this.outputDepartmentId : null)
      .pipe(
        switchMap((started) => {
          this.job.set(started);
          return timer(1500, 1500).pipe(
            switchMap(() => this.api.job<T>(started.id)),
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
    this.error.set(null);
    this.message.set(null);
    this.facts.set([]);
    this.profile.set(null);
    this.statistics.set(null);
    this.zoneRows.set(null);
    this.series.set(null);
    this.transitions.set(null);
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
  return d.toISOString().slice(0, 10);
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
