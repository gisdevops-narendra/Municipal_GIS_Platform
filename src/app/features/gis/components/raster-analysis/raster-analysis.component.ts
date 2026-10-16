import { Component, EventEmitter, Input, OnDestroy, Output, computed, inject, signal } from '@angular/core';
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
  | 'swipe' | 'change' | 'ndvi' | 'indices' | 'classify';

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
  { id: 'change', label: 'Change Detection', group: 'Imagery Analysis', section: 'Compare', moduleId: 953, icon: 'pi pi-sync', description: 'Detect what changed between two dates.' },
  { id: 'ndvi', label: 'NDVI / Vegetation Index', group: 'Imagery Analysis', section: 'Spectral', moduleId: 952, icon: 'pi pi-sparkles', description: 'Vegetation health from red and near-infrared bands.' },
  { id: 'indices', label: 'Spectral Indices', group: 'Imagery Analysis', section: 'Spectral', moduleId: 954, icon: 'pi pi-palette', description: 'NDWI (water), NDBI (built-up) or SAVI (vegetation on bare soil).' },
  { id: 'classify', label: 'Unsupervised Classification', group: 'Imagery Analysis', section: 'Spectral', moduleId: 955, icon: 'pi pi-clone', description: 'K-means land-cover classes from multi-band imagery.' }
];
export const RASTER_TOOL_MODULE_IDS = RASTER_TOOLS.map((t) => t.moduleId);

/** Tools that publish a new layer and so need an output name. */
const OUTPUT_TOOLS: RasterToolId[] = [
  'slope', 'aspect', 'hillshade', 'contour', 'rugged', 'fillsinks', 'watershed', 'flood', 'viewshed',
  'calc', 'reclass', 'clip', 'polygonize', 'ndvi', 'change', 'mosaic', 'resample', 'rasterize',
  'idw', 'heatmap', 'proximity', 'indices', 'classify', 'online'
];

/** Tools whose main input is a vector layer instead of a raster. */
const VECTOR_TOOLS: RasterToolId[] = ['rasterize', 'idw', 'heatmap', 'proximity'];
/** Tools that pick their own rasters (no single "input raster" picker). */
const NO_RASTER_INPUT: RasterToolId[] = ['upload', 'online', 'calc', 'swipe', 'mosaic', ...VECTOR_TOOLS];

type Slot = 'a' | 'b' | 'line' | 'polygon';

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
  imports: [FormsModule, NgTemplateOutlet, ButtonModule, SelectModule],
  templateUrl: './raster-analysis.component.html',
  styleUrls: ['../buffer-overlay/buffer-overlay.component.scss', './raster-analysis.component.scss']
})
export class RasterAnalysisComponent implements OnDestroy {
  private readonly mapService = inject(MapService);
  private readonly api = inject(RasterService);
  private readonly departmentService = inject(DepartmentService);

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

  styleMode: 'ramp' | 'rgb' = 'ramp';
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

  // online data
  onlineSource: 'dem' | 'landcover' | 'sentinel2' = 'dem';
  aoiMode: 'view' | 'draw' | 'layer' = 'view';
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

