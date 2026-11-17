import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import type BaseLayer from 'ol/layer/Base';
import TileWMS from 'ol/source/TileWMS';
import WMTS, { optionsFromCapabilities } from 'ol/source/WMTS';
import WMTSTileGrid from 'ol/tilegrid/WMTS';
import XYZ from 'ol/source/XYZ';
import TileArcGISRest from 'ol/source/TileArcGISRest';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import WMSCapabilities from 'ol/format/WMSCapabilities';
import WMTSCapabilities from 'ol/format/WMTSCapabilities';
import { bbox as bboxStrategy } from 'ol/loadingstrategy';
import { transformExtent } from 'ol/proj';
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style';

/**
 * "Add Service": outside map services (WMS, WMTS, XYZ tiles, ArcGIS REST,
 * WFS) added to the map by URL. Specs are plain JSON so they can be kept in
 * the browser and in Share Map links; the public viewer builds the same
 * layers from them.
 */
export type ExternalKind = 'WMS' | 'WMTS' | 'XYZ' | 'ARCGIS' | 'WFS';

/** A WMTS layer's tile grid, captured from its capabilities document. */
export interface WmtsGrid {
  layer: string;
  matrixSet: string;
  format: string;
  style: string;
  requestEncoding: 'KVP' | 'REST';
  urls: string[];
  projection: string;
  matrixIds: string[];
  resolutions: number[];
  origins: number[][];
  tileSizes: number[][];
  extent: number[] | null;
  dimensions: Record<string, string>;
}

export interface ExternalLayerSpec {
  id: string;
  kind: ExternalKind;
  title: string;
  url: string;
  /** WMS layer name / WFS type name / ArcGIS "show:<ids>". */
  layer?: string;
  format?: string;
  style?: string;
  version?: string;
  outputFormat?: string;
  attribution?: string;
  opacity: number;
  visible: boolean;
  wmts?: WmtsGrid;
}

export type ExternalLayerDraft = Omit<ExternalLayerSpec, 'id' | 'opacity' | 'visible'>;

export interface DiscoveredService {
  kind: ExternalKind;
  title: string;
  layers: { name: string; title: string; abstract?: string; draft: ExternalLayerDraft }[];
}

export type FetchText = (url: string) => Promise<string>;

export const EXTERNAL_KIND_LABELS: Record<ExternalKind, string> = {
  WMS: 'WMS',
  WMTS: 'WMTS',
  XYZ: 'XYZ / TMS tiles',
  ARCGIS: 'ArcGIS REST',
  WFS: 'WFS (vector)'
};

/** Plain browser fetch — used where no proxy is available (public viewer). */
export const directFetchText: FetchText = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

const SUPPORTED_PROJECTIONS = /^(EPSG:3857|EPSG:900913|EPSG:4326|CRS:84|OGC:CRS84|urn:ogc:def:crs:EPSG::3857|urn:ogc:def:crs:EPSG::4326|urn:ogc:def:crs:OGC:1\.3:CRS84)$/i;

/** URL without the OGC request parameters a user often pastes along. */
export function serviceBase(url: string): string {
  try {
    const u = new URL(url.trim());
    for (const key of [...u.searchParams.keys()]) {
      if (/^(service|request|version|layers?|typenames?|format|f)$/i.test(key)) u.searchParams.delete(key);
    }
    return u.toString().replace(/\?$/, '');
  } catch {
    return url.trim();
  }
}

