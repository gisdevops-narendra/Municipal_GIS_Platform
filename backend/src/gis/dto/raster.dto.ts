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
  Matches,
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
  @IsIn(['normalize', 'histogram'])
  stretch?: 'normalize' | 'histogram';

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
  @IsIn(['slope', 'aspect', 'hillshade', 'roughness', 'TRI', 'TPI'])
  kind!: 'slope' | 'aspect' | 'hillshade' | 'roughness' | 'TRI' | 'TPI';

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

  /** Several observers → a cumulative "seen by how many" raster. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsArray({ each: true })
  points?: LonLat[];
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
  @ArrayMaxSize(6)
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

// ----- Raster Data -----

export class RasterStatisticsDto extends RasterInputDto {
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(100)
  bins?: number;
}

const RESAMPLING = ['nearest', 'bilinear', 'cubic', 'average', 'mode'] as const;

export class MosaicDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  layerIds!: string[];

  @IsOptional()
  @IsIn(RESAMPLING)
  resampling?: (typeof RESAMPLING)[number];

  @IsString()
  @Length(1, 80)
  outputName!: string;
}

export class ResampleDto extends RasterOutputDto {
  /** Output pixel size in metres; omitted = keep the source resolution. */
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(100000)
  pixelSize?: number;

  /** "same", "UTM" (zone picked from the raster centre) or "EPSG:<code>". */
  @IsOptional()
  @Matches(/^(same|UTM|EPSG:\d{4,6})$/)
  targetCrs?: string;

  @IsOptional()
  @IsIn(RESAMPLING)
  resampling?: (typeof RESAMPLING)[number];
}

/** Tools reading a vector layer onto a grid of `pixelSize` metres. */
class VectorGridDto {
  @IsUUID()
  vectorLayerId!: string;

  @IsNumber()
  @Min(0.1)
  @Max(100000)
  pixelSize!: number;

  @IsString()
  @Length(1, 80)
  outputName!: string;
}

export class RasterizeDto extends VectorGridDto {
  /** Numeric field to burn; omitted = 1 inside features. */
  @IsOptional()
  @IsString()
  @Length(1, 63)
  field?: string;

  @IsOptional()
  @IsBoolean()
  allTouched?: boolean;
}

// ----- Terrain -----

export class FillSinksDto extends RasterOutputDto {}

// ----- Raster Analytics -----

export class ZonalStatisticsDto extends RasterInputDto {
  @IsUUID()
  zonesLayerId!: string;

  /** Field naming each zone in the result table. */
  @IsOptional()
  @IsString()
  @Length(1, 63)
  labelField?: string;

  @IsOptional()
  @IsBoolean()
  allTouched?: boolean;

  /** When set, the zones are also published with their statistics. */
  @IsOptional()
  @IsString()
  @Length(1, 80)
  outputName?: string;
}

export class IdwDto extends VectorGridDto {
  @IsString()
  @Length(1, 63)
  field!: string;

  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(6)
  power?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(64)
  maxPoints?: number;
}

export class HeatmapDto extends VectorGridDto {
  @IsOptional()
  @IsString()
  @Length(1, 63)
  weightField?: string;

  /** Kernel search radius in metres. */
  @IsNumber()
  @Min(1)
  @Max(50000)
  radius!: number;
}

export class ProximityDto extends VectorGridDto {
  /** Distances beyond this (metres) are left empty. */
  @IsNumber()
  @Min(1)
  @Max(100000)
  maxDistance!: number;
}

// ----- Imagery -----

export class SpectralIndexDto extends RasterOutputDto {
  @IsIn(['ndwi', 'ndbi', 'savi'])
  kind!: 'ndwi' | 'ndbi' | 'savi';

  /** NDWI: green · NDBI: SWIR · SAVI: red. */
  @IsInt()
  @Min(1)
  bandA!: number;

  /** Near-infrared for all three. */
  @IsInt()
  @Min(1)
  bandB!: number;

  /** SAVI soil brightness factor L. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  soilFactor?: number;
}

export class ClassifyDto extends RasterOutputDto {
  @IsInt()
  @Min(2)
  @Max(12)
  classes!: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsInt({ each: true })
  @Min(1, { each: true })
  bands?: number[];
}

// ----- Online Data -----

/** `[minLon, minLat, maxLon, maxLat]` in EPSG:4326. */
class AoiDto {
  @IsArray()
  @ArrayMinSize(4)
  @ArrayMaxSize(4)
  @IsNumber({}, { each: true })
  @Min(-180, { each: true })
  @Max(180, { each: true })
  bbox!: [number, number, number, number];
}

export class SentinelSearchDto extends AoiDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxCloud?: number;
}

export class OnlineRasterDto extends AoiDto {
  @IsIn(['dem', 'landcover', 'sentinel2', 'composite', 'population', 'water'])
  source!: 'dem' | 'landcover' | 'sentinel2' | 'composite' | 'population' | 'water';

  /** Composite: date range, cloud limit and number of scenes. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxCloud?: number;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(15)
  maxScenes?: number;

  /** Optional exact boundary (GeoJSON Polygon / MultiPolygon, EPSG:4326). */
  @IsOptional()
  @IsObject()
  polygon?: GeoJsonPolygon;

  /** Sentinel-2 scene id from the search. */
  @IsOptional()
  @Matches(/^S2[A-D]_[A-Z0-9_]{10,80}$/)
  sceneId?: string;

  /** Sentinel-2: blank out cloud / shadow pixels (scene classification). */
  @IsOptional()
  @IsBoolean()
  maskClouds?: boolean;

  @IsString()
  @Length(1, 80)
  outputName!: string;
}

export class SentinelPreviewDto extends AoiDto {
  @Matches(/^S2[A-D]_[A-Z0-9_]{10,80}$/)
  sceneId!: string;
}

// ----- Imagery (v2) / Terrain (v2) -----

export class IndexSeriesDto extends AoiDto {
  @IsIn(['ndvi', 'ndwi', 'ndbi'])
  kind!: 'ndvi' | 'ndwi' | 'ndbi';

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxCloud?: number;

  @IsOptional()
  @IsObject()
  polygon?: GeoJsonPolygon;
}

export class LandSurfaceTempDto extends AoiDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxCloud?: number;

  @IsOptional()
  @IsObject()
  polygon?: GeoJsonPolygon;

  @IsString()
  @Length(1, 80)
  outputName!: string;
}

class TrainingClassDto {
  @IsString()
  @Length(1, 60)
  label!: string;

  @IsOptional()
  @IsHexColor()
  color?: string;

  /** Training areas — GeoJSON (Multi)Polygon in EPSG:4326. */
  @IsObject()
  geometry!: GeoJsonPolygon;
}

export class SupervisedClassifyDto extends RasterOutputDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => TrainingClassDto)
  classes!: TrainingClassDto[];

  @IsOptional()
  @IsIn(['maxlike', 'mindist'])
  method?: 'maxlike' | 'mindist';
}

export class ChangeMatrixDto {
  @IsUUID()
  beforeLayerId!: string;

  @IsUUID()
  afterLayerId!: string;

  @IsString()
  @Length(1, 80)
  outputName!: string;
}

export class StreamNetworkDto extends RasterOutputDto {
  /** Minimum upstream catchment (km²) for a cell to count as a stream. */
  @IsNumber()
  @Min(0.001)
  @Max(100000)
  thresholdKm2!: number;
}
