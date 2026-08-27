import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'node:crypto';

export interface CreateKeycloakUserInput {
  email: string;
  fullName: string;
  mobileNumber: string;
  password: string;
}

export interface CreateKeycloakUserWithTemporaryPasswordInput {
  email: string;
  fullName: string;
  mobileNumber: string;
}

const TEMP_PASSWORD_CHARS =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';

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

  /** Self-registration path (Task 3): creates a Keycloak user with the
   *  password the owner chose at registration time. Throws
   *  ConflictException if the username/email is already taken in Keycloak. */
  async createUser(
    input: CreateKeycloakUserInput,
  ): Promise<{ keycloakUserId: string }> {
    return this.createUserInternal(input, {
      type: 'password',
      value: input.password,
      temporary: false,
    });
  }

  /**
   * Owner-initiated user creation (Task 4): the Owner does not know — and
   * must never choose — another person's password, so this generates a
   * strong temporary one server-side and marks it `temporary: true`,
   * forcing Keycloak to require a password change on first login.
   *
   * There is no email/notification system in this task's scope, so the
   * generated password is returned once in the API response for the Owner
   * to share with the new user out of band. It is never logged or
   * persisted anywhere. A follow-up task should replace this with a proper
   * invite-link/email flow.
   */
  async createUserWithTemporaryPassword(
    input: CreateKeycloakUserWithTemporaryPasswordInput,
  ): Promise<{ keycloakUserId: string; temporaryPassword: string }> {
    const temporaryPassword = this.generateTemporaryPassword();
    const { keycloakUserId } = await this.createUserInternal(input, {
      type: 'password',
      value: temporaryPassword,
      temporary: true,
    });
    return { keycloakUserId, temporaryPassword };
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

  private generateTemporaryPassword(): string {
    let password = '';
    for (let i = 0; i < 14; i++) {
      password += TEMP_PASSWORD_CHARS[randomInt(TEMP_PASSWORD_CHARS.length)];
    }
    return password;
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
