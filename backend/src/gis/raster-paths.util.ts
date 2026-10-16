import * as path from 'path';

/** Where a raster layer's Cloud-Optimized GeoTIFF lives — derived from the
 *  layer id (never user input), under the municipality's storage folder. */
export function rasterFilePath(storageRoot: string, municipalityId: string, layerId: string): string {
  return path.join(storageRoot, municipalityId, 'rasters', `${layerId}.tif`);
}
