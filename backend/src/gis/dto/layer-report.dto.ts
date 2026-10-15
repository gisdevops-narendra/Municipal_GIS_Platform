import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export const REPORT_MAX_FIELDS = 10;
export const REPORT_MAX_ROWS = 5000;

/** POST /api/gis/layers/:id/report — a layer data report (PDF). */
export class LayerReportDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  /** Attribute columns, in order; validated against the layer's own fields. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(REPORT_MAX_FIELDS)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  fields!: string[];

  /** Whole layer, the Attribute Table's current query, or its selection. */
  @IsIn(['layer', 'query', 'selection'])
  scope!: 'layer' | 'query' | 'selection';

  /** scope = 'query': the ECQL filter (vetted by assertSafeCql). */
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  cqlFilter?: string;

  /** scope = 'query': a human label for the filter, shown in the report. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  scopeLabel?: string;

  /** scope = 'selection': WFS feature ids of this layer. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(REPORT_MAX_ROWS)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  featureIds?: string[];
}
