import { ActivatedRouteSnapshot, DetachedRouteHandle } from '@angular/router';
import { AppRouteReuseStrategy } from './app-route-reuse.strategy';

/** Minimal ActivatedRouteSnapshot stand-in — the strategy only reads
 *  `data`, `routeConfig`, `params` and `pathFromRoot[].url`. */
function snapshot(opts: {
  reuse?: boolean;
  segments?: string[];
  params?: Record<string, string>;
  config?: object;
}): ActivatedRouteSnapshot {
  const url = (opts.segments ?? []).map((path) => ({ path }));
  const snap = {
    data: opts.reuse ? { reuse: true } : {},
    params: opts.params ?? {},
    routeConfig: opts.config ?? { path: (opts.segments ?? []).join('/') },
    url,
    pathFromRoot: [] as unknown[],
  };
  snap.pathFromRoot = [{ url: [] }, snap];
  return snap as unknown as ActivatedRouteSnapshot;
}

const HANDLE = { componentRef: { destroy: () => undefined } } as unknown as DetachedRouteHandle;

describe('AppRouteReuseStrategy', () => {
  let strategy: AppRouteReuseStrategy;

  beforeEach(() => {
    strategy = new AppRouteReuseStrategy();
  });

  it('only detaches routes that opt in with data.reuse', () => {
    expect(strategy.shouldDetach(snapshot({ reuse: true, segments: ['gis'] }))).toBe(true);
    expect(strategy.shouldDetach(snapshot({ segments: ['login'] }))).toBe(false);
  });

  it('stores and re-attaches an opted-in route by its full path', () => {
    const route = snapshot({ reuse: true, segments: ['gis'] });
    expect(strategy.shouldAttach(route)).toBe(false);

    strategy.store(route, HANDLE);

    expect(strategy.shouldAttach(snapshot({ reuse: true, segments: ['gis'] }))).toBe(true);
    expect(strategy.retrieve(snapshot({ reuse: true, segments: ['gis'] }))).toBe(HANDLE);
  });

  it('keys by params so a different :id gets its own slot', () => {
    const permsA = snapshot({
      reuse: true,
      segments: ['gis', 'layers', 'a1', 'permissions'],
      params: { id: 'a1' },
    });
    strategy.store(permsA, HANDLE);

    const permsB = snapshot({
      reuse: true,
      segments: ['gis', 'layers', 'b2', 'permissions'],
      params: { id: 'b2' },
    });
    expect(strategy.shouldAttach(permsB)).toBe(false);
    expect(strategy.shouldAttach(permsA)).toBe(true);
  });

  it('never reuses a route in place when the config or params differ', () => {
    const gis = { path: 'gis' };
    const settings = { path: 'settings' };
    expect(
      strategy.shouldReuseRoute(
        snapshot({ config: gis }) as ActivatedRouteSnapshot,
        snapshot({ config: gis }) as ActivatedRouteSnapshot,
      ),
    ).toBe(true);
    expect(
      strategy.shouldReuseRoute(
        snapshot({ config: gis }) as ActivatedRouteSnapshot,
        snapshot({ config: settings }) as ActivatedRouteSnapshot,
      ),
    ).toBe(false);
  });

  it('clear() drops every cached handle and destroys it', () => {
    const destroy = jasmine.createSpy('destroy');
    const handle = { componentRef: { destroy } } as unknown as DetachedRouteHandle;
    strategy.store(snapshot({ reuse: true, segments: ['gis'] }), handle);
    strategy.store(snapshot({ reuse: true, segments: ['settings'] }), handle);

    strategy.clear();

    expect(destroy).toHaveBeenCalledTimes(2);
    expect(strategy.shouldAttach(snapshot({ reuse: true, segments: ['gis'] }))).toBe(false);
  });
});
