import { Injectable } from '@angular/core';

/** Public icon search + icon-data API (CORS-enabled), covering Google's,
 *  Font Awesome's and other free icon sets. */
export const ICONIFY_API = 'https://api.iconify.design';

/** Iconify's smallest search page; we never ask for more. */
const SEARCH_LIMIT = 32;
/** Blob URLs kept for thumbnails (oldest are revoked beyond this). */
const MAX_THUMBS = 240;

interface IconData {
  body: string;
  width: number;
  height: number;
}

interface IconSetResponse {
  prefix: string;
  width?: number;
  height?: number;
  icons?: Record<string, { body: string; width?: number; height?: number }>;
  aliases?: Record<string, { parent: string; width?: number; height?: number }>;
}

/**
 * Online icon libraries for point markers, on a small request budget:
 *  - a search asks for one page (32) and is made once per query + library
 *    set — results are cached for the session and repeated / concurrent
 *    calls share one request;
 *  - icon shapes come in one batch request per library (Iconify's JSON
 *    API) instead of one image request per thumbnail, and are cached —
 *    thumbnails, colour changes and the picked icon are built locally;
 *  - AI icon words are cached per layer.
 * Every call uses `fetch`, never HttpClient, so the app's auth token is
 * never sent to the third-party host.
 */
@Injectable({ providedIn: 'root' })
export class IconLibraryService {
  private readonly searches = new Map<string, Promise<string[]>>();
  private readonly data = new Map<string, IconData>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly thumbs = new Map<string, string>();
  private readonly aiTerms = new Map<string, string[]>();
  /** Requests sent to the icon API this session (for diagnostics/tests). */
  requests = 0;

