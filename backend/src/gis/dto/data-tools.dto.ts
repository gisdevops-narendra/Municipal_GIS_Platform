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
  Matches,
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

// ----- Field management, geometry, find & replace, split (Data Tools batch 2) -----

export const FIELD_TYPES = ['text', 'integer', 'double precision', 'date', 'boolean'] as const;
export const GEOMETRY_MEASURES = ['area_m2', 'area_ha', 'length_m', 'perimeter_m', 'x', 'y', 'lon', 'lat'] as const;

export class FieldManageDto {
  @IsIn(['add', 'rename', 'delete'])
  action!: 'add' | 'rename' | 'delete';

  @IsString()
  @MaxLength(63)
  field!: string;

  /** add: the column type. */
  @IsOptional()
  @IsIn(FIELD_TYPES)
  type?: (typeof FIELD_TYPES)[number];

  /** rename: the new name. */
  @IsOptional()
  @IsString()
  @MaxLength(63)
  newName?: string;
}

export class CalcGeometryDto {
  @IsIn(GEOMETRY_MEASURES)
  measure!: (typeof GEOMETRY_MEASURES)[number];

  /** Target field — created (double precision) when missing. */
  @IsString()
  @MaxLength(63)
  field!: string;
}

export class FindReplaceDto {
  @IsString()
  @MaxLength(63)
  field!: string;

  @IsString()
  @MaxLength(500)
  find!: string;

  @IsString()
  @MaxLength(500)
  replace!: string;

  @IsOptional()
  @IsBoolean()
  matchCase?: boolean;

  /** Only values equal to `find` (otherwise every occurrence inside a value). */
  @IsOptional()
  @IsBoolean()
  wholeValue?: boolean;

  @IsOptional()
  @IsBoolean()
  preview?: boolean;
}

export class SplitLayerDto {
  @IsString()
  @MaxLength(63)
  field!: string;
}

// ----- Data Tools batch 3 -----

export class AutoNumberDto {
  @IsString()
  @MaxLength(63)
  field!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  prefix?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  start?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  pad?: number;

  /** Restart numbering within each value of this field (e.g. ward). */
  @IsOptional()
  @IsString()
  @MaxLength(63)
  groupBy?: string;
}

export class ChangeTypeDto {
  @IsString()
  @MaxLength(63)
  field!: string;

  @IsIn(['text', 'integer', 'double precision', 'date', 'boolean'])
  to!: 'text' | 'integer' | 'double precision' | 'date' | 'boolean';

  @IsOptional()
  @IsBoolean()
  preview?: boolean;
}

export class DuplicatesDto {
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  fields!: string[];
}

export class StandardiseDto {
  @IsString()
  @MaxLength(63)
  field!: string;

  @IsOptional()
  @IsBoolean()
  trim?: boolean;

  @IsOptional()
  @IsIn(['upper', 'lower', 'title'])
  letterCase?: 'upper' | 'lower' | 'title';

  /** "-", "NA", "N/A", "null", "" → empty (NULL). */
  @IsOptional()
  @IsBoolean()
  nullify?: boolean;

  @IsOptional()
  @IsBoolean()
  preview?: boolean;
}

export class AppendDto {
  @IsUUID()
  sourceLayerId!: string;
}

// ----- Projection -----

const EPSG = /^EPSG:\d{4,6}$/i;

/** POST /api/gis/layers/:id/reproject — transform the coordinates into
 *  another CRS, as a new layer or in place. */
export class ReprojectLayerDto {
  @Matches(EPSG, { message: 'The CRS must look like EPSG:32643.' })
  targetCrs!: string;

  @IsIn(['new', 'inplace'])
  mode!: 'new' | 'inplace';

  /** Name of the new layer (mode "new"). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  outputName?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;
}

/** POST /api/gis/layers/:id/define-crs — the coordinates are right but the
 *  layer is labelled with the wrong CRS: relabel without moving them. */
export class DefineCrsDto {
  @Matches(EPSG, { message: 'The CRS must look like EPSG:32643.' })
  crs!: string;
}
