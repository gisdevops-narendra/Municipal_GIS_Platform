import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UseGuards, applyDecorators } from '@nestjs/common';
import { KeycloakJwtGuard } from '../auth/guards/keycloak-jwt.guard';
import { AppUserGuard, type RequestWithAppUser } from '../auth/guards/app-user.guard';
import { PrismaService } from '../prisma/prisma.service';

import { isPlatformAdmin } from '../auth/platform-admin.util';

export { isPlatformAdmin };

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithAppUser>();
    const user = await this.prisma.user.findUnique({
      where: { id: request.appUser.id },
      select: { email: true, isPlatformAdmin: true },
    });
    if (!user || !isPlatformAdmin(user)) {
      throw new ForbiddenException('Platform administrators only.');
    }
    return true;
  }
}

/** Signed-in, active, and a platform admin. */
export function RequirePlatformAdmin() {
  return applyDecorators(UseGuards(KeycloakJwtGuard, AppUserGuard, PlatformAdminGuard));
}
