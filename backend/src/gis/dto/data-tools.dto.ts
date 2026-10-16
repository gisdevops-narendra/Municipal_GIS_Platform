import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** POST /api/gis/layers/:id/field-calculator. */
export class FieldCalcDto {
  /** Existing field to overwrite, or a new one (with `newFieldType`). */
  @IsString()
  @MaxLength(63)
  field!: string;

  @IsOptional()
  @IsIn(['text', 'double precision', 'integer', 'date', 'boolean'])
  newFieldType?: 'text' | 'double precision' | 'integer' | 'date' | 'boolean';

  @IsString()
  @MaxLength(1000)
  expression!: string;

  /** Only evaluate on the first 5 features — nothing is written. */
  @IsOptional()
  @IsBoolean()
  preview?: boolean;
}

/** Multipart fields of POST /api/gis/layers/:id/join-table (file = CSV). */
export class TableJoinDto {
  @IsString()
  @MaxLength(63)
  layerKey!: string;

  @IsString()
  @MaxLength(200)
  tableKey!: string;

  /** CSV columns to bring in — comma-separated in the form; all when empty. */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : value,
  )
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  columns?: string[];
}

/** Multipart fields of POST /api/gis/geocode (file = CSV). */
export class GeocodeDto {
  @IsString()
  @MaxLength(200)
  addressColumn!: string;

  @IsUUID()
  referenceLayerId!: string;

  @IsString()
  @MaxLength(63)
  referenceField!: string;

  @IsString()
  @MaxLength(120)
  outputName!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(1)
  minScore?: number;
}

/** POST /api/gis/layers/:id/validate. */
export class ValidateLayerDto {
  /** Polygon holes up to this many m² are reported as gaps. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  maxGapArea?: number;

  /** Report statistical outliers of the numeric fields (default on). */
  @IsOptional()
  @IsBoolean()
  outliers?: boolean;

  /** Judge each value against its own group, e.g. its ward. */
  @IsOptional()
  @IsString()
  @MaxLength(63)
  outlierGroupField?: string;

  /** Modified z-score above which a value is reported (default 3.5). */
  @IsOptional()
  @IsNumber()
  @Min(2)
  @Max(10)
  outlierThreshold?: number;
}

export class FixLayerDto {
  @IsIn(['invalid', 'duplicates', 'empty'])
  kind!: 'invalid' | 'duplicates' | 'empty';
}

export class FieldRuleDto {
  @IsString()
  @MaxLength(63)
  field!: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  values?: string[];

  @IsOptional()
  @IsNumber()
  min?: number | null;

  @IsOptional()
  @IsNumber()
  max?: number | null;
}

/** PUT /api/gis/layers/:id/field-rules — the full rule set. */
export class FieldRulesDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => FieldRuleDto)
  rules!: FieldRuleDto[];
}

export class CreateSnapshotDto {
  @IsString()
  @MaxLength(120)
  name!: string;
}
