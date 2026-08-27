import { Injectable } from '@angular/core';
import { nextUid } from '../models/query-builder.model';
import { Bookmark, BookmarkResult, BookmarkView } from '../models/bookmark.model';

/**
 * Persists spatial bookmarks per workspace in `localStorage` — the same
 * client-side storage architecture the app already uses for saved queries
 * (`SavedQueryService`). There is no server-side bookmark endpoint; when one
 * exists, only this service changes — the panel talks to it purely through
 * `list` / `add` / `rename` / `remove`.
 */
@Injectable({ providedIn: 'root' })
export class BookmarkService {
  private key(workspaceKey: string): string {
    return `mgp.bookmarks.${workspaceKey || 'default'}`;
  }

  list(workspaceKey: string): Bookmark[] {
    try {
      const raw = localStorage.getItem(this.key(workspaceKey));
      const parsed = raw ? (JSON.parse(raw) as Bookmark[]) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  add(workspaceKey: string, name: string, view: BookmarkView): BookmarkResult {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: 'empty' };
    }
    const existing = this.list(workspaceKey);
    if (existing.some((bookmark) => this.sameName(bookmark.name, trimmed))) {
      return { ok: false, reason: 'duplicate' };
    }
    const bookmark: Bookmark = {
      id: nextUid('bm'),
      name: trimmed,
      createdAt: new Date().toISOString(),
      view
    };
    this.persist(workspaceKey, [bookmark, ...existing]);
    return { ok: true, bookmark };
  }

  rename(workspaceKey: string, id: string, name: string): BookmarkResult {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: 'empty' };
    }
    const list = this.list(workspaceKey);
    const target = list.find((bookmark) => bookmark.id === id);
    if (!target) {
      return { ok: false, reason: 'not-found' };
    }
    if (list.some((bookmark) => bookmark.id !== id && this.sameName(bookmark.name, trimmed))) {
      return { ok: false, reason: 'duplicate' };
    }
    const updated = { ...target, name: trimmed };
    this.persist(
      workspaceKey,
      list.map((bookmark) => (bookmark.id === id ? updated : bookmark))
    );
    return { ok: true, bookmark: updated };
  }

  remove(workspaceKey: string, id: string): void {
    this.persist(
      workspaceKey,
      this.list(workspaceKey).filter((bookmark) => bookmark.id !== id)
    );
  }

  private sameName(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  private persist(workspaceKey: string, bookmarks: Bookmark[]): void {
    try {
      localStorage.setItem(this.key(workspaceKey), JSON.stringify(bookmarks.slice(0, 100)));
    } catch {
      /* storage unavailable / full — non-critical */
    }
  }
}
