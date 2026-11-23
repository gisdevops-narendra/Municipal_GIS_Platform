import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnDestroy,
  OnInit,
  Output,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  untracked
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import OlMap from 'ol/Map';
import View from 'ol/View';
import Feature, { type FeatureLike } from 'ol/Feature';
import Point from 'ol/geom/Point';
import TileLayer from 'ol/layer/Tile';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import XYZ from 'ol/source/XYZ';
import ImageStatic from 'ol/source/ImageStatic';
import TileGrid from 'ol/tilegrid/TileGrid';
import Projection from 'ol/proj/Projection';
import { fromLonLat, toLonLat, transform as olTransform } from 'ol/proj';
import { Circle as CircleStyle, Fill, Stroke, Style, Text as TextStyle } from 'ol/style';
import Translate from 'ol/interaction/Translate';
import { defaults as defaultControls } from 'ol/control/defaults';
import ScaleLine from 'ol/control/ScaleLine';
import TileState from 'ol/TileState';
import type ImageTile from 'ol/ImageTile';
import type BaseLayer from 'ol/layer/Base';
import { AuthService } from '../../../../core/services/auth.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { BASEMAPS } from '../../services/map.service';
import { CrsService } from '../../services/crs.service';
import { RasterService } from '../../services/raster.service';
import { CrsPickerComponent } from '../crs-picker/crs-picker.component';
import { parseDms } from '../map-controls/map-controls.component';
import { MIN_GCPS, fitTransform, type GeorefTransform } from '../../services/georef-math';
import {
  GeorefGcp,
  GeorefPreview,
  GeorefResampling,
  GeorefSession,
  GeorefSettings,
  GeoreferenceService,
  parsePointsFile,
  toPointsFile
} from '../../services/georeference.service';

const TRANSFORMS: { value: GeorefTransform; label: string; hint: string }[] = [
  { value: 'helmert', label: 'Helmert', hint: 'Shift, rotate and scale only — keeps the shape exactly (≥ 2 GCPs).' },
  { value: 'poly1', label: 'Polynomial 1 (affine)', hint: 'Adds shear / different X-Y scale. Best default for flat scans (≥ 3 GCPs).' },
  { value: 'poly2', label: 'Polynomial 2', hint: 'Bends the image — for warped paper or old maps (≥ 6 GCPs, well spread).' },
  { value: 'poly3', label: 'Polynomial 3', hint: 'Stronger bending — needs many well-spread GCPs (≥ 10).' },
  { value: 'tps', label: 'Thin plate spline', hint: 'Passes exactly through every GCP (no residuals) — for local distortions; needs dense GCPs.' }
];

const RESAMPLING: { value: GeorefResampling; label: string }[] = [
  { value: 'near', label: 'Nearest neighbour' },
  { value: 'bilinear', label: 'Bilinear' },
  { value: 'cubic', label: 'Cubic' },
  { value: 'cubicspline', label: 'Cubic spline' },
  { value: 'lanczos', label: 'Lanczos' }
];

const REF_BASEMAPS = ['osm', 'esri-imagery', 'esri-hybrid', 'esri-streets'].filter((id) => BASEMAPS[id]);

/** Residual (in source pixels) above which a GCP is flagged. */
const RESIDUAL_WARN_PX = 2;

let gcpSeq = 0;
const newGcpId = () => `g${Date.now().toString(36)}${(gcpSeq++).toString(36)}`;

/**
 * Georeferencer (QGIS workflow): the scanned image on the left (pixel
 * space, zoomable to full resolution), a reference map on the right, the
 * GCP table with live residuals below. Click a point on the image, then the
 * same point on the map — or type its coordinates (decimal, DMS or the
 * target CRS). Preview warps a low-resolution copy onto the map; "Start
 * georeferencing" runs the full warp as a background job and publishes a
 * raster layer.
 */
