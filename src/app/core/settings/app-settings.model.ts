/**
 * Per-user application settings. Mirrors the backend `AppSettingsDto`
 * (`backend/src/settings/dto/app-settings.dto.ts`). The frontend owns the
 * default set (`settings-defaults.ts`); the backend stores only the parts a
 * user has changed and deep-merges on write.
 *
 * Extending: add a field here + a default there + (if it needs server
 * validation) a field on the DTO. Consumers read via `SettingsService`.
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type Density = 'compact' | 'comfortable';
export type MapUnits = 'metric' | 'imperial';
export type CoordinateFormat = 'decimal' | 'dms';
export type DateFormatMode = 'system' | 'iso' | 'dmy' | 'mdy' | 'long';
export type TimeFormatMode = '12h' | '24h';
export type NumberFormatMode = 'system' | 'in' | 'eu' | 'us' | 'plain';
export type RenderQuality = 'standard' | 'high';
export type ToastPosition =
  | 'bottom-right'
  | 'bottom-left'
  | 'top-right'
  | 'top-left'
  | 'bottom-center'
  | 'top-center';

export interface AppearanceSettings {
  theme: ThemeMode;
  /** id from `COLOR_THEMES` (`color-themes.ts`). */
  colorTheme: string;
  density: Density;
  /** base font-size multiplier, 0.85–1.3. */
  fontScale: number;
}

export interface AccessibilitySettings {
  highContrast: boolean;
  reduceMotion: boolean;
  underlineLinks: boolean;
  largeTargets: boolean;
}

export interface LocaleSettings {
  /** BCP-47 tag used for `<html lang>` and all `Intl.*` formatting. */
  language: string;
  dateFormat: DateFormatMode;
  timeFormat: TimeFormatMode;
  numberFormat: NumberFormatMode;
  firstDayOfWeek: 0 | 1;
}

export interface DefaultMapView {
  lon: number;
  lat: number;
  zoom: number;
}

export interface MapPerformanceSettings {
  renderQuality: RenderQuality;
  animateMap: boolean;
  /** GetFeatureInfo `FEATURE_COUNT` per layer. */
  featureInfoLimit: number;
}

export interface MapSettings {
  units: MapUnits;
  coordinateFormat: CoordinateFormat;
  defaultBasemap: string;
  /** `null` = automatic framing from layer bounds. */
  defaultView: DefaultMapView | null;
  /** `{ [layerCode]: boolean }` — overrides `GisLayer.visibleByDefault`. */
  layerVisibility: Record<string, boolean>;
  performance: MapPerformanceSettings;
}

export interface NotificationSettings {
  toastPosition: ToastPosition;
  toastDuration: number;
  /** `{ [category]: boolean }` — a `false` suppresses that category. */
  categories: Record<string, boolean>;
  sound: boolean;
}

export interface SessionSettings {
  /** minutes of inactivity before auto-logout; 0 = never. */
  autoLogoutMinutes: number;
  warnBeforeLogout: boolean;
}

export interface ShortcutSettings {
  enabled: boolean;
}

export interface AppSettings {
  appearance: AppearanceSettings;
  accessibility: AccessibilitySettings;
  locale: LocaleSettings;
  map: MapSettings;
  notifications: NotificationSettings;
  session: SessionSettings;
  shortcuts: ShortcutSettings;
}

/** A recursively-partial `AppSettings` — the shape `SettingsService.patch` takes. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object
    ? T[K] extends unknown[]
      ? T[K]
      : DeepPartial<T[K]>
    : T[K];
};

/** Notification categories the app actually emits (drives the toggles UI). */
export const NOTIFICATION_CATEGORIES: { id: string; label: string }[] = [
  { id: 'general', label: 'General messages' },
  { id: 'uploads', label: 'GIS data uploads & validation' },
  { id: 'layers', label: 'Layer publish / style / delete' },
  { id: 'system', label: 'System status changes' },
  { id: 'session', label: 'Session & auto-logout' },
];
