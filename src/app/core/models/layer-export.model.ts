/** Download formats of GET /api/gis/layers/:id/export?format=… — must
 *  match the backend's LAYER_EXPORT_FORMATS keys. */
export type LayerExportFormat = 'geojson' | 'csv' | 'shapefile' | 'kml';

export interface LayerExportFormatOption {
  value: LayerExportFormat;
  label: string;
  extension: string;
  /** Module Access catalog id that unlocks this format (seed-modules.ts:
   *  Export to GeoJSON=231, csv=227, shapefile=228, kml=230). The backend
   *  enforces the same ids. */
  moduleId?: number;
}

export const EXPORT_DATA_MODULE_ID = 226;

export const LAYER_EXPORT_FORMATS: LayerExportFormatOption[] = [
  { value: 'geojson', label: 'GeoJSON', extension: 'geojson', moduleId: 231 },
  { value: 'csv', label: 'CSV', extension: 'csv', moduleId: 227 },
  { value: 'shapefile', label: 'Shapefile (.zip)', extension: 'zip', moduleId: 228 },
  { value: 'kml', label: 'KML', extension: 'kml', moduleId: 230 }
];
