import { Injectable } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  DetachedRouteHandle,
  RouteReuseStrategy,
} from '@angular/router';

/**
 * Keep-alive route reuse. A screen that opts in (route `data: { reuse: true }`)
 * is detached whole — its DOM, its injector subtree and every signal it
 * holds — when the user navigates away, and the *same* component instance is
 * re-attached when they come back, so the workspace is exactly as they left
 * it (map view, forms, filters, query/analysis results, AI chat, dock
 * sizes…). Nothing is serialised; this is in-memory, for the session only —
 * a hard refresh starts fresh.
 *
 * Only explicitly opted-in routes are cached — the landing page, login and
 * the registration flow behave exactly as before.
 */
@Injectable({ providedIn: 'root' })
export class AppRouteReuseStrategy implements RouteReuseStrategy {
  private readonly handles = new Map<string, DetachedRouteHandle>();

  /** Wipe every cached screen — called when the session ends so a different
   *  user signing in on the same tab never sees the previous user's state.
   *  (Normal logout is a full-page Keycloak redirect, which already clears
   *  memory; this is belt-and-braces.) */
  clear(): void {
    for (const handle of this.handles.values()) {
      const ref = (handle as { componentRef?: { destroy(): void } }).componentRef;
      ref?.destroy();
    }
    this.handles.clear();
  }

  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    return this.isReusable(route);
  }

  store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
    const key = this.keyFor(route);
    if (!key) return;
    if (handle) {
      this.handles.set(key, handle);
    } else {
      this.handles.delete(key);
    }
  }

  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    const key = this.keyFor(route);
    return !!key && this.handles.has(key);
  }

  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    const key = this.keyFor(route);
    return (key && this.handles.get(key)) ?? null;
  }

  shouldReuseRoute(
    future: ActivatedRouteSnapshot,
    curr: ActivatedRouteSnapshot,
  ): boolean {
    // Angular's default: same route config AND same params. A param change
    // (e.g. a different layer id on the permissions screen) still rebuilds
    // the component.
    return (
      future.routeConfig === curr.routeConfig &&
      JSON.stringify(future.params) === JSON.stringify(curr.params)
    );
  }

  private isReusable(route: ActivatedRouteSnapshot): boolean {
    return route.data?.['reuse'] === true;
  }

  /** Stable cache key: the full matched path including params, so
   *  `gis/layers/<id>/permissions` gets one slot per id. `null` for routes
   *  that don't opt in. */
  private keyFor(route: ActivatedRouteSnapshot): string | null {
    if (!this.isReusable(route)) return null;
    return route.pathFromRoot
      .flatMap((entry) => entry.url.map((segment) => segment.path))
      .join('/');
  }
}
