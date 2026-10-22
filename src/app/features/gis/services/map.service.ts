import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { AuthService } from '../../../core/services/auth.service';
import OlMap from 'ol/Map';
import View from 'ol/View';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import TileLayer from 'ol/layer/Tile';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import OSM from 'ol/source/OSM';
import XYZ from 'ol/source/XYZ';
import ImageWMS from 'ol/source/ImageWMS';
import TileWMS from 'ol/source/TileWMS';
import ImageStatic from 'ol/source/ImageStatic';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import WKT from 'ol/format/WKT';
import Draw, { createBox } from 'ol/interaction/Draw';
import Modify from 'ol/interaction/Modify';
import Snap from 'ol/interaction/Snap';
import DragPan from 'ol/interaction/DragPan';
import PointerInteraction from 'ol/interaction/Pointer';
import KeyboardPan from 'ol/interaction/KeyboardPan';
import Overlay from 'ol/Overlay';
import LineString from 'ol/geom/LineString';
import Polygon, { fromCircle } from 'ol/geom/Polygon';
import CircleGeom from 'ol/geom/Circle';
import { Fill, Stroke, Style, Circle as CircleStyle, Text as TextStyle } from 'ol/style';
import { getArea, getLength } from 'ol/sphere';
import { defaults as defaultControls } from 'ol/control';
import ScaleLine from 'ol/control/ScaleLine';
import MousePosition from 'ol/control/MousePosition';
import { createStringXY } from 'ol/coordinate';
import { fromLonLat, getPointResolution, toLonLat, transform, transformExtent } from 'ol/proj';
import { createEmpty, extend as extendExtent, isEmpty as isEmptyExtent } from 'ol/extent';
import type Geometry from 'ol/geom/Geometry';
import { forkJoin, map as rxMap, Observable, of } from 'rxjs';
import type { EventsKey } from 'ol/events';
import { unByKey } from 'ol/Observable';
import { environment } from '../../../../environments/environment';
import { SettingsService } from '../../../core/services/settings.service';
import { GisLayer } from '../../../core/models/gis-layer.model';
import { Sketch } from '../models/sketch.model';
import './projections';

const MAP_PROJECTION = 'EPSG:3857';
const LAYER_PROJECTION = 'EPSG:4326';

export type MeasureDrawType = 'LineString' | 'Polygon' | 'Circle';

/** Geodesic measurement of the geometry currently (or last) drawn by the
 *  Measurement Tool. All figures are SI — metres / square metres. */
export interface MeasureResult {
  type: MeasureDrawType;
  /** total line length, polygon perimeter, or circle circumference */
  lengthM: number;
  /** polygon or circle area (undefined for a line) */
  areaM2?: number;
  /** circle radius (undefined otherwise) */
  radiusM?: number;
  /** per-segment lengths for a line or a polygon ring */
  segmentsM: number[];
}

/** Generic fallback view (roughly India) used only when no layer on this
 *  municipality's workspace has a usable bounding box yet (e.g. a freshly
 *  registered municipality with no demo data seeded) — see Task 6 §5: the
 *  view must never be a hardcoded Somnath-specific coordinate. */
const FALLBACK_CENTER_4326: [number, number] = [78.9629, 22.5937];
const FALLBACK_ZOOM = 4;

/** MultiBuffer ring colours, innermost first (violet, matching the
 *  analysis overlay). Shared with the Buffer panel's colour key. */
export const RING_COLORS = ['#4a2f86', '#6b4fa8', '#8a6fc4', '#a991da', '#c6b4ea', '#e0d5f5'];

/** Views remembered by Nav History (back/forward). */
const NAV_HISTORY_LIMIT = 50;
/** Zoom Go To X:Y animates to (never zooms *out* past the current zoom). */
const GOTO_ZOOM = 17;

interface NavHistoryEntry {
  center: [number, number];
  zoom: number;
  rotation: number;
}

export interface FeatureInfoFeature {
  attributes: Record<string, unknown>;
  /** stable WFS/WMS feature id (e.g. "wards.5"), when GeoServer supplies one */
  id?: string;
  /** GeoJSON geometry as returned by GetFeatureInfo (map projection) */
  geometry?: Record<string, unknown> | null;
}

export interface FeatureInfoResult {
  layer: GisLayer;
  features: FeatureInfoFeature[];
}

/** Drives the on-map Identify popup (an OpenLayers `Overlay`). `null` = the
 *  popup is hidden. */
export interface FeatureInfoPopupState {
  loading: boolean;
  error: string | null;
  results: FeatureInfoResult[];
}

interface ManagedLayer {
  layer: GisLayer;
  /** Vector layers: one untiled WMS image; rasters: cached GWC tiles. */
  olLayer: ImageLayer<ImageWMS> | TileLayer<TileWMS>;
}

export interface BasemapOption {
  id: string;
  label: string;
  attribution: string;
}

/** One visible WMS layer as the Print Layout panel needs to describe it to
 *  the backend — id only (the backend resolves the GeoServer name), plus
 *  the live opacity and any CQL filter currently applied. */
export interface PrintLayerContext {
  layerId: string;
  opacity: number;
  cqlFilter: string | null;
}

/** Everything the Print Layout panel needs to reproduce the live view on
 *  paper: the current extent expressed as centre + true map scale (so the
 *  printed resolution matches the screen), the rotation, the visible
 *  layers top-first, and which basemap is active. */
export interface PrintMapContext {
  projection: 'EPSG:3857';
  center: [number, number];
  /** Real-world scale denominator (1 : N) at the view centre. */
  scale: number;
  rotation: number;
  layers: PrintLayerContext[];
  basemapId: string;
}

/** Task 9 §7/§16: open-source/public tile sources only — no commercial
 *  provider is ever required for the map to function, and none of these
 *  need an API key/token (OSM stays the default). Esri's ArcGIS Online
 *  "World_Imagery"/"World_Street_Map" services are free, anonymous XYZ
 *  endpoints — the same satellite/street basemaps Esri's own products
 *  use — suitable for a non-production demo/dev deployment like the
 *  others here. Note Esri's tile path is `{z}/{y}/{x}` (y before x),
 *  unlike every other entry below. */
const BASEMAPS: Record<string, { label: string; attribution: string; build: () => TileLayer<OSM | XYZ> }> = {
  osm: {
    label: 'OpenStreetMap',
    attribution: '© OpenStreetMap contributors',
    build: () => new TileLayer({ source: new OSM() })
  },
  'esri-imagery': {
    label: 'Satellite (Esri)',
    attribution: 'Esri, Maxar, Earthstar Geographics, and the GIS community',
    build: () =>
      new TileLayer({
        source: new XYZ({
          url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          attributions: 'Esri, Maxar, Earthstar Geographics, and the GIS community',
          maxZoom: 19
        })
      })
  },
  'esri-streets': {
    label: 'Streets (Esri)',
    attribution: 'Esri, HERE, Garmin, FAO, NOAA, USGS',
    build: () =>
      new TileLayer({
        source: new XYZ({
          url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
          attributions: 'Esri, HERE, Garmin, FAO, NOAA, USGS',
          maxZoom: 19
        })
      })
  },
  'carto-voyager': {
    label: 'Voyager (CARTO)',
    attribution: '© OpenStreetMap contributors © CARTO',
    build: () =>
      new TileLayer({
        source: new XYZ({
          url: 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
          attributions: '© OpenStreetMap contributors © CARTO',
          maxZoom: 20
        })
      })
  },
  'carto-dark': {
    label: 'Dark (CARTO)',
    attribution: '© OpenStreetMap contributors © CARTO',
    build: () =>
      new TileLayer({
        source: new XYZ({
          url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
          attributions: '© OpenStreetMap contributors © CARTO',
          maxZoom: 20
        })
      })
  },
  topo: {
    label: 'Topographic',
    attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
    build: () =>
      new TileLayer({
        source: new XYZ({
          url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
          attributions: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
          maxZoom: 17
        })
      })
  }
};

/**
 * Thin, isolated wrapper around one OpenLayers `Map` instance. Owns
 * everything OpenLayers-specific (layer creation, WMS URLs, GetFeatureInfo
 * requests) so the components that display map state (layer-panel,
 * feature-info, map-controls, legend) never need to import `ol` directly —
 * they read/react through this service's signals and call its methods.
 *
 * Registered as a component-level provider on the page hosting the map
 * (one Map instance per /gis visit), not `providedIn: 'root'`.
 */
@Injectable()
export class MapService {
  private map: OlMap | null = null;
  private readonly settings = inject(SettingsService);
  /** Settings → Default Layer Visibility as last applied to the map. */
  private appliedVisibilityOverrides: Record<string, boolean> = {};

  constructor() {
    // A changed per-layer default takes effect on the open map right away
    // (the workspace is kept alive, so initMap won't run again).
    effect(() => {
      const overrides = this.settings.map().layerVisibility ?? {};
      untracked(() => {
        const previous = this.appliedVisibilityOverrides;
        this.appliedVisibilityOverrides = { ...overrides };
        for (const { layer } of this.managedLayers.values()) {
          if (overrides[layer.code] !== previous[layer.code]) {
            this.setLayerVisibility(layer.id, this.defaultVisible(layer));
          }
        }
      });
    });
  }

  /** A layer's start-up visibility: the user's Settings override (keyed by
   *  layer code) wins over the layer's own `visibleByDefault`. */
  private defaultVisible(layer: GisLayer): boolean {
    const overrides = this.settings.map().layerVisibility ?? {};
    return layer.code in overrides ? overrides[layer.code] : layer.visibleByDefault;
  }
  private baseLayer: TileLayer<OSM | XYZ> | null = null;
  private readonly managedLayers = new Map<string, ManagedLayer>();
  private readonly auth = inject(AuthService);
  /** Draw order of the data layers, top first. Rasters default to the
   *  bottom so they never hide vector data; the user can reorder. */
  readonly layerOrder = signal<string[]>([]);
  private initialExtent3857: number[] | null = null;

  /** Overlay that draws the attribute table's currently-selected features
   *  on top of everything else. Created lazily on first selection. */
  private selectionLayer: VectorLayer<VectorSource> | null = null;
  /** Overlay for Query Builder results (distinct colour from selection). */
  private queryLayer: VectorLayer<VectorSource> | null = null;
  /** Overlay for Buffer / Overlay analysis output. */
  private analysisLayer: VectorLayer<VectorSource> | null = null;
  private readonly wkt = new WKT();
  /** Sketch layer + active interaction for "draw geometry for spatial query". */
  private drawLayer: VectorLayer<VectorSource> | null = null;
  private drawInteraction: Draw | null = null;
  private readonly geoJson = new GeoJSON();

