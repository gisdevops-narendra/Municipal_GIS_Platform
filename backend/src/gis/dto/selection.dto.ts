import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/** Most features one selection can export / save (Switch Selection's cap). */
export const SELECTION_MAX_FEATURES = 5000;

/** Feature keys (the numeric part of "<layer>.<n>" WFS ids). */
class SelectionDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SELECTION_MAX_FEATURES)
  @IsInt({ each: true })
  @Min(1, { each: true })
  featureIds!: number[];
}

/** POST /api/gis/layers/:id/export — Export selected. */
export class ExportSelectionDto extends SelectionDto {
  @IsIn(['geojson', 'csv', 'shapefile', 'kml'])
  format!: 'geojson' | 'csv' | 'shapefile' | 'kml';

  /** Output CRS (KML is always EPSG:4326); default the layer's own. */
  @IsOptional()
  @Matches(/^EPSG:\d{4,6}$/i, { message: 'crs must look like "EPSG:4326"' })
  crs?: string;
}

/** POST /api/gis/layers/:id/save-selection — a new layer of the selection. */
export class SaveSelectionDto extends SelectionDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  /** Owner only: publish the result as this department's layer. */
  @IsOptional()
  @IsUUID()
  departmentId?: string;
}
