import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';

/** `[longitude, latitude]` with both numbers in range. */
function IsLonLat(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isLonLat',
      validator: {
        validate: (p: unknown) =>
          Array.isArray(p) &&
          p.length === 2 &&
          typeof p[0] === 'number' &&
          typeof p[1] === 'number' &&
          Math.abs(p[0]) <= 180 &&
          Math.abs(p[1]) <= 90,
        defaultMessage: () => 'each point must be [longitude, latitude]',
      },
    },
    options,
  );
}

/** A clicked map position, `[longitude, latitude]` in EPSG:4326. */
type LonLat = [number, number];

/** POST /api/gis/network/route — route along a routing (LINE) layer:
 *  `from` + `to`, or 2–25 `stops` in visiting order. */
export class RouteDto {
  @IsUUID()
  layerId!: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  from?: LonLat;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  to?: LonLat;

  /** Stops in order (overrides from / to). Each is [lon, lat]. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(25)
  @IsLonLat({ each: true })
  stops?: LonLat[];

  /** Reorder the middle stops for the shortest trip. */
  @IsOptional()
  @IsBoolean()
  optimize?: boolean;

  /** Return to the first stop at the end. */
  @IsOptional()
  @IsBoolean()
  roundTrip?: boolean;

  /** Areas to keep out of: closed rings of [lon, lat]. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsArray({ each: true })
  @ArrayMaxSize(500, { each: true })
  avoidAreas?: LonLat[][];

  /** Roads to keep off: each point blocks the road stretch nearest it. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsLonLat({ each: true })
  avoidPoints?: LonLat[];
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