  /** Up to 32 icon ids ("prefix:name") for `query`, best first, with
   *  style variants of one icon (-outline, -rounded, -sharp …) folded. */
  search(query: string, prefixes: string): Promise<string[]> {
    const q = query.trim().toLowerCase();
    const key = `${prefixes}|${q}`;
    let pending = this.searches.get(key);
    if (!pending) {
      this.requests++;
      pending = fetch(`${ICONIFY_API}/search?query=${encodeURIComponent(q)}&prefixes=${prefixes}&limit=${SEARCH_LIMIT}`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((body: { icons?: string[] }) => {
          const ids = rankByName(foldVariants(body.icons ?? []), q);
          if (!prefixes.includes(',')) return ids;
          // Mixed libraries: every exact match first (the best icon of
          // each library), then the rest in per-library blocks.
          const exact = ids.filter((id) => nameScore(id, q) === 0);
          return [...exact, ...blockByLibrary(ids.filter((id) => !exact.includes(id)))];
        });
      // A failed search is not cached: the next attempt retries.
      pending.catch(() => this.searches.delete(key));
      this.searches.set(key, pending);
    }
    return pending;
  }

  /** Fetch the shapes of `ids` not loaded yet: one request per library. */
  async load(ids: string[]): Promise<void> {
    const missing = new Map<string, string[]>();
    const waits: Promise<void>[] = [];
    for (const id of ids) {
      if (this.data.has(id)) continue;
      const inFlight = this.loading.get(id);
      if (inFlight) {
        waits.push(inFlight);
        continue;
      }
      const [prefix, name] = id.split(':');
      missing.set(prefix, [...(missing.get(prefix) ?? []), name]);
    }
    for (const [prefix, names] of missing) {
      this.requests++;
      const batch = fetch(`${ICONIFY_API}/${prefix}.json?icons=${names.map(encodeURIComponent).join(',')}`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((set: IconSetResponse) => this.store(set))
        .finally(() => names.forEach((n) => this.loading.delete(`${prefix}:${n}`)));
      names.forEach((n) => this.loading.set(`${prefix}:${n}`, batch));
      waits.push(batch);
    }
    await Promise.all(waits);
  }

  /** SVG markup of a loaded icon in `color`, `height` px tall. */
  svg(id: string, color: string, height = 64): string | null {
    const icon = this.data.get(id);
    if (!icon) return null;
    const width = Math.round((icon.width / icon.height) * height);
    const body = icon.body.replace(/currentColor/g, color);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${icon.width} ${icon.height}">${body}</svg>`;
  }

  /** Object URL of a thumbnail (null until the icon is loaded). */
  thumb(id: string, color: string): string | null {
    const key = `${id}|${color}`;
    const cached = this.thumbs.get(key);
    if (cached) return cached;
    const svg = this.svg(id, color, 32);
    if (!svg) return null;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    this.thumbs.set(key, url);
    if (this.thumbs.size > MAX_THUMBS) {
      const [oldKey, oldUrl] = this.thumbs.entries().next().value as [string, string];
      URL.revokeObjectURL(oldUrl);
      this.thumbs.delete(oldKey);
    }
    return url;
  }

  cachedAiTerms(key: string): string[] | undefined {
    return this.aiTerms.get(key);
  }

  rememberAiTerms(key: string, terms: string[]): void {
    this.aiTerms.set(key, terms);
  }

  private store(set: IconSetResponse): void {
    const w = set.width ?? 16;
    const h = set.height ?? 16;
    for (const [name, icon] of Object.entries(set.icons ?? {})) {
      this.data.set(`${set.prefix}:${name}`, { body: icon.body, width: icon.width ?? w, height: icon.height ?? h });
    }
    // An alias draws its parent's shape.
    for (const [name, alias] of Object.entries(set.aliases ?? {})) {
      const parent = set.icons?.[alias.parent];
      if (parent) {
        this.data.set(`${set.prefix}:${name}`, {
          body: parent.body,
          width: alias.width ?? parent.width ?? w,
          height: alias.height ?? parent.height ?? h,
        });
      }
    }
  }
}

/** Icons whose name *is* the query first ("tree" before "file-tree"),
 *  then names starting with it, then names holding all its words; within
 *  each, Iconify's own order is kept. */
function rankByName(ids: string[], query: string): string[] {
  return ids
    .map((id, i) => ({ id, i, s: nameScore(id, query) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.id);
}

/** 0 = the icon's name is the query, 1 = starts with it, 2 = holds all
 *  its words, 3 = other (a looser match by Iconify). */
function nameScore(id: string, query: string): number {
  const words = query.split(/[^a-z0-9]+/).filter(Boolean);
  const exact = words.join('-');
  const name = baseName(id);
  if (name === exact) return 0;
  if (name.startsWith(`${exact}-`)) return 1;
  const parts = new Set(name.split('-'));
  return words.every((w) => parts.has(w)) ? 2 : 3;
}

/** Style suffixes that make a variant of the same icon. Weight words are
 *  suffixes only in Phosphor ("-light" is part of "traffic-light"). */
const VARIANT = /-(outline|outlined|rounded|round|sharp|fill|filled|solid|regular|duotone|twotone|two-tone|\d+)(?=-|$)/g;
const PHOSPHOR_WEIGHT = /-(thin|light|bold)$/;

/** An icon's name without its style variant suffixes. */
function baseName(id: string): string {
  const [prefix, name] = id.split(':');
  const base = prefix === 'ph' ? name.replace(PHOSPHOR_WEIGHT, '') : name;
  return base.replace(VARIANT, '') || name;
}

/** The first `count` ids drawing on at most `maxLibraries` libraries
 *  (each library's icon shapes are one request). */
export function pageOf(ids: string[], count: number, maxLibraries: number): string[] {
  const libraries = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (out.length >= count) break;
    const prefix = id.split(':')[0];
    if (!libraries.has(prefix)) {
      if (libraries.size >= maxLibraries) continue;
      libraries.add(prefix);
    }
    out.push(id);
  }
  return out;
}

/** Icons per library in a block of a mixed-library result list. */
const LIBRARY_BLOCK = 4;

/** Mixed-library results in blocks of up to 4 per library, libraries in
 *  order of their best hit (Iconify's relevance): similar-looking icons
 *  sit together and no library fills the page. With `pageOf` a page then
 *  needs icon shapes from few libraries — few requests. */
function blockByLibrary(ids: string[]): string[] {
  const byLibrary = new Map<string, string[]>();
  for (const id of ids) {
    const prefix = id.split(':')[0];
    byLibrary.set(prefix, [...(byLibrary.get(prefix) ?? []), id]);
  }
  const queues = [...byLibrary.values()];
  const out: string[] = [];
  while (out.length < ids.length) {
    for (const queue of queues) out.push(...queue.splice(0, LIBRARY_BLOCK));
  }
  return out;
}

/** Keeps the first (best-ranked) variant of each icon per library, so a
 *  short result list shows different icons, not one icon five times. */
function foldVariants(ids: string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    const key = `${id.split(':')[0]}:${baseName(id)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