function withParams(base: string, params: Record<string, string>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export function guessKind(url: string): ExternalKind | null {
  if (/\{(z|x|y|-y)\}/i.test(url)) return 'XYZ';
  if (/\/arcgis\/rest\/services|\/(MapServer|ImageServer)(\/|$|\?)/i.test(url)) return 'ARCGIS';
  if (/service=wmts|\/wmts/i.test(url)) return 'WMTS';
  if (/service=wfs|\/wfs/i.test(url)) return 'WFS';
  if (/service=wms|\/wms/i.test(url)) return 'WMS';
  return null;
}

/** Reads the service's capabilities and lists the layers it offers. */
export async function discoverService(url: string, kind: ExternalKind | 'AUTO', fetchText: FetchText): Promise<DiscoveredService> {
  const resolved = kind === 'AUTO' ? guessKind(url) : kind;
  if (resolved) return discoverKind(url, resolved, fetchText);
  const errors: string[] = [];
  for (const k of ['WMS', 'WMTS', 'WFS'] as ExternalKind[]) {
    try {
      const found = await discoverKind(url, k, fetchText);
      if (found.layers.length) return found;
    } catch (error) {
      errors.push(`${k}: ${(error as Error).message}`);
    }
  }
  throw new Error('Could not recognise the service. Pick its type and check the URL.');
}

async function discoverKind(url: string, kind: ExternalKind, fetchText: FetchText): Promise<DiscoveredService> {
  switch (kind) {
    case 'XYZ': {
      if (!/\{(z|x|y|-y)\}/i.test(url)) throw new Error('An XYZ URL needs {z}, {x} and {y} placeholders.');
      const host = safeHost(url);
      return { kind, title: host, layers: [{ name: url, title: `${host} tiles`, draft: { kind, url: url.trim(), title: `${host} tiles` } }] };
    }
    case 'ARCGIS':
      return discoverArcGis(url, fetchText);
    case 'WMS':
      return discoverWms(url, fetchText);
    case 'WMTS':
      return discoverWmts(url, fetchText);
    case 'WFS':
      return discoverWfs(url, fetchText);
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url.replace(/\{[^}]+\}/g, '0')).hostname;
  } catch {
    return 'Tiles';
  }
}

async function discoverArcGis(url: string, fetchText: FetchText): Promise<DiscoveredService> {
  const clean = url.trim().replace(/\?.*$/, '').replace(/\/+$/, '');
  const match = clean.match(/^(.*\/(?:MapServer|ImageServer))(?:\/(\d+))?$/i);
  if (!match) throw new Error('Use a .../MapServer or .../ImageServer URL.');
  const base = match[1];
  const info = JSON.parse(await fetchText(`${base}?f=json`)) as {
    error?: { message?: string };
    documentInfo?: { Title?: string };
    mapName?: string;
    name?: string;
    serviceDescription?: string;
    copyrightText?: string;
    layers?: { id: number; name: string; parentLayerId?: number }[];
  };
  if (info.error) throw new Error(info.error.message ?? 'ArcGIS error');
  const title = info.documentInfo?.Title || info.mapName || info.name || base.split('/').slice(-2, -1)[0] || 'ArcGIS service';
  const attribution = info.copyrightText || undefined;
  const whole = { name: '', title: `${title} (all layers)`, draft: { kind: 'ARCGIS' as const, url: base, title, attribution } };
  const sublayers = (info.layers ?? [])
    .filter((l) => (match[2] ? String(l.id) === match[2] : true))
    .map((l) => ({
      name: String(l.id),
      title: l.name,
      draft: { kind: 'ARCGIS' as const, url: base, title: `${title} — ${l.name}`, layer: `show:${l.id}`, attribution }
    }));
  return { kind: 'ARCGIS', title, layers: match[2] ? sublayers : [whole, ...sublayers] };
}

async function discoverWms(url: string, fetchText: FetchText): Promise<DiscoveredService> {
  const base = serviceBase(url);
  const xml = await fetchText(withParams(base, { SERVICE: 'WMS', REQUEST: 'GetCapabilities' }));
  if (!/WMS_Capabilities|WMT_MS_Capabilities/.test(xml)) throw new Error('Not a WMS capabilities document.');
  const caps = new WMSCapabilities().read(xml) as {
    version?: string;
    Service?: { Title?: string };
    Capability?: { Layer?: WmsCapLayer; Request?: { GetMap?: { Format?: string[] } } };
  };
  const formats = caps.Capability?.Request?.GetMap?.Format ?? [];
  const format = formats.find((f) => /png/i.test(f)) ?? formats[0] ?? 'image/png';
  const out: DiscoveredService['layers'] = [];
  const walk = (layer: WmsCapLayer | undefined) => {
    if (!layer) return;
    if (layer.Name) {
      out.push({
        name: layer.Name,
        title: layer.Title || layer.Name,
        abstract: layer.Abstract,
        draft: { kind: 'WMS', url: base, title: layer.Title || layer.Name, layer: layer.Name, format, version: caps.version ?? '1.3.0' }
      });
    }
    (layer.Layer ?? []).forEach(walk);
  };
  walk(caps.Capability?.Layer);
  return { kind: 'WMS', title: caps.Service?.Title || safeHost(base), layers: out.slice(0, 500) };
}

