import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RasterModuleGuard } from './raster-module.guard';
import { RASTER_MODULES, terrainModules } from './raster-tool-registry';

/** Module Access was removed: every signed-in account may use every raster
 *  tool. The guard now only rejects an unknown `:tool` job. */
describe('RasterModuleGuard', () => {
  const handler = () => undefined;
  let rule: unknown;

  const context = (params: Record<string, string> = {}, body: unknown = {}) =>
    ({
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => ({ appUser: { id: 'u1' }, params, body }) }),
    }) as unknown as ExecutionContext;

  const guard = () => new RasterModuleGuard({ get: () => rule } as unknown as Reflector);

  beforeEach(() => {
    rule = undefined;
  });

  it('allows a route without a raster rule', () => {
    expect(guard().canActivate(context())).toBe(true);
  });

  it('allows any listed raster tool', () => {
    rule = [RASTER_MODULES.upload];
    expect(guard().canActivate(context())).toBe(true);
  });

  it('allows terrain tools of any kind', () => {
    rule = terrainModules;
    expect(guard().canActivate(context({}, { kind: 'slope' }))).toBe(true);
    expect(guard().canActivate(context({}, { kind: 'TPI' }))).toBe(true);
  });

  it('allows known job tools and rejects unknown ones', () => {
    rule = 'job';
    expect(guard().canActivate(context({ tool: 'online' }))).toBe(true);
    expect(guard().canActivate(context({ tool: 'mosaic' }))).toBe(true);
    expect(() => guard().canActivate(context({ tool: 'nope' }))).toThrow(NotFoundException);
  });
});
