/** Types for the GIS Print Layout tool (POST /api/gis/print/*). The
 *  backend builds the actual MapFish Print spec — the frontend only
 *  describes the live map and the chosen page options. */

export type PrintPageSize = 'A4' | 'A3';
export type PrintOrientation = 'portrait' | 'landscape';
export type PrintFormat = 'pdf' | 'png';
/** Not every live-map basemap can be printed: MapFish's fixed 'osm' layer
 *  type only ever requests `{baseURL}/{z}/{x}/{y}.png` — the Esri
 *  basemaps use a different tile path (`{z}/{y}/{x}`, y before x) that
 *  this print pipeline doesn't support, so they're intentionally absent
 *  here (see PrintLayoutComponent.toPrintBasemapId for the fallback). */
export type PrintBasemapId = 'osm' | 'carto-voyager' | 'carto-dark' | 'topo' | 'none';

export interface PrintLayerRequest {
  layerId: string;
  opacity?: number;
  cqlFilter?: string;
}

export interface PrintReportRequest {
  pageSize: PrintPageSize;
  orientation: PrintOrientation;
  format: PrintFormat;
  dpi: number;
  title?: string;
  metadata?: string;
  includeLegend: boolean;
  includeScalebar: boolean;
  includeNorthArrow: boolean;
  includeDate: boolean;
  basemapId?: PrintBasemapId;
  map: {
    center: [number, number];
    scale: number;
    rotation: number;
    projection: 'EPSG:3857';
  };
  layers: PrintLayerRequest[];
}

/** Shape of MapFish's own capabilities.json (only the parts the panel
 *  reads). Everything is optional — the panel falls back to sensible
 *  defaults if the call fails. */
export interface PrintCapabilities {
  app?: string;
  formats?: string[];
  layouts?: {
    name: string;
    attributes?: { name: string; clientParams?: Record<string, unknown> }[];
  }[];
}
