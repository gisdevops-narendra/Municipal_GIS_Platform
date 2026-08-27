import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { SystemRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { RequestWithAppUser } from './app-user.guard';

/**
 * Enforces the SystemRole(s) declared by `@Roles(...)` against
 * `request.appUser` (set by AppUserGuard, which must run first). A route
 * with no `@Roles(...)` metadata is allowed through unchanged — this guard
 * only restricts routes that explicitly opt in.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<
      SystemRole[] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithAppUser>();
    const appUser = request.appUser;

    if (!appUser || !requiredRoles.includes(appUser.systemRole)) {
      throw new ForbiddenException(
        'You do not have permission to perform this action.',
      );
    }

    return true;
  }
}
