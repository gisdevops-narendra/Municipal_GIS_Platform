const MAX_SLUG_LENGTH = 40;

/**
 * Derives a safe, deterministic slug from a municipality name for use as a
 * GeoServer workspace name (also reused as the base for the GIS workspace
 * `code`). GeoServer workspace names end up in URLs and XML namespaces, so
 * they must be lowercase, contain no spaces or punctuation, and start with
 * a letter.
 *
 * This is deterministic but NOT guaranteed globally unique on its own —
 * "Somnath Municipal Corporation" and "Somnath Municipality" both slugify
 * to "somnath_municipal..."-ish values that could collide. Callers that
 * need a guaranteed-unique GeoServer workspace name (there is exactly one
 * GeoServer instance shared by all municipalities) must check for
 * collisions against existing workspaces and disambiguate — see
 * GisWorkspaceService.generateUniqueGeoserverWorkspaceName, which appends
 * a numeric suffix (_2, _3, ...) until it finds a free name.
 *
 * Never derived from raw frontend input beyond the municipality's own
 * `name` field, which itself is validated server-side at registration.
 */
export function slugifyWorkspaceName(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics (e.g. é -> e)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');

  const truncated = normalized.slice(0, MAX_SLUG_LENGTH).replace(/_+$/, '');
  const withFallback = truncated || 'municipality';

  // GeoServer/XML namespace names must start with a letter.
  return /^[a-z]/.test(withFallback) ? withFallback : `ws_${withFallback}`;
}

/** Uppercase, underscore-joined workspace code, e.g. "Somnath Municipality"
 *  -> "SOMNATH_MUNICIPALITY_GIS". Not required to be globally unique (only
 *  `geoserverWorkspace` is) — see the GISWorkspace model comment. */
export function deriveWorkspaceCode(name: string): string {
  const base = slugifyWorkspaceName(name).toUpperCase();
  return `${base}_GIS`;
}
