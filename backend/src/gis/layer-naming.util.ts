import { randomUUID } from 'crypto';

const MAX_CODE_LENGTH = 50;

/**
 * Derives a safe, deterministic, uppercase layer code from a user-supplied
 * layer name — e.g. "Road Network" -> "ROAD_NETWORK". Mirrors
 * workspace-naming.util.ts's slugifyWorkspaceName (same reasoning: never
 * use raw user input as a database/GeoServer identifier). Uppercase to
 * match the existing Task 6 convention (MUNICIPAL_BOUNDARY, WARDS, ROADS).
 *
 * Deterministic but not unique on its own — two different layer names can
 * collide (e.g. "Road Network" and "Road, Network!" both slugify to
 * "ROAD_NETWORK"). Uniqueness within a workspace is enforced by
 * GISLayer's `@@unique([gisWorkspaceId, code])` constraint; a colliding
 * upload is treated as targeting the same logical layer (a new version),
 * not rejected — see docs/backend.md "Layer versioning".
 */
export function deriveLayerCode(layerName: string): string {
  const normalized = layerName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');

  const truncated = normalized.slice(0, MAX_CODE_LENGTH).replace(/_+$/, '');
  const withFallback = truncated || 'LAYER';

  // Table/GeoServer-safe identifiers must start with a letter.
  return /^[A-Z]/.test(withFallback) ? withFallback : `L_${withFallback}`;
}

/**
 * Generates a safe, opaque PostGIS table name for a newly imported layer —
 * NEVER derived from user input (layer name, filename, etc.), only from a
 * fresh random UUID. See Task 7 §28: "Do not use layer_<user_input>
 * directly." Lowercase + underscores only, always starts with a letter,
 * safe to interpolate directly into DDL/identifiers without further
 * escaping (still validated defensively with isSafeTableName below before
 * any raw SQL use).
 */
export function generateLayerTableName(): string {
  return `layer_${randomUUID().replace(/-/g, '')}`;
}

/** Defense-in-depth check before any raw-SQL use of a table name that is
 *  always application-generated (see generateLayerTableName) — never
 *  trusts that a stored value is safe just because of where it came from. */
export function isSafeGeneratedTableName(tableName: string): boolean {
  return /^layer_[a-f0-9]{32}$/.test(tableName);
}
