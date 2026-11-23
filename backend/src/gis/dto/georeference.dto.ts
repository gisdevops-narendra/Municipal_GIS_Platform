import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export const GEOREF_TRANSFORMS = ['helmert', 'poly1', 'poly2', 'poly3', 'tps'] as const;
export const GEOREF_RESAMPLING = ['near', 'bilinear', 'cubic', 'cubicspline', 'lanczos'] as const;

/** One ground control point: an image position and where it is on Earth
 *  (always WGS84 longitude / latitude; converted to the target CRS). */
export class GeorefGcpDto {
  @IsString()
  @Length(1, 40)
  id!: string;

  @IsBoolean()
  enabled!: boolean;

  /** pixel column / line of the source image (may be fractional) */
  @IsNumber()
  @Min(-1e7)
  @Max(1e7)
  px!: number;

  @IsNumber()
  @Min(-1e7)
  @Max(1e7)
  py!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lon!: number;

  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;
}

/** Transformation settings (QGIS "Transformation Settings"). */
export class GeorefSettingsDto {
  @IsIn(GEOREF_TRANSFORMS)
  transform!: (typeof GEOREF_TRANSFORMS)[number];

  @IsIn(GEOREF_RESAMPLING)
  resampling!: (typeof GEOREF_RESAMPLING)[number];

  /** Output CRS, e.g. "EPSG:32642". */
  @Matches(/^EPSG:\d{4,6}$/i)
  targetCrs!: string;
}

/** PUT /gis/raster/georef/:id — saves the session's GCPs and settings. */
export class SaveGeorefSessionDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => GeorefGcpDto)
  gcps!: GeorefGcpDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => GeorefSettingsDto)
  settings?: GeorefSettingsDto;
}

/** POST /gis/raster/georef/:id/preview — a quick low-resolution warp. */
export class GeorefPreviewDto extends SaveGeorefSessionDto {
  @ValidateNested()
  @Type(() => GeorefSettingsDto)
  declare settings: GeorefSettingsDto;
}

/** Background job "georeference": full-resolution warp, published as a
 *  raster layer (downloadable as GeoTIFF from the layer). */
export class GeoreferenceRunDto extends GeorefPreviewDto {
  @IsUUID()
  sessionId!: string;

  @IsString()
  @Length(1, 80)
  outputName!: string;
}

/** POST /gis/raster/georef — upload options. */
export class CreateGeorefSessionDto {
  /** Resolution a PDF page is rendered at (images ignore it). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(72)
  @Max(600)
  dpi?: number;
}
