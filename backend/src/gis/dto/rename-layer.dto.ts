import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

/** PATCH /api/gis/layers/:id — the display name only; the layer code,
 *  PostGIS table and GeoServer name stay as they are. */
export class RenameLayerDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  name!: string;
}
