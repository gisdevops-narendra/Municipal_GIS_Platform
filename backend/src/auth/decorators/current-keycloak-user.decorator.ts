import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { KeycloakJwtPayload } from '../strategies/keycloak-jwt.strategy';

interface RequestWithKeycloakUser extends Request {
  user: KeycloakJwtPayload;
}

/**
 * Extracts the validated Keycloak token claims set by KeycloakJwtGuard.
 * Only usable on routes protected by that guard — the claims are never
 * populated otherwise.
 */
export const CurrentKeycloakUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): KeycloakJwtPayload => {
    const request = ctx.switchToHttp().getRequest<RequestWithKeycloakUser>();
    return request.user;
  },
);