  /** Dedicated measurement layer/overlays — never touches the GIS layers. */
  private measureLayer: VectorLayer<VectorSource> | null = null;
  private measureDraw: Draw | null = null;
  private measureGeomListener: (() => void) | null = null;
  private measureTooltip: Overlay | null = null;
  private measureSegments: Overlay[] = [];
  /** epoch ms until which map single-clicks are ignored — covers the
   *  trailing click that ends a draw/measure gesture. */
  private suppressClickUntil = 0;
  /** True while the Measurement tool panel is open — Identify (map-click
   *  feature info) is fully disabled for that whole time, not just while a
   *  measurement is actively being drawn. */
  private measureModeActive = false;

  /** On-map Identify popup (OpenLayers `Overlay`). The element is owned by
   *  MunicipalMapComponent; this service positions it and holds its state. */
  private featurePopupOverlay: Overlay | null = null;
  readonly featureInfoPopup = signal<FeatureInfoPopupState | null>(null);

  /** Geometries (EPSG:4326) of the currently highlighted/selected features —
   *  read by the Query Builder for "use current selection as spatial input". */
  readonly selectionGeometries = signal<Record<string, unknown>[]>([]);

  /** Current visibility per GisLayer.id, seeded from visibleByDefault —
   *  the single source of truth the layer panel binds its checkboxes to. */
  readonly layerVisibility = signal<Record<string, boolean>>({});

  /** Task 9 §7: which open/public basemap is currently active. */
  readonly activeBasemap = signal<string>('osm');

  /** Nav History availability, for the back/forward buttons. */
  readonly canGoBack = signal(false);
  /** Bumped after every pan / zoom / rotate, for readouts that follow the view. */
  readonly viewRevision = signal(0);
  readonly canGoForward = signal(false);
  private navHistory: NavHistoryEntry[] = [];
  private navIndex = -1;

  private gotoLayer: VectorLayer<VectorSource> | null = null;
  private sketchLayer: VectorLayer<VectorSource> | null = null;
  readonly basemapOptions: BasemapOption[] = Object.entries(BASEMAPS).map(([id, def]) => ({
    id,
    label: def.label,
    attribution: def.attribution
  }));

  /**
   * @param statusTargets optional DOM elements to render the scale bar and
   *   cursor-coordinate readout into (the GIS workspace docks them in its
   *   status bar). When omitted they render in OL's own overlay container,
   *   floating on the map (used by the upload-wizard preview).
   */
  initMap(
    target: HTMLElement,
    layers: GisLayer[],
    statusTargets: { scaleLineTarget?: HTMLElement; mousePositionTarget?: HTMLElement } = {}
  ): void {
    this.baseLayer = BASEMAPS['osm'].build();
    this.activeBasemap.set('osm');

    const view = new View({ center: fromLonLat(FALLBACK_CENTER_4326), zoom: FALLBACK_ZOOM });

    this.map = new OlMap({
      target,
      layers: [this.baseLayer],
      view,
      // Custom zoom buttons are provided by MapControlsComponent instead
      // of OL's default corner control, for consistent PrimeNG styling —
      // but attribution stays (required by OpenStreetMap's usage policy).
      // ScaleLine and MousePosition are kept as OL's own lightweight
      // controls (Task 9 §8/§9) rather than reimplemented.
      controls: defaultControls({ zoom: false, rotate: false }).extend([
        new ScaleLine({ className: 'gis-scale-line', units: 'metric', target: statusTargets.scaleLineTarget }),
        new MousePosition({
          className: 'gis-mouse-position',
          coordinateFormat: createStringXY(5),
          projection: 'EPSG:4326',
          placeholder: '',
          target: statusTargets.mousePositionTarget
        })
      ])
    });

    const initialVisibility: Record<string, boolean> = {};
    const sortedLayers = [...layers].sort((a, b) => a.displayOrder - b.displayOrder);
    for (const layer of sortedLayers) {
      initialVisibility[layer.id] = this.defaultVisible(layer);
      this.addWmsLayer(layer);
    }
    this.layerVisibility.set(initialVisibility);
    this.applyLayerOrder();

    this.initialExtent3857 = this.computeInitialExtent(layers);
    this.resetNavHistory();
    this.map.on('moveend', () => {
      this.recordView();
      this.viewRevision.update((n) => n + 1);
    });
    this.resetView();
    this.setPanEnabled(this.panEnabled);
  }

  destroy(): void {
    this.cancelDraw();
    this.clearMeasure();
    this.map?.setTarget(undefined);
    this.map = null;
    this.managedLayers.clear();
    this.selectionLayer = null;
    this.queryLayer = null;
    this.analysisLayer = null;
    this.drawLayer = null;
    this.editLayer = null;
    this.editModify = null;
    this.editSnap = null;
    this.editPickKey = null;
    this.measureLayer = null;
    this.gotoLayer = null;
    this.sketchLayer = null;
    this.resetNavHistory();
    this.featurePopupOverlay = null;
    this.featureInfoPopup.set(null);
    this.measureModeActive = false;
    this.selectionGeometries.set([]);
  }

  /** Re-measures the map container — call after a dock panel opens, closes,
   *  or is resized so OpenLayers repaints at the new size. */
  updateSize(): void {
    this.map?.updateSize();
  }

  // ----- attribute-table selection sync -----

  /** Replaces the highlighted-feature overlay with `geometries` (GeoJSON,
   *  EPSG:4326). Empty array clears it. */
  setSelectionHighlight(geometries: (Record<string, unknown> | null | undefined)[]): void {
    const source = this.ensureSelectionSource();
    source.clear();
    const kept: Record<string, unknown>[] = [];
    for (const geometry of geometries) {
      const feature = this.toMapFeature(geometry);
      if (feature && geometry) {
        source.addFeature(feature);
        kept.push(geometry);
      }
    }
    this.selectionGeometries.set(kept);
  }

  clearSelectionHighlight(): void {
    this.selectionLayer?.getSource()?.clear();
    this.selectionGeometries.set([]);
  }

  // ----- query builder: WMS filter, result highlight, draw -----

  /** Applies (or clears with `null`) an ECQL filter on a layer's WMS render
   *  — GeoServer only paints matching features. */
  setLayerCqlFilter(layerId: string, cql: string | null): void {
    const entry = this.managedLayers.get(layerId);
    const source = entry?.olLayer.getSource();
    if (!source) return;
    const params = { ...source.getParams() };
    const wanted = cql && cql.trim().length > 0 ? cql : null;
    if ((params['CQL_FILTER'] ?? null) === wanted) return;
    if (wanted) {
      params['CQL_FILTER'] = wanted;
    } else {
      delete params['CQL_FILTER'];
    }
    // `updateParams` only *merges* — Object.assign(this.params_, params) — so a
    // key that was dropped from the copy above is never actually removed from
    // the source, leaving the layer stuck on its last filter. `setParams`
    // replaces the param object wholesale (and resets the loader), so clearing
    // a filter really does bring the full layer back.
    source.setParams(params);
  }

  clearAllLayerCqlFilters(): void {
    for (const [id] of this.managedLayers) {
      this.setLayerCqlFilter(id, null);
    }
  }

  // ----- layer styling -----

  /** Forces a WMS layer to re-fetch from GeoServer — call after its style
   *  changes server-side so the styled render replaces the cached tiles.
   *  Works for a managed GIS layer id or the wizard's `preview` layer. */
  refreshLayerStyle(layerId: string): void {
    const source = this.managedLayers.get(layerId)?.olLayer.getSource();
    source?.updateParams({ _style: Date.now() });
  }

  // ----- buffer / overlay analysis -----

  /** WKT for a GeoJSON geometry, reprojected `sourceProj` → `targetProj`. */
  wktFromGeoJson(
    geojson: Record<string, unknown>,
    sourceProj = LAYER_PROJECTION,
    targetProj = MAP_PROJECTION
  ): string {
    const geometry = this.geoJson.readGeometry(geojson, {
      dataProjection: sourceProj,
      featureProjection: targetProj
    });
    return this.wkt.writeGeometry(geometry);
  }

  /** Selection Tool: a drawn EPSG:4326 shape as compact EPSG:4326 WKT —
   *  simplified to ~2 px at the current zoom (a freehand lasso carries
   *  hundreds of vertices) and rounded to 6 decimals (~0.1 m), so the
   *  INTERSECTS filter fits comfortably in a WFS GET URL. */
  shapeToQueryWkt(geojson: Record<string, unknown>): string {
    const geometry = this.geoJson.readGeometry(geojson, {
      dataProjection: LAYER_PROJECTION,
      featureProjection: MAP_PROJECTION
    });
    const tolerance = (this.map?.getView().getResolution() ?? 1) * 2;
    return this.wkt.writeGeometry(geometry.simplify(tolerance), {
      dataProjection: LAYER_PROJECTION,
      featureProjection: MAP_PROJECTION,
      decimals: 6
    });
  }

  /** Reprojects a GeoJSON geometry `sourceProj` → `targetProj`. */
  reprojectGeoJson(
    geojson: Record<string, unknown>,
    sourceProj: string,
    targetProj: string
  ): Record<string, unknown> {
    const geometry = this.geoJson.readGeometry(geojson, {
      dataProjection: sourceProj,
      featureProjection: targetProj
    });
    return this.geoJson.writeGeometryObject(geometry) as Record<string, unknown>;
  }

  /** Approx. latitude (degrees) of a GeoJSON geometry's centre — for the
   *  Web-Mercator distance correction used when buffering. */
  centreLatitude(geojson: Record<string, unknown>, sourceProj = LAYER_PROJECTION): number {
    const geometry = this.geoJson.readGeometry(geojson, {
      dataProjection: sourceProj,
      featureProjection: LAYER_PROJECTION
    });
    const extent = geometry.getExtent();
    return (extent[1] + extent[3]) / 2;
  }

  /** Draws (or clears with `null`) the analysis result geometry — a
   *  distinct violet overlay above everything else. `geojson` is EPSG:4326. */
  setAnalysisGeometry(geojson: Record<string, unknown> | null): void {
    const source = this.ensureAnalysisSource();
    source.clear();
    const feature = this.toMapFeature(geojson);
    if (feature) {
      source.addFeature(feature);
    }
  }

