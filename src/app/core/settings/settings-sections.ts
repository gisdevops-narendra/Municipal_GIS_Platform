/**
 * Registry of Settings screen sections. Drives the left-hand nav and the
 * `@switch` in `SettingsComponent`. Adding a section = one entry here + one
 * `@case` + one component; nothing else in the shell changes.
 */
export type SettingsGroup =
  | 'account'
  | 'appearance'
  | 'regional'
  | 'map'
  | 'assistant'
  | 'system-behaviour'
  | 'about';

export interface SettingsSectionMeta {
  id: string;
  label: string;
  /** PrimeIcons class, e.g. `pi pi-palette`. */
  icon: string;
  group: SettingsGroup;
  /** one-line description shown under the heading. */
  blurb: string;
}

export const SETTINGS_GROUPS: { id: SettingsGroup; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'regional', label: 'Regional & Formats' },
  { id: 'map', label: 'Map' },
  { id: 'assistant', label: 'AI Assistant' },
  { id: 'system-behaviour', label: 'Notifications & Session' },
  { id: 'about', label: 'System & About' },
];

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  {
    id: 'profile',
    label: 'Profile & Account',
    icon: 'pi pi-user',
    group: 'account',
    blurb: 'Your name, contact number and email.',
  },
  {
    id: 'appearance',
    label: 'Theme & Colour',
    icon: 'pi pi-palette',
    group: 'appearance',
    blurb: 'Light / dark mode, colour theme, density and text size.',
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    icon: 'pi pi-eye',
    group: 'appearance',
    blurb: 'Contrast, motion, link underlines and larger targets.',
  },
  {
    id: 'language',
    label: 'Language',
    icon: 'pi pi-globe',
    group: 'regional',
    blurb: 'Interface language and the locale used for all formatting.',
  },
  {
    id: 'datetime',
    label: 'Date & Time Format',
    icon: 'pi pi-calendar',
    group: 'regional',
    blurb: 'How dates and times are displayed across the app.',
  },
  {
    id: 'numbers',
    label: 'Number Format',
    icon: 'pi pi-hashtag',
    group: 'regional',
    blurb: 'Decimal and grouping style for numeric values.',
  },
  {
    id: 'map-units',
    label: 'Map Units',
    icon: 'pi pi-arrows-h',
    group: 'map',
    blurb: 'Metric or imperial for distances and areas.',
  },
  {
    id: 'coordinates',
    label: 'Coordinate Format',
    icon: 'pi pi-compass',
    group: 'map',
    blurb: 'Decimal degrees or degrees-minutes-seconds.',
  },
  {
    id: 'basemap',
    label: 'Default Basemap',
    icon: 'pi pi-map',
    group: 'map',
    blurb: 'Which basemap the GIS workspace opens with.',
  },
  {
    id: 'default-view',
    label: 'Default Map Extent',
    icon: 'pi pi-expand',
    group: 'map',
    blurb: 'The view the map centres on when it loads.',
  },
  {
    id: 'layer-visibility',
    label: 'Default Layer Visibility',
    icon: 'pi pi-clone',
    group: 'map',
    blurb: 'Override which layers are switched on at startup.',
  },
  {
    id: 'map-performance',
    label: 'Map Performance',
    icon: 'pi pi-bolt',
    group: 'map',
    blurb: 'Render quality, animation and feature-info limits.',
  },
  {
    id: 'assistant',
    label: 'AI Assistant',
    icon: 'pi pi-sparkles',
    group: 'assistant',
    blurb: 'How the assistant answers, what it searches, how results show on the map, and your chat history.',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: 'pi pi-bell',
    group: 'system-behaviour',
    blurb: 'Toast position, duration and which events notify you.',
  },
  {
    id: 'session',
    label: 'Session & Auto Logout',
    icon: 'pi pi-clock',
    group: 'system-behaviour',
    blurb: 'Sign out automatically after a period of inactivity.',
  },
  {
    id: 'shortcuts',
    label: 'Keyboard Shortcuts',
    icon: 'pi pi-th-large',
    group: 'system-behaviour',
    blurb: 'Global shortcuts and how to turn them off.',
  },
  {
    id: 'system-status',
    label: 'System Status',
    icon: 'pi pi-server',
    group: 'about',
    blurb: 'Live connectivity for the API, database and GeoServer.',
  },
  {
    id: 'about',
    label: 'About & Version',
    icon: 'pi pi-info-circle',
    group: 'about',
    blurb: 'Version numbers, environment and open-source credits.',
  },
  {
    id: 'help',
    label: 'Help & Documentation',
    icon: 'pi pi-question-circle',
    group: 'about',
    blurb: 'Guides for the platform and where to get support.',
  },
  {
    id: 'privacy',
    label: 'Privacy & Data Usage',
    icon: 'pi pi-shield',
    group: 'about',
    blurb: 'What is stored, where it lives and how it is used.',
  },
  {
    id: 'delete-account',
    label: 'Delete account',
    icon: 'pi pi-trash',
    group: 'about',
    blurb: 'Permanently delete your account and all of your GIS data.',
  },
  {
    id: 'reset',
    label: 'Reset Settings',
    icon: 'pi pi-refresh',
    group: 'about',
    blurb: 'Restore every setting on this screen to its default.',
  },
];

export const DEFAULT_SECTION_ID = 'profile';

/**
 * Tabs of the Settings window. Each tab stacks one or more of the sections
 * above (every section is kept — they are only grouped into fewer tabs).
 */
export interface SettingsTab {
  id: string;
  label: string;
  icon: string;
  sections: string[];
}

export const SETTINGS_TABS: SettingsTab[] = [
  { id: 'general', label: 'General', icon: 'pi pi-user', sections: ['profile'] },
  { id: 'appearance', label: 'Appearance', icon: 'pi pi-palette', sections: ['appearance', 'accessibility'] },
  { id: 'regional', label: 'Language & region', icon: 'pi pi-globe', sections: ['language', 'datetime', 'numbers'] },
  {
    id: 'map',
    label: 'Map',
    icon: 'pi pi-map',
    sections: ['map-units', 'coordinates', 'basemap', 'default-view', 'layer-visibility', 'map-performance'],
  },
  { id: 'assistant', label: 'AI Assistant', icon: 'pi pi-sparkles', sections: ['assistant'] },
  { id: 'notifications', label: 'Notifications', icon: 'pi pi-bell', sections: ['notifications', 'session', 'shortcuts'] },
  { id: 'privacy', label: 'Data & privacy', icon: 'pi pi-shield', sections: ['privacy', 'reset', 'delete-account'] },
  { id: 'about', label: 'About', icon: 'pi pi-info-circle', sections: ['system-status', 'about', 'help'] },
];

/** Tab id for a tab id or an (old, linkable) section id. */
export function tabForSection(id: string): string {
  if (SETTINGS_TABS.some((t) => t.id === id)) return id;
  return SETTINGS_TABS.find((t) => t.sections.includes(id))?.id ?? SETTINGS_TABS[0].id;
}
