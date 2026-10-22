import { Type } from 'class-transformer';
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
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

export const BLANK_FIELD_TYPES = ['text', 'integer', 'decimal', 'date', 'boolean'] as const;
export type BlankFieldType = (typeof BLANK_FIELD_TYPES)[number];

export class BlankLayerFieldDto {
  @IsString()
  @Matches(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, {
    message: 'Field names use letters, digits and _ and start with a letter or _.',
  })
  name!: string;

  @IsIn(BLANK_FIELD_TYPES)
  type!: BlankFieldType;
}

/** POST /api/gis/layers/blank — an empty, editable vector layer. */
export class CreateBlankLayerDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsIn(['POINT', 'LINE', 'POLYGON'])
  geometryType!: 'POINT' | 'LINE' | 'POLYGON';

  /** Storage CRS (EPSG:n); the workspace default when omitted. */
  @IsOptional()
  @Matches(/^EPSG:\d{4,6}$/i, { message: 'The CRS must look like EPSG:32643.' })
  crs?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BlankLayerFieldDto)
  fields!: BlankLayerFieldDto[];
}

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
