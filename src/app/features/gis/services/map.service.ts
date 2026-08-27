import { Injectable, signal } from '@angular/core';
import OlMap from 'ol/Map';
import View from 'ol/View';
import Feature from 'ol/Feature';
import TileLayer from 'ol/layer/Tile';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import OSM from 'ol/source/OSM';
import XYZ from 'ol/source/XYZ';
import ImageWMS from 'ol/source/ImageWMS';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import Draw, { createBox } from 'ol/interaction/Draw';
import { Fill, Stroke, Style, Circle as CircleStyle } from 'ol/style';
import { defaults as defaultControls } from 'ol/control';
import ScaleLine from 'ol/control/ScaleLine';
import MousePosition from 'ol/control/MousePosition';
import { createStringXY } from 'ol/coordinate';
import { fromLonLat, transformExtent } from 'ol/proj';
import { createEmpty, extend as extendExtent, isEmpty as isEmptyExtent } from 'ol/extent';
import { forkJoin, map as rxMap, Observable, of } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { GisLayer } from '../../../core/models/gis-layer.model';

const MAP_PROJECTION = 'EPSG:3857';
const LAYER_PROJECTION = 'EPSG:4326';

/** Generic fallback view (roughly India) used only when no layer on this
 *  municipality's workspace has a usable bounding box yet (e.g. a freshly
 *  registered municipality with no demo data seeded) — see Task 6 §5: the
 *  view must never be a hardcoded Somnath-specific coordinate. */
const FALLBACK_CENTER_4326: [number, number] = [78.9629, 22.5937];
const FALLBACK_ZOOM = 4;

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

interface ManagedLayer {
  layer: GisLayer;
  olLayer: ImageLayer<ImageWMS>;
}

export interface BasemapOption {
  id: string;
  label: string;
  attribution: string;
}

/** Task 9 §7/§16: open-source/public tile sources only — no commercial
 *  provider is ever required for the map to function (OSM stays the
 *  default). CartoDB Positron and OpenTopoMap are both free, no-API-key
 *  XYZ tile services suitable for a non-production demo/dev deployment. */
