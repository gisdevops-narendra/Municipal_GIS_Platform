import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as jwksRsa from 'jwks-rsa';

/**
 * Claims we rely on from a validated Keycloak access token. Only a small,
 * explicit subset — never trust or forward the raw token payload beyond
 * this shape.
 */
export interface KeycloakJwtPayload {
  sub: string;
  email?: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  azp?: string;
  aud?: string | string[];
  iss: string;
  exp: number;
}

/**
 * Validates Keycloak-issued JWTs: RS256 signature against Keycloak's JWKS
 * endpoint, issuer, expiration (handled by passport-jwt), and that the
 * token was actually issued to our known frontend client (azp/aud) rather
 * than some other client in the realm.
 *
 * This is the ONLY place token trust is established. Every other guard/
 * controller in the app must go through it (via KeycloakJwtGuard) instead
 * of re-implementing verification.
 */
@Injectable()
export class KeycloakJwtStrategy extends PassportStrategy(
  Strategy,
  'keycloak-jwt',
) {
  private readonly expectedClientId: string;

  constructor(config: ConfigService) {
    // KEYCLOAK_URL must match the browser-facing origin Angular
    // authenticates against (e.g. http://localhost:8180), because that is
    // what Keycloak stamps into the token's `iss` claim — this is what we
    // validate against below.
    //
    // KEYCLOAK_INTERNAL_URL is where THIS backend process actually reaches
    // Keycloak over the network to fetch its signing keys, which can differ
    // (e.g. the Docker Compose service hostname `http://keycloak:8080`)
    // when the backend and Keycloak share a container network but the
    // browser does not. It defaults to KEYCLOAK_URL for the common case of
    // both being reached via the same host-mapped port.
    const keycloakUrl = config.getOrThrow<string>('KEYCLOAK_URL');
    const keycloakInternalUrl =
      config.get<string>('KEYCLOAK_INTERNAL_URL') ?? keycloakUrl;
    const realm = config.getOrThrow<string>('KEYCLOAK_REALM');
    const issuer = `${keycloakUrl}/realms/${realm}`;

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      issuer,
      algorithms: ['RS256'],
      secretOrKeyProvider: jwksRsa.passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `${keycloakInternalUrl}/realms/${realm}/protocol/openid-connect/certs`,
      }),
    });

    this.expectedClientId = config.getOrThrow<string>(
      'KEYCLOAK_FRONTEND_CLIENT_ID',
    );
  }

  validate(payload: KeycloakJwtPayload): KeycloakJwtPayload {
    const audience = Array.isArray(payload.aud)
      ? payload.aud
      : [payload.aud].filter(Boolean);
    const issuedToKnownClient =
      payload.azp === this.expectedClientId ||
      audience.includes(this.expectedClientId);

    if (!issuedToKnownClient) {
      throw new UnauthorizedException(
        'Token was not issued to a recognized client.',
      );
    }

    return payload;
  }
}
