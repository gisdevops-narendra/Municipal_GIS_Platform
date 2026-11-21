import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CanActivate } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import type { KeycloakJwtPayload } from '../strategies/keycloak-jwt.strategy';
import type { AppUser } from '../types/app-user.type';
import { isPlatformAdmin } from '../platform-admin.util';

export interface RequestWithAppUser extends Request {
  user: KeycloakJwtPayload;
  appUser: AppUser;
}

/**
 * Resolves the authenticated application User (municipality, department,
 * role) from the Keycloak identity set by KeycloakJwtGuard, and attaches it
 * to `request.appUser` for downstream guards/decorators (RolesGuard,
 * @CurrentAppUser()) to use without repeating the lookup.
 *
 * Must run AFTER KeycloakJwtGuard: `@UseGuards(KeycloakJwtGuard, AppUserGuard)`.
 *
 * Also enforces that a deactivated (status !== ACTIVE) application user is
 * rejected on every request that reaches this guard — this is what makes
 * "deactivate a user" actually take effect, independent of whether their
 * existing Keycloak access token is still cryptographically valid.
 */
@Injectable()
export class AppUserGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithAppUser>();
    const keycloakUserId = request.user?.sub;

    if (!keycloakUserId) {
      throw new UnauthorizedException('Authentication required.');
    }

    const user = await this.prisma.user.findUnique({
      where: { keycloakUserId },
    });

    if (!user) {
      throw new NotFoundException(
        'No application user is linked to this Keycloak identity.',
      );
    }

    if (user.status !== 'ACTIVE') {
      throw new ForbiddenException('This account has been deactivated.');
    }

    // Admin accounts are for platform administration only — no map
    // workspace, so every map / GIS endpoint is off limits to them.
    const path = (request as { originalUrl?: string; url?: string }).originalUrl ?? request.url ?? '';
    if (/^\/api\/gis(\/|\?|$)/.test(path) && isPlatformAdmin(user)) {
      throw new ForbiddenException(
        'Admin accounts manage the platform and have no map workspace. Sign in with a regular account to use the map.',
      );
    }

    request.appUser = {
      id: user.id,
      keycloakUserId: user.keycloakUserId,
      municipalityId: user.municipalityId,
      // Roles were removed: every account owns its workspace.
      systemRole: 'MUNICIPALITY_OWNER',
      status: user.status,
    };

    return true;
  }
}
