import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsHexColor,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { RASTER_RAMPS, RASTER_STYLE_MODES, type RasterStyleMode } from '../raster-style';

/** `[longitude, latitude]` in EPSG:4326. */
type LonLat = [number, number];

/** A GeoJSON Polygon / MultiPolygon in EPSG:4326. */
type GeoJsonPolygon = { type: string; coordinates: unknown };

export class RasterUploadDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;
}

export class PointDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  point!: LonLat;
}

class StyleClassDto {
  @IsNumber()
  value!: number;

  @IsHexColor()
  color!: string;

  @IsOptional()
  @IsString()
  @Length(0, 60)
  label?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  opacity?: number;
}

export class RasterStyleDto {
  @IsIn(RASTER_STYLE_MODES)
  mode!: RasterStyleMode;

  @IsOptional()
  @IsInt()
  @Min(1)
  band?: number;

  @IsOptional()
  @IsIn(Object.keys(RASTER_RAMPS))
  ramp?: string;

  @IsOptional()
  @IsNumber()
  min?: number;

  @IsOptional()
  @IsNumber()
  max?: number;

  @IsOptional()
  @IsBoolean()
  invert?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => StyleClassDto)
  classes?: StyleClassDto[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(3)
  @ArrayMaxSize(3)
  @IsInt({ each: true })
  @Min(1, { each: true })
  bands?: [number, number, number];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  opacity?: number;
}

/** Base of every tool request: the input raster + band. */
class RasterInputDto {
  @IsUUID()
  layerId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  band?: number;
}

/** Tools that publish their result as a new layer. */
class RasterOutputDto extends RasterInputDto {
  @IsString()
  @Length(1, 80)
  outputName!: string;
}

export class TerrainDto extends RasterOutputDto {
  @IsIn(['slope', 'aspect', 'hillshade'])
  kind!: 'slope' | 'aspect' | 'hillshade';

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(100)
  zFactor?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(360)
  azimuth?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(90)
  altitude?: number;

  @IsOptional()
  @IsBoolean()
  percent?: boolean;
}

export class ContourDto extends RasterOutputDto {
  @IsNumber()
  @Min(0.01)
  interval!: number;

  @IsOptional()
  @IsNumber()
  base?: number;
}

export class ProfileDto extends RasterInputDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(500)
  line!: LonLat[];

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(1000)
  samples?: number;
}

export class CutFillDto extends RasterInputDto {
  @IsObject()
  polygon!: GeoJsonPolygon;

  /** Design level; omitted = the mean ground level inside the polygon. */
  @IsOptional()
  @IsNumber()
  baseLevel?: number;
}

export class WatershedDto extends RasterOutputDto {
  @IsIn(['accumulation', 'watershed'])
  mode!: 'accumulation' | 'watershed';

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  point?: LonLat;
}

export class FloodDto extends RasterOutputDto {
  /** Water surface elevation, in the raster's units. */
  @IsNumber()
  level!: number;

  /** Only flood the area connected to this point. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  seed?: LonLat;
}

export class LineOfSightDto extends RasterInputDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  from!: LonLat;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  to!: LonLat;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  observerHeight?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  targetHeight?: number;
}

export class ViewshedDto extends RasterOutputDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  point!: LonLat;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  observerHeight?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  targetHeight?: number;

  /** Metres; omitted = the whole raster. */
  @IsOptional()
  @IsNumber()
  @Min(1)
  maxDistance?: number;
}

export class CalcInputDto {
  @IsUUID()
  layerId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  band?: number;
}

export class RasterCalculatorDto {
  /** Bound to A, B, C, D in the expression, in order. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => CalcInputDto)
  inputs!: CalcInputDto[];

  @IsString()
  @Length(1, 500)
  expression!: string;

  @IsString()
  @Length(1, 80)
  outputName!: string;
}

class ReclassRuleDto {
  @IsNumber()
  min!: number;

  @IsNumber()
  max!: number;

  @IsInt()
  @Min(-32767)
  @Max(32767)
  value!: number;

  @IsOptional()
  @IsString()
  @Length(0, 60)
  label?: string;
}

export class ReclassifyDto extends RasterOutputDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => ReclassRuleDto)
  rules!: ReclassRuleDto[];
}

export class ClipDto extends RasterOutputDto {
  @IsObject()
  polygon!: GeoJsonPolygon;
}

export class PolygonizeDto extends RasterOutputDto {}

export class NdviDto extends RasterOutputDto {
  @IsInt()
  @Min(1)
  redBand!: number;

  @IsInt()
  @Min(1)
  nirBand!: number;
}

export class ChangeDetectionDto {
  @IsUUID()
  beforeLayerId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  beforeBand?: number;

  @IsUUID()
  afterLayerId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  afterBand?: number;

  /** Differences within ±threshold count as "no change". */
  @IsOptional()
  @IsNumber()
  @Min(0)
  threshold?: number;

  @IsString()
  @Length(1, 80)
  outputName!: string;
}