  /** Network result (route / nearest facility / trace): bold blue lines
   *  with a white casing so they stand out over any road layer, the first
   *  point as a green start marker and the rest as red end markers.
   *  `lines` and `points` are EPSG:4326. */
  setAnalysisRoute(
    lines: [number, number][][],
    points: [number, number][],
    /** Other routes, drawn thinner and fainter underneath in their colour. */
    alternatives: { lines: [number, number][][]; color: string }[] = [],
    color = '#1d4ed8'
  ): void {
    const source = this.ensureAnalysisSource();
    source.clear();
    for (const alt of alternatives) {
      const feature = this.toMapFeature({ type: 'MultiLineString', coordinates: alt.lines });
      if (!feature) continue;
      feature.setStyle([
        new Style({ stroke: new Stroke({ color: '#ffffff', width: 6, lineCap: 'round', lineJoin: 'round' }), zIndex: 0 }),
        new Style({ stroke: new Stroke({ color: `${alt.color}b3`, width: 3.5, lineCap: 'round', lineJoin: 'round', lineDash: [8, 6] }), zIndex: 0 })
      ]);
      source.addFeature(feature);
    }
    const path = this.toMapFeature({ type: 'MultiLineString', coordinates: lines });
    if (path) {
      path.setStyle([
        new Style({ stroke: new Stroke({ color: '#ffffff', width: 9, lineCap: 'round', lineJoin: 'round' }), zIndex: 1 }),
        new Style({ stroke: new Stroke({ color, width: 5, lineCap: 'round', lineJoin: 'round' }), zIndex: 2 })
      ]);
      source.addFeature(path);
    }
    points.forEach((point, index) => {
      const marker = this.toMapFeature({ type: 'Point', coordinates: point });
      if (!marker) return;
      const start = index === 0;
      marker.setStyle(
        new Style({
          image: new CircleStyle({
            radius: 9,
            fill: new Fill({ color: start ? '#16a34a' : '#dc2626' }),
            stroke: new Stroke({ color: '#ffffff', width: 2.5 })
          }),
          text: new TextStyle({
            text: start ? 'A' : points.length === 2 ? 'B' : String(index),
            font: '700 11px sans-serif',
            fill: new Fill({ color: '#ffffff' })
          }),
          zIndex: 3
        })
      );
      source.addFeature(marker);
    });
  }

  /** Routing result: every route (the active one bold on top, the others
   *  dashed), lettered stop markers, and avoid areas / blocked roads in
   *  red. Stops and the active route can be dragged (see enableRouteDrag).
   *  All coordinates EPSG:4326. */
  setRoutingView(view: {
    routes: { lines: [number, number][][]; color: string; active: boolean }[];
    stops: { at: [number, number]; label: string; index: number; role: 'start' | 'via' | 'end' }[];
    avoidAreas: [number, number][][];
    avoidPoints: [number, number][];
  }): void {
    const source = this.ensureAnalysisSource();
    source.clear();
    const red = '#dc2626';
    for (const ring of view.avoidAreas) {
      const area = this.toMapFeature({ type: 'Polygon', coordinates: [ring] });
      if (!area) continue;
      area.setStyle(
        new Style({
          stroke: new Stroke({ color: red, width: 2, lineDash: [6, 4] }),
          fill: new Fill({ color: 'rgba(220, 38, 38, 0.12)' }),
          zIndex: 0
        })
      );
      source.addFeature(area);
    }
    for (const route of [...view.routes].sort((a, b) => Number(a.active) - Number(b.active))) {
      const feature = this.toMapFeature({ type: 'MultiLineString', coordinates: route.lines });
      if (!feature) continue;
      feature.set('routeRole', route.active ? 'route' : 'alternative');
      feature.setStyle(
        route.active
          ? [
              new Style({ stroke: new Stroke({ color: '#ffffff', width: 9, lineCap: 'round', lineJoin: 'round' }), zIndex: 2 }),
              new Style({ stroke: new Stroke({ color: route.color, width: 5, lineCap: 'round', lineJoin: 'round' }), zIndex: 3 })
            ]
          : [
              new Style({ stroke: new Stroke({ color: '#ffffff', width: 6, lineCap: 'round', lineJoin: 'round' }), zIndex: 1 }),
              new Style({ stroke: new Stroke({ color: `${route.color}b3`, width: 3.5, lineCap: 'round', lineJoin: 'round', lineDash: [8, 6] }), zIndex: 1 })
            ]
      );
      source.addFeature(feature);
    }
    for (const point of view.avoidPoints) {
      const block = this.toMapFeature({ type: 'Point', coordinates: point });
      if (!block) continue;
      block.setStyle(
        new Style({
          image: new CircleStyle({ radius: 8, fill: new Fill({ color: red }), stroke: new Stroke({ color: '#fff', width: 2 }) }),
          text: new TextStyle({ text: '✕', font: '700 10px sans-serif', fill: new Fill({ color: '#fff' }) }),
          zIndex: 4
        })
      );
      source.addFeature(block);
    }
    for (const stop of view.stops) {
      const marker = this.toMapFeature({ type: 'Point', coordinates: stop.at });
      if (!marker) continue;
      marker.set('routeRole', 'stop');
      marker.set('stopIndex', stop.index);
      marker.setStyle(
        new Style({
          image: new CircleStyle({
            radius: 10,
            fill: new Fill({ color: stop.role === 'start' ? '#16a34a' : stop.role === 'end' ? '#dc2626' : '#ea580c' }),
            stroke: new Stroke({ color: '#ffffff', width: 2.5 })
          }),
          text: new TextStyle({ text: stop.label, font: '700 11px sans-serif', fill: new Fill({ color: '#ffffff' }) }),
          zIndex: 5
        })
      );
      source.addFeature(marker);
    }
  }

  private routeDrag: { interaction: PointerInteraction; moveKey: EventsKey } | null = null;

  /** Lets the user drag a stop marker (moves it) or the active route
   *  (adds a via point where it is dropped) on the routing view. `grab` /
   *  `drop` are EPSG:4326. Returns a function that turns it off. */
  enableRouteDrag(onDrop: (target: { stopIndex: number | null; grab: [number, number]; drop: [number, number] }) => void): () => void {
    this.disableRouteDrag();
    const map = this.map;
    if (!map) return () => undefined;
    const source = this.ensureAnalysisSource();
    const hit = (pixel: number[]) =>
      map.forEachFeatureAtPixel(pixel, (f) => (f.get('routeRole') === 'stop' || f.get('routeRole') === 'route' ? (f as Feature) : undefined), {
        layerFilter: (layer) => layer === this.analysisLayer,
        hitTolerance: 6
      });
    let grabbed: { stopIndex: number | null; grab: [number, number] } | null = null;
    let ghost: Feature<Point> | null = null;
    const interaction = new PointerInteraction({
      handleDownEvent: (event) => {
        if (this.drawInteraction) return false;
        const feature = hit(event.pixel);
        if (!feature) return false;
        const index = feature.get('stopIndex');
        grabbed = { stopIndex: typeof index === 'number' ? index : null, grab: toLonLat(event.coordinate) as [number, number] };
        ghost = new Feature(new Point(event.coordinate));
        ghost.setStyle(
          new Style({
            image: new CircleStyle({ radius: 8, fill: new Fill({ color: 'rgba(29, 78, 216, 0.35)' }), stroke: new Stroke({ color: '#1d4ed8', width: 2 }) }),
            zIndex: 6
          })
        );
        source.addFeature(ghost);
        return true;
      },
      handleDragEvent: (event) => {
        ghost?.getGeometry()?.setCoordinates(event.coordinate);
      },
      handleUpEvent: (event) => {
        if (ghost) source.removeFeature(ghost);
        ghost = null;
        const target = grabbed;
        grabbed = null;
        if (target) onDrop({ ...target, drop: toLonLat(event.coordinate) as [number, number] });
        return false;
      }
    });
    map.addInteraction(interaction);
    const moveKey = map.on('pointermove', (event) => {
      if (event.dragging || this.drawInteraction) return;
      const over = !!hit(event.pixel);
      map.getTargetElement().style.cursor = over ? 'grab' : '';
    });
    this.routeDrag = { interaction, moveKey };
    return () => this.disableRouteDrag();
  }

  disableRouteDrag(): void {
    if (!this.routeDrag) return;
    this.map?.removeInteraction(this.routeDrag.interaction);
    unByKey(this.routeDrag.moveKey);
    const target = this.map?.getTargetElement();
    if (target) target.style.cursor = '';
    this.routeDrag = null;
  }

  private previewLayer: ImageLayer<ImageStatic> | null = null;

  /** Raster quick-look (e.g. a Sentinel-2 scene before download): a static
   *  image stretched over an EPSG:4326 bbox, just above the data layers. */
  setPreviewImage(url: string, bbox: [number, number, number, number]): void {
    if (!this.map) return;
    this.clearPreviewImage();
    this.previewLayer = new ImageLayer({
      source: new ImageStatic({ url, imageExtent: bbox, projection: LAYER_PROJECTION, interpolate: true }),
      properties: { preview: true }
    });
    const layers = this.map.getLayers();
    layers.insertAt(Math.min(this.managedLayers.size + 1, layers.getLength()), this.previewLayer);
  }

  clearPreviewImage(): void {
    if (this.previewLayer) this.map?.removeLayer(this.previewLayer);
    this.previewLayer = null;
  }

  clearAnalysisGeometry(): void {
    this.analysisLayer?.getSource()?.clear();
  }

  /** MultiBuffer: concentric buffers (EPSG:4326 GeoJSON, innermost first)
   *  drawn as graduated bands on the analysis overlay — inner rings on top,
   *  each in its RING_COLORS shade. Replaces whatever was there. */
  setAnalysisRings(rings: Record<string, unknown>[]): void {
    const source = this.ensureAnalysisSource();
    source.clear();
    rings.forEach((geojson, index) => {
      const feature = this.toMapFeature(geojson);
      if (!feature) return;
      const color = RING_COLORS[Math.min(index, RING_COLORS.length - 1)];
      feature.setStyle(
        new Style({
          stroke: new Stroke({ color, width: 2 }),
          fill: new Fill({ color: `${color}26` }),
          zIndex: rings.length - index
        })
      );
      source.addFeature(feature);
    });
  }

