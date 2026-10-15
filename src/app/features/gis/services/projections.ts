import proj4 from 'proj4';
import { register } from 'ol/proj/proj4';

/**
 * Coordinate systems the Go To X:Y tool accepts. OpenLayers only knows
 * EPSG:4326 / EPSG:3857 out of the box; the WGS84 UTM zones covering India
 * (42N–46N — workspaces store data in EPSG:32643 by default) are registered
 * here through proj4. Importing this module registers them once.
 */
export interface CoordinateSystemOption {
  code: string;
  label: string;
  /** Axis labels for the input fields, in the order X, Y. */
  axes: [string, string];
  /** Geographic (degrees) vs projected (metres) — drives input hints. */
  geographic: boolean;
}

const UTM_ZONES = [42, 43, 44, 45, 46];

for (const zone of UTM_ZONES) {
  proj4.defs(`EPSG:326${zone}`, `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs +type=crs`);
}
register(proj4);

export const GOTO_COORDINATE_SYSTEMS: CoordinateSystemOption[] = [
  { code: 'EPSG:4326', label: 'WGS84 — Longitude / Latitude', axes: ['Longitude', 'Latitude'], geographic: true },
  ...UTM_ZONES.map((zone) => ({
    code: `EPSG:326${zone}`,
    label: `UTM zone ${zone}N (EPSG:326${zone})`,
    axes: ['Easting', 'Northing'] as [string, string],
    geographic: false
  })),
  { code: 'EPSG:3857', label: 'Web Mercator (EPSG:3857)', axes: ['X', 'Y'], geographic: false }
];
