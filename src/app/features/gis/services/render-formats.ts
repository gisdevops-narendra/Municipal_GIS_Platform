import type { GisLayer, GisRenderMode } from '../../../core/models/gis-layer.model';

/** A concrete way of drawing a layer (everything but AUTO). */
export type RenderFormat = Exclude<GisRenderMode, 'AUTO'>;

export interface RenderFormatInfo {
  format: RenderFormat;
  label: string;
  /** Speed / scalability score out of 10 (shown to administrators). */
  score: number;
  icon: string;
  /** Which kinds of layer it can draw. */
  vector: boolean;
  raster: boolean;
  /** Styled in the browser from the layer's GeoServer style. */
  browserStyled: boolean;
  hint: string;
}

/** Fastest first: this order is also the automatic fallback order. */
export const RENDER_FORMATS: RenderFormatInfo[] = [
  {
    format: 'PMTILES',
    label: 'PMTiles',
    score: 10,
    icon: 'pi pi-box',
    vector: true,
    raster: true,
    browserStyled: true,
    hint: 'Pre-built single-file tile archive read with range requests — no server rendering. Fastest for large, rarely edited layers.'
  },
  {
    format: 'MVT',
    label: 'Vector tiles (MVT/PBF)',
    score: 9.5,
    icon: 'pi pi-objects-column',
    vector: true,
    raster: false,
    browserStyled: true,
    hint: 'GeoWebCache vector tiles drawn in the browser: crisp at every zoom, always current.'
  },
  {
    format: 'WMTS',
    label: 'WMTS',
    score: 9.5,
    icon: 'pi pi-th-large',
    vector: true,
    raster: true,
    browserStyled: false,
    hint: 'Standard cached image tiles from GeoWebCache (OGC WMTS). Also used by the 3D view.'
  },
  {
    format: 'XYZ',
    label: 'XYZ / TMS',
    score: 9,
    icon: 'pi pi-table',
    vector: true,
    raster: true,
    browserStyled: false,
    hint: 'Cached image tiles from GeoWebCache by simple z/x/y URLs.'
  },
  {
    format: 'COG',
    label: 'COG + TiTiler',
    score: 9,
    icon: 'pi pi-image',
    vector: false,
    raster: true,
    browserStyled: false,
    hint: 'Tiles cut on demand from the Cloud-Optimized GeoTIFF by TiTiler — no GeoServer rendering.'
  },
  {
    format: 'WMS_TILED',
    label: 'WMS + GeoWebCache',
    score: 8,
    icon: 'pi pi-clone',
    vector: true,
    raster: true,
    browserStyled: false,
    hint: 'Tiled WMS requests answered from the GeoWebCache tile cache.'
  },
  {
    format: 'WMS',
    label: 'WMS (live image)',
    score: 7,
    icon: 'pi pi-desktop',
    vector: true,
    raster: true,
    browserStyled: false,
    hint: 'One image per view rendered live by GeoServer. Always up to date; best for small, often edited layers.'
  },
  {
    format: 'WFS',
    label: 'WFS (features)',
    score: 5,
    icon: 'pi pi-share-alt',
    vector: true,
    raster: false,
    browserStyled: true,
    hint: 'Raw features (GeoJSON) from GeoServer, drawn in the browser. Small layers only.'
  },
  {
    format: 'OGC_FEATURES',
    label: 'OGC API – Features',
    score: 5,
    icon: 'pi pi-code',
    vector: true,
    raster: false,
    browserStyled: true,
    hint: 'Raw features from the platform\'s OGC API (PostGIS), drawn in the browser. Small layers only.'
  }
];

const BY_FORMAT = new Map(RENDER_FORMATS.map((f) => [f.format, f]));

export function formatInfo(format: RenderFormat): RenderFormatInfo {
  return BY_FORMAT.get(format)!;
}

/** Formats an administrator can choose for this layer, fastest first. */
export function formatsFor(layer: GisLayer): RenderFormatInfo[] {
  const raster = layer.layerType === 'RASTER';
  return RENDER_FORMATS.filter((f) => (raster ? f.raster : f.vector));
}

/** Formats that draw features in the browser — they need a reproducible
 *  style; rasters never use them except a PMTiles image archive. */
export function isBrowserStyled(format: RenderFormat, layer: GisLayer): boolean {
  if (format === 'PMTILES') return layer.layerType !== 'RASTER';
  return formatInfo(format).browserStyled;
}

/**
 * The format to try for a layer, and what to fall back to: the chosen
 * format first, then every faster-to-slower compatible format after it.
 * Feature formats (WFS / OGC API) fall back to vector tiles, never the
 * other way round. AUTO starts at the fastest format.
 */
export function fallbackChain(layer: GisLayer): RenderFormat[] {
  const all = formatsFor(layer).map((f) => f.format);
  const mode = layer.renderMode ?? 'AUTO';
  const tiled: RenderFormat[] = all.filter((f) => f !== 'WFS' && f !== 'OGC_FEATURES');
  if (mode === 'AUTO') return tiled;
  if (mode === 'WFS' || mode === 'OGC_FEATURES') return [mode, ...tiled.filter((f) => f !== 'PMTILES')];
  const at = tiled.indexOf(mode as RenderFormat);
  return at >= 0 ? tiled.slice(at) : tiled;
}

/** What AUTO would pick for a layer right now (ignoring runtime checks). */
export function recommendedFormat(layer: GisLayer): RenderFormat {
  if (layer.pmtilesStatus === 'READY') return 'PMTILES';
  // Rasters: GeoWebCache WMTS keeps GeoServer's exact styling.
  return layer.layerType === 'RASTER' ? 'WMTS' : 'MVT';
}