  private ensureAnalysisSource(): VectorSource {
    if (!this.analysisLayer) {
      const violet = '#6b4fa8';
      this.analysisLayer = new VectorLayer({
        source: new VectorSource(),
        style: new Style({
          stroke: new Stroke({ color: violet, width: 2.5 }),
          fill: new Fill({ color: 'rgba(107, 79, 168, 0.15)' }),
          image: new CircleStyle({
            radius: 6,
            stroke: new Stroke({ color: violet, width: 2.5 }),
            fill: new Fill({ color: 'rgba(107, 79, 168, 0.3)' })
          })
        }),
        zIndex: 9997,
        properties: { analysisOverlay: true }
      });
      this.map?.addLayer(this.analysisLayer);
    }
    return this.analysisLayer.getSource() as VectorSource;
  }

  /** `append` keeps the shapes already highlighted (AI Assistant setting
   *  "Clear previous results" off). */
  setQueryHighlight(geometries: (Record<string, unknown> | null | undefined)[], append = false): void {
    const source = this.ensureQuerySource();
    if (!append) source.clear();
    for (const geometry of geometries) {
      const feature = this.toMapFeature(geometry);
      if (feature) source.addFeature(feature);
    }
  }

  clearQueryHighlight(): void {
    this.queryLayer?.getSource()?.clear();
  }

  /** Lets the user draw one geometry for a spatial query. Emits the drawn
   *  shape as GeoJSON (EPSG:4326) and keeps it on screen; complete /
   *  `cancelDraw` / `clearDraw` remove it. */
  beginDraw(
    kind: 'Point' | 'Line' | 'Rectangle' | 'Polygon' | 'Circle' | 'Freehand' | 'Lasso'
  ): Observable<Record<string, unknown>> {
    this.cancelDraw();
    this.stopMeasure();
    const source = this.ensureDrawSource();
    source.clear();

    const type =
      kind === 'Point'
        ? 'Point'
        : kind === 'Line' || kind === 'Freehand'
          ? 'LineString'
          : kind === 'Rectangle' || kind === 'Circle'
            ? 'Circle'
            : 'Polygon'; // Polygon, Lasso (freehand polygon)

    return new Observable<Record<string, unknown>>((subscriber) => {
      this.drawInteraction = new Draw({
        source,
        type,
        freehand: kind === 'Freehand' || kind === 'Lasso',
        geometryFunction: kind === 'Rectangle' ? createBox() : undefined
      });
      this.drawInteraction.on('drawstart', () => source.clear());
      this.drawInteraction.on('drawend', (event) => {
        this.suppressClickUntil = Date.now() + 400;
        const drawn = (event as unknown as { feature: Feature }).feature.getGeometry();
        // GeoJSON has no circle type — a drawn circle becomes a 64-gon.
        const geom = drawn instanceof CircleGeom ? fromCircle(drawn, 64) : drawn;
        if (geom) {
          const geojson = this.geoJson.writeGeometryObject(geom, {
            dataProjection: LAYER_PROJECTION,
            featureProjection: MAP_PROJECTION
          });
          subscriber.next(geojson as Record<string, unknown>);
        }
        this.cancelDraw();
        subscriber.complete();
      });
      this.map?.addInteraction(this.drawInteraction);
      return () => this.cancelDraw();
    });
  }

  cancelDraw(): void {
    if (this.drawInteraction && this.map) {
      this.map.removeInteraction(this.drawInteraction);
    }
    this.drawInteraction = null;
  }

  clearDraw(): void {
    this.cancelDraw();
    this.drawLayer?.getSource()?.clear();
  }

  // ----- feature editing -----

  private editLayer: VectorLayer<VectorSource> | null = null;
  private editModify: Modify | null = null;
  private editSnap: Snap | null = null;
  private editPickKey: EventsKey | null = null;
  /** Bumped whenever the user moves a vertex of the feature being edited. */
  readonly editGeometryRevision = signal(0);

  /** Shows one feature (GeoJSON, EPSG:4326) as the edit target; with
   *  `editable` its vertices can be dragged (snapping to itself). */
  setEditFeature(geojson: Record<string, unknown> | null, editable = true): void {
    const source = this.ensureEditSource();
    this.stopEditInteractions();
    source.clear();
    if (!geojson) return;
    const geometry = this.geoJson.readGeometry(geojson, {
      dataProjection: LAYER_PROJECTION,
      featureProjection: MAP_PROJECTION
    });
    source.addFeature(new Feature(geometry));
    if (!editable || !this.map) return;
    this.editModify = new Modify({ source });
    this.editModify.on('modifyend', () => this.editGeometryRevision.update((n) => n + 1));
    this.editSnap = new Snap({ source });
    this.map.addInteraction(this.editModify);
    this.map.addInteraction(this.editSnap);
  }

  /** The edit target's current geometry as GeoJSON (EPSG:4326). */
  getEditGeometry(): Record<string, unknown> | null {
    const geometry = this.editLayer?.getSource()?.getFeatures()[0]?.getGeometry();
    return geometry
      ? (this.geoJson.writeGeometryObject(geometry, {
          dataProjection: LAYER_PROJECTION,
          featureProjection: MAP_PROJECTION
        }) as Record<string, unknown>)
      : null;
  }

  clearEditFeature(): void {
    this.stopEditInteractions();
    this.editLayer?.getSource()?.clear();
  }

  /** One map click → its EPSG:4326 position and a ~8 px pick tolerance in
   *  metres. Identify is suppressed for that click. */
  pickMapPoint(): Observable<{ lonLat: [number, number]; toleranceM: number }> {
    this.cancelMapPick();
    return new Observable((subscriber) => {
      this.editPickKey = this.map?.once('singleclick', (event) => {
        this.editPickKey = null;
        this.suppressClickUntil = Date.now() + 400;
        const view = this.map!.getView();
        const metresPerPixel = getPointResolution(
          view.getProjection(),
          view.getResolution() ?? 1,
          event.coordinate
        );
        subscriber.next({
          lonLat: toLonLat(event.coordinate) as [number, number],
          toleranceM: metresPerPixel * 8
        });
        subscriber.complete();
      }) as EventsKey | null;
      return () => this.cancelMapPick();
    });
  }

  cancelMapPick(): void {
    if (this.editPickKey) unByKey(this.editPickKey);
    this.editPickKey = null;
  }

  private stopEditInteractions(): void {
    if (this.map) {
      if (this.editModify) this.map.removeInteraction(this.editModify);
      if (this.editSnap) this.map.removeInteraction(this.editSnap);
    }
    this.editModify = null;
    this.editSnap = null;
  }

  private ensureEditSource(): VectorSource {
    if (!this.editLayer) {
      const accent = '#1f7a4d';
      this.editLayer = new VectorLayer({
        source: new VectorSource(),
        style: [
          new Style({
            stroke: new Stroke({ color: accent, width: 3 }),
            fill: new Fill({ color: 'rgba(31, 122, 77, 0.15)' }),
            image: new CircleStyle({ radius: 7, stroke: new Stroke({ color: '#fff', width: 2 }), fill: new Fill({ color: accent }) })
          })
        ],
        zIndex: 10001,
        properties: { drawOverlay: true }
      });
      this.map?.addLayer(this.editLayer);
    }
    return this.editLayer.getSource() as VectorSource;
  }

  // ----- measurement tool -----

  /**
   * Starts a geodesic measurement. Only ever one measurement interaction is
   * active — any previous one (and the query-draw interaction) is removed
   * first. `onChange` fires live while the user draws; `onComplete` fires on
   * finish. The finished geometry + its label stay on the dedicated
   * measurement layer until `stopMeasure` / `clearMeasure`.
   */
  startMeasure(
    type: MeasureDrawType,
    onChange: (result: MeasureResult) => void,
    onComplete: (result: MeasureResult) => void
  ): void {
    this.cancelDraw();
    this.stopMeasure();
    if (!this.map) return;

    const source = this.ensureMeasureSource();
    this.measureDraw = new Draw({
      source,
      type,
      style: this.measureSketchStyle()
    });

    this.measureDraw.on('drawstart', (event) => {
      const feature = (event as unknown as { feature: Feature }).feature;
      const geometry = feature.getGeometry() as Geometry;
      this.ensureMeasureTooltip();
      const update = () => {
        const result = this.measureGeometry(geometry, type);
        this.positionMeasureLabels(geometry, type, result);
        onChange(result);
      };
      update();
      geometry.on('change', update);
      this.measureGeomListener = () => geometry.un('change', update);
    });

    this.measureDraw.on('drawend', (event) => {
      this.suppressClickUntil = Date.now() + 400;
      const geometry = (event as unknown as { feature: Feature }).feature.getGeometry() as Geometry;
      this.measureGeomListener?.();
      this.measureGeomListener = null;
      const result = this.measureGeometry(geometry, type);
      this.positionMeasureLabels(geometry, type, result, true);
      // hand the sketch's labels over as finished graphics: keep them on the
      // map, but release the refs so the next measurement gets fresh ones
      this.measureTooltip?.getElement()?.classList.add('measure-tooltip--static');
      this.measureTooltip?.set('measureLabel', true);
      this.measureTooltip = null;
      this.measureSegments = [];
      if (this.measureDraw && this.map) {
        this.map.removeInteraction(this.measureDraw);
      }
      this.measureDraw = null;
      onComplete(result);
    });

    this.map.addInteraction(this.measureDraw);
  }

  /** Removes the active measurement interaction. An in-progress (unfinished)
   *  sketch and its labels are discarded; finished measurements are kept. */
  stopMeasure(): void {
    this.measureGeomListener?.();
    this.measureGeomListener = null;
    if (this.measureDraw && this.map) {
      this.map.removeInteraction(this.measureDraw);
    }
    this.measureDraw = null;
    if (this.measureTooltip) {
      this.removeOverlay(this.measureTooltip);
      this.measureTooltip = null;
      for (const overlay of this.measureSegments) {
        this.removeOverlay(overlay);
      }
      this.measureSegments = [];
    }
  }

  /** Removes the active interaction AND every finished measurement graphic. */
  clearMeasure(): void {
    this.stopMeasure();
    this.measureLayer?.getSource()?.clear();
    for (const overlay of (this.map?.getOverlays().getArray() ?? []).slice()) {
      if (overlay.get('measureLabel')) {
        this.removeOverlay(overlay);
      }
    }
    this.measureSegments = [];
  }

