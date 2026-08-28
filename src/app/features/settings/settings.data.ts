/**
 * Static option lists for the Settings sections. Kept out of the section
 * components so they stay lean and the choices are easy to audit in one
 * place. Values must match the unions in
 * `src/app/core/settings/app-settings.model.ts` and the backend
 * `AppSettingsDto`.
 */

export interface Option<T = string> {
  label: string;
  value: T;
}

/** Interface language — also the locale used for every `Intl.*` readout. */
export const LANGUAGE_OPTIONS: Option[] = [
  { label: 'English (India)', value: 'en-IN' },
  { label: 'English (United Kingdom)', value: 'en-GB' },
  { label: 'English (United States)', value: 'en-US' },
  { label: 'हिन्दी — Hindi (India)', value: 'hi-IN' },
];

export const DATE_FORMAT_OPTIONS: Option[] = [
  { label: 'Match language / system', value: 'system' },
  { label: 'ISO — 2026-08-28', value: 'iso' },
  { label: 'Day / Month / Year — 28/08/2026', value: 'dmy' },
  { label: 'Month / Day / Year — 08/28/2026', value: 'mdy' },
  { label: 'Long — 28 August 2026', value: 'long' },
];

export const TIME_FORMAT_OPTIONS: Option[] = [
  { label: '24-hour (14:30)', value: '24h' },
  { label: '12-hour (2:30 PM)', value: '12h' },
];

export const NUMBER_FORMAT_OPTIONS: Option[] = [
  { label: 'Match language / system', value: 'system' },
  { label: 'Indian — 12,34,567.89', value: 'in' },
  { label: 'European — 1.234.567,89', value: 'eu' },
  { label: 'US / UK — 1,234,567.89', value: 'us' },
  { label: 'Plain — 1234567.89', value: 'plain' },
];

export const FIRST_DAY_OPTIONS: Option<0 | 1>[] = [
  { label: 'Monday', value: 1 },
  { label: 'Sunday', value: 0 },
];

export const MAP_UNITS_OPTIONS: Option[] = [
  { label: 'Metric — metres, kilometres, hectares', value: 'metric' },
  { label: 'Imperial — feet, miles, acres', value: 'imperial' },
];

export const COORDINATE_FORMAT_OPTIONS: Option[] = [
  { label: 'Decimal degrees — 72.58140, 23.02250', value: 'decimal' },
  { label: 'Degrees / minutes / seconds — 23°01\'21.0"N', value: 'dms' },
];

/** Ids must match `BASEMAPS` in `features/gis/services/map.service.ts`. */
export const BASEMAP_OPTIONS: Option[] = [
  { label: 'OpenStreetMap', value: 'osm' },
  { label: 'Light (CARTO)', value: 'carto-light' },
  { label: 'Topographic (OpenTopoMap)', value: 'topo' },
];

export const RENDER_QUALITY_OPTIONS: Option[] = [
  { label: 'Standard', value: 'standard' },
  { label: 'High (sharper on HiDPI screens, more data)', value: 'high' },
];

export const TOAST_POSITION_OPTIONS: Option[] = [
  { label: 'Bottom right', value: 'bottom-right' },
  { label: 'Bottom left', value: 'bottom-left' },
  { label: 'Bottom centre', value: 'bottom-center' },
  { label: 'Top right', value: 'top-right' },
  { label: 'Top left', value: 'top-left' },
  { label: 'Top centre', value: 'top-center' },
];

export const AUTO_LOGOUT_OPTIONS: Option<number>[] = [
  { label: 'Never', value: 0 },
  { label: 'After 15 minutes', value: 15 },
  { label: 'After 30 minutes', value: 30 },
  { label: 'After 1 hour', value: 60 },
  { label: 'After 2 hours', value: 120 },
];

export const THEME_MODE_OPTIONS: Option[] = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'Match system', value: 'system' },
];

export const DENSITY_OPTIONS: Option[] = [
  { label: 'Comfortable', value: 'comfortable' },
  { label: 'Compact', value: 'compact' },
];
