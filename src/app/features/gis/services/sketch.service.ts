import { Injectable, inject } from '@angular/core';
import { AuthService } from '../../../core/services/auth.service';
import { readUserScoped, userScopedKey } from './user-scoped-storage';
import { nextUid } from '../models/query-builder.model';
import { Sketch, SketchKind } from '../models/sketch.model';

const MAX_SKETCHES = 200;

/**
 * Persists Draw & Mark sketches per workspace in `localStorage` — the same
 * client-side storage the app uses for bookmarks and saved queries (so they
 * are per browser, not shared). When a server endpoint exists, only this
 * service changes.
 */
@Injectable({ providedIn: 'root' })
export class SketchService {
  private readonly auth = inject(AuthService);

  private key(workspaceKey: string): string {
    return userScopedKey('mgp.sketches', workspaceKey, this.auth.user()?.id);
  }

  list(workspaceKey: string): Sketch[] {
    try {
      const raw = readUserScoped('mgp.sketches', workspaceKey, this.auth.user()?.id);
      const parsed = raw ? (JSON.parse(raw) as Sketch[]) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  add(
    workspaceKey: string,
    sketch: { kind: SketchKind; label: string; color: string; geometry: Record<string, unknown> }
  ): Sketch {
    const created: Sketch = {
      id: nextUid('sk'),
      kind: sketch.kind,
      label: sketch.label.trim(),
      color: sketch.color,
      geometry: sketch.geometry,
      createdAt: new Date().toISOString()
    };
    this.persist(workspaceKey, [created, ...this.list(workspaceKey)]);
    return created;
  }

  remove(workspaceKey: string, id: string): void {
    this.persist(
      workspaceKey,
      this.list(workspaceKey).filter((sketch) => sketch.id !== id)
    );
  }

  clear(workspaceKey: string): void {
    this.persist(workspaceKey, []);
  }

  /** All sketches as one GeoJSON FeatureCollection (EPSG:4326). */
  toFeatureCollection(sketches: Sketch[]): Record<string, unknown> {
    return {
      type: 'FeatureCollection',
      features: sketches.map((sketch) => ({
        type: 'Feature',
        geometry: sketch.geometry,
        properties: { kind: sketch.kind, label: sketch.label, color: sketch.color, createdAt: sketch.createdAt }
      }))
    };
  }

  private persist(workspaceKey: string, sketches: Sketch[]): void {
    try {
      localStorage.setItem(this.key(workspaceKey), JSON.stringify(sketches.slice(0, MAX_SKETCHES)));
    } catch {
      /* storage unavailable / full — non-critical */
    }
  }
}