  private measureGeometry(geometry: Geometry, type: MeasureDrawType): MeasureResult {
    const projection = MAP_PROJECTION;
    if (type === 'LineString') {
      const line = geometry as LineString;
      const coords = line.getCoordinates();
      return {
        type,
        lengthM: getLength(line, { projection }),
        segmentsM: this.segmentLengths(coords, projection)
      };
    }
    if (type === 'Polygon') {
      const polygon = geometry as Polygon;
      const ring = polygon.getLinearRing(0);
      const ringCoords = ring ? ring.getCoordinates() : [];
      return {
        type,
        areaM2: getArea(polygon, { projection }),
        lengthM: ring ? getLength(new LineString(ringCoords), { projection }) : 0,
        segmentsM: this.segmentLengths(ringCoords, projection)
      };
    }
    // Circle
    const circle = geometry as CircleGeom;
    const polygon = fromCircle(circle, 128);
    const circumference = getLength(polygon, { projection });
    return {
      type,
      lengthM: circumference,
      areaM2: getArea(polygon, { projection }),
      radiusM: circumference / (2 * Math.PI),
      segmentsM: []
    };
  }

  private segmentLengths(coords: number[][], projection: string): number[] {
    const segments: number[] = [];
    for (let i = 1; i < coords.length; i++) {
      segments.push(getLength(new LineString([coords[i - 1], coords[i]]), { projection }));
    }
    return segments;
  }

  private positionMeasureLabels(
    geometry: Geometry,
    type: MeasureDrawType,
    result: MeasureResult,
    persistent = false
  ): void {
    // main label
    const anchor = this.measureAnchor(geometry, type);
    if (this.measureTooltip && anchor) {
      this.measureTooltip.setPosition(anchor);
      const element = this.measureTooltip.getElement();
      if (element) {
        element.textContent = this.mainLabel(result);
      }
    }

    // per-segment labels (lines + polygon rings), capped so long paths
    // don't flood the map with overlays
    if (!this.map) return;
    const coords = this.ringCoords(geometry, type);
    const wanted = coords.length > 1 && result.segmentsM.length <= 40 ? result.segmentsM.length : 0;

    while (this.measureSegments.length > wanted) {
      this.removeOverlay(this.measureSegments.pop() as Overlay);
    }
    while (this.measureSegments.length < wanted) {
      const el = document.createElement('div');
      el.className = 'measure-segment';
      const overlay = new Overlay({ element: el, offset: [0, 0], positioning: 'center-center', stopEvent: false });
      overlay.set('measureLabel', true);
      overlay.set('measureSegment', true);
      this.map.addOverlay(overlay);
      this.measureSegments.push(overlay);
    }
    for (let i = 0; i < wanted; i++) {
      const mid = [
        (coords[i][0] + coords[i + 1][0]) / 2,
        (coords[i][1] + coords[i + 1][1]) / 2
      ];
      this.measureSegments[i].setPosition(mid);
      const el = this.measureSegments[i].getElement();
      if (el) {
        el.textContent = this.formatSegment(result.segmentsM[i]);
      }
    }

    if (persistent && this.measureTooltip) {
      this.measureTooltip.set('measureLabel', true);
    }
  }

  private measureAnchor(geometry: Geometry, type: MeasureDrawType): number[] | undefined {
    if (type === 'Polygon') {
      return (geometry as Polygon).getInteriorPoint().getCoordinates().slice(0, 2);
    }
    if (type === 'Circle') {
      return (geometry as CircleGeom).getCenter();
    }
    const coords = (geometry as LineString).getCoordinates();
    return coords.length ? coords[coords.length - 1] : undefined;
  }

  private ringCoords(geometry: Geometry, type: MeasureDrawType): number[][] {
    if (type === 'LineString') return (geometry as LineString).getCoordinates();
    if (type === 'Polygon') {
      const ring = (geometry as Polygon).getLinearRing(0);
      return ring ? ring.getCoordinates() : [];
    }
    return [];
  }

  private mainLabel(result: MeasureResult): string {
    if (result.type === 'Polygon' && result.areaM2 != null) {
      return this.metricArea(result.areaM2);
    }
    if (result.type === 'Circle' && result.radiusM != null) {
      return `r ${this.formatSegment(result.radiusM)}`;
    }
    return this.formatSegment(result.lengthM);
  }

