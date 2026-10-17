import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** POST /api/gis/layers/:id/features — geometry is GeoJSON in EPSG:4326. */
export class CreateFeatureDto {
  @IsObject()
  geometry!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  properties?: Record<string, unknown>;
}

/** PATCH /api/gis/layers/:id/features/:fid — either part may be omitted. */
export class UpdateFeatureDto {
  @IsOptional()
  @IsObject()
  geometry?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  properties?: Record<string, unknown>;
}

export const GEOPROCESS_OPERATIONS = [
  'buffer',
  'dissolve',
  'intersect',
  'clip',
  'erase',
  'join',
  // one layer
  'centroids',
  'convexhull',
  'envelope',
  'simplify',
  'explode',
  'polygonstolines',
  'linestopolygons',
  'pointsalonglines',
  'voronoi',
  'squaregrid',
  'hexgrid',
  // two layers
  'merge',
  'symdifference',
  'nearest',
  'selectbylocation',
] as const;
export type GeoprocessOperation = (typeof GEOPROCESS_OPERATIONS)[number];

/** POST /api/gis/geoprocessing — writes and publishes a new layer. */
export class GeoprocessDto {
  @IsIn(GEOPROCESS_OPERATIONS)
  operation!: GeoprocessOperation;

  @IsUUID()
  inputLayerId!: string;

  /** intersect / clip / erase / join. */
  @IsOptional()
  @IsUUID()
  overlayLayerId?: string;

  @IsString()
  @MaxLength(120)
  outputName!: string;

  /** Owner only: publish the result as this department's layer. */
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  /** buffer: metres. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(50000)
  distance?: number;

  /** buffer: merge all buffers into one feature. */
  @IsOptional()
  @IsBoolean()
  dissolve?: boolean;

  /** dissolve: group by this field (whole layer when omitted). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  dissolveField?: string;

  /** join: copy the first intersecting feature's attributes, or count them. */
  @IsOptional()
  @IsIn(['attributes', 'count'])
  joinMode?: 'attributes' | 'count';
}

/** POST /api/gis/layers/:id/impact — features within `distance` m of a
 *  GeoJSON (EPSG:4326) geometry, as CSV. */
export class ImpactReportDto {
  @IsObject()
  geometry!: Record<string, unknown>;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(50000)
  distance?: number;
}

/** POST /api/gis/layers/:id/features/:fid/split — GeoJSON line, EPSG:4326. */
export class SplitFeatureDto {
  @IsObject()
  line!: Record<string, unknown>;
}

/** POST /api/gis/layers/:id/features/merge. */
export class MergeFeaturesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  featureIds!: number[];

  @IsInt()
  keepId!: number;
}
