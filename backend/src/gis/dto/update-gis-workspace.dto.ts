import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Owner-editable workspace configuration. Deliberately has no
 * `municipalityId`, `geoserverWorkspace`, or `code` field — those are
 * system-controlled (set once during provisioning) and can never be
 * accepted from the client, per Task 5 §11.
 */
export class UpdateGisWorkspaceDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(/^EPSG:\d{4,6}$/, {
    message: 'defaultCrs must look like "EPSG:32643"',
  })
  defaultCrs?: string;

  @IsOptional()
  @IsString()
  @Matches(/^EPSG:\d{4,6}$/, {
    message: 'displayCrs must look like "EPSG:4326"',
  })
  displayCrs?: string;
}
