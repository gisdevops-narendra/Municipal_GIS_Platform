import { AppSettings, DeepPartial, NOTIFICATION_CATEGORIES } from './app-settings.model';

/**
 * The default settings — every value chosen so the app behaves *exactly*
 * as it did before the Settings module existed (light theme resolved from
 * `system`, comfortable density, metric, decimal coordinates, OSM basemap,
 * no auto-logout, all notifications on). A user with no stored settings, or
 * one who hits "Reset Application Settings", gets precisely this.
 */
export const SETTINGS_DEFAULTS: AppSettings = {
  appearance: {
    theme: 'system',
    colorTheme: 'survey-teal',
    density: 'comfortable',
    fontScale: 1,
  },
  accessibility: {
    highContrast: false,
    reduceMotion: false,
    underlineLinks: false,
    largeTargets: false,
  },
  locale: {
    language: 'en-IN',
    dateFormat: 'system',
    timeFormat: '24h',
    numberFormat: 'system',
    firstDayOfWeek: 1,
  },
  map: {
    units: 'metric',
    coordinateFormat: 'decimal',
    defaultBasemap: 'osm',
    defaultView: null,
    layerVisibility: {},
    performance: {
      renderQuality: 'standard',
      animateMap: true,
      featureInfoLimit: 10,
    },
  },
  notifications: {
    toastPosition: 'bottom-right',
    toastDuration: 4000,
    categories: Object.fromEntries(
      NOTIFICATION_CATEGORIES.map((c) => [c.id, true]),
    ),
    sound: false,
  },
  session: {
    autoLogoutMinutes: 0,
    warnBeforeLogout: true,
  },
  shortcuts: {
    enabled: true,
  },
};

/** Deep clone so callers can never mutate `SETTINGS_DEFAULTS`. */
export function cloneDefaults(): AppSettings {
  return structuredClone(SETTINGS_DEFAULTS);
}

/**
 * Merge a stored (partial, possibly stale) settings blob over the defaults.
 * Objects merge key-by-key; arrays and primitives (incl. `null`) replace.
 * Unknown keys in `stored` are ignored — the defaults define the shape.
 */
export function mergeSettings(
  stored: DeepPartial<AppSettings> | null | undefined,
): AppSettings {
  const merged = deepMerge(
    cloneDefaults() as unknown as Record<string, unknown>,
    (stored ?? {}) as Record<string, unknown>,
  );
  return merged as unknown as AppSettings;
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const current = target[key];
    if (isRecord(value) && isRecord(current)) {
      // both objects → merge, keeping keys the defaults don't know about
      // (free-form maps: map.layerVisibility, notifications.categories).
      deepMerge(current, value);
    } else {
      // primitive, array, null, or object-over-nonobject → replace
      target[key] = value;
    }
  }
  return target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
