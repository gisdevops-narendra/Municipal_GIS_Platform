import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { IntegrationsService } from '../../gis/integrations.service';
import { AppUserGuard, RequestWithAppUser } from './app-user.guard';
import { KeycloakJwtGuard } from './keycloak-jwt.guard';

/**
 * Signed-in user (Keycloak JWT) OR an API key — `X-API-Key: mgp_…` or
 * `Authorization: ApiKey mgp_…`. A key acts as the user who created it,
 * with that user's layer permissions. Use only on read endpoints.
 */
@Injectable()
export class ApiKeyOrJwtGuard implements CanActivate {
  private readonly jwt = new KeycloakJwtGuard();

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithAppUser>();
    const header = request.headers['x-api-key'];
    const auth = request.headers['authorization'];
    const key =
      (typeof header === 'string' && header.trim()) ||
      (typeof auth === 'string' && /^ApiKey\s+/i.test(auth) ? auth.replace(/^ApiKey\s+/i, '').trim() : '');

    if (key) {
      const user = await this.integrations.resolveKey(key);
      if (!user) throw new UnauthorizedException('Invalid, expired or revoked API key.');
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

    await this.jwt.canActivate(context);
    return new AppUserGuard(this.prisma).canActivate(context);
  }
}
