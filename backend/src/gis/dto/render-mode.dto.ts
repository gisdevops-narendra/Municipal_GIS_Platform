import { IsIn } from 'class-validator';

export const RENDER_MODES = ['WMS', 'WMS_TILED', 'MVT'] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

/** PATCH /api/gis/layers/:id/render-mode */
export class SetRenderModeDto {
  @IsIn(RENDER_MODES)
  mode!: RenderMode;
}
