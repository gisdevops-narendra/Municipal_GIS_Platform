import { Injectable, inject } from '@angular/core';
import { AuthService } from '../../../core/services/auth.service';
import { userScopedKey } from './user-scoped-storage';
import { nextUid } from '../models/query-builder.model';
import { Sketch, SketchKind } from '../models/sketch.model';

const MAX_SKETCHES = 200;
/** Where sketches used to be persisted — removed on startup. */
const LEGACY_STORAGE_PREFIX = 'mgp.sketches';

/**
 * Draw & Mark sketches are temporary markup: kept in memory per workspace
 * and user for this session only, so a map Reset (`clearAll`) or a page
 * reload removes them. Anything meant to last belongs in a Draw & Mark
 * layer, which is stored on the server.
 */
@Injectable({ providedIn: 'root' })
export class SketchService {
  private readonly auth = inject(AuthService);
  private readonly store = new Map<string, Sketch[]>();

  constructor() {
    // Sketches were once kept in localStorage — drop those leftovers.
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith(LEGACY_STORAGE_PREFIX)) localStorage.removeItem(key);
      }
    } catch {
      /* storage unavailable — nothing to clean */
    }
  }

  private key(workspaceKey: string): string {
    return userScopedKey(LEGACY_STORAGE_PREFIX, workspaceKey, this.auth.user()?.id);
  }

  list(workspaceKey: string): Sketch[] {
    return this.store.get(this.key(workspaceKey)) ?? [];
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

  /** Map Reset: every workspace's sketches go. */
  clearAll(): void {
    this.store.clear();
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
    this.store.set(this.key(workspaceKey), sketches.slice(0, MAX_SKETCHES));
  }
}
