import { IsIn } from 'class-validator';

/** Rendering formats, fastest first (see GisRenderMode in schema.prisma). */
export const RENDER_MODES = [
  'AUTO',
  'PMTILES',
  'MVT',
  'WMTS',
  'XYZ',
  'COG',
  'WMS_TILED',
  'WMS',
  'WFS',
  'OGC_FEATURES',
] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

/** Which formats make sense for which kind of data. */
export const RENDER_MODES_BY_TYPE: Record<'VECTOR' | 'RASTER', readonly RenderMode[]> = {
  VECTOR: ['AUTO', 'PMTILES', 'MVT', 'WMTS', 'XYZ', 'WMS_TILED', 'WMS', 'WFS', 'OGC_FEATURES'],
  RASTER: ['AUTO', 'PMTILES', 'WMTS', 'XYZ', 'COG', 'WMS_TILED', 'WMS'],
};

/** PATCH /api/gis/layers/:id/render-mode */
export class SetRenderModeDto {
  @IsIn(RENDER_MODES)
  mode!: RenderMode;
}