const BASEMAPS: Record<string, { label: string; attribution: string; build: () => TileLayer<OSM | XYZ> }> = {
  osm: {
    label: 'OpenStreetMap',
    attribution: '© OpenStreetMap contributors',
    build: () => new TileLayer({ source: new OSM() })
  },
  'carto-light': {
    label: 'Light (CARTO)',
    attribution: '© OpenStreetMap contributors © CARTO',
    build: () =>
      new TileLayer({
        source: new XYZ({
          url: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
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
  private baseLayer: TileLayer<OSM | XYZ> | null = null;
  private readonly managedLayers = new Map<string, ManagedLayer>();
  private initialExtent3857: number[] | null = null;

  /** Overlay that draws the attribute table's currently-selected features
   *  on top of everything else. Created lazily on first selection. */
  private selectionLayer: VectorLayer<VectorSource> | null = null;
  /** Overlay for Query Builder results (distinct colour from selection). */
  private queryLayer: VectorLayer<VectorSource> | null = null;
  /** Sketch layer + active interaction for "draw geometry for spatial query". */
  private drawLayer: VectorLayer<VectorSource> | null = null;
  private drawInteraction: Draw | null = null;
  private readonly geoJson = new GeoJSON();

  /** Geometries (EPSG:4326) of the currently highlighted/selected features —
   *  read by the Query Builder for "use current selection as spatial input". */
  readonly selectionGeometries = signal<Record<string, unknown>[]>([]);

  /** Current visibility per GisLayer.id, seeded from visibleByDefault —
   *  the single source of truth the layer panel binds its checkboxes to. */
  readonly layerVisibility = signal<Record<string, boolean>>({});

  /** Task 9 §7: which open/public basemap is currently active. */
  readonly activeBasemap = signal<string>('osm');
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
      initialVisibility[layer.id] = layer.visibleByDefault;
      this.addWmsLayer(layer);
    }
    this.layerVisibility.set(initialVisibility);

    this.initialExtent3857 = this.computeInitialExtent(layers);
    this.resetView();
  }

  destroy(): void {
    this.cancelDraw();
    this.map?.setTarget(undefined);
    this.map = null;
    this.managedLayers.clear();
    this.selectionLayer = null;
    this.queryLayer = null;
    this.drawLayer = null;
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
    if (cql && cql.trim().length > 0) {
      params['CQL_FILTER'] = cql;
    } else {
      delete params['CQL_FILTER'];
    }
    source.updateParams(params);
  }

  clearAllLayerCqlFilters(): void {
    for (const [id] of this.managedLayers) {
      this.setLayerCqlFilter(id, null);
    }
  }

  setQueryHighlight(geometries: (Record<string, unknown> | null | undefined)[]): void {
    const source = this.ensureQuerySource();
    source.clear();
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
  beginDraw(kind: 'Point' | 'Line' | 'Rectangle' | 'Polygon'): Observable<Record<string, unknown>> {
    this.cancelDraw();
    const source = this.ensureDrawSource();
    source.clear();

    const type = kind === 'Point' ? 'Point' : kind === 'Line' ? 'LineString' : kind === 'Rectangle' ? 'Circle' : 'Polygon';

    return new Observable<Record<string, unknown>>((subscriber) => {
      this.drawInteraction = new Draw({
        source,
        type,
        geometryFunction: kind === 'Rectangle' ? createBox() : undefined
      });
      this.drawInteraction.on('drawstart', () => source.clear());
      this.drawInteraction.on('drawend', (event) => {
        const geom = (event as unknown as { feature: Feature }).feature.getGeometry();
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
      const primary = '#128077';
      this.queryLayer = new VectorLayer({
        source: new VectorSource(),
        style: new Style({
          stroke: new Stroke({ color: primary, width: 2.5 }),
          fill: new Fill({ color: 'rgba(18, 128, 119, 0.14)' }),
          image: new CircleStyle({
            radius: 6,
            stroke: new Stroke({ color: primary, width: 2.5 }),
            fill: new Fill({ color: 'rgba(18, 128, 119, 0.3)' })
          })
        }),
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

  /** Registers a handler for single-clicks on the map, receiving the
   *  clicked coordinate in the map's own projection (EPSG:3857) — ready to
   *  pass straight into getFeatureInfo. Keeps `ol/Map` itself out of
   *  component code. */
  onSingleClick(handler: (coordinate: number[]) => void): void {
    this.map?.on('singleclick', (event) => handler(event.coordinate));
  }

  setLayerVisibility(layerId: string, visible: boolean): void {
    const entry = this.managedLayers.get(layerId);
    if (!entry) return;
    entry.olLayer.setVisible(visible);
    this.layerVisibility.update((current) => ({ ...current, [layerId]: visible }));
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

  private zoomToExtent4326(bbox: [number, number, number, number]): void {
    const view = this.map?.getView();
    if (!view) return;
    const extent = transformExtent(bbox, LAYER_PROJECTION, MAP_PROJECTION);
    view.fit(extent, { size: this.map?.getSize(), padding: [40, 40, 40, 40], maxZoom: 18, duration: 250 });
  }

  /** GeoServer WMS GetLegendGraphic — a public, anonymous GeoServer image
   *  endpoint, so this is just a URL, no HTTP call needed here. */
  legendGraphicUrl(layer: GisLayer): string {
    const qualifiedLayer = `${layer.geoserverWorkspace}:${layer.geoserverLayer}`;
    const params = new URLSearchParams({
      service: 'WMS',
      version: '1.1.0',
      request: 'GetLegendGraphic',
      format: 'image/png',
      layer: qualifiedLayer,
      legend_options: 'fontAntiAliasing:true;fontSize:11'
    });
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

  private addWmsLayer(layer: GisLayer): void {
    if (!this.map) return;
    const qualifiedLayer = `${layer.geoserverWorkspace}:${layer.geoserverLayer}`;
    const source = new ImageWMS({
      url: `${environment.geoserverUrl}/${layer.geoserverWorkspace}/wms`,
      params: { LAYERS: qualifiedLayer, TILED: false },
      projection: MAP_PROJECTION,
      ratio: 1
    });
    const olLayer = new ImageLayer({ source, visible: layer.visibleByDefault, properties: { gisLayerId: layer.id } });
    this.map.addLayer(olLayer);
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