interface WmsCapLayer {
  Name?: string;
  Title?: string;
  Abstract?: string;
  Layer?: WmsCapLayer[];
}

async function discoverWmts(url: string, fetchText: FetchText): Promise<DiscoveredService> {
  const base = serviceBase(url);
  const capsUrl = /WMTSCapabilities\.xml$/i.test(base) ? base : withParams(base, { SERVICE: 'WMTS', REQUEST: 'GetCapabilities' });
  const xml = await fetchText(capsUrl);
  if (!/<(\w+:)?Capabilities/.test(xml) || !/TileMatrixSet/.test(xml)) throw new Error('Not a WMTS capabilities document.');
  const caps = new WMTSCapabilities().read(xml) as {
    ServiceIdentification?: { Title?: string };
    Contents?: {
      Layer?: { Identifier: string; Title?: string; Abstract?: string; TileMatrixSetLink?: { TileMatrixSet: string }[] }[];
      TileMatrixSet?: { Identifier: string; SupportedCRS?: string }[];
    };
  };
  const sets = new Map((caps.Contents?.TileMatrixSet ?? []).map((s) => [s.Identifier, s.SupportedCRS ?? '']));
  const out: DiscoveredService['layers'] = [];
  for (const layer of caps.Contents?.Layer ?? []) {
    const links = (layer.TileMatrixSetLink ?? []).map((l) => l.TileMatrixSet);
    const pick =
      links.find((id) => /3857|900913/.test(sets.get(id) ?? '')) ??
      links.find((id) => SUPPORTED_PROJECTIONS.test((sets.get(id) ?? '').replace(/^urn:ogc:def:crs:EPSG:[\d.]*:/i, 'EPSG:')));
    if (!pick) continue;
    const options = optionsFromCapabilities(caps, { layer: layer.Identifier, matrixSet: pick });
    if (!options) continue;
    const grid = options.tileGrid as WMTSTileGrid;
    const resolutions = grid.getResolutions();
    const zs = resolutions.map((_, z) => z);
    const sizeAt = (z: number) => {
      const s = grid.getTileSize(z);
      return typeof s === 'number' ? [s, s] : [s[0], s[1]];
    };
    const projection = typeof options.projection === 'string' ? options.projection : options.projection?.getCode?.() ?? 'EPSG:3857';
    const wmts: WmtsGrid = {
      layer: layer.Identifier,
      matrixSet: pick,
      format: options.format ?? 'image/png',
      style: options.style ?? 'default',
      requestEncoding: (options.requestEncoding as 'KVP' | 'REST') ?? 'KVP',
      urls: options.urls ?? [base],
      projection,
      matrixIds: grid.getMatrixIds(),
      resolutions,
      origins: zs.map((z) => [...grid.getOrigin(z)]),
      tileSizes: zs.map(sizeAt),
      extent: grid.getExtent() ? [...grid.getExtent()] : null,
      dimensions: (options.dimensions as Record<string, string>) ?? {}
    };
    out.push({
      name: layer.Identifier,
      title: layer.Title || layer.Identifier,
      abstract: layer.Abstract,
      draft: { kind: 'WMTS', url: base, title: layer.Title || layer.Identifier, layer: layer.Identifier, wmts }
    });
  }
  if (!out.length) throw new Error('No WMTS layer in Web Mercator or WGS84 was found.');
  return { kind: 'WMTS', title: caps.ServiceIdentification?.Title || safeHost(base), layers: out.slice(0, 500) };
}

