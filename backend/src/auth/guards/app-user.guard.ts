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

    request.appUser = {
      id: user.id,
      keycloakUserId: user.keycloakUserId,
      municipalityId: user.municipalityId,
      departmentId: user.departmentId,
      systemRole: user.systemRole,
      status: user.status,
    };

    return true;
  }
}
