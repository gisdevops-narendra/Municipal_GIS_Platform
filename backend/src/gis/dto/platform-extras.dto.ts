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

// ----- Groundwater -----
export class WellReadingDto {
  /** YYYY-MM-DD */
  @IsString()
  @MaxLength(10)
  date!: string;

  /** Depth to water below ground, metres. */
  @IsNumber()
  @Min(-50)
  @Max(2000)
  depthM!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class WellImportDto {
  /** Well-layer field the file's well ids match ('ogc_fid' = feature id). */
  @IsString()
  @MaxLength(63)
  keyField!: string;

  @IsArray()
  @ArrayMaxSize(20000)
  @IsObject({ each: true })
  rows!: { key: string; date: string; depthM: number }[];
}

// ----- Disease outbreak -----
export class OutbreakDto {
  @IsUUID()
  layerId!: string;

  @IsString()
  @MaxLength(63)
  dateField!: string;

  @IsOptional()
  @IsString()
  @MaxLength(63)
  diseaseField?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  diseaseValues?: string[];

  /** YYYY-MM-DD; default = 90 days up to the latest case. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  to?: string;

  /** Cases within this distance join a cluster. */
  @IsOptional()
  @IsNumber()
  @Min(20)
  @Max(5000)
  clusterDistanceM?: number;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(100)
  minCases?: number;

  /** Control (fogging / spraying) ring around each cluster. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5000)
  zoneBufferM?: number;

  @IsOptional()
  @IsUUID()
  areaLayerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(63)
  areaPopulationField?: string;

  /** Set to also save the control zones as a new polygon layer. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  saveZonesAs?: string;
}

// ----- EV charging -----
export class EvCoverageDto {
  @IsUUID()
  chargerLayerId!: string;

  @IsOptional()
  @IsUUID()
  demandLayerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(63)
  demandWeightField?: string;

  /** Grid cell size (km); India's guideline is one station per 3 × 3 km. */
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(20)
  cellKm?: number;

  /** Straight-line distance a charger serves (km). */
  @IsOptional()
  @IsNumber()
  @Min(0.2)
  @Max(50)
  serviceRadiusKm?: number;

  /** [minLon, minLat, maxLon, maxLat] */
  @IsArray()
  @ArrayMaxSize(4)
  @IsNumber({}, { each: true })
  bbox!: number[];
}

export class HazardAreaDto {
  @IsString()
  @MaxLength(120)
  id!: string;

  /** GeoJSON (EPSG:4326) — a point (quake epicentre) or alert polygon. */
  @IsObject()
  geometry!: Record<string, unknown>;

  /** Ground distance around the geometry that counts as exposed (km). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(500)
  bufferKm?: number;
}

export class HazardExposureDto {
  @IsUUID()
  layerId!: string;

  @IsArray()
  @ArrayMaxSize(50)
  areas!: HazardAreaDto[];
}
