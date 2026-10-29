import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CreateUploadDto } from './create-upload.dto';

export const EXTERNAL_DB_TYPES = ['POSTGRESQL', 'MYSQL', 'MONGODB'] as const;
export type ExternalDbType = (typeof EXTERNAL_DB_TYPES)[number];

export const PG_SSL_MODES = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'] as const;

/** Connection details for an external database. Sent with every request
 *  and never stored — the platform keeps no credentials. */
export class ExternalDbConnectionDto {
  @IsIn(EXTERNAL_DB_TYPES)
  type!: ExternalDbType;

  /** Host name or IP address — no scheme, path or credentials. */
  @IsString()
  @Length(1, 255)
  @Matches(/^[A-Za-z0-9._\-:[\]]+$/, { message: 'host must be a host name or IP address' })
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsString()
  @Length(1, 128)
  database!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  password?: string;

  /** PostgreSQL: SSL mode. */
  @IsOptional()
  @IsIn(PG_SSL_MODES)
  sslMode?: (typeof PG_SSL_MODES)[number];

  /** PostgreSQL: list only these schemas (comma-separated). */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(/^[A-Za-z0-9_$, ]*$/, { message: 'schemas must be a comma-separated list of schema names' })
  schemas?: string;

  /** MongoDB: the database that holds the user (default "admin"). */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  authSource?: string;

  /** MongoDB: connect over TLS. */
  @IsOptional()
  @IsBoolean()
  tls?: boolean;

  /** MongoDB: DNS seed list (mongodb+srv://, e.g. Atlas) — port ignored. */
  @IsOptional()
  @IsBoolean()
  srv?: boolean;
}

export class ExternalDbRequestDto {
  @ValidateNested()
  @Type(() => ExternalDbConnectionDto)
  connection!: ExternalDbConnectionDto;
}

export class ExternalDbDatasetDto extends ExternalDbRequestDto {
  /** Table (GDAL layer name, e.g. "public.roads") or MongoDB collection. */
  @IsString()
  @Length(1, 300)
  dataset!: string;
}

/** Import a table / collection as a new upload — then the same
 *  Validation → Columns → Preview → Review workflow as a file. */
export class ExternalDbImportDto extends CreateUploadDto {
  @ValidateNested()
  @Type(() => ExternalDbConnectionDto)
  connection!: ExternalDbConnectionDto;

  @IsString()
  @Length(1, 300)
  dataset!: string;

  /** MongoDB: the field holding GeoJSON geometry. Omitted with latitude /
   *  longitude or X/Y columns for point data. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  geometryField?: string;

  /** Attribute fields to import (all when omitted). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  fields?: string[];

  /** Import at most this many records. */
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}
