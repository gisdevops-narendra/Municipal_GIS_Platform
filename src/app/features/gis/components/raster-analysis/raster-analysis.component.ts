import { Component, EventEmitter, Input, OnDestroy, Output, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, Subscription } from 'rxjs';
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
  RasterService,
  RasterStyleSpec
} from '../../services/raster.service';

export type RasterToolId =
  | 'upload' | 'style' | 'identify'
  | 'profile' | 'slope' | 'aspect' | 'hillshade' | 'contour' | 'cutfill'
  | 'watershed' | 'flood' | 'los' | 'viewshed'
  | 'calc' | 'reclass' | 'clip' | 'polygonize'
  | 'swipe' | 'ndvi' | 'change';

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
  { id: 'upload', label: 'Raster Upload & Publish', group: 'Raster Data', moduleId: 911, icon: 'pi pi-upload', description: 'Publish a GeoTIFF (DEM, satellite or drone image) as a map layer.' },
  { id: 'style', label: 'Raster Styling', group: 'Raster Data', moduleId: 912, icon: 'pi pi-palette', description: 'Colour a raster with a ramp, stretch and opacity.' },
  { id: 'identify', label: 'Pixel Identify', group: 'Raster Data', moduleId: 913, icon: 'pi pi-info-circle', description: 'Click the map to read pixel values from every band.' },
  { id: 'profile', label: 'Elevation Profile', group: 'Terrain Analysis', moduleId: 921, section: 'Surface', icon: 'pi pi-chart-line', description: 'Draw a line to plot the elevation profile along it.' },
  { id: 'slope', label: 'Slope', group: 'Terrain Analysis', moduleId: 922, section: 'Surface', icon: 'pi pi-sort-amount-up', description: 'Steepness of the terrain from a DEM, in degrees or percent.' },
  { id: 'aspect', label: 'Aspect', group: 'Terrain Analysis', moduleId: 923, section: 'Surface', icon: 'pi pi-compass', description: 'Direction each slope faces (0–360°).' },
  { id: 'hillshade', label: 'Hillshade', group: 'Terrain Analysis', moduleId: 924, section: 'Surface', icon: 'pi pi-sun', description: 'Shaded relief from a light source for 3D-looking terrain.' },
  { id: 'contour', label: 'Contour Generation', group: 'Terrain Analysis', moduleId: 925, section: 'Surface', icon: 'pi pi-wave-pulse', description: 'Generate contour lines at a fixed elevation interval.' },
  { id: 'cutfill', label: 'Cut & Fill / Volume', group: 'Terrain Analysis', moduleId: 926, section: 'Hydrology & Earthwork', icon: 'pi pi-box', description: 'Earthwork volumes to bring an area to a target height.' },
  { id: 'watershed', label: 'Drainage / Watershed', group: 'Terrain Analysis', moduleId: 927, section: 'Hydrology & Earthwork', icon: 'pi pi-share-alt', description: 'Flow paths and catchment area draining to a point.' },
  { id: 'flood', label: 'Flood Inundation', group: 'Terrain Analysis', moduleId: 928, section: 'Hydrology & Earthwork', icon: 'pi pi-cloud', description: 'Area flooded at a given water level.' },
  { id: 'los', label: 'Line of Sight', group: 'Terrain Analysis', moduleId: 929, section: 'Visibility', icon: 'pi pi-eye', description: 'Is the target visible from the observer along a line?' },
  { id: 'viewshed', label: 'Viewshed', group: 'Terrain Analysis', moduleId: 930, section: 'Visibility', icon: 'pi pi-bullseye', description: 'Everything visible from an observer point.' },
  { id: 'calc', label: 'Raster Calculator', group: 'Raster Analytics', moduleId: 942, icon: 'pi pi-calculator', description: 'Map algebra across rasters, e.g. (A - B) / (A + B).' },
  { id: 'reclass', label: 'Reclassify', group: 'Raster Analytics', moduleId: 943, icon: 'pi pi-sliders-h', description: 'Group pixel values into new classes.' },
  { id: 'clip', label: 'Clip to Boundary', group: 'Raster Analytics', moduleId: 944, icon: 'pi pi-stop', description: 'Cut a raster to a drawn or chosen boundary.' },
  { id: 'polygonize', label: 'Raster to Vector', group: 'Raster Analytics', moduleId: 945, icon: 'pi pi-th-large', description: 'Convert raster zones into vector polygons.' },
  { id: 'swipe', label: 'Swipe / Compare', group: 'Imagery Analysis', moduleId: 951, icon: 'pi pi-arrows-h', description: 'Slide between two layers to compare them.' },
  { id: 'ndvi', label: 'NDVI / Vegetation Index', group: 'Imagery Analysis', moduleId: 952, icon: 'pi pi-sparkles', description: 'Vegetation health from red and near-infrared bands.' },
  { id: 'change', label: 'Change Detection', group: 'Imagery Analysis', moduleId: 953, icon: 'pi pi-sync', description: 'Detect what changed between two dates.' }
];
export const RASTER_TOOL_MODULE_IDS = RASTER_TOOLS.map((t) => t.moduleId);

