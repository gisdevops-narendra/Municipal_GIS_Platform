import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { KeycloakJwtGuard } from '../auth/guards/keycloak-jwt.guard';
import { AppUserGuard, type RequestWithAppUser } from '../auth/guards/app-user.guard';
import { ModuleAccessService } from '../module-access/module-access.service';
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
    private readonly moduleAccess: ModuleAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.get<ModuleRule | undefined>(RASTER_MODULES_KEY, context.getHandler());
    if (!rule) return true;
    const request = context.switchToHttp().getRequest<RequestWithAppUser & { params: Record<string, string>; body: unknown }>();
    let ids: number[];
    if (rule === 'job') {
      const tool = RASTER_JOB_TOOLS[request.params.tool];
      if (!tool) throw new NotFoundException(`Unknown raster tool "${request.params.tool}".`);
      ids = typeof tool.modules === 'function' ? tool.modules(request.body) : tool.modules;
    } else {
      ids = typeof rule === 'function' ? rule(request.body) : rule;
    }
    const granted = await this.moduleAccess.getEffectiveModuleIdsForAppUser(request.appUser);
    if (!ids.some((id) => granted.has(id))) {
      throw new ForbiddenException('Your module access does not include this raster tool.');
    }
    return true;
  }
}