@Component({
  selector: 'app-georeferencer',
  standalone: true,
  imports: [FormsModule, CrsPickerComponent],
  templateUrl: './georeferencer.component.html',
  styleUrl: './georeferencer.component.scss'
})
export class GeoreferencerComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly api = inject(GeoreferenceService);
  private readonly rasterApi = inject(RasterService);
  private readonly crsService = inject(CrsService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);
  private readonly host = inject(ElementRef<HTMLElement>);

  @Input({ required: true }) sessionId!: string;
  @Output() readonly closed = new EventEmitter<void>();
  @Output() readonly layerCreated = new EventEmitter<GisLayer>();

  @ViewChild('imageMap') private imageEl!: ElementRef<HTMLDivElement>;
  @ViewChild('refMap') private refEl!: ElementRef<HTMLDivElement>;
  @ViewChild('pointsFile') private pointsFileEl!: ElementRef<HTMLInputElement>;

  readonly transforms = TRANSFORMS;
  readonly resamplings = RESAMPLING;
  readonly basemaps = REF_BASEMAPS.map((id) => ({ id, label: BASEMAPS[id].label }));
  readonly warnPx = RESIDUAL_WARN_PX;

  readonly session = signal<GeorefSession | null>(null);
  readonly gcps = signal<GeorefGcp[]>([]);
  readonly transform = signal<GeorefTransform>('poly1');
  readonly resampling = signal<GeorefResampling>('bilinear');
  readonly targetCrs = signal<string>('');
  /** proj4 definition of the target CRS is loaded (residuals need it). */
  readonly crsReady = signal(false);
  readonly selectedId = signal<string | null>(null);
  /** Image position clicked, waiting for its map coordinates. */
  readonly pending = signal<{ px: number; py: number } | null>(null);
  readonly addMode = signal(true);
  readonly basemap = signal('esri-imagery');
  readonly previewing = signal(false);
  readonly preview = signal<GeorefPreview | null>(null);
  readonly previewOpacity = signal(0.6);
  readonly running = signal(false);
  readonly jobStage = signal<string | null>(null);
  readonly outputName = signal('');
  readonly saveState = signal<'saved' | 'saving' | 'unsaved'>('saved');
  /** A CRS the scan's GCPs fit much better (projection detection). */
  readonly crsSuggestion = signal<{ code: string; px: number; currentPx: number } | null>(null);
  private suggestTimer: ReturnType<typeof setTimeout> | undefined;

  // typed coordinates for the pending point
  /** dms: separate degree / minute / second boxes + hemisphere pickers
   *  (no symbols to type); dd: decimal or free-form DMS; target: X / Y. */
  coordMode: 'dms' | 'dd' | 'target' = 'dms';
  coordX = '';
  coordY = '';
  coordError = '';
  lonD = '';
  lonM = '';
  lonS = '';
  lonH: 'E' | 'W' = 'E';
  latD = '';
  latM = '';
  latS = '';
  latH: 'N' | 'S' = 'N';

  private imageMap: OlMap | null = null;
  private refMap: OlMap | null = null;
  private readonly imageMarkers = new VectorSource();
  private readonly refMarkers = new VectorSource();
  private refBase: BaseLayer | null = null;
  private previewLayer: ImageLayer<ImageStatic> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;

  /** Enabled GCPs in the target CRS, fitted with the chosen transform. */
  readonly fit = computed(() => {
    const crs = this.targetCrs();
    if (!crs || !this.crsReady()) return null;
    const enabled = this.gcps().filter((g) => g.enabled);
    const pairs = enabled.map((g) => {
      const [x, y] = olTransform([g.lon, g.lat], 'EPSG:4326', crs);
      return { px: g.px, py: g.py, x, y };
    });
    const result = fitTransform(this.transform(), pairs);
    if (!result) return null;
    const byId = new Map(enabled.map((g, i) => [g.id, result.residuals[i]]));
    return { ...result, byId };
  });

  readonly units = computed(() => (/^EPSG:4326$/i.test(this.targetCrs()) ? '°' : 'm'));
  readonly enabledCount = computed(() => this.gcps().filter((g) => g.enabled).length);
  readonly minGcps = computed(() => MIN_GCPS[this.transform()]);
  readonly transformHint = computed(() => TRANSFORMS.find((t) => t.value === this.transform())?.hint ?? '');
  readonly canRun = computed(() => !!this.targetCrs() && this.enabledCount() >= this.minGcps() && !!this.fit() && this.session()?.status === 'ready');

  /** Residual of one GCP in source pixels (null = not part of the fit). */
  residualPx(g: GeorefGcp): number | null {
    const f = this.fit();
    const r = f?.byId.get(g.id);
    return f && r && f.pixelSize > 0 ? r.d / f.pixelSize : null;
  }

  residual(g: GeorefGcp): { dx: number; dy: number; d: number } | null {
    return this.fit()?.byId.get(g.id) ?? null;
  }

  fmt(v: number, digits?: number): string {
    const d = digits ?? (this.units() === '°' ? 7 : 2);
    return v.toFixed(d);
  }

  constructor() {
    // Redraw markers when GCPs / selection / residuals change.
    effect(() => {
      this.gcps();
      this.selectedId();
      this.fit();
      this.pending();
      untracked(() => this.drawMarkers());
    });
    // Target CRS → load its proj4 definition.
    effect(() => {
      const crs = this.targetCrs();
      untracked(() => {
        this.crsReady.set(false);
        if (!crs) return;
        this.crsService.ensureRegistered(crs).subscribe((ok) => {
          if (crs !== this.targetCrs()) return;
          this.crsReady.set(ok);
          if (!ok) this.notify.error(`${crs} cannot be used in the browser.`, 'Target CRS');
        });
      });
    });
    // Projection detection: re-check whenever the GCPs or the CRS change.
    effect(() => {
      this.gcps();
      this.targetCrs();
      this.crsReady();
      untracked(() => {
        clearTimeout(this.suggestTimer);
        this.suggestTimer = setTimeout(() => this.detectProjection(), 400);
      });
    });
    effect(() => {
      const opacity = this.previewOpacity();
      untracked(() => this.previewLayer?.setOpacity(opacity));
    });
    effect(() => {
      const id = this.basemap();
      untracked(() => this.setBasemap(id));
    });
  }

  ngOnInit(): void {
    // Full-screen overlay: live under <body>, outside any transformed panel.
    document.body.appendChild(this.host.nativeElement);
  }

  ngAfterViewInit(): void {
    this.refMap = new OlMap({
      target: this.refEl.nativeElement,
      layers: [new VectorLayer({ source: this.refMarkers, zIndex: 10, style: (f) => this.markerStyle(f) })],
      view: new View({ center: fromLonLat([78.9629, 22.5937]), zoom: 4 }),
      controls: defaultControls({ attribution: true, rotate: false }).extend([new ScaleLine()])
    });
    this.setBasemap(this.basemap());
    this.refMap.on('singleclick', (e) => this.onRefClick(e.coordinate));
    const refDrag = new Translate({ layers: (l) => l.getSource() === this.refMarkers });
    refDrag.on('translateend', (e) => {
      const f = e.features.item(0);
      const [lon, lat] = toLonLat((f.getGeometry() as Point).getCoordinates());
      this.updateGcp(f.get('id'), { lon, lat });
    });
    this.refMap.addInteraction(refDrag);
    this.load();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    clearTimeout(this.saveTimer);
    clearTimeout(this.pollTimer);
    this.flushSave();
    this.imageMap?.setTarget(undefined);
    this.refMap?.setTarget(undefined);
    this.host.nativeElement.remove();
  }

  // ----- loading -----

  private load(): void {
    this.api.get(this.sessionId).subscribe({
      next: (s) => {
        if (this.destroyed) return;
        this.session.set(s);
        if (!this.outputName()) this.outputName.set(`${s.name} (georeferenced)`.slice(0, 80));
        if (s.status === 'processing') {
          this.pollTimer = setTimeout(() => this.load(), 2500);
          return;
        }
        if (s.status === 'failed') return;
        this.gcps.set(s.gcps ?? []);
        if (s.settings) {
          this.transform.set(s.settings.transform);
          this.resampling.set(s.settings.resampling);
          this.targetCrs.set(s.settings.targetCrs);
        }
        this.initImageMap(s);
        this.fitRefToGcps();
      },
      error: () => this.notify.error('Could not open this georeferencing session.')
    });
  }

  private initImageMap(s: GeorefSession): void {
    if (this.imageMap) return;
    const extent = [0, -s.height, s.width, 0];
    const projection = new Projection({ code: `georef-${s.id}`, units: 'pixels', extent });
    const resolutions = Array.from({ length: s.maxZoom + 1 }, (_, z) => 2 ** (s.maxZoom - z));
    const token = () => this.auth.getToken();
    const source = new XYZ({
      projection,
      tileGrid: new TileGrid({ extent, origin: [0, 0], resolutions, tileSize: 256 }),
      url: this.api.tileUrl(s.id),
      tileLoadFunction: (tile, src) => {
        const t = token();
        fetch(src, { headers: t ? { Authorization: `Bearer ${t}` } : {} })
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
          .then((blob) => {
            const img = (tile as ImageTile).getImage() as HTMLImageElement;
            const url = URL.createObjectURL(blob);
            img.onload = () => URL.revokeObjectURL(url);
            img.src = url;
          })
          .catch(() => tile.setState(TileState.ERROR));
      }
    });
    this.imageMap = new OlMap({
      target: this.imageEl.nativeElement,
      layers: [
        new TileLayer({ source }),
        new VectorLayer({ source: this.imageMarkers, zIndex: 10, style: (f) => this.markerStyle(f) })
      ],
      view: new View({
        projection,
        center: [s.width / 2, -s.height / 2],
        // Zoom in to 8× native for sub-pixel GCP placement.
        resolutions: [...resolutions.map((r) => r * 2).slice(0, 1), ...resolutions, 0.5, 0.25, 0.125],
        extent: [-s.width * 0.25, -s.height * 1.25, s.width * 1.25, s.height * 0.25],
        constrainOnlyCenter: true
      }),
      controls: defaultControls({ attribution: false, rotate: false })
    });
    this.imageMap.getView().fit(extent, { padding: [20, 20, 20, 20] });
    this.imageMap.on('singleclick', (e) => this.onImageClick(e.coordinate));
    const drag = new Translate({ layers: (l) => l.getSource() === this.imageMarkers });
    drag.on('translateend', (e) => {
      const f = e.features.item(0);
      if (f.get('pending')) {
        const [x, y] = (f.getGeometry() as Point).getCoordinates();
        this.pending.set({ px: x, py: -y });
        return;
      }
      const [x, y] = (f.getGeometry() as Point).getCoordinates();
      this.updateGcp(f.get('id'), { px: x, py: -y });
    });
    this.imageMap.addInteraction(drag);
    this.drawMarkers();
  }

  private setBasemap(id: string): void {
    if (!this.refMap || !BASEMAPS[id]) return;
    if (this.refBase) this.refMap.removeLayer(this.refBase);
    this.refBase = BASEMAPS[id].build();
    this.refBase.setZIndex(0);
    this.refMap.addLayer(this.refBase);
  }

  private fitRefToGcps(): void {
    const pts = this.gcps().map((g) => fromLonLat([g.lon, g.lat]));
    if (!this.refMap || pts.length === 0) return;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    this.refMap.getView().fit([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], { padding: [60, 60, 60, 60], maxZoom: 16 });
  }

  // ----- markers -----

  private markerStyle(f: FeatureLike): Style {
    const selected = f.get('id') === this.selectedId();
    const pending = !!f.get('pending');
    const bad = !!f.get('bad');
    const disabled = !!f.get('disabled');
    const color = pending ? '#f59e0b' : disabled ? '#9ca3af' : bad ? '#dc2626' : selected ? '#2563eb' : '#16a34a';
    return new Style({
      image: new CircleStyle({
        radius: selected || pending ? 8 : 6,
        fill: new Fill({ color: 'rgba(255,255,255,0.25)' }),
        stroke: new Stroke({ color, width: selected ? 3 : 2 })
      }),
      text: new TextStyle({
        text: pending ? '?' : String(f.get('label') ?? ''),
        offsetX: 12,
        offsetY: -12,
        font: '600 12px sans-serif',
        fill: new Fill({ color }),
        stroke: new Stroke({ color: '#fff', width: 3 })
      })
    });
  }

  private drawMarkers(): void {
    this.imageMarkers.clear();
    this.refMarkers.clear();
    this.gcps().forEach((g, i) => {
      const r = this.residualPx(g);
      const props = { id: g.id, label: i + 1, bad: r !== null && r > RESIDUAL_WARN_PX, disabled: !g.enabled };
      const img = new Feature({ geometry: new Point([g.px, -g.py]), ...props });
      const ref = new Feature({ geometry: new Point(fromLonLat([g.lon, g.lat])), ...props });
      this.imageMarkers.addFeature(img);
      this.refMarkers.addFeature(ref);
    });
    const p = this.pending();
    if (p) this.imageMarkers.addFeature(new Feature({ geometry: new Point([p.px, -p.py]), pending: true }));
  }

  // ----- adding / editing GCPs -----

  private onImageClick(coordinate: number[]): void {
    const s = this.session();
    if (!s || !this.addMode()) return;
    // Clicking an existing marker selects it instead of adding a point.
    const hit = this.imageMap?.forEachFeatureAtPixel(this.imageMap.getPixelFromCoordinate(coordinate), (f) => f, { hitTolerance: 4 });
    if (hit && hit.get('id')) {
      this.select(hit.get('id'));
      return;
    }
    const [x, y] = coordinate;
    if (x < 0 || -y < 0 || x > s.width || -y > s.height) return;
    this.pending.set({ px: x, py: -y });
    this.coordX = '';
    this.coordY = '';
    this.coordError = '';
    // Start from the previous point's whole degrees (sheet corners share them).
    const last = this.gcps()[this.gcps().length - 1];
    this.lonD = last ? String(Math.floor(Math.abs(last.lon))) : '';
    this.latD = last ? String(Math.floor(Math.abs(last.lat))) : '';
    this.lonM = this.lonS = this.latM = this.latS = '';
    if (last) {
      this.lonH = last.lon < 0 ? 'W' : 'E';
      this.latH = last.lat < 0 ? 'S' : 'N';
    }
  }

  private onRefClick(coordinate: number[]): void {
    const hit = this.refMap?.forEachFeatureAtPixel(this.refMap.getPixelFromCoordinate(coordinate), (f) => f, { hitTolerance: 4 });
    if (hit && hit.get('id') && !this.pending()) {
      this.select(hit.get('id'));
      return;
    }
    const p = this.pending();
    if (!p) return;
    const [lon, lat] = toLonLat(coordinate);
    this.addGcp(p.px, p.py, lon, lat);
  }

  /** Coordinates typed for the pending point: decimal / DMS lon-lat, or
   *  X / Y in the target CRS. */
  addTyped(): void {
    const p = this.pending();
    if (!p) return;
    this.coordError = '';
    let lon: number;
    let lat: number;
    if (this.coordMode === 'dms') {
      const part = (v: string, max: number) => {
        const n = v.trim() === '' ? 0 : Number(v.replace(',', '.'));
        return Number.isFinite(n) && n >= 0 && n < max ? n : NaN;
      };
      const lonDeg = part(this.lonD, 181);
      const latDeg = part(this.latD, 91);
      const values = [lonDeg, part(this.lonM, 60), part(this.lonS, 60), latDeg, part(this.latM, 60), part(this.latS, 60)];
      if (this.lonD.trim() === '' || this.latD.trim() === '' || values.some(Number.isNaN)) {
        this.coordError = 'Fill in the degrees; minutes and seconds must be 0–59 (leave them empty for 0).';
        return;
      }
      lon = (values[0] + values[1] / 60 + values[2] / 3600) * (this.lonH === 'W' ? -1 : 1);
      lat = (values[3] + values[4] / 60 + values[5] / 3600) * (this.latH === 'S' ? -1 : 1);
    } else if (this.coordMode === 'dd') {
      const a = parseDms(this.coordX);
      const b = parseDms(this.coordY);
      if (!a || !b) {
        this.coordError = 'Enter longitude and latitude as decimals (70.625) or DMS (70°37\'30"E).';
        return;
      }
      // N/S/E/W letters decide which value is which.
      [lon, lat] = a.axis === 'lat' || b.axis === 'lon' ? [b.deg, a.deg] : [a.deg, b.deg];
    } else {
      const x = Number(this.coordX.replace(',', '.'));
      const y = Number(this.coordY.replace(',', '.'));
      if (!this.targetCrs() || !this.crsReady() || !Number.isFinite(x) || !Number.isFinite(y)) {
        this.coordError = 'Choose the target CRS first, then enter X and Y as numbers.';
        return;
      }
      [lon, lat] = olTransform([x, y], this.targetCrs(), 'EPSG:4326');
    }
    if (!(Math.abs(lon) <= 180 && Math.abs(lat) <= 90)) {
      this.coordError = 'That position is outside the valid range.';
      return;
    }
    this.addGcp(p.px, p.py, lon, lat);
  }

  private addGcp(px: number, py: number, lon: number, lat: number): void {
    const gcp: GeorefGcp = { id: newGcpId(), enabled: true, px, py, lon, lat };
    this.gcps.update((list) => [...list, gcp]);
    this.pending.set(null);
    this.selectedId.set(gcp.id);
    // Show where the new point landed on the reference map.
    const view = this.refMap?.getView();
    if (view) {
      if (this.gcps().length === 1) view.animate({ center: fromLonLat([lon, lat]), zoom: Math.max(view.getZoom() ?? 0, 12), duration: 400 });
      else this.fitRefToGcps();
    }
    // First point: default the output to its UTM zone (WGS84).
    if (!this.targetCrs()) {
      const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
      this.targetCrs.set(`EPSG:${lat >= 0 ? 326 : 327}${String(zone).padStart(2, '0')}`);
    }
    this.changed();
  }

  cancelPending(): void {
    this.pending.set(null);
  }

  updateGcp(id: string, patch: Partial<GeorefGcp>): void {
    this.gcps.update((list) => list.map((g) => (g.id === id ? { ...g, ...patch } : g)));
    this.changed();
  }

  setCoord(g: GeorefGcp, key: 'px' | 'py' | 'lon' | 'lat', value: string): void {
    const n = Number(String(value).replace(',', '.'));
    if (Number.isFinite(n)) this.updateGcp(g.id, { [key]: n });
  }

  removeGcp(id: string): void {
    this.gcps.update((list) => list.filter((g) => g.id !== id));
    if (this.selectedId() === id) this.selectedId.set(null);
    this.changed();
  }

  removeAll(): void {
    this.notify.confirm({
      header: 'Delete all GCPs?',
      message: 'Every ground control point of this session will be removed.',
      confirmLabel: 'Delete all',
      destructive: true,
      accept: () => {
        this.gcps.set([]);
        this.selectedId.set(null);
        this.changed();
      }
    });
  }

  select(id: string): void {
    this.selectedId.set(id);
    const g = this.gcps().find((x) => x.id === id);
    if (!g) return;
    this.imageMap?.getView().animate({ center: [g.px, -g.py], duration: 250 });
    this.refMap?.getView().animate({ center: fromLonLat([g.lon, g.lat]), duration: 250 });
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if ((event.target as HTMLElement)?.closest('input, select, textarea')) return;
    if (event.key === 'Escape') {
      if (this.pending()) this.cancelPending();
      else this.close();
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedId()) {
      this.removeGcp(this.selectedId()!);
    }
  }

  // ----- projection detection -----

  /** A scanned map is drawn in some projection; an affine fit is only
   *  accurate in that same projection. With ≥ 4 GCPs, the affine fit is
   *  tried in likely CRSs (nearby UTM zones, lat/long, Web Mercator, India
   *  LCC) and the clearly better one is offered. */
  private detectProjection(): void {
    const enabled = this.gcps().filter((g) => g.enabled);
    const current = this.targetCrs();
    if (enabled.length < 4 || !current || !this.crsReady()) {
      this.crsSuggestion.set(null);
      return;
    }
    const lons = enabled.map((g) => g.lon);
    const south = enabled.reduce((s, g) => s + g.lat, 0) / enabled.length < 0;
    const zone = (lon: number) => Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
    const zones = new Set<number>();
    for (let z = zone(Math.min(...lons)) - 1; z <= zone(Math.max(...lons)) + 1; z++) if (z >= 1 && z <= 60) zones.add(z);
    const codes = [...new Set([current, 'EPSG:4326', 'EPSG:3857', 'EPSG:7755', ...[...zones].map((z) => `EPSG:${south ? 327 : 326}${String(z).padStart(2, '0')}`)])];
    let pending = codes.length;
    const ready: string[] = [];
    for (const code of codes) {
      this.crsService.ensureRegistered(code).subscribe({
        next: (ok) => ok && ready.push(code),
        error: () => --pending === 0 && this.scoreProjections(ready, enabled, current),
        complete: () => --pending === 0 && this.scoreProjections(ready, enabled, current)
      });
    }
  }

  private scoreProjections(codes: string[], enabled: GeorefGcp[], current: string): void {
    if (current !== this.targetCrs()) return;
    const rmsePx = (code: string): number | null => {
      try {
        const pairs = enabled.map((g) => {
          const [x, y] = olTransform([g.lon, g.lat], 'EPSG:4326', code);
          return { px: g.px, py: g.py, x, y };
        });
        const f = fitTransform('poly1', pairs);
        return f && f.pixelSize > 0 ? f.rmse / f.pixelSize : null;
      } catch {
        return null;
      }
    };
    const currentPx = rmsePx(current);
    let best: { code: string; px: number } | null = null;
    for (const code of codes) {
      const px = rmsePx(code);
      if (px !== null && (!best || px < best.px)) best = { code, px };
    }
    // Only suggest when it clearly matters (current fit poor, ≥ 2× better).
    const worth = best && currentPx !== null && best.code !== current && currentPx > 1 && best.px < currentPx / 2;
    this.crsSuggestion.set(worth ? { code: best!.code, px: best!.px, currentPx: currentPx! } : null);
  }

  useSuggestedCrs(): void {
    const s = this.crsSuggestion();
    if (!s) return;
    this.crsSuggestion.set(null);
    this.setTargetCrs(s.code);
    this.clearPreview();
  }

  // ----- settings / saving -----

  setTransform(value: GeorefTransform): void {
    this.transform.set(value);
    this.changed();
  }

  setResampling(value: GeorefResampling): void {
    this.resampling.set(value);
    this.changed();
  }

  setTargetCrs(value: string | null): void {
    this.targetCrs.set(value ?? '');
    this.changed();
  }

  private settings(): GeorefSettings | null {
    return this.targetCrs() ? { transform: this.transform(), resampling: this.resampling(), targetCrs: this.targetCrs() } : null;
  }

  /** Something changed: the preview is stale; save in a moment. */
  private changed(): void {
    this.saveState.set('unsaved');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 800);
  }

  private flushSave(): void {
    clearTimeout(this.saveTimer);
    const settings = this.settings();
    if (this.saveState() !== 'unsaved' || !this.session()) return;
    this.saveState.set('saving');
    this.api
      .save(this.sessionId, this.gcps(), settings ?? { transform: this.transform(), resampling: this.resampling(), targetCrs: 'EPSG:4326' })
      .subscribe({
        next: () => this.saveState() === 'saving' && this.saveState.set('saved'),
        error: () => this.saveState.set('unsaved')
      });
  }

  // ----- GCP files (QGIS .points) -----

  exportPoints(): void {
    const text = toPointsFile(this.gcps(), this.gcps().map((g) => this.residualPx(g)));
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.session()?.name ?? 'gcps'}.points`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  importPoints(): void {
    this.pointsFileEl.nativeElement.value = '';
    this.pointsFileEl.nativeElement.click();
  }

  onPointsFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    void file.text().then((text) => {
      const { points, crsWkt } = parsePointsFile(text);
      if (!points.length) {
        this.notify.error('No GCPs found in that file.', 'Import GCPs');
        return;
      }
      const geographic = !crsWkt || /GEOGCRS|GEOGCS|EPSG["',\s]*4326/i.test(crsWkt) || points.every((p) => Math.abs(p.mapX) <= 180 && Math.abs(p.mapY) <= 90);
      if (!geographic && (!this.targetCrs() || !this.crsReady())) {
        this.notify.error('The file uses projected coordinates — choose its CRS as the target CRS first, then import again.', 'Import GCPs');
        return;
      }
      const imported = points.map((p) => {
        const [lon, lat] = geographic ? [p.mapX, p.mapY] : olTransform([p.mapX, p.mapY], this.targetCrs(), 'EPSG:4326');
        return { id: newGcpId(), enabled: p.enabled, px: p.px, py: p.py, lon, lat };
      });
      this.gcps.update((list) => [...list, ...imported]);
      if (!this.targetCrs() && imported.length) {
        const g = imported[0];
        const zone = Math.min(60, Math.max(1, Math.floor((g.lon + 180) / 6) + 1));
        this.targetCrs.set(`EPSG:${g.lat >= 0 ? 326 : 327}${String(zone).padStart(2, '0')}`);
      }
      this.changed();
      this.fitRefToGcps();
      this.notify.success(`${imported.length} GCPs imported${geographic ? '' : ` (from ${this.targetCrs()})`}.`, 'Import GCPs');
    });
  }

  // ----- preview / run -----

  runPreview(): void {
    const settings = this.settings();
    if (!settings || !this.canRun()) return;
    this.previewing.set(true);
    this.api.preview(this.sessionId, this.gcps(), settings).subscribe({
      next: (p) => {
        this.previewing.set(false);
        this.preview.set(p);
        if (!this.refMap) return;
        if (this.previewLayer) this.refMap.removeLayer(this.previewLayer);
        this.previewLayer = new ImageLayer({
          source: new ImageStatic({ url: p.image, imageExtent: p.bounds, projection: 'EPSG:4326', interpolate: true }),
          opacity: this.previewOpacity(),
          zIndex: 5
        });
        this.refMap.addLayer(this.previewLayer);
        const [a, b, c, d] = p.bounds;
        this.refMap.getView().fit([...fromLonLat([a, b]), ...fromLonLat([c, d])], { padding: [30, 30, 30, 30] });
      },
      error: (err) => {
        this.previewing.set(false);
        this.notify.error(err?.error?.message ?? 'The preview could not be made.', 'Preview');
      }
    });
  }

  clearPreview(): void {
    if (this.previewLayer) this.refMap?.removeLayer(this.previewLayer);
    this.previewLayer = null;
    this.preview.set(null);
  }

  start(): void {
    const settings = this.settings();
    const name = this.outputName().trim();
    if (!settings || !this.canRun() || !name) return;
    this.flushSave();
    this.running.set(true);
    this.jobStage.set('Starting…');
    this.rasterApi
      .startJob('georeference', { sessionId: this.sessionId, gcps: this.gcps(), settings, outputName: name }, 'georef')
      .subscribe({
        next: (job) => this.pollJob(job.id),
        error: (err) => {
          this.running.set(false);
          this.notify.error(err?.error?.message ?? 'Georeferencing could not start.', 'Georeferencer');
        }
      });
  }

  private pollJob(id: string): void {
    this.rasterApi.job<{ layer: GisLayer; result: { rmse: number } }>(id).subscribe({
      next: (job) => {
        if (this.destroyed) return;
        this.jobStage.set(job.stage);
        if (job.status === 'done' && job.result) {
          this.running.set(false);
          this.layerCreated.emit(job.result.layer);
          this.notify.success(`"${job.result.layer.name}" was added to the map. Download it as GeoTIFF from Raster Analysis → Download Raster.`, 'Georeferenced');
          this.api.get(this.sessionId).subscribe((s) => this.session.set(s));
        } else if (job.status === 'failed' || job.status === 'cancelled') {
          this.running.set(false);
          this.notify.error(job.error ?? 'Georeferencing failed.', 'Georeferencer');
        } else {
          this.pollTimer = setTimeout(() => this.pollJob(id), 2000);
        }
      },
      error: () => {
        this.running.set(false);
        this.notify.error('Lost track of the georeferencing job — check Raster Analysis → History.');
      }
    });
  }

  close(): void {
    this.flushSave();
    this.closed.emit();
  }
}
