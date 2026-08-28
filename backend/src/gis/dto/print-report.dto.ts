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
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';

/** One visible map layer to print, referenced by its GISLayer id only —
 *  the backend resolves the GeoServer workspace/layer name and builds the
 *  WMS URL itself (never trusting a client-supplied URL). */
export class PrintLayerDto {
  @IsUUID()
  layerId!: string;

  /** 0–1; defaults to 1 when omitted. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  opacity?: number;

  /** ECQL filter currently applied to this layer on the live map (Query
   *  Builder / Buffer) — passed straight through as GeoServer CQL_FILTER
   *  so the print matches the screen. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  cqlFilter?: string;
}

/** The live OpenLayers view, in the map projection (always EPSG:3857 for
 *  this platform's map). `center` + `scale` (not bbox) so the printed
 *  resolution matches the screen exactly. */
export class PrintMapDto {
  @IsArray()
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  center!: [number, number];

  @IsNumber()
  @Min(1)
  scale!: number;

  @IsNumber()
  rotation!: number;

  @IsIn(['EPSG:3857'])
  projection!: 'EPSG:3857';
}

export class PrintReportDto {
  @IsIn(['A4', 'A3'])
  pageSize!: 'A4' | 'A3';

  @IsIn(['portrait', 'landscape'])
  orientation!: 'portrait' | 'landscape';

  @IsIn(['pdf', 'png'])
  format!: 'pdf' | 'png';

  @IsInt()
  @IsIn([96, 150, 300])
  dpi!: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  metadata?: string;

  @IsBoolean()
  includeLegend!: boolean;

  @IsBoolean()
  includeScalebar!: boolean;

  @IsBoolean()
  includeNorthArrow!: boolean;

  @IsBoolean()
  includeDate!: boolean;

  /** Basemap id, resolved by the backend against a fixed allowlist — never
   *  a URL. `none` prints the WMS layers on a white background. */
  @IsOptional()
  @IsIn(['osm', 'carto-light', 'topo', 'none'])
  basemapId?: 'osm' | 'carto-light' | 'topo' | 'none';

  @ValidateNested()
  @Type(() => PrintMapDto)
  map!: PrintMapDto;

  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => PrintLayerDto)
  layers!: PrintLayerDto[];
}
