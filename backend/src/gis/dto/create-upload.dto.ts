import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const CRS_PATTERN = /^EPSG:\d{4,6}$/;

/**
 * Fields accompanying the multipart file in POST /api/gis/uploads.
 * Deliberately does NOT declare `municipalityId` — see Task 7 §17, the
 * backend always derives it from the authenticated caller. Field-name
 * choices for CSV (latitudeField/longitudeField/xField/yField) mirror the
 * wizard's own step names (§7/§22).
 */
export class CreateUploadDto {
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  layerName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsIn(['CANONICAL', 'DEPARTMENT'])
  ownershipType!: 'CANONICAL' | 'DEPARTMENT';

  /** User-confirmed source CRS — required for CSV X/Y (never assumed to
   *  be WGS84, Task 7 §7/§8), optional otherwise (falls back to whatever
   *  GDAL auto-detects from the file itself, or EPSG:4326 for CSV
   *  latitude/longitude columns, which is the correct semantic default). */
  @IsOptional()
  @Matches(CRS_PATTERN, { message: 'sourceCrs must look like "EPSG:4326"' })
  sourceCrs?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  latitudeField?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  longitudeField?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  xField?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  yField?: string;
}
