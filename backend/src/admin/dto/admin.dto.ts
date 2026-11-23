import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';

export class ListAccountsQuery {
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}

export class SetAccountStatusDto {
  @IsIn(['ACTIVE', 'DISABLED']) status!: 'ACTIVE' | 'DISABLED';
}

export class SetAccountQuotaDto {
  /** MB; null = unlimited. */
  @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(10_000_000) quotaMb!: number | null;
}

export class AuditQuery {
  @IsOptional() @IsString() @MaxLength(100) accountId?: string;
  @IsOptional() @IsString() @MaxLength(100) action?: string;
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}

/** POST /admin/backups/:stamp/restore */
export class RestoreBackupDto {
  @IsArray()
  @IsIn(['db', 'geoserver', 'storage', 'keycloak'], { each: true })
  parts!: string[];

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  /** must equal the backup name for a real restore */
  @IsOptional()
  @IsString()
  confirm?: string;
}

/** PUT /admin/storage/retention */
export class RetentionDto {
  @IsInt() @Min(1) @Max(365) tempDays!: number;
  @IsInt() @Min(0) @Max(3650) georefDays!: number;
  @IsInt() @Min(0) @Max(3650) cacheDays!: number;
  @IsInt() @Min(0) @Max(3650) publishedOriginalsDays!: number;
  @IsInt() @Min(0) @Max(36500) auditDays!: number;
}
