import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/** A clicked map position, `[longitude, latitude]` in EPSG:4326. */
type LonLat = [number, number];

/** POST /api/gis/network/route — shortest path along a LINE layer. */
export class RouteDto {
  @IsUUID()
  layerId!: string;

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
}

/** POST /api/gis/network/nearest — closest facilities by network distance. */
export class NearestFacilityDto {
  /** Road (LINE) layer the distances are measured along. */
  @IsUUID()
  layerId!: string;

  /** POINT layer holding the facilities (hospitals, schools, ...). */
  @IsUUID()
  facilityLayerId!: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  from!: LonLat;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  count?: number;
}

/** POST /api/gis/network/trace — everything connected to a clicked line. */
export class TraceDto {
  @IsUUID()
  layerId!: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  at!: LonLat;

  /** Stop tracing this far (metres along the network) from the start. */
  @IsOptional()
  @IsNumber()
  @Min(1)
  maxDistanceM?: number;
}

/** POST /api/gis/network/service-area — what is reachable along a road
 *  layer within each break (metres, or minutes at `speedKmh`). */
export class ServiceAreaDto {
  @IsUUID()
  layerId!: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  at!: LonLat;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsNumber({}, { each: true })
  @Min(1, { each: true })
  breaks!: number[];

  /** When set, `breaks` are minutes of travel at this speed. */
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(150)
  speedKmh?: number;
}