/** Tools that publish a new layer and so need an output name. */
const OUTPUT_TOOLS: RasterToolId[] = [
  'slope', 'aspect', 'hillshade', 'contour', 'watershed', 'flood', 'viewshed',
  'calc', 'reclass', 'clip', 'polygonize', 'ndvi', 'change'
];

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
  }
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
  readonly departments = signal<{ label: string; value: string }[]>([]);

  // ----- input raster -----
  readonly layerId = signal<string | null>(null);
  readonly info = signal<RasterInfo | null>(null);
  band = 1;
  outputName = '';
  readonly bandOptions = computed(() =>
    (this.info()?.bands ?? []).map((b) => ({ label: `Band ${b.band}${b.color && b.color !== 'Undefined' ? ` (${b.color})` : ''}`, value: b.band }))
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

  readonly swipeLayerId = signal<string | null>(null);
  swipeFraction = 50;

  // ----- results -----
  readonly running = signal(false);
  readonly error = signal<string | null>(null);
  readonly message = signal<string | null>(null);
  readonly facts = signal<{ label: string; value: string }[]>([]);
  readonly profile = signal<ProfilePoint[] | null>(null);

  private pickSub?: Subscription;

  ngOnDestroy(): void {
    this.pickSub?.unsubscribe();
    this.mapService.cancelDraw();
    this.mapService.setSwipe(null);
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
    this.tool.set(id);
    const group = RASTER_TOOLS.find((t) => t.id === id)?.group;
    if (group) this.activeGroup.set(group);
    this.resetResult();
    this.clearInputs();
    this.suggestOutputName();
  }

  selectLayer(id: string | null): void {
    this.layerId.set(id);
    this.info.set(null);
    this.band = 1;
    this.resetResult();
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
    if (info.bandCount >= 4) {
      this.redBand = 3;
      this.nirBand = 4;
    } else {
      this.redBand = 1;
      this.nirBand = Math.min(2, info.bandCount);
    }
  }

  private suggestOutputName(): void {
    const layer = this.layersSignal().find((l) => l.id === this.layerId());
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
        if (slot === 'a' && this.tool() === 'identify') this.runIdentify();
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
    if (tool !== 'calc' && !layerId) return this.error.set('Choose a raster layer first.');
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
    this.execute(this.api.upload(this.uploadFile, this.uploadName.trim(), this.uploadDepartmentId), (layer) => {
      this.message.set(`"${layer.name}" was published as a raster layer.`);
      this.layerCreated.emit(layer);
      this.uploadFile = null;
      this.uploadName = '';
    });
  }

  private runStyle(layerId: string): void {
    const spec: RasterStyleSpec =
      this.styleMode === 'rgb'
        ? { mode: 'rgb', bands: this.rgbBands, opacity: this.styleOpacity }
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
    this.execute(this.api.run(tool, body), (r: LayerResult) => {
      this.message.set(`New layer "${r.layer.name}" added to the map.`);
      this.facts.set(describe(r.result));
      this.mapService.clearAnalysisGeometry();
      this.layerCreated.emit(r.layer);
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
  waterPct: ['Water / bare (< 0)', (v) => `${v.toFixed(1)} %`]
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
  for (const c of classes ?? []) facts.push({ label: `Class ${c.label || c.value}`, value: formatArea(c.areaM2) });
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
