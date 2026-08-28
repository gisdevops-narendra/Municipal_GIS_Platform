/**
 * Selectable colour themes (Settings → Appearance). Each retunes the app's
 * primary + accent tokens (used by the app's own CSS) *and* PrimeNG's
 * primary palette at runtime (`ThemeService` calls
 * `updatePrimaryPalette`). Everything else — surfaces, ink, lines — stays
 * neutral and follows light/dark. "Survey Teal" is the original palette,
 * so the default (`survey-teal`) reproduces today's look exactly.
 */

export interface ColorThemeRamp {
  50: string;
  100: string;
  200: string;
  300: string;
  400: string;
  500: string;
  600: string;
  700: string;
  800: string;
  900: string;
  950: string;
}

export interface ColorTheme {
  id: string;
  label: string;
  /** the 50–950 ramp handed to PrimeNG's `updatePrimaryPalette`. */
  primary: ColorThemeRamp;
  /** app-token overrides applied as CSS custom properties on <html>. */
  tokens: {
    '--color-primary-700': string;
    '--color-primary-600': string;
    '--color-primary-500': string;
    '--color-primary-100': string;
    '--color-accent-600': string;
    '--color-accent-100': string;
  };
  /** small swatch for the picker. */
  swatch: string;
}

export const COLOR_THEMES: ColorTheme[] = [
  {
    id: 'survey-teal',
    label: 'Survey Teal',
    swatch: '#128077',
    primary: {
      50: '#e6f0ee', 100: '#c2dbd6', 200: '#9bc4bc', 300: '#73ada2',
      400: '#559b8e', 500: '#128077', 600: '#0e6660', 700: '#0b4f4a',
      800: '#083a36', 900: '#062725', 950: '#031514',
    },
    tokens: {
      '--color-primary-700': '#0b4f4a',
      '--color-primary-600': '#0e6660',
      '--color-primary-500': '#128077',
      '--color-primary-100': '#e2efed',
      '--color-accent-600': '#b5722a',
      '--color-accent-100': '#f4e9dc',
    },
  },
  {
    id: 'indigo',
    label: 'Cadastral Indigo',
    swatch: '#4f46e5',
    primary: {
      50: '#eef0fb', 100: '#d4d8f5', 200: '#aeb5ec', 300: '#8791e2',
      400: '#6b74dc', 500: '#4f46e5', 600: '#4038c4', 700: '#332c9c',
      800: '#262279', 900: '#1b1856', 950: '#100e33',
    },
    tokens: {
      '--color-primary-700': '#332c9c',
      '--color-primary-600': '#4038c4',
      '--color-primary-500': '#4f46e5',
      '--color-primary-100': '#e5e7fb',
      '--color-accent-600': '#b5722a',
      '--color-accent-100': '#f4e9dc',
    },
  },
  {
    id: 'slate',
    label: 'Graphite Slate',
    swatch: '#475569',
    primary: {
      50: '#eef1f4', 100: '#d7dde3', 200: '#b3bfc9', 300: '#8f9caa',
      400: '#6b7d8f', 500: '#475569', 600: '#3a4657', 700: '#2d3644',
      800: '#212833', 900: '#151a22', 950: '#0b0e12',
    },
    tokens: {
      '--color-primary-700': '#2d3644',
      '--color-primary-600': '#3a4657',
      '--color-primary-500': '#475569',
      '--color-primary-100': '#e4e8ec',
      '--color-accent-600': '#b5722a',
      '--color-accent-100': '#f4e9dc',
    },
  },
  {
    id: 'terracotta',
    label: 'Boundary Terracotta',
    swatch: '#b5722a',
    primary: {
      50: '#f8efe4', 100: '#eed6bc', 200: '#e0b689', 300: '#d29656',
      400: '#c58238', 500: '#b5722a', 600: '#955c22', 700: '#71461a',
      800: '#523313', 900: '#34210c', 950: '#1c1106',
    },
    tokens: {
      '--color-primary-700': '#71461a',
      '--color-primary-600': '#955c22',
      '--color-primary-500': '#b5722a',
      '--color-primary-100': '#f4e6d6',
      '--color-accent-600': '#0e6660',
      '--color-accent-100': '#e2efed',
    },
  },
  {
    id: 'forest',
    label: 'Contour Forest',
    swatch: '#2f7d46',
    primary: {
      50: '#e7f1ea', 100: '#c5ddce', 200: '#9cc5ab', 300: '#72ac88',
      400: '#519a6d', 500: '#2f7d46', 600: '#26653a', 700: '#1d4d2d',
      800: '#153920', 900: '#0d2515', 950: '#06130a',
    },
    tokens: {
      '--color-primary-700': '#1d4d2d',
      '--color-primary-600': '#26653a',
      '--color-primary-500': '#2f7d46',
      '--color-primary-100': '#dcecdf',
      '--color-accent-600': '#b5722a',
      '--color-accent-100': '#f4e9dc',
    },
  },
];

export const DEFAULT_COLOR_THEME_ID = 'survey-teal';

export function colorTheme(id: string): ColorTheme {
  return COLOR_THEMES.find((t) => t.id === id) ?? COLOR_THEMES[0];
}
