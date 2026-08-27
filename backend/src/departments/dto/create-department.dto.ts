import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Code is normalized consistently server-side (never trust the client's
 *  casing/whitespace): trimmed and upper-cased before validation/storage,
 *  e.g. "roads " -> "ROADS". */
const normalizeCode = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateDepartmentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  name!: string;

  @Transform(normalizeCode)
  @IsString()
  @Matches(/^[A-Z0-9_-]{2,30}$/, {
    message:
      'code must be 2-30 characters: letters, numbers, hyphen or underscore',
  })
  code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateDepartmentDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @Transform(normalizeCode)
  @IsString()
  @Matches(/^[A-Z0-9_-]{2,30}$/, {
    message:
      'code must be 2-30 characters: letters, numbers, hyphen or underscore',
  })
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';
}
