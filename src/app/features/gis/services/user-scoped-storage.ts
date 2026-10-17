/**
 * localStorage keys for a user's own GIS items (bookmarks, sketches, saved
 * queries). Keys used to be per workspace only, so everyone signing in on a
 * shared office PC saw — and could change — each other's items.
 */
export function userScopedKey(base: string, workspaceKey: string, userId: string | undefined): string {
  const ws = workspaceKey || 'default';
  return userId ? `${base}.${ws}.${userId}` : `${base}.${ws}`;
}

/** Reads the user's value. The first time, the old shared (per-workspace)
 *  value is moved under this user's key so nothing saved earlier is lost. */
export function readUserScoped(base: string, workspaceKey: string, userId: string | undefined): string | null {
  const key = userScopedKey(base, workspaceKey, userId);
  const current = localStorage.getItem(key);
  if (current !== null || !userId) return current;
  const legacyKey = userScopedKey(base, workspaceKey, undefined);
  const legacy = localStorage.getItem(legacyKey);
  if (legacy !== null) {
    localStorage.setItem(key, legacy);
    localStorage.removeItem(legacyKey);
  }
  return legacy;
}
