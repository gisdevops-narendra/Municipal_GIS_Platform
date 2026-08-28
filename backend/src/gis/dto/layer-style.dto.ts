import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsHexColor,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export type StyleGeometry = 'point' | 'line' | 'polygon' | 'raster';
export type StyleMode = 'single' | 'categorized' | 'graduated';
export type MarkShape =
  'circle' | 'square' | 'triangle' | 'star' | 'cross' | 'x';
export type ClassificationMethod = 'equalInterval' | 'quantile' | 'manual';
export type IconMime = 'image/svg+xml' | 'image/png';

/** A point icon (ExternalGraphic). `source: 'builtin'` → `name` is a
 *  bundled marker-icon id (backend/src/gis/marker-icons); `source:
 *  'custom'` → `name` is the GeoServer style-resource filename an upload
 *  produced. The backend resolves both to a relative ExternalGraphic URL
 *  and guarantees the file is in the workspace's style resource dir before
 *  the YSLD references it. */
export class IconRefDto {
  @IsIn(['builtin', 'custom'])
  source!: 'builtin' | 'custom';

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsIn(['image/svg+xml', 'image/png'])
  mime!: IconMime;
}

/** A single drawing symbol — reused for the base symbol and per class /
 *  category. Fields not relevant to the layer's geometry are ignored by
 *  the YSLD generator. */
export class SymbolSpecDto {
  @IsOptional()
  @IsIn(['circle', 'square', 'triangle', 'star', 'cross', 'x'])
  markShape?: MarkShape;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(120)
  markSize?: number;

  @IsOptional()
  @IsNumber()
  @Min(-360)
  @Max(360)
  markRotation?: number;

  /** When set, the point is drawn as this icon (ExternalGraphic) instead
   *  of a vector mark — fill/stroke no longer apply (GeoServer renders the
   *  graphic as-is), but size / rotation / opacity / anchor do. */
  @IsOptional()
  @ValidateNested()
  @Type(() => IconRefDto)
  icon?: IconRefDto;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  iconOpacity?: number;

  /** ExternalGraphic anchor point, 0..1. Defaults to the icon's own
   *  manifest anchor (tip for pins, centre for shapes). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  iconAnchorX?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  iconAnchorY?: number;

  @IsOptional()
  @IsHexColor()
  fillColor?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  fillOpacity?: number;

  @IsOptional()
  @IsHexColor()
  strokeColor?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(40)
  strokeWidth?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  strokeOpacity?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsNumber({}, { each: true })
  strokeDash?: number[];

  @IsOptional()
  @IsIn(['butt', 'round', 'square'])
  strokeCap?: 'butt' | 'round' | 'square';

  @IsOptional()
  @IsIn(['miter', 'round', 'bevel'])
  strokeJoin?: 'miter' | 'round' | 'bevel';
}

export class CategoryDto {
  /** Attribute value this category matches. String or number. */
  value!: string | number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ValidateNested()
  @Type(() => SymbolSpecDto)
  symbol!: SymbolSpecDto;
}

export class CategorizeSpecDto {
  @IsString()
  @MaxLength(63)
  field!: string;

  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => CategoryDto)
  categories!: CategoryDto[];

  @IsBoolean()
  includeOther!: boolean;
}

export class GraduateSpecDto {
  @IsString()
  @MaxLength(63)
  field!: string;

  @IsIn(['equalInterval', 'quantile', 'manual'])
  method!: ClassificationMethod;

  @IsInt()
  @Min(2)
  @Max(12)
  classCount!: number;

  /** Ascending class boundaries — `classCount + 1` values (min … max). */
  @IsArray()
  @ArrayMaxSize(13)
  @IsNumber({}, { each: true })
  breaks!: number[];

  /** One hex colour per class (`classCount` entries). */
  @IsArray()
  @ArrayMaxSize(12)
  @IsHexColor({ each: true })
  ramp!: string[];
}

export class LabelSpecDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString()
  @MaxLength(63)
  field!: string;

  @IsString()
  @MaxLength(60)
  font!: string;

  @IsNumber()
  @Min(6)
  @Max(72)
  size!: number;

  @IsHexColor()
  color!: string;

  @IsHexColor()
  haloColor!: string;

  @IsNumber()
  @Min(0)
  @Max(10)
  haloWidth!: number;

  @IsNumber()
  @Min(-360)
  @Max(360)
  rotation!: number;

  @IsNumber()
  @Min(-100)
  @Max(100)
  offsetX!: number;

  @IsNumber()
  @Min(-100)
  @Max(100)
  offsetY!: number;

  @IsIn(['point', 'line'])
  placement!: 'point' | 'line';
}

export class ScaleSpecDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  minDenominator?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxDenominator?: number;
}

export class ColorMapEntryDto {
  @IsNumber()
  quantity!: number;

  @IsHexColor()
  color!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  opacity?: number;
}

export class RasterSpecDto {
  @IsNumber()
  @Min(0)
  @Max(1)
  opacity!: number;

  @IsArray()
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => ColorMapEntryDto)
  colorMap!: ColorMapEntryDto[];
}

export class LayerStyleSpecDto {
  @IsIn([1])
  version!: 1;

  @IsIn(['point', 'line', 'polygon', 'raster'])
  geometry!: StyleGeometry;

  @IsIn(['single', 'categorized', 'graduated'])
  mode!: StyleMode;

  @ValidateNested()
  @Type(() => SymbolSpecDto)
  symbol!: SymbolSpecDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CategorizeSpecDto)
  categorize?: CategorizeSpecDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => GraduateSpecDto)
  graduate?: GraduateSpecDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LabelSpecDto)
  labels?: LabelSpecDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ScaleSpecDto)
  scale?: ScaleSpecDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => RasterSpecDto)
  raster?: RasterSpecDto;
}
