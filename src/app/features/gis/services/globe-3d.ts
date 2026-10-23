import { environment } from '../../../../environments/environment';

/**
 * 3D mode of the main map: a Cesium globe shown in the map's own container
 * (over the OpenLayers view) with the same basemap, data layers and area.
 * MapService owns it — see MapService.set3d().
 *
 * Cesium is large (several MB), so it is loaded from a pinned CDN build the
 * first time 3D is switched on — never part of the app bundle.
 */
const CESIUM_VERSION = '1.121.0';
const CESIUM_BASE = `https://cdn.jsdelivr.net/npm/cesium@${CESIUM_VERSION}/Build/Cesium/`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cesium = any;
let loading: Promise<Cesium> | null = null;

function loadCesium(): Promise<Cesium> {
  const w = window as unknown as { Cesium?: Cesium; CESIUM_BASE_URL?: string };
  if (w.Cesium) return Promise.resolve(w.Cesium);
  loading ??= new Promise<Cesium>((resolve, reject) => {
    w.CESIUM_BASE_URL = CESIUM_BASE;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${CESIUM_BASE}Widgets/widgets.css`;
    document.head.appendChild(css);
    const script = document.createElement('script');
    script.src = `${CESIUM_BASE}Cesium.js`;
    script.async = true;
    script.onload = () => (w.Cesium ? resolve(w.Cesium) : reject(new Error('Cesium did not load.')));
    script.onerror = () => {
      loading = null;
      reject(new Error('3D could not be loaded — check the internet connection.'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export type Extent4326 = [number, number, number, number];

/** A DEM's height grid (row-major, north first) over a lon/lat bbox. */
export interface DemGrid {
  width: number;
  height: number;
  bbox: Extent4326;
  z: (number | null)[];
  min: number;
  max: number;
}

/** What the globe mirrors from the 2D map. */
export interface GlobeContext {
  extent: Extent4326 | null;
  /** Basemap tile URL templates ({z}/{x}/{y}), bottom → top. */
  basemap: { urls: string[]; credit: string };
  /** Visible GIS layers, bottom → top. */
  layers: { id: string; url: string; params: Record<string, string>; opacity: number }[];
}

/** Terrain from the workspace's own DEM (no Cesium ion token needed):
 *  every tile samples the DEM grid bilinearly; outside it the edge heights
 *  fade out, so there is no cliff at the DEM's edge. */
function demTerrain(Cesium: Cesium, dem: DemGrid): unknown {
  const size = 33;
  const [w, s, e, n] = dem.bbox;
  const fill = dem.min;
  const at = (c: number, r: number) => dem.z[r * dem.width + c] ?? fill;
  const sample = (lon: number, lat: number) => {
    const fx = Math.min(Math.max(((lon - w) / (e - w)) * (dem.width - 1), 0), dem.width - 1);
    const fy = Math.min(Math.max(((n - lat) / (n - s)) * (dem.height - 1), 0), dem.height - 1);
    const c0 = Math.floor(fx);
    const r0 = Math.floor(fy);
    const c1 = Math.min(c0 + 1, dem.width - 1);
    const r1 = Math.min(r0 + 1, dem.height - 1);
    const tx = fx - c0;
    const ty = fy - r0;
    const top = at(c0, r0) * (1 - tx) + at(c1, r0) * tx;
    const bottom = at(c0, r1) * (1 - tx) + at(c1, r1) * tx;
    const h = top * (1 - ty) + bottom * ty;
    // Outside the DEM the edge height fades to its lowest level within
    // 15 % of its size — no cliff at the edge, no streaks across the globe.
    const away = Math.max(Math.max(w - lon, lon - e, 0) / (e - w), Math.max(s - lat, lat - n, 0) / (n - s));
    const t = Math.min(away / 0.15, 1);
    return h * (1 - t) + fill * t;
  };
  const tiling = new Cesium.GeographicTilingScheme();
  return new Cesium.CustomHeightmapTerrainProvider({
    width: size,
    height: size,
    tilingScheme: tiling,
    callback: (x: number, y: number, level: number) => {
      const rect = tiling.tileXYToRectangle(x, y, level);
      const heights = new Float32Array(size * size);
      const d = Cesium.Math.toDegrees;
      const [west, south, east, north] = [d(rect.west), d(rect.south), d(rect.east), d(rect.north)];
      for (let r = 0; r < size; r++) {
        const lat = north - ((north - south) * r) / (size - 1);
        for (let c = 0; c < size; c++) heights[r * size + c] = sample(west + ((east - west) * c) / (size - 1), lat);
      }
      return heights;
    }
  });
}

export class Globe3d {
  private basemapKey = '';
  private layersKey = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private baseLayers: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private dataLayers: any[] = [];
  readonly hasTerrain = !!environment.cesiumIonToken;

  private constructor(
    private readonly Cesium: Cesium,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly viewer: any,
    private readonly element: HTMLElement
  ) {}

  /** Builds the globe inside `host` (positioned over the 2D map). */
  static async create(host: HTMLElement, context: GlobeContext, dem: DemGrid | null = null, exaggeration = 1): Promise<Globe3d> {
    const Cesium = await loadCesium();
    const element = document.createElement('div');
    element.className = 'gis-globe';
    Object.assign(element.style, { position: 'absolute', inset: '0', zIndex: '5', background: '#0b1622' });
    host.appendChild(element);
    const hasTerrain = !!environment.cesiumIonToken;
    if (hasTerrain) Cesium.Ion.defaultAccessToken = environment.cesiumIonToken;
    let viewer;
    try {
      viewer = new Cesium.Viewer(element, {
        baseLayer: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        animation: false,
        timeline: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
        ...(hasTerrain
          ? { terrain: Cesium.Terrain.fromWorldTerrain({ requestVertexNormals: true }) }
          : dem
            ? { terrainProvider: demTerrain(Cesium, dem) }
            : {})
      });
    } catch (error) {
      element.remove();
      throw error;
    }
    viewer.scene.globe.depthTestAgainstTerrain = hasTerrain || !!dem;
    // Relief reads better lit, with the sun over the north-west.
    viewer.scene.globe.enableLighting = false;
    viewer.scene.globe.showGroundAtmosphere = true;
    viewer.scene.fog.enabled = true;
    viewer.cesiumWidget.creditContainer.style.fontSize = '10px';
    const globe = new Globe3d(Cesium, viewer, element);
    globe.setExaggeration(exaggeration);
    globe.sync(context);
    if (hasTerrain) {
      Cesium.createOsmBuildingsAsync()
        .then((tiles: unknown) => !viewer.isDestroyed() && viewer.scene.primitives.add(tiles))
        .catch(() => undefined);
    }
    globe.flyTo(context.extent, true, 0);
    return globe;
  }

  /** Mirrors the 2D map's basemap and visible layers (cheap when unchanged). */
  sync(context: GlobeContext): void {
    const Cesium = this.Cesium;
    const imagery = this.viewer.imageryLayers;
    const basemapKey = JSON.stringify(context.basemap);
    if (basemapKey !== this.basemapKey) {
      this.basemapKey = basemapKey;
      this.baseLayers.forEach((l) => imagery.remove(l, true));
      this.baseLayers = context.basemap.urls.map((url, i) =>
        imagery.addImageryProvider(
          new Cesium.UrlTemplateImageryProvider({ url, maximumLevel: 19, credit: i === 0 ? context.basemap.credit : undefined }),
          i
        )
      );
    }
    const layersKey = JSON.stringify(context.layers);
    if (layersKey !== this.layersKey) {
      this.layersKey = layersKey;
      this.dataLayers.forEach((l) => imagery.remove(l, true));
      this.dataLayers = context.layers.map((layer) => {
        const { LAYERS, ...rest } = layer.params;
        const added = imagery.addImageryProvider(
          new Cesium.WebMapServiceImageryProvider({
            url: layer.url,
            layers: LAYERS,
            parameters: { ...rest, transparent: true, format: 'image/png' },
            tileWidth: 512,
            tileHeight: 512
          })
        );
        added.alpha = layer.opacity;
        return added;
      });
    }
  }

  /** Swaps the relief source when the visible DEM changes (the ion world
   *  terrain, when configured, always stays). */
  setTerrain(dem: DemGrid | null): void {
    if (this.hasTerrain || this.viewer.isDestroyed()) return;
    this.viewer.terrainProvider = dem ? demTerrain(this.Cesium, dem) : new this.Cesium.EllipsoidTerrainProvider();
    this.viewer.scene.globe.depthTestAgainstTerrain = !!dem;
  }

  /** Vertical exaggeration of the relief (1 = true scale). */
  setExaggeration(factor: number): void {
    const scene = this.viewer.scene;
    if ('verticalExaggeration' in scene) scene.verticalExaggeration = factor;
    else scene.globe.terrainExaggeration = factor;
  }

  /** Frames an area: tilted (oblique) or straight down. */
  flyTo(extent: Extent4326 | null, tilted = true, duration = 1.2): void {
    const Cesium = this.Cesium;
    const [minX, minY, maxX, maxY] = extent ?? [68, 6, 98, 37];
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const widthM = (maxX - minX) * 111320 * Math.cos((cy * Math.PI) / 180);
    const heightM = (maxY - minY) * 110540;
    const radius = Math.max(Math.hypot(widthM, heightM) / 2, 200);
    this.viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(cx, cy, 0), radius), {
      offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(tilted ? -40 : -90), radius * (tilted ? 1.9 : 2.2)),
      duration
    });
  }

  zoom(direction: 1 | -1): void {
    const camera = this.viewer.camera;
    const height = this.Cesium.Cartographic.fromCartesian(camera.position).height;
    const amount = Math.max(height * 0.45, 20);
    if (direction > 0) camera.zoomIn(amount);
    else camera.zoomOut(amount);
  }

  /** The area in view now (lon/lat) — for handing back to the 2D map. */
  viewExtent(): Extent4326 | null {
    const Cesium = this.Cesium;
    const rect = this.viewer.camera.computeViewRectangle(this.viewer.scene.globe.ellipsoid);
    if (!rect) return null;
    const d = Cesium.Math.toDegrees;
    return [d(rect.west), d(rect.south), d(rect.east), d(rect.north)];
  }

  destroy(): void {
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
    this.element.remove();
  }
}
