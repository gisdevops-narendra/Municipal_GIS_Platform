/**
 * Fonts installed in the GeoServer container are DejaVu and Liberation
 * (plus decorative ones). A style naming a font GeoServer doesn't have —
 * typically Arial, from QGIS/ArcGIS exports — silently falls back to a
 * serif font and labels look wrong. Map the common proprietary families to
 * their installed, metric-compatible equivalents.
 */
const FONT_SUBSTITUTES: Record<string, string> = {
  arial: 'Liberation Sans',
  'arial bold': 'Liberation Sans',
  'arial narrow': 'Liberation Sans Narrow',
  helvetica: 'Liberation Sans',
  'helvetica neue': 'Liberation Sans',
  calibri: 'Liberation Sans',
  verdana: 'DejaVu Sans',
  tahoma: 'DejaVu Sans',
  'segoe ui': 'Liberation Sans',
  'ms sans serif': 'Liberation Sans',
  'microsoft sans serif': 'Liberation Sans',
  'times new roman': 'Liberation Serif',
  times: 'Liberation Serif',
  georgia: 'Liberation Serif',
  'courier new': 'Liberation Mono',
  courier: 'Liberation Mono',
  consolas: 'DejaVu Sans Mono',
};

export function substituteFont(family: string): string {
  return FONT_SUBSTITUTES[family.trim().toLowerCase()] ?? family;
}

/** Rewrites every `font-family` CssParameter / SvgParameter in an SLD. */
export function substituteSldFonts(sld: string): string {
  return sld.replace(
    /(<(?:\w+:)?(?:CssParameter|SvgParameter)\s+name\s*=\s*["']font-family["']\s*>)([^<]*)(<\/)/gi,
    (_m, open: string, family: string, close: string) => `${open}${substituteFont(family)}${close}`,
  );
}
