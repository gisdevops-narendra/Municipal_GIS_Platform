import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface CreateKeycloakUserInput {
  email: string;
  fullName: string;
  mobileNumber: string;
  password: string;
}

/**
 * Server-side-only client for the Keycloak Admin REST API.
 *
 * Keycloak remains the sole owner of credentials: this service creates the
 * Keycloak user so our own database never stores or sees a password beyond
 * this in-memory call. It authenticates using a confidential client's
 * service account (KEYCLOAK_ADMIN_CLIENT_ID/SECRET) — those credentials
 * never reach the browser.
 */
@Injectable()
export class KeycloakAdminService {
  private readonly logger = new Logger(KeycloakAdminService.name);
  private readonly keycloakUrl: string;
  private readonly realm: string;
  private readonly adminClientId: string;
  private readonly adminClientSecret: string;

  constructor(private readonly config: ConfigService) {
    // This service only ever makes server-to-server calls, so it should use
    // KEYCLOAK_INTERNAL_URL (the network-reachable address, e.g. the Docker
    // Compose service hostname) when set, falling back to KEYCLOAK_URL
    // otherwise. Unlike KeycloakJwtStrategy, it never needs to match a
    // browser-facing issuer claim.
    this.keycloakUrl =
      this.config.get<string>('KEYCLOAK_INTERNAL_URL') ??
      this.config.getOrThrow<string>('KEYCLOAK_URL');
    this.realm = this.config.getOrThrow<string>('KEYCLOAK_REALM');
    this.adminClientId = this.config.getOrThrow<string>(
      'KEYCLOAK_ADMIN_CLIENT_ID',
    );
    this.adminClientSecret = this.config.getOrThrow<string>(
      'KEYCLOAK_ADMIN_CLIENT_SECRET',
    );
  }

  /** Creates a Keycloak user with a permanent password — the one the
   *  Owner chose at registration, or the one the Owner set for a new
   *  municipality user. Throws ConflictException if the username/email is
   *  already taken in Keycloak. */
  async createUser(
    input: CreateKeycloakUserInput,
  ): Promise<{ keycloakUserId: string }> {
    return this.createUserInternal(input, {
      type: 'password',
      value: input.password,
      temporary: false,
    });
  }

  private async createUserInternal(
    input: { email: string; fullName: string; mobileNumber: string },
    credential: { type: 'password'; value: string; temporary: boolean },
  ): Promise<{ keycloakUserId: string }> {
    const token = await this.getAdminAccessToken();
    const [firstName, ...rest] = input.fullName.trim().split(/\s+/);
    const lastName = rest.join(' ') || firstName;

    const response = await fetch(
      `${this.keycloakUrl}/admin/realms/${this.realm}/users`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: input.email,
          email: input.email,
          firstName,
          lastName,
          enabled: true,
          emailVerified: true,
          attributes: { mobileNumber: [input.mobileNumber] },
          requiredActions: credential.temporary ? ['UPDATE_PASSWORD'] : [],
          credentials: [credential],
        }),
      },
    );

    if (response.status === 409) {
      throw new ConflictException(
        'A Keycloak account with this email already exists.',
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        `Keycloak user creation failed (${response.status}): ${body}`,
      );
      throw new BadGatewayException(
        'Unable to create the identity provider account. Please try again.',
      );
    }

    const location = response.headers.get('location');
    const keycloakUserId = location?.split('/').pop();
    if (!keycloakUserId) {
      this.logger.error(
        'Keycloak user creation response did not include a Location header.',
      );
      throw new BadGatewayException(
        'Unable to create the identity provider account. Please try again.',
      );
    }

    return { keycloakUserId };
  }

  /** Best-effort compensating action used when a Keycloak user was created
   *  but the subsequent database transaction failed. Never throws — a
   *  failure here must not mask the original error, it only risks leaving
   *  an orphaned Keycloak user for manual cleanup. */
  async deleteUser(keycloakUserId: string): Promise<void> {
    try {
      const token = await this.getAdminAccessToken();
      await fetch(
        `${this.keycloakUrl}/admin/realms/${this.realm}/users/${keycloakUserId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
    } catch (error) {
      this.logger.error(
        `Failed to roll back Keycloak user ${keycloakUserId}`,
        error as Error,
      );
    }
  }

  /** Revokes all active Keycloak sessions for a user — called when an
   *  Owner deactivates them, so an already-open browser session can't keep
   *  using the app. Best-effort: a failure here must not block the status
   *  change itself, since AppUserGuard independently rejects every API
   *  call from a DISABLED application user regardless of session state. */
  async logoutUserSessions(keycloakUserId: string): Promise<void> {
    try {
      const token = await this.getAdminAccessToken();
      await fetch(
        `${this.keycloakUrl}/admin/realms/${this.realm}/users/${keycloakUserId}/logout`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
    } catch (error) {
      this.logger.error(
        `Failed to revoke sessions for Keycloak user ${keycloakUserId}`,
        error as Error,
      );
    }
  }

  private async getAdminAccessToken(): Promise<string> {
    const response = await fetch(
      `${this.keycloakUrl}/realms/${this.realm}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.adminClientId,
          client_secret: this.adminClientSecret,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        `Failed to obtain Keycloak admin token (${response.status}): ${body}`,
      );
      throw new BadGatewayException(
        'Unable to reach the identity provider. Please try again.',
      );
    }

    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  }
}
