import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';

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

export class InviteUserDto {
  @IsString() @MaxLength(200) @Matches(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: 'Enter a valid email.' }) email!: string;
  @IsString() @MaxLength(120) fullName!: string;
}

export class UpdateUserDto {
  @IsOptional() @IsString() @MaxLength(120) fullName?: string;
  @IsOptional() @IsString() @MaxLength(200) @Matches(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: 'Enter a valid email.' }) email?: string;
}

export class SecurityDto {
  @IsInt() @Min(0) @Max(64) minLength!: number;
  @IsInt() @Min(0) @Max(10) digits!: number;
  @IsInt() @Min(0) @Max(10) upperCase!: number;
  @IsInt() @Min(0) @Max(10) specialChars!: number;
  @IsBoolean() notUsername!: boolean;
  @IsInt() @Min(0) @Max(3650) expireDays!: number;
  @IsBoolean() bruteForce!: boolean;
  @IsInt() @Min(1) @Max(100) failures!: number;
  @IsInt() @Min(1) @Max(1440) lockMinutes!: number;
  @IsInt() @Min(5) @Max(1440) sessionIdleMinutes!: number;
  @IsBoolean() requireTwoFactor!: boolean;
}

export class EmailDto {
  @IsString() @MaxLength(200) host!: string;
  @IsInt() @Min(1) @Max(65535) port!: number;
  @IsString() @MaxLength(200) from!: string;
  @IsString() @MaxLength(120) fromName!: string;
  @IsBoolean() starttls!: boolean;
  @IsBoolean() ssl!: boolean;
  @IsBoolean() auth!: boolean;
  @IsString() @MaxLength(200) user!: string;
  @IsOptional() @IsString() @MaxLength(300) password?: string;
}

export class TestEmailDto {
  @IsString() @Matches(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: 'Enter a valid email.' }) to!: string;
}

export class BrandingDto {
  @IsString() @MaxLength(60) platformName!: string;
  @IsString() @MaxLength(120) tagline!: string;
  @IsString() @MaxLength(500) loginMessage!: string;
  @IsOptional() @ValidateIf((o) => o.primaryColor !== null) @Matches(/^#[0-9a-fA-F]{6}$/) primaryColor!: string | null;
}

export class AnnouncementDto {
  @IsBoolean() enabled!: boolean;
  @IsString() @MaxLength(500) message!: string;
  @IsIn(['info', 'warning', 'critical']) level!: 'info' | 'warning' | 'critical';
  @IsOptional() @IsString() endsAt!: string | null;
}

export class MaintenanceDto {
  @IsBoolean() enabled!: boolean;
  @IsString() @MaxLength(500) message!: string;
}

export class ModulesDto {
  @IsArray() @IsString({ each: true }) global!: string[];
  @IsObject() perAccount!: Record<string, string[]>;
}

export class IntegrityFixDto {
  @IsIn(['orphan-geoserver-layer', 'orphan-table']) kind!: string;
  @IsString() @MaxLength(200) id!: string;
}
