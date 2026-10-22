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
  { label: 'Satellite (Esri)', value: 'esri-imagery' },
  { label: 'Streets (Esri)', value: 'esri-streets' },
  { label: 'Voyager (CARTO)', value: 'carto-voyager' },
  { label: 'Dark (CARTO)', value: 'carto-dark' },
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

export const ASSISTANT_ANSWER_STYLE_OPTIONS: Option[] = [
  { label: 'Short — just the answer', value: 'short' },
  { label: 'Detailed — also show how it was interpreted', value: 'detailed' },
];

export const ASSISTANT_LANGUAGE_OPTIONS: Option[] = [
  { label: 'English', value: 'en' },
  { label: 'मराठी — Marathi', value: 'mr' },
  { label: 'हिन्दी — Hindi', value: 'hi' },
];

export const ASSISTANT_DISTANCE_UNIT_OPTIONS: Option[] = [
  { label: 'Automatic (m, then km)', value: 'auto' },
  { label: 'Metres', value: 'm' },
  { label: 'Kilometres', value: 'km' },
];

export const ASSISTANT_AREA_UNIT_OPTIONS: Option[] = [
  { label: 'Automatic (m², then ha)', value: 'auto' },
  { label: 'Square metres', value: 'sqm' },
  { label: 'Hectares', value: 'ha' },
  { label: 'Acres', value: 'acre' },
];

export const ASSISTANT_NEAR_OPTIONS: Option<number>[] = [
  { label: 'Ask each time', value: 0 },
  { label: '100 m', value: 100 },
  { label: '250 m', value: 250 },
  { label: '500 m', value: 500 },
  { label: '1 km', value: 1000 },
  { label: '2 km', value: 2000 },
];

export const ASSISTANT_LAYER_SCOPE_OPTIONS: Option[] = [
  { label: 'All layers I can see', value: 'all' },
  { label: 'Only layers switched on on the map', value: 'visible' },
  { label: 'Only the layers I choose', value: 'custom' },
];

export const ASSISTANT_PANEL_MODE_OPTIONS: Option[] = [
  { label: 'Docked — beside the map', value: 'docked' },
  { label: 'Wide — docked, with more room', value: 'wide' },
  { label: 'Floating — a card over the map', value: 'floating' },
];

export const DENSITY_OPTIONS: Option[] = [
  { label: 'Comfortable', value: 'comfortable' },
  { label: 'Compact', value: 'compact' },
];
