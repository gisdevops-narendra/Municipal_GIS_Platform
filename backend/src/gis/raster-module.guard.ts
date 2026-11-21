import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { KeycloakJwtGuard } from '../auth/guards/keycloak-jwt.guard';
import { AppUserGuard, type RequestWithAppUser } from '../auth/guards/app-user.guard';
import { RASTER_JOB_TOOLS } from './raster-tool-registry';

const RASTER_MODULES_KEY = 'rasterModules';

/** Which module ids grant a route: fixed ids, ids derived from the request
 *  body (terrain kind), or 'job' = from the `:tool` route param. */
type ModuleRule = number[] | ((body: unknown) => number[]) | 'job';

/**
 * Raster Analysis endpoint gate: municipality member AND at least one of
 * the given Module Access ids in the caller's effective modules. The
 * panel hides tools the same way, but the API must not rely on that.
 */
export function RequireRasterModule(rule: ModuleRule) {
  return applyDecorators(
    SetMetadata(RASTER_MODULES_KEY, rule),
    UseGuards(KeycloakJwtGuard, AppUserGuard, RasterModuleGuard),
  );
}

@Injectable()
export class RasterModuleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const rule = this.reflector.get<ModuleRule | undefined>(RASTER_MODULES_KEY, context.getHandler());
    if (!rule) return true;
    const request = context.switchToHttp().getRequest<RequestWithAppUser & { params: Record<string, string>; body: unknown }>();
    // Module access was removed: every signed-in account may use every
    // raster tool. Only reject unknown job tools.
    if (rule === 'job' && !RASTER_JOB_TOOLS[request.params.tool]) {
      throw new NotFoundException(`Unknown raster tool "${request.params.tool}".`);
    }
    return true;
  }
}
