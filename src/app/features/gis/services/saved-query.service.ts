import { Injectable } from '@angular/core';
import { QueryDefinition, SavedQuery, nextUid } from '../models/query-builder.model';

/**
 * Persists named queries per workspace in `localStorage`. There is no
 * server-side saved-query endpoint yet; this keeps the feature entirely
 * client-side and per-browser. Swapping in a backend later means changing
 * only this service — the Query Builder talks to it through `list` / `save`
 * / `remove`.
 */
@Injectable({ providedIn: 'root' })
export class SavedQueryService {
  private key(workspaceKey: string): string {
    return `mgp.savedQueries.${workspaceKey || 'default'}`;
  }

  list(workspaceKey: string): SavedQuery[] {
    try {
      const raw = localStorage.getItem(this.key(workspaceKey));
      const parsed = raw ? (JSON.parse(raw) as SavedQuery[]) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  save(workspaceKey: string, name: string, definition: QueryDefinition): SavedQuery {
    const entry: SavedQuery = {
      id: nextUid('sq'),
      name: name.trim() || 'Untitled query',
      createdAt: new Date().toISOString(),
      definition: structuredClone(definition)
    };
    const next = [entry, ...this.list(workspaceKey).filter((q) => q.name !== entry.name)];
    this.persist(workspaceKey, next);
    return entry;
  }

  remove(workspaceKey: string, id: string): void {
    this.persist(
      workspaceKey,
      this.list(workspaceKey).filter((q) => q.id !== id)
    );
  }

  private persist(workspaceKey: string, queries: SavedQuery[]): void {
    try {
      localStorage.setItem(this.key(workspaceKey), JSON.stringify(queries.slice(0, 50)));
    } catch {
      /* storage full / unavailable — a saved query is a convenience, not critical */
    }
  }
}