  // terrain / imagery extras
  ruggedKind: 'roughness' | 'TRI' | 'TPI' = 'TRI';
  indexKind: 'ndwi' | 'ndbi' | 'savi' = 'ndwi';
  indexA = 2;
  indexB = 4;
  soilFactor = 0.5;
  classCount = 6;

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
    if (this.tool() === 'swipe' && id !== 'swipe') this.mapService.setSwipe(null);
    if (this.picking()) this.cancelPick();
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
    this.styleMode = info.bandCount >= 3 ? 'rgb' : 'ramp';
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
    if (this.tool() === 'online') {
      this.outputName = { dem: 'Elevation (Copernicus DEM)', landcover: 'Land cover (ESA WorldCover)', sentinel2: 'Sentinel-2 image' }[
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
    const kind = slot === 'line' ? 'Line' : slot === 'polygon' ? 'Polygon' : 'Point';
    this.pickSub = this.mapService.beginDraw(kind).subscribe({
      next: (geometry) => {
        const coords = geometry['coordinates'] as unknown;
        if (slot === 'a') this.pointA.set((coords as number[]).slice(0, 2) as LonLat);
        else if (slot === 'b') this.pointB.set((coords as number[]).slice(0, 2) as LonLat);
        else if (slot === 'line') this.line.set((coords as number[][]).map((c) => [c[0], c[1]] as LonLat));
        else this.polygon.set(geometry);
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
    if (this.calcInputs.length < 4) this.calcInputs = [...this.calcInputs, { layerId: null, band: 1 }];
  }

  removeCalcInput(index: number): void {
    this.calcInputs = this.calcInputs.filter((_, i) => i !== index);
  }

  calcLetter(index: number): string {
    return 'ABCD'[index];
  }

  setOnlineSource(source: 'dem' | 'landcover' | 'sentinel2'): void {
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
    return this.aoiMode === 'draw'
      ? 'Draw the area (or use selected polygons) first.'
      : this.aoiMode === 'layer'
        ? 'Choose a layer whose extent to use.'
        : 'The map view is not ready yet.';
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
    this.mapService.setSwipe(id, this.swipeFraction / 100);
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
              { label: 'Cut volume', value: `${fmtInt(r.cutM3)} m³` },
              { label: 'Fill volume', value: `${fmtInt(r.fillM3)} m³` },
              { label: 'Net (cut − fill)', value: `${fmtInt(r.netM3)} m³` },
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
        if (!this.outputName.trim()) return this.error.set('Enter a name for the new layer.');
        return this.runLayerTool('calculator', { inputs, expression: this.expression, outputName: this.outputName.trim() });
      }
      case 'reclass':
        if (this.reclassRules.length === 0) return this.error.set('Add at least one range.');
        return this.runLayerTool('reclassify', { ...base, rules: this.reclassRules });
      case 'clip':
        if (!this.polygon()) return this.error.set('Draw the boundary (or use selected polygons) first.');
        return this.runLayerTool('clip', { layerId, polygon: this.polygon(), outputName: base.outputName });
      case 'polygonize':
        return this.runLayerTool('polygonize', base);
      case 'ndvi':
        return this.runLayerTool('ndvi', { layerId, redBand: this.redBand, nirBand: this.nirBand, outputName: base.outputName });
      case 'online': {
        const aoi = this.aoi();
        if (!aoi) return this.error.set(this.aoiHint());
        if (this.onlineSource === 'sentinel2' && !this.sceneId()) return this.error.set('Search and pick a Sentinel-2 scene first.');
        if (!this.outputName.trim()) return this.error.set('Enter a name for the new layer.');
        return this.runLayerTool('online', {
          source: this.onlineSource,
          ...aoi,
          sceneId: this.onlineSource === 'sentinel2' ? this.sceneId() : undefined,
          maskClouds: this.onlineSource === 'sentinel2' ? this.maskClouds : undefined,
          outputName: this.outputName.trim()
        });
      }
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
    this.clearPreview();
    this.scenes.set(null);
    this.sceneId.set(null);
    this.clearInputs();
    this.resetResult();
    if (this.tool() === 'swipe') {
      this.swipeLayerId.set(null);
      this.mapService.setSwipe(null);
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
      .startJob<T>(tool, body)
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

  fmtValue(v: number | null): string {
    return fmt(v);
  }

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
  volumeM3: ['Water volume', (v) => `${fmtInt(v)} m³`],
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
  fillVolumeM3: ['Fill volume', (v) => `${fmtInt(v)} m³`],
  maxFillDepth: ['Deepest pit', (v) => `${fmt(v)} m`],
  points: ['Points used', fmtInt],
  peakPerKm2: ['Peak density', (v) => `${fmt(v)} / km²`],
  withinM2: ['Area within distance', formatArea],
  inputs: ['Rasters merged', fmtInt],
  tiles: ['Source tiles', fmtInt],
  maskedPct: ['Cloud / shadow masked', (v) => `${v.toFixed(1)} %`],
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

function formatLength(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function formatArea(m2: number): string {
  if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(2)} km²`;
  if (m2 >= 1e4) return `${(m2 / 1e4).toFixed(2)} ha`;
  return `${Math.round(m2)} m²`;
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