  private formatSegment(metres: number): string {
    return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${Math.round(metres)} m`;
  }

  private metricArea(squareMetres: number): string {
    if (squareMetres >= 1_000_000) return `${(squareMetres / 1_000_000).toFixed(2)} km²`;
    if (squareMetres >= 10_000) return `${(squareMetres / 10_000).toFixed(2)} ha`;
    return `${Math.round(squareMetres)} m²`;
  }

  private ensureMeasureSource(): VectorSource {
    if (!this.measureLayer) {
      this.measureLayer = new VectorLayer({
        source: new VectorSource(),
        style: this.measureFinishedStyle(),
        zIndex: 10001,
        properties: { measureOverlay: true }
      });
      this.map?.addLayer(this.measureLayer);
    }
    return this.measureLayer.getSource() as VectorSource;
  }

  private ensureMeasureTooltip(): void {
    if (this.measureTooltip) return;
    const element = document.createElement('div');
    element.className = 'measure-tooltip';
    this.measureTooltip = new Overlay({
      element,
      offset: [0, -12],
      positioning: 'bottom-center',
      stopEvent: false
    });
    this.map?.addOverlay(this.measureTooltip);
  }

  private removeOverlay(overlay: Overlay): void {
    this.map?.removeOverlay(overlay);
    overlay.getElement()?.remove();
  }

  private measureSketchStyle(): Style {
    return new Style({
      stroke: new Stroke({ color: '#1c2430', width: 2, lineDash: [7, 5] }),
      fill: new Fill({ color: 'rgba(28, 36, 48, 0.08)' }),
      image: new CircleStyle({ radius: 5, stroke: new Stroke({ color: '#1c2430', width: 2 }), fill: new Fill({ color: '#fff' }) })
    });
  }

  private measureFinishedStyle(): Style {
    return new Style({
      stroke: new Stroke({ color: '#1c2430', width: 2 }),
      fill: new Fill({ color: 'rgba(28, 36, 48, 0.06)' }),
      image: new CircleStyle({ radius: 4, stroke: new Stroke({ color: '#1c2430', width: 2 }), fill: new Fill({ color: '#fff' }) }),
      text: new TextStyle({ font: '11px "IBM Plex Mono", monospace', fill: new Fill({ color: '#1c2430' }) })
    });
  }

  /** Zooms/pans the map to frame the given GeoJSON (EPSG:4326) geometries. */
  zoomToGeometries(geometries: (Record<string, unknown> | null | undefined)[]): void {
    const view = this.map?.getView();
    if (!view) return;
    const extent = createEmpty();
    for (const geometry of geometries) {
      const feature = this.toMapFeature(geometry);
      const geom = feature?.getGeometry();
      if (geom) {
        extendExtent(extent, geom.getExtent());
      }
    }
    if (!isEmptyExtent(extent)) {
      view.fit(extent, { size: this.map?.getSize(), padding: [60, 60, 60, 60], maxZoom: 18, duration: 250 });
    }
  }

  private ensureQuerySource(): VectorSource {
    if (!this.queryLayer) {
      // Colour from the AI Assistant settings; the style is rebuilt only
      // when that colour changes.
      let cached: { color: string; style: Style } | null = null;
      const style = () => {
        const color = /^#[0-9a-f]{6}$/i.test(this.settings.assistant().highlightColor)
          ? this.settings.assistant().highlightColor
          : '#128077';
        if (cached?.color !== color) {
          const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
          cached = {
            color,
            style: new Style({
              stroke: new Stroke({ color, width: 2.5 }),
              fill: new Fill({ color: `rgba(${r}, ${g}, ${b}, 0.14)` }),
              image: new CircleStyle({
                radius: 6,
                stroke: new Stroke({ color, width: 2.5 }),
                fill: new Fill({ color: `rgba(${r}, ${g}, ${b}, 0.3)` })
              })
            })
          };
        }
        return cached.style;
      };
      this.queryLayer = new VectorLayer({
        source: new VectorSource(),
        style,
        zIndex: 9998,
        properties: { queryOverlay: true }
      });
      this.map?.addLayer(this.queryLayer);
    }
    return this.queryLayer.getSource() as VectorSource;
  }

  private ensureDrawSource(): VectorSource {
    if (!this.drawLayer) {
      const accent = '#b5722a';
      this.drawLayer = new VectorLayer({
        source: new VectorSource(),
        style: new Style({
          stroke: new Stroke({ color: accent, width: 2, lineDash: [6, 4] }),
          fill: new Fill({ color: 'rgba(181, 114, 42, 0.1)' }),
          image: new CircleStyle({ radius: 6, stroke: new Stroke({ color: accent, width: 2 }), fill: new Fill({ color: 'rgba(181, 114, 42, 0.25)' }) })
        }),
        zIndex: 10000,
        properties: { drawOverlay: true }
      });
      this.map?.addLayer(this.drawLayer);
    }
    return this.drawLayer.getSource() as VectorSource;
  }

  private ensureSelectionSource(): VectorSource {
    if (!this.selectionLayer) {
      const accent = '#b5722a';
      const stroke = new Stroke({ color: accent, width: 3 });
      this.selectionLayer = new VectorLayer({
        source: new VectorSource(),
        style: new Style({
          stroke,
          fill: new Fill({ color: 'rgba(181, 114, 42, 0.16)' }),
          image: new CircleStyle({
            radius: 7,
            stroke: new Stroke({ color: accent, width: 3 }),
            fill: new Fill({ color: 'rgba(181, 114, 42, 0.35)' })
          })
        }),
        zIndex: 9999,
        properties: { selectionOverlay: true }
      });
      this.map?.addLayer(this.selectionLayer);
    }
    return this.selectionLayer.getSource() as VectorSource;
  }

  private toMapFeature(geometry: Record<string, unknown> | null | undefined): Feature | null {
    if (!geometry) return null;
    try {
      const geom = this.geoJson.readGeometry(geometry, {
        dataProjection: LAYER_PROJECTION,
        featureProjection: MAP_PROJECTION
      });
      return new Feature({ geometry: geom });
    } catch {
      return null;
    }
  }

  /** Toggles the map container in/out of the browser's native Fullscreen
   *  API — simpler and more consistent with our own PrimeNG button styling
   *  than OL's built-in FullScreen control. No-op if unsupported. */
  toggleFullscreen(): void {
    const target = this.map?.getTargetElement();
    if (!target) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void target.requestFullscreen?.();
    }
  }

  /** Information Tool module gate: when off, map clicks open no popup. */
  private identifyEnabled = true;
  /** Pan module gate, kept so it can be applied once the map exists. */
  private panEnabled = true;

  setIdentifyEnabled(enabled: boolean): void {
    this.identifyEnabled = enabled;
    if (!enabled) this.featureInfoPopup.set(null);
  }

  /** User's Identify toggle (map-controls button) — on by default; works
   *  only while the Information Tool module gate is also open. */
  readonly identifyActive = signal(true);

  toggleIdentify(): void {
    this.identifyActive.update((on) => !on);
    if (!this.identifyActive()) this.featureInfoPopup.set(null);
  }

  /** Pan module gate: turns map dragging (DragPan + keyboard pan) on/off. */
  setPanEnabled(enabled: boolean): void {
    this.panEnabled = enabled;
    this.map?.getInteractions().forEach((interaction) => {
      if (interaction instanceof DragPan || interaction instanceof KeyboardPan) {
        interaction.setActive(enabled);
      }
    });
  }

  /** Registers a handler for single-clicks on the map, receiving the
   *  clicked coordinate in the map's own projection (EPSG:3857) — ready to
   *  pass straight into getFeatureInfo. Suppressed while the Measurement
   *  tool is open, or a measurement / query-draw interaction is active, so
   *  those clicks never also trigger Identify. */
  onSingleClick(handler: (coordinate: number[]) => void): void {
    this.map?.on('singleclick', (event) => {
      if (
        !this.identifyEnabled ||
        !this.identifyActive() ||
        this.measureModeActive ||
        this.measureDraw ||
        this.drawInteraction ||
        this.editPickKey ||
        this.editModify ||
        Date.now() < this.suppressClickUntil
      ) {
        return;
      }
      handler(event.coordinate);
    });
  }

  // ----- Identify popup (custom on-map feature-info card) -----

  /** Called once by MunicipalMapComponent with the popup's host element. */
  registerFeatureInfoPopup(element: HTMLElement): void {
    if (this.featurePopupOverlay || !this.map) return;
    this.featurePopupOverlay = new Overlay({
      element,
      positioning: 'bottom-center',
      offset: [0, -14],
      stopEvent: true,
      autoPan: { animation: { duration: 200 } }
    });
    this.map.addOverlay(this.featurePopupOverlay);
  }

  /** Opens (or moves) the Identify popup at a map coordinate (EPSG:3857). */
  openFeatureInfoPopup(coordinate: number[], state: FeatureInfoPopupState): void {
    this.featurePopupOverlay?.setPosition(coordinate);
    this.featureInfoPopup.set(state);
  }

  /** Opens the Identify popup at an EPSG:4326 point (used by map search). */
  openFeatureInfoPopupAt4326(point: [number, number], state: FeatureInfoPopupState): void {
    this.openFeatureInfoPopup(fromLonLat(point), state);
  }

  /** Updates the popup's contents without moving it. */
  updateFeatureInfoPopup(state: FeatureInfoPopupState): void {
    if (this.featureInfoPopup()) this.featureInfoPopup.set(state);
  }

  closeFeatureInfoPopup(): void {
    this.featurePopupOverlay?.setPosition(undefined);
    this.featureInfoPopup.set(null);
  }

  /** Toggled by the Measurement tool for its whole open lifetime. Turning
   *  it on also dismisses any open Identify popup. */
  setMeasureMode(active: boolean): void {
    this.measureModeActive = active;
    if (active) this.closeFeatureInfoPopup();
  }

  setLayerVisibility(layerId: string, visible: boolean): void {
    const entry = this.managedLayers.get(layerId);
    if (!entry) return;
    entry.olLayer.setVisible(visible);
    this.layerVisibility.update((current) => ({ ...current, [layerId]: visible }));
  }

  // ----- Raster Analysis: Swipe / Compare -----

  private swipe: { layerId: string; fraction: number; keys: EventsKey[] } | null = null;

  /** Shows only the left `fraction` (0..1) of a layer, revealing whatever
   *  is drawn below it; `null` turns the swipe off. */
  setSwipe(layerId: string | null, fraction = 0.5): void {
    if (this.swipe && this.swipe.layerId !== layerId) {
      unByKey(this.swipe.keys);
      this.swipe = null;
    }
    const olLayer = layerId ? this.managedLayers.get(layerId)?.olLayer : undefined;
    if (!layerId || !olLayer) {
      this.map?.render();
      return;
    }
    if (!this.swipe) {
      const state = { layerId, fraction, keys: [] as EventsKey[] };
      state.keys = [
        olLayer.on('prerender', (event) => {
          const ctx = event.context as CanvasRenderingContext2D;
          const x = ctx.canvas.width * state.fraction;
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, x, ctx.canvas.height);
          ctx.clip();
        }),
        olLayer.on('postrender', (event) => {
          const ctx = event.context as CanvasRenderingContext2D;
          ctx.restore();
          const x = ctx.canvas.width * state.fraction;
          ctx.save();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, ctx.canvas.height);
          ctx.stroke();
          ctx.restore();
        })
      ];
      this.swipe = state;
    }
    this.swipe.fraction = Math.min(Math.max(fraction, 0), 1);
    this.map?.render();
  }

  private spyglass: { layerId: string; radius: number; pos: number[] | null; keys: EventsKey[] } | null = null;

  /** Spyglass compare: the layer shows only inside a circle that follows
   *  the mouse; `null` turns it off. Radius in CSS pixels. */
  setSpyglass(layerId: string | null, radius = 120): void {
    if (this.spyglass && this.spyglass.layerId !== layerId) {
      unByKey(this.spyglass.keys);
      this.spyglass = null;
    }
    const olLayer = layerId ? this.managedLayers.get(layerId)?.olLayer : undefined;
    if (!this.map || !layerId || !olLayer) {
      this.map?.render();
      return;
    }
    if (!this.spyglass) {
      const state = { layerId, radius, pos: null as number[] | null, keys: [] as EventsKey[] };
      const map = this.map;
      state.keys = [
        map.on('pointermove', (e) => {
          state.pos = e.pixel;
          map.render();
        }),
        olLayer.on('prerender', (event) => {
          const ctx = event.context as CanvasRenderingContext2D;
          ctx.save();
          ctx.beginPath();
          if (state.pos) {
            const ratio = event.frameState?.pixelRatio ?? 1;
            ctx.arc(state.pos[0] * ratio, state.pos[1] * ratio, state.radius * ratio, 0, 2 * Math.PI);
          }
          ctx.clip();
        }),
        olLayer.on('postrender', (event) => {
          const ctx = event.context as CanvasRenderingContext2D;
          ctx.restore();
          if (!state.pos) return;
          const ratio = event.frameState?.pixelRatio ?? 1;
          ctx.save();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 3 * ratio;
          ctx.beginPath();
          ctx.arc(state.pos[0] * ratio, state.pos[1] * ratio, state.radius * ratio, 0, 2 * Math.PI);
          ctx.stroke();
          ctx.restore();
        })
      ];
      this.spyglass = state;
    }
    this.spyglass.radius = radius;
    this.map.render();
  }

  private hoverLayer: VectorLayer<VectorSource> | null = null;

  /** A single highlighted point (e.g. the spot under the cursor on an
   *  elevation profile chart); `null` hides it. EPSG:4326. */
  setHoverMarker(lonLat: [number, number] | null): void {
    if (!this.map) return;
    if (!this.hoverLayer) {
      this.hoverLayer = new VectorLayer({
        source: new VectorSource(),
        zIndex: 1000,
        style: new Style({
          image: new CircleStyle({ radius: 7, fill: new Fill({ color: '#f59e0b' }), stroke: new Stroke({ color: '#fff', width: 2 }) })
        })
      });
      this.map.addLayer(this.hoverLayer);
    }
    const source = this.hoverLayer.getSource()!;
    source.clear();
    if (lonLat) source.addFeature(new Feature(new Point(fromLonLat(lonLat))));
  }

  /** Analysis overlay with one colour per geometry (e.g. line of sight:
   *  visible green, hidden red). Replaces whatever was there. */
  setAnalysisColoredGeometries(items: { geometry: Record<string, unknown>; color: string }[]): void {
    const source = this.ensureAnalysisSource();
    source.clear();
    for (const { geometry, color } of items) {
      const feature = this.toMapFeature(geometry);
      if (!feature) continue;
      feature.setStyle(
        new Style({
          stroke: new Stroke({ color, width: 4 }),
          fill: new Fill({ color: `${color}33` }),
          image: new CircleStyle({ radius: 6, fill: new Fill({ color }), stroke: new Stroke({ color: '#fff', width: 2 }) })
        })
      );
      source.addFeature(feature);
    }
  }

  zoomIn(): void {
    const view = this.map?.getView();
    if (!view) return;
    const zoom = view.getZoom();
    if (zoom !== undefined) view.animate({ zoom: zoom + 1, duration: 150 });
  }

  zoomOut(): void {
    const view = this.map?.getView();
    if (!view) return;
    const zoom = view.getZoom();
    if (zoom !== undefined) view.animate({ zoom: zoom - 1, duration: 150 });
  }

  resetView(): void {
    const view = this.map?.getView();
    if (!view) return;
    if (this.initialExtent3857) {
      view.fit(this.initialExtent3857, { size: this.map?.getSize(), padding: [24, 24, 24, 24], maxZoom: 18 });
    } else {
      view.setCenter(fromLonLat(FALLBACK_CENTER_4326));
      view.setZoom(FALLBACK_ZOOM);
    }
  }

  // ----- navigation history -----

  /** Called on every `moveend`. A view equal to the current history entry
   *  is ignored — which is exactly what happens when back/forward animate
   *  to a stored entry, so stepping through history never rewrites it. */
  private recordView(): void {
    const view = this.map?.getView();
    const center = view?.getCenter();
    const zoom = view?.getZoom();
    if (!view || !center || zoom === undefined) return;
    const entry: NavHistoryEntry = { center: [center[0], center[1]], zoom, rotation: view.getRotation() };
    const current = this.navHistory[this.navIndex];
    if (current && sameView(current, entry)) return;
    // A new move after going back discards the forward branch, like a browser.
    this.navHistory = [...this.navHistory.slice(0, this.navIndex + 1), entry].slice(-NAV_HISTORY_LIMIT);
    this.navIndex = this.navHistory.length - 1;
    this.updateNavState();
  }

  goBack(): void {
    this.stepHistory(-1);
  }

  goForward(): void {
    this.stepHistory(1);
  }

  private stepHistory(delta: number): void {
    const view = this.map?.getView();
    const entry = this.navHistory[this.navIndex + delta];
    if (!view || !entry) return;
    this.navIndex += delta;
    this.updateNavState();
    view.animate({ center: entry.center, zoom: entry.zoom, rotation: entry.rotation, duration: 250 });
  }

  private resetNavHistory(): void {
    this.navHistory = [];
    this.navIndex = -1;
    this.updateNavState();
  }

  private updateNavState(): void {
    this.canGoBack.set(this.navIndex > 0);
    this.canGoForward.set(this.navIndex < this.navHistory.length - 1);
  }

  // ----- draw & mark (sketches) -----

  /** Renders every saved sketch (replacing what was shown): shapes in their
   *  own colour with an optional label, markers as labelled pins. */
  setSketches(sketches: Sketch[]): void {
    const source = this.ensureSketchSource();
    source.clear();
    for (const sketch of sketches) {
      const feature = this.toMapFeature(sketch.geometry);
      if (!feature) continue;
      feature.setId(sketch.id);
      feature.setStyle(this.sketchStyle(sketch));
      source.addFeature(feature);
    }
  }

  private sketchStyle(sketch: Sketch): Style {
    const text = sketch.label
      ? new TextStyle({
          text: sketch.label,
          font: '600 12px Inter, system-ui, sans-serif',
          fill: new Fill({ color: '#1b1f23' }),
          stroke: new Stroke({ color: '#ffffff', width: 3 }),
          offsetY: sketch.kind === 'Marker' ? -20 : 0,
          overflow: true
        })
      : undefined;
    if (sketch.kind === 'Marker') {
      return new Style({
        image: new CircleStyle({ radius: 7, fill: new Fill({ color: sketch.color }), stroke: new Stroke({ color: '#ffffff', width: 2.5 }) }),
        text
      });
    }
    return new Style({
      stroke: new Stroke({ color: sketch.color, width: 2.5 }),
      fill: new Fill({ color: `${sketch.color}33` }),
      image: new CircleStyle({ radius: 5, fill: new Fill({ color: sketch.color }), stroke: new Stroke({ color: '#ffffff', width: 1.5 }) }),
      text
    });
  }

  private ensureSketchSource(): VectorSource {
    if (!this.sketchLayer) {
      this.sketchLayer = new VectorLayer({
        source: new VectorSource(),
        zIndex: 9998,
        properties: { sketchOverlay: true }
      });
      this.map?.addLayer(this.sketchLayer);
    }
    return this.sketchLayer.getSource() as VectorSource;
  }

  // ----- go to X:Y -----

  /** Flies to (x, y) given in `crs` and marks the spot. Returns the target
   *  in EPSG:4326 (for display), or null when the coordinate can't be
   *  transformed or lies outside the projection's valid area. */
  goToCoordinate(x: number, y: number, crs: string): [number, number] | null {
    const view = this.map?.getView();
    if (!view || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const target = transform([x, y], crs, view.getProjection());
    const lonLat = transform([x, y], crs, LAYER_PROJECTION);
    if (!target.every(Number.isFinite) || Math.abs(lonLat[1]) > 85 || Math.abs(lonLat[0]) > 180) return null;

    const source = this.ensureGotoSource();
    source.clear();
    source.addFeature(new Feature(new Point(target)));
    view.animate({ center: target, zoom: Math.max(view.getZoom() ?? 0, GOTO_ZOOM), duration: 400 });
    return [lonLat[0], lonLat[1]];
  }

  clearGoToMarker(): void {
    this.gotoLayer?.getSource()?.clear();
  }

  private ensureGotoSource(): VectorSource {
    if (!this.gotoLayer) {
      const accent = '#b5722a';
      this.gotoLayer = new VectorLayer({
        source: new VectorSource(),
        style: [
          new Style({ image: new CircleStyle({ radius: 11, stroke: new Stroke({ color: 'rgba(181, 114, 42, 0.45)', width: 2 }) }) }),
          new Style({
            image: new CircleStyle({ radius: 5, fill: new Fill({ color: accent }), stroke: new Stroke({ color: '#ffffff', width: 2 }) })
          })
        ],
        zIndex: 10001,
        properties: { gotoOverlay: true }
      });
      this.map?.addLayer(this.gotoLayer);
    }
    return this.gotoLayer.getSource() as VectorSource;
  }

  // ----- spatial bookmarks -----

  /** Current view centre / zoom / projection — for saving a bookmark. */
  /** The visible map extent as an EPSG:4326 `[minX, minY, maxX, maxY]`. */
  getViewExtent4326(): [number, number, number, number] | null {
    if (!this.map) return null;
    const size = this.map.getSize();
    if (!size) return null;
    const extent = this.map.getView().calculateExtent(size);
    return transformExtent(extent, MAP_PROJECTION, LAYER_PROJECTION) as [number, number, number, number];
  }

  getViewState(): { center: [number, number]; zoom: number; projection: string } | null {
    const view = this.map?.getView();
    const center = view?.getCenter();
    const zoom = view?.getZoom();
    if (!view || !center || zoom === undefined) {
      return null;
    }
    return { center: [center[0], center[1]], zoom, projection: view.getProjection().getCode() };
  }

  /** Animates the view to a saved bookmark, reprojecting the centre if the
   *  bookmark was stored under a different projection. */
  applyViewState(state: { center: [number, number]; zoom: number; projection: string }): void {
    const view = this.map?.getView();
    if (!view) return;
    const target = view.getProjection().getCode();
    const center =
      state.projection === target
        ? state.center
        : (transform(state.center, state.projection, target) as [number, number]);
    view.animate({ center, zoom: state.zoom, duration: 400 });
  }

  // ----- print layout -----

  /** The live map scale denominator (1 : N) at the view centre, using the
   *  OGC standard 0.28 mm/pixel — the same convention MapFish Print uses,
   *  so a round-trip preserves the on-screen resolution. `null` before the
   *  map is ready. */
  currentScaleDenominator(): number | null {
    const view = this.map?.getView();
    const resolution = view?.getResolution();
    const center = view?.getCenter();
    if (!view || resolution === undefined || !center) {
      return null;
    }
    const pointResolution = getPointResolution(MAP_PROJECTION, resolution, center);
    return pointResolution / 0.00028;
  }

  /** Snapshot of the current view + visible WMS layers for the Print
   *  Layout panel. Overlays (measurement, query highlight, analysis,
   *  selection) and the basemap are excluded here — the backend adds the
   *  basemap from `basemapId`, and the transient overlays are not part of
   *  a printed map. `null` before the map is ready. */
  getPrintContext(): PrintMapContext | null {
    const view = this.map?.getView();
    const center = view?.getCenter();
    const scale = this.currentScaleDenominator();
    if (!view || !center || scale === null) {
      return null;
    }
    // managedLayers is insertion-ordered bottom→top (displayOrder at init);
    // MapFish wants the topmost layer first.
    const layers: PrintLayerContext[] = [...this.managedLayers.values()]
      .filter((entry) => entry.olLayer.getVisible())
      .reverse()
      .map((entry) => {
        const params = entry.olLayer.getSource()?.getParams() ?? {};
        const cql = params['CQL_FILTER'];
        return {
          layerId: entry.layer.id,
          opacity: entry.olLayer.getOpacity(),
          cqlFilter: typeof cql === 'string' && cql.trim().length > 0 ? cql : null
        };
      });

    return {
      projection: MAP_PROJECTION,
      center: [center[0], center[1]],
      scale,
      rotation: view.getRotation(),
      layers,
      basemapId: this.activeBasemap()
    };
  }

  /** Task 9 §7: swaps the single base tile layer's source — every other
   *  layer (WMS overlays, controls) is untouched. No-op for an unknown id. */
  setBasemap(id: string): void {
    const definition = BASEMAPS[id];
    if (!definition || !this.map || !this.baseLayer) return;
    this.map.removeLayer(this.baseLayer);
    this.baseLayer = definition.build();
    this.map.getLayers().insertAt(0, this.baseLayer);
    this.activeBasemap.set(id);
  }

  /** Task 9 §4/§17: zooms to one layer's own EPSG:4326 bbox (dashboard
   *  "view this layer on the map" deep link). No-op if the layer has no
   *  bbox yet (e.g. zero features). */
  zoomToLayer(layer: GisLayer): void {
    if (!isUsableBbox(layer.bbox)) return;
    this.zoomToExtent4326([layer.bbox.minX, layer.bbox.minY, layer.bbox.maxX, layer.bbox.maxY]);
  }

  /** Task 9 §4: zooms to the union bbox of several layers (dashboard
   *  "view this department on the map" deep link). Layers without a bbox
   *  are skipped; no-op if none of them have one. */
  zoomToLayers(layers: GisLayer[]): void {
    const withBbox = layers.filter(
      (layer): layer is GisLayer & { bbox: NonNullable<GisLayer['bbox']> } => isUsableBbox(layer.bbox)
    );
    if (withBbox.length === 0) return;
    const minX = Math.min(...withBbox.map((l) => l.bbox.minX));
    const minY = Math.min(...withBbox.map((l) => l.bbox.minY));
    const maxX = Math.max(...withBbox.map((l) => l.bbox.maxX));
    const maxY = Math.max(...withBbox.map((l) => l.bbox.maxY));
    this.zoomToExtent4326([minX, minY, maxX, maxY]);
  }

  /** Task 9 §5: zooms to a search result feature's bbox (EPSG:4326,
   *  [minX, minY, maxX, maxY] as returned by GeoServer's WFS). */
  zoomToBbox4326(bbox: [number, number, number, number]): void {
    this.zoomToExtent4326(bbox);
  }

  zoomToExtent4326(bbox: [number, number, number, number]): void {
    const view = this.map?.getView();
    if (!view) return;
    const extent = transformExtent(bbox, LAYER_PROJECTION, MAP_PROJECTION);
    view.fit(extent, { size: this.map?.getSize(), padding: [40, 40, 40, 40], maxZoom: 18, duration: 250 });
  }

  /** GeoServer WMS GetLegendGraphic — a public, anonymous GeoServer image
   *  endpoint, so this is just a URL, no HTTP call needed here. */
  legendGraphicUrl(layer: GisLayer, cacheBust?: number): string {
    const qualifiedLayer = `${layer.geoserverWorkspace}:${layer.geoserverLayer}`;
    const params = new URLSearchParams({
      service: 'WMS',
      version: '1.1.0',
      request: 'GetLegendGraphic',
      format: 'image/png',
      layer: qualifiedLayer,
      legend_options: 'fontAntiAliasing:true;fontSize:11'
    });
    if (cacheBust) params.set('_ts', String(cacheBust));
    return `${environment.geoserverUrl}/${layer.geoserverWorkspace}/wms?${params.toString()}`;
  }

  /**
   * WMS GetFeatureInfo at a clicked map pixel — one request per currently
   * VISIBLE vector layer (never a hidden/toggled-off one, satisfying Task 6
   * TEST 10), each scoped to exactly that layer so results are
   * unambiguous. `application/json` per Task 6 §15; a GeoServer error or
   * network failure for one layer is caught and treated as "no features"
   * for that layer rather than failing the whole click.
   */
  getFeatureInfo(coordinate: number[]): Observable<FeatureInfoResult[]> {
    const view = this.map?.getView();
    const resolution = view?.getResolution();
    if (!this.map || !view || resolution === undefined) {
      return of([]);
    }

    const queries = [...this.managedLayers.values()]
      .filter((entry) => entry.olLayer.getVisible() && entry.layer.layerType === 'VECTOR')
      .map((entry) => this.queryOneLayer(entry, coordinate, resolution, view.getProjection().getCode()));

    if (queries.length === 0) {
      return of([]);
    }
    return forkJoin(queries).pipe(rxMap((results) => results.filter((result): result is FeatureInfoResult => result !== null && result.features.length > 0)));
  }

  private queryOneLayer(entry: ManagedLayer, coordinate: number[], resolution: number, projectionCode: string): Observable<FeatureInfoResult | null> {
    const url = entry.olLayer.getSource()?.getFeatureInfoUrl(coordinate, resolution, projectionCode, {
      INFO_FORMAT: 'application/json',
      FEATURE_COUNT: 10
    });
    if (!url) {
      return of(null);
    }

    return new Observable<FeatureInfoResult | null>((subscriber) => {
      fetch(url)
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
        .then(
          (body: {
            features?: { id?: string; properties: Record<string, unknown>; geometry?: Record<string, unknown> | null }[];
          }) => {
            const features = (body.features ?? []).map((feature) => ({
              attributes: feature.properties,
              id: feature.id,
              geometry: feature.geometry ?? null
            }));
            subscriber.next({ layer: entry.layer, features });
            subscriber.complete();
          }
        )
        .catch(() => {
          // A single layer's GetFeatureInfo failing (GeoServer error,
          // network issue) must not break the rest of the click — see
          // Task 6 §29. It's simply treated as "no features" for this layer.
          subscriber.next({ layer: entry.layer, features: [] });
          subscriber.complete();
        });
    });
  }

  /** Brings the map in line with a reloaded layer list after init: layers
   *  published since (e.g. Raster Analysis output) are added and shown,
   *  deleted ones removed — no page refresh needed. */
  syncLayers(layers: GisLayer[]): void {
    if (!this.map) return;
    const ids = new Set(layers.map((layer) => layer.id));
    for (const [id, entry] of [...this.managedLayers]) {
      if (ids.has(id)) continue;
      this.map.removeLayer(entry.olLayer);
      this.managedLayers.delete(id);
    }
    const added: Record<string, boolean> = {};
    for (const layer of [...layers].sort((a, b) => a.displayOrder - b.displayOrder)) {
      const existing = this.managedLayers.get(layer.id);
      if (existing) {
        existing.layer = layer;
        continue;
      }
      this.addWmsLayer(layer, this.managedLayers.size + 1);
      this.managedLayers.get(layer.id)?.olLayer.setVisible(true);
      added[layer.id] = true;
    }
    this.layerVisibility.update((current) => {
      const next: Record<string, boolean> = { ...added };
      for (const id of Object.keys(current)) if (ids.has(id)) next[id] = current[id];
      return next;
    });
    this.applyLayerOrder();
  }

  // ----- draw order -----

  /** Moves a layer in the draw order (top = drawn last, on top). */
  moveLayer(layerId: string, where: 'top' | 'up' | 'down' | 'bottom'): void {
    const order = [...this.layerOrder()];
    const from = order.indexOf(layerId);
    if (from < 0) return;
    order.splice(from, 1);
    const to =
      where === 'top' ? 0 : where === 'bottom' ? order.length : where === 'up' ? Math.max(0, from - 1) : Math.min(order.length, from + 1);
    order.splice(to, 0, layerId);
    this.layerOrder.set(order);
    this.writeLayerOrder(order);
    this.applyZIndexes();
  }

  /** Saved order for the layers still present; new layers placed by kind
   *  (points over lines over polygons, rasters at the bottom). */
  private applyLayerOrder(): void {
    const present = [...this.managedLayers.values()].map((m) => m.layer);
    const ids = new Set(present.map((l) => l.id));
    const saved = this.readLayerOrder().filter((id) => ids.has(id));
    const rank = (l: GisLayer) =>
      l.layerType === 'RASTER' ? 0 : l.geometryType === 'POLYGON' ? 1 : l.geometryType === 'LINE' ? 2 : 3;
    const fresh = present
      .filter((l) => !saved.includes(l.id))
      .sort((a, b) => rank(b) - rank(a) || a.displayOrder - b.displayOrder);
    const order = [...saved];
    for (const layer of fresh) {
      // New vectors go above existing rasters; new rasters go to the bottom.
      if (layer.layerType === 'RASTER') {
        order.push(layer.id);
      } else {
        const firstRaster = order.findIndex((id) => this.managedLayers.get(id)?.layer.layerType === 'RASTER');
        order.splice(firstRaster < 0 ? order.length : firstRaster, 0, layer.id);
      }
    }
    this.layerOrder.set(order);
    this.applyZIndexes();
  }

  private applyZIndexes(): void {
    const order = this.layerOrder();
    // Data layers sit between the basemap (0) and the overlays (9997+).
    order.forEach((id, index) => this.managedLayers.get(id)?.olLayer.setZIndex(100 + order.length - index));
  }

  private layerOrderKey(): string {
    return `mgp.layerOrder.${this.auth.user()?.id ?? 'anon'}`;
  }

  private readLayerOrder(): string[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(this.layerOrderKey()) ?? '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeLayerOrder(order: string[]): void {
    try {
      localStorage.setItem(this.layerOrderKey(), JSON.stringify(order));
    } catch {
      /* storage unavailable — order still applies for this session */
    }
  }

  private addWmsLayer(layer: GisLayer, insertAt?: number): void {
    if (!this.map) return;
    const qualifiedLayer = `${layer.geoserverWorkspace}:${layer.geoserverLayer}`;
    const visible = this.defaultVisible(layer);
    const properties = { gisLayerId: layer.id };
    // Rasters are heavy to render, so they come as 256 px tiles through
    // GeoWebCache (GeoServer re-renders a tile only once; a style change
    // truncates the cache). Vector layers stay single-image WMS so CQL
    // filters and the newest edits always show.
    const olLayer =
      layer.layerType === 'RASTER'
        ? new TileLayer({
            source: new TileWMS({
              url: `${environment.geoserverUrl}/gwc/service/wms`,
              params: { LAYERS: qualifiedLayer, TILED: true, FORMAT: 'image/png', VERSION: '1.1.1' },
              projection: MAP_PROJECTION,
              transition: 0
            }),
            visible,
            properties
          })
        : new ImageLayer({
            source: new ImageWMS({
              url: `${environment.geoserverUrl}/${layer.geoserverWorkspace}/wms`,
              params: { LAYERS: qualifiedLayer, TILED: false },
              projection: MAP_PROJECTION,
              ratio: 1
            }),
            visible,
            properties
          });
    // Later additions go just above the existing data layers, below any
    // analysis / sketch overlays drawn on top.
    if (insertAt !== undefined) this.map.getLayers().insertAt(Math.min(insertAt, this.map.getLayers().getLength()), olLayer);
    else this.map.addLayer(olLayer);
    this.managedLayers.set(layer.id, { layer, olLayer });
  }

  private computeInitialExtent(layers: GisLayer[]): number[] | null {
    // Prefer the boundary layer's own extent; fall back to the first other
    // layer that has a usable one, so the map still frames real data even
    // if the boundary layer specifically has no features yet.
    const boundary = layers.find(
      (layer) => layer.code === 'MUNICIPAL_BOUNDARY' && isUsableBbox(layer.bbox)
    );
    const source = boundary ?? layers.find((layer) => isUsableBbox(layer.bbox));
    if (!source?.bbox) {
      return null;
    }
    const { minX, minY, maxX, maxY } = source.bbox;
    return transformExtent([minX, minY, maxX, maxY], LAYER_PROJECTION, MAP_PROJECTION);
  }
}

/** A bbox is only worth zooming to if it is finite and has real area. A
 *  degenerate one (zero/near-zero span, or the [x, 0] point GeoServer
 *  reports for a layer whose source geometry has no valid CRS yet) would
 *  otherwise fling the view to a 1-metre point in the ocean — better to
 *  fall back to the default extent. ~1e-4° ≈ 11 m; every real municipal
 *  layer spans far more than that. */
function isUsableBbox(bbox: GisLayer['bbox'] | null | undefined): bbox is NonNullable<GisLayer['bbox']> {
  if (!bbox) return false;
  const { minX, minY, maxX, maxY } = bbox;
  if (![minX, minY, maxX, maxY].every((n) => Number.isFinite(n))) return false;
  return maxX - minX >= 1e-4 && maxY - minY >= 1e-4;
}

function sameView(a: NavHistoryEntry, b: NavHistoryEntry): boolean {
  return (
    Math.abs(a.center[0] - b.center[0]) < 0.01 &&
    Math.abs(a.center[1] - b.center[1]) < 0.01 &&
    Math.abs(a.zoom - b.zoom) < 1e-3 &&
    Math.abs(a.rotation - b.rotation) < 1e-4
  );
}
