import { ForbiddenException, NotFoundException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RasterModuleGuard } from './raster-module.guard';
import { RASTER_MODULES, terrainModules } from './raster-tool-registry';

describe('RasterModuleGuard', () => {
  const handler = () => undefined;
  let granted: Set<number>;
  let rule: unknown;

  const context = (params: Record<string, string> = {}, body: unknown = {}) =>
    ({
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => ({ appUser: { id: 'u1' }, params, body }) }),
    }) as unknown as ExecutionContext;

  const guard = () =>
    new RasterModuleGuard(
      { get: () => rule } as unknown as Reflector,
      { getEffectiveModuleIdsForAppUser: jest.fn().mockResolvedValue(granted) } as never,
    );

  beforeEach(() => {
    granted = new Set();
    rule = undefined;
  });

  it('allows a route without a raster rule', async () => {
    await expect(guard().canActivate(context())).resolves.toBe(true);
  });

  it('allows when any listed module is granted', async () => {
    rule = [RASTER_MODULES.statistics, RASTER_MODULES.style];
    granted = new Set([RASTER_MODULES.style]);
    await expect(guard().canActivate(context())).resolves.toBe(true);
  });

  it('rejects when none of the modules is granted', async () => {
    rule = [RASTER_MODULES.upload];
    granted = new Set([RASTER_MODULES.style]);
    await expect(guard().canActivate(context())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('derives terrain modules from the requested kind', async () => {
    rule = terrainModules;
    granted = new Set([RASTER_MODULES.slope]);
    await expect(guard().canActivate(context({}, { kind: 'slope' }))).resolves.toBe(true);
    await expect(guard().canActivate(context({}, { kind: 'TPI' }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('gates a job by its :tool param', async () => {
    rule = 'job';
    granted = new Set([RASTER_MODULES.online]);
    await expect(guard().canActivate(context({ tool: 'online' }))).resolves.toBe(true);
    await expect(guard().canActivate(context({ tool: 'mosaic' }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard().canActivate(context({ tool: 'nope' }))).rejects.toBeInstanceOf(NotFoundException);
  });
});
