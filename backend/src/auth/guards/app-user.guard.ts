import { ExecutionContext, ForbiddenException, Injectable, NotFoundException, UnauthorizedException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { CanActivate } from '@nestjs/common';
import type { Request } from 'express';
import { PlatformSettingsService } from '../../platform/platform-settings.service';
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
  constructor(private readonly prisma: PrismaService,
    @Optional() private readonly platformSettings?: PlatformSettingsService,
  ) {}

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

    // Maintenance mode (Admin → Announcements): only platform admins in.
    if (this.platformSettings && !isPlatformAdmin(user)) {
      const maintenance = await this.platformSettings.get('maintenance').catch(() => null);
      if (maintenance?.enabled) throw new ServiceUnavailableException(maintenance.message || 'The platform is under maintenance.');
    }

    this.trackActivity(user.id);

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

  /** Last sign-in (≤ every 5 min) and one activity row per user per day,
   *  for Admin → Users / Analytics. Fire-and-forget. */
  private readonly seen = new Map<string, number>();
  private readonly activeToday = new Set<string>();
  private today = '';

  private trackActivity(userId: string): void {
    const now = Date.now();
    if (now - (this.seen.get(userId) ?? 0) > 5 * 60_000) {
      this.seen.set(userId, now);
      void this.prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date(now) } }).catch(() => undefined);
    }
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.today) {
      this.today = day;
      this.activeToday.clear();
    }
    if (!this.activeToday.has(userId)) {
      this.activeToday.add(userId);
      void this.prisma.userActivityDay
        .upsert({ where: { day_userId: { day: new Date(day), userId } }, create: { day: new Date(day), userId }, update: {} })
        .catch(() => undefined);
    }
  }
}
