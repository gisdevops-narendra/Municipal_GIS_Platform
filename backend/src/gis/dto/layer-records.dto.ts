import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** POST /gis/layers/:id/records — see LayerRecordsService. */
export class LayerRecordsQueryDto {
  /** ECQL filter as the map tools build it. */
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  filter?: string;

  /** Only these features ("<layer>.<fid>" or bare fid). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  featureIds?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(25000)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;

  @IsOptional()
  @IsString()
  @MaxLength(63)
  sortField?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

  /** Nearest first to this [lon, lat] (map identify). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  near?: [number, number];

  /** false = leave out geometry / attributes / the total. */
  @IsOptional()
  @IsBoolean()
  geometry?: boolean;

  @IsOptional()
  @IsBoolean()
  properties?: boolean;

  @IsOptional()
  @IsBoolean()
  count?: boolean;
}