async function discoverWfs(url: string, fetchText: FetchText): Promise<DiscoveredService> {
  const base = serviceBase(url);
  const xml = await fetchText(withParams(base, { SERVICE: 'WFS', REQUEST: 'GetCapabilities', VERSION: '1.1.0' }));
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (!doc.getElementsByTagNameNS('*', 'FeatureTypeList').length) throw new Error('Not a WFS capabilities document.');
  const text = (el: Element, tag: string) => el.getElementsByTagNameNS('*', tag)[0]?.textContent?.trim() ?? '';
  const formats = [...doc.getElementsByTagNameNS('*', 'Value'), ...doc.getElementsByTagNameNS('*', 'Format')]
    .map((e) => e.textContent?.trim() ?? '')
    .filter((f) => /json/i.test(f));
  const outputFormat = formats.find((f) => f === 'application/json') ?? formats[0] ?? 'application/json';
  const title = text(doc.documentElement, 'Title') || safeHost(base);
  const layers = [...doc.getElementsByTagNameNS('*', 'FeatureType')].map((ft) => {
    const name = text(ft, 'Name');
    const t = text(ft, 'Title') || name;
    return { name, title: t, abstract: text(ft, 'Abstract') || undefined, draft: { kind: 'WFS' as const, url: base, title: t, layer: name, outputFormat } };
  });
  return { kind: 'WFS', title, layers: layers.filter((l) => l.name).slice(0, 500) };
}

const WFS_STYLE = new Style({
  stroke: new Stroke({ color: '#c2410c', width: 1.6 }),
  fill: new Fill({ color: 'rgba(234, 88, 12, 0.14)' }),
  image: new CircleStyle({ radius: 5, fill: new Fill({ color: '#ea580c' }), stroke: new Stroke({ color: '#fff', width: 1.2 }) })
});

/** Builds the OpenLayers layer for a spec. `fetchText` is used by WFS. */
export function buildExternalLayer(spec: ExternalLayerSpec, fetchText: FetchText = directFetchText): BaseLayer {
  const common = { opacity: spec.opacity, visible: spec.visible, zIndex: 500, properties: { externalId: spec.id } };
  const attributions = spec.attribution || undefined;
  switch (spec.kind) {
    case 'WMS':
      return new TileLayer({
        ...common,
        source: new TileWMS({
          url: spec.url,
          params: {
            LAYERS: spec.layer ?? '',
            STYLES: spec.style ?? '',
            FORMAT: spec.format ?? 'image/png',
            TRANSPARENT: true,
            VERSION: spec.version ?? '1.3.0',
            TILED: true
          },
          attributions
        })
      });
    case 'WMTS': {
      const g = spec.wmts!;
      const projection = /4326|CRS:?84/i.test(g.projection) ? 'EPSG:4326' : 'EPSG:3857';
      return new TileLayer({
        ...common,
        source: new WMTS({
          urls: g.urls,
          layer: g.layer,
          matrixSet: g.matrixSet,
          format: g.format,
          style: g.style,
          requestEncoding: g.requestEncoding,
          projection,
          dimensions: g.dimensions,
          attributions,
          tileGrid: new WMTSTileGrid({
            origins: g.origins,
            resolutions: g.resolutions,
            matrixIds: g.matrixIds,
            tileSizes: g.tileSizes as [number, number][],
            extent: g.extent ?? undefined
          })
        })
      });
    }
    case 'XYZ':
      return new TileLayer({ ...common, source: new XYZ({ url: spec.url, attributions, maxZoom: 22 }) });
    case 'ARCGIS':
      return new TileLayer({
        ...common,
        source: new TileArcGISRest({ url: spec.url, params: spec.layer ? { LAYERS: spec.layer } : {}, attributions })
      });
    case 'WFS': {
      const format = new GeoJSON();
      const source: VectorSource = new VectorSource({
        format,
        strategy: bboxStrategy,
        attributions,
        loader: (extent, _resolution, projection, success, failure) => {
          const [minX, minY, maxX, maxY] = transformExtent(extent, projection, 'EPSG:4326');
          const url = withParams(spec.url, {
            SERVICE: 'WFS',
            REQUEST: 'GetFeature',
            VERSION: '1.1.0',
            TYPENAME: spec.layer ?? '',
            OUTPUTFORMAT: spec.outputFormat ?? 'application/json',
            SRSNAME: 'EPSG:4326',
            MAXFEATURES: '5000',
            BBOX: `${minX},${minY},${maxX},${maxY},EPSG:4326`
          });
          fetchText(url)
            .then((text) => {
              const features = format.readFeatures(text, { dataProjection: 'EPSG:4326', featureProjection: projection });
              source.addFeatures(features);
              success?.(features);
            })
            .catch(() => failure?.());
        }
      });
      return new VectorLayer({ ...common, source, style: WFS_STYLE });
    }
  }
}
