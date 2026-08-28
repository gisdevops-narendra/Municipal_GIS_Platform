import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * The wire shape of a user's application settings (Settings module). Every
 * field is optional: `PATCH /api/me/settings` deep-merges whatever subset
 * the client sends into the stored blob. This DTO is the single source of
 * truth for what a *valid* settings payload is — the global ValidationPipe
 * (`whitelist + forbidNonWhitelisted`) strips anything not declared here.
 *
 * Mirrors the frontend `AppSettings` interface
 * (`src/app/core/settings/app-settings.model.ts`). Adding a setting = one
 * field here + one field there + one default.
 */

class AppearanceSettingsDto {
  @IsOptional()
  @IsIn(['light', 'dark', 'system'])
  theme?: 'light' | 'dark' | 'system';

  @IsOptional()
  @IsString()
  @MaxLength(40)
  colorTheme?: string;

  @IsOptional()
  @IsIn(['compact', 'comfortable'])
  density?: 'compact' | 'comfortable';

  @IsOptional()
  @IsNumber()
  @Min(0.85)
  @Max(1.3)
  fontScale?: number;
}

class AccessibilitySettingsDto {
  @IsOptional() @IsBoolean() highContrast?: boolean;
  @IsOptional() @IsBoolean() reduceMotion?: boolean;
  @IsOptional() @IsBoolean() underlineLinks?: boolean;
  @IsOptional() @IsBoolean() largeTargets?: boolean;
}

class LocaleSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(12)
  language?: string;

  @IsOptional()
  @IsIn(['system', 'iso', 'dmy', 'mdy', 'long'])
  dateFormat?: 'system' | 'iso' | 'dmy' | 'mdy' | 'long';

  @IsOptional()
  @IsIn(['12h', '24h'])
  timeFormat?: '12h' | '24h';

  @IsOptional()
  @IsIn(['system', 'in', 'eu', 'us', 'plain'])
  numberFormat?: 'system' | 'in' | 'eu' | 'us' | 'plain';

  @IsOptional()
  @IsIn([0, 1])
  firstDayOfWeek?: 0 | 1;
}

class DefaultViewDto {
  @IsNumber() @Min(-180) @Max(180) lon!: number;
  @IsNumber() @Min(-90) @Max(90) lat!: number;
  @IsNumber() @Min(0) @Max(24) zoom!: number;
}

class MapPerformanceDto {
  @IsOptional()
  @IsIn(['standard', 'high'])
  renderQuality?: 'standard' | 'high';

  @IsOptional() @IsBoolean() animateMap?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(25)
  featureInfoLimit?: number;
}

class MapSettingsDto {
  @IsOptional()
  @IsIn(['metric', 'imperial'])
  units?: 'metric' | 'imperial';

  @IsOptional()
  @IsIn(['decimal', 'dms'])
  coordinateFormat?: 'decimal' | 'dms';

  @IsOptional()
  @IsString()
  @MaxLength(40)
  defaultBasemap?: string;

  /** `null` clears any saved default view (back to automatic framing). */
  @IsOptional()
  @ValidateNested()
  @Type(() => DefaultViewDto)
  defaultView?: DefaultViewDto | null;

  /** `{ [layerCode]: boolean }` — overrides a layer's `visibleByDefault`. */
  @IsOptional()
  @IsObject()
  layerVisibility?: Record<string, boolean>;

  @IsOptional()
  @ValidateNested()
  @Type(() => MapPerformanceDto)
  performance?: MapPerformanceDto;
}

class NotificationSettingsDto {
  @IsOptional()
  @IsIn([
    'bottom-right',
    'bottom-left',
    'top-right',
    'top-left',
    'bottom-center',
    'top-center',
  ])
  toastPosition?: string;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(15000)
  toastDuration?: number;

  /** `{ [category]: boolean }` — a `false` suppresses that category. */
  @IsOptional()
  @IsObject()
  categories?: Record<string, boolean>;

  @IsOptional() @IsBoolean() sound?: boolean;
}

class SessionSettingsDto {
  /** 0 = never auto-logout. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  autoLogoutMinutes?: number;

  @IsOptional() @IsBoolean() warnBeforeLogout?: boolean;
}

class ShortcutSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class AppSettingsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => AppearanceSettingsDto)
  appearance?: AppearanceSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AccessibilitySettingsDto)
  accessibility?: AccessibilitySettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocaleSettingsDto)
  locale?: LocaleSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => MapSettingsDto)
  map?: MapSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationSettingsDto)
  notifications?: NotificationSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SessionSettingsDto)
  session?: SessionSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ShortcutSettingsDto)
  shortcuts?: ShortcutSettingsDto;
}
