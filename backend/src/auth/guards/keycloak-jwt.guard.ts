import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';

/**
 * Reusable guard for every protected endpoint. Verifies the request carries
 * a valid Keycloak-issued access token (signature, issuer, expiry, client)
 * via KeycloakJwtStrategy, and attaches the token claims to `request.user`.
 *
 * Usage: `@UseGuards(KeycloakJwtGuard)` on any controller/route.
 */
@Injectable()
export class KeycloakJwtGuard extends AuthGuard('keycloak-jwt') {
  override handleRequest<TUser = unknown>(err: unknown, user: TUser): TUser {
    if (err || !user) {
      throw new UnauthorizedException('Authentication required.');
    }
    return user;
  }

  override getRequest(context: ExecutionContext): Request {
    return context.switchToHttp().getRequest<Request>();
  }
}
