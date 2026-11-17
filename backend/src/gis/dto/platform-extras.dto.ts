import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateShareLinkDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  layerIds!: string[];

  /** Outside services shown on the map (Add Service specs). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsObject({ each: true })
  external?: Record<string, unknown>[];

  @IsOptional()
  @IsString()
  @MaxLength(40)
  basemap?: string;

  @IsArray()
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  center!: number[];

  @IsNumber()
  @Min(0)
  @Max(24)
  zoom!: number;

  /** Omitted / null = never expires. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  expiresInDays?: number | null;
}

export class CreateApiKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  expiresInDays?: number | null;
}

export const WEBHOOK_EVENTS = [
  'feature.created',
  'feature.updated',
  'feature.deleted',
  'layer.published',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | 'ping';

export class CreateWebhookDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsString()
  @MaxLength(2000)
  url!: string;

  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(['*', ...WEBHOOK_EVENTS], { each: true })
  events!: string[];
}

export class UpdateWebhookDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(['*', ...WEBHOOK_EVENTS], { each: true })
  events?: string[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** PATCH /gis/catalog/:layerId — a layer's Data Catalog record. */
export class UpdateLayerMetadataDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  licence?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  keywords?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  contact?: string;

  @IsOptional()
  @IsIn(['', 'once', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'as-needed'])
  updateFrequency?: string;

  /** When the data itself was captured / valid (YYYY-MM-DD). */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  dataDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class StorageLimitsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  municipalityQuotaMb?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsObject({ each: true })
  departments?: { id: string; quotaMb: number | null }[];
}

/** POST /gis/osm-import — OpenStreetMap features in a box as a new layer. */
export class OsmImportDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsIn(['buildings', 'roads', 'schools', 'health', 'water', 'waterways', 'worship', 'parks', 'landuse', 'shops', 'custom'])
  preset!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  customKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  customValue?: string;

  @IsIn(['POINT', 'LINE', 'POLYGON'])
  geometryType!: 'POINT' | 'LINE' | 'POLYGON';

  /** [minLon, minLat, maxLon, maxLat] */
  @IsArray()
  @ArrayMaxSize(4)
  @IsNumber({}, { each: true })
  bbox!: number[];

  @IsOptional()
  @IsUUID()
  departmentId?: string;
}
