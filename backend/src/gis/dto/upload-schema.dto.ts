import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { COLUMN_KINDS, COLUMN_ROLES, type ColumnKind } from '../upload-schema.service';

/** One column as the uploader approved it in the Columns step. */
export class UploadColumnChangeDto {
  /** The column's current name. */
  @IsString()
  @MaxLength(63)
  name!: string;

  /** New name (omitted / equal to `name` = keep). Validated server-side
   *  against the real columns: lowercase snake_case, unique, not reserved. */
  @IsOptional()
  @IsString()
  @MaxLength(63)
  newName?: string;

  /** New type (omitted / same = keep). Refused if any value would be lost. */
  @IsOptional()
  @IsIn(COLUMN_KINDS)
  type?: ColumnKind;

  /** What the column means, for the AI assistant (omitted = no meaning
   *  saved for it; the AI keeps profiling it automatically). */
  @IsOptional()
  @IsIn([...COLUMN_ROLES])
  role?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  aliases?: string[];
}

/** `PUT /gis/uploads/:id/schema` — every column, approved together. */
export class ApplyUploadSchemaDto {
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => UploadColumnChangeDto)
  columns!: UploadColumnChangeDto[];
}
