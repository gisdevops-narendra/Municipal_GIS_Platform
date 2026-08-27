import { Injectable, computed, effect, inject, signal } from '@angular/core';
import Keycloak from 'keycloak-js';
import { KEYCLOAK_EVENT_SIGNAL, KeycloakEventType, typeEventArgs } from 'keycloak-angular';
import type { ReadyArgs } from 'keycloak-angular';
import { AuthenticatedUser } from '../models/authenticated-user.model';

/**
 * Clean authentication abstraction over Keycloak (OIDC/OAuth2).
 *
 * This is the ONLY place in the application that should talk to the
 * `keycloak-js` instance directly. Components and other services must go
 * through this service instead — so the day the identity provider changes,
 * or multi-tenant realm strategy is introduced, only this file changes.
 *
 * Keycloak roles are intentionally NOT surfaced here: the future
 * application authorization model (Municipality -> Department -> Role ->
 * Permissions -> Layer/Module access) is a separate concern built later.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly keycloak = inject(Keycloak);
  private readonly keycloakSignal = inject(KEYCLOAK_EVENT_SIGNAL);

  private readonly authenticatedSignal = signal(false);
  private readonly userSignal = signal<AuthenticatedUser | null>(null);

  /** Reactive authenticated state. Prefer this over calling isAuthenticated()
   *  in templates so change detection can react to it directly. */
  readonly isAuthenticated = this.authenticatedSignal.asReadonly();

  /** Reactive current-user state. Null while unauthenticated. */
  readonly user = computed(() => this.userSignal());

  constructor() {
    effect(() => {
      const event = this.keycloakSignal();

      switch (event.type) {
        case KeycloakEventType.Ready: {
          const authenticated = typeEventArgs<ReadyArgs>(event.args);
          this.syncState(authenticated);
          break;
        }
        case KeycloakEventType.AuthSuccess:
        case KeycloakEventType.AuthRefreshSuccess:
          this.syncState(true);
          break;
        case KeycloakEventType.AuthLogout:
        case KeycloakEventType.AuthRefreshError:
          this.syncState(false);
          break;
        default:
          break;
      }
    });
  }

  private syncState(authenticated: boolean): void {
    this.authenticatedSignal.set(authenticated);
    this.userSignal.set(authenticated ? this.mapUser() : null);
  }

  private mapUser(): AuthenticatedUser | null {
    const claims = this.keycloak.tokenParsed;
    if (!claims?.sub) {
      return null;
    }
    return {
      id: claims.sub,
      username: claims['preferred_username'] ?? '',
      email: claims['email'],
      firstName: claims['given_name'],
      lastName: claims['family_name']
    };
  }

  /** Redirects the browser to the Keycloak login page. Resolves only after
   *  the redirect has been initiated. `loginHint` only pre-fills the
   *  username field on Keycloak's own login page — it is never used to
   *  authenticate locally. */
  login(options: { redirectUri?: string; loginHint?: string } = {}): Promise<void> {
    const redirectUri = options.redirectUri ?? window.location.href;
    return this.keycloak.login({ redirectUri, loginHint: options.loginHint });
  }

  /** Redirects through Keycloak's logout endpoint, clearing the Keycloak
   *  session, then returns the browser to the application. */
  logout(redirectUri: string = window.location.origin + '/'): Promise<void> {
    return this.keycloak.logout({ redirectUri });
  }

  isAuthenticatedNow(): boolean {
    return !!this.keycloak.authenticated;
  }

  getUser(): AuthenticatedUser | null {
    return this.userSignal();
  }

  /** Current access token, or undefined if unauthenticated. Do not persist
   *  or log this value — it is held only in memory by keycloak-js. */
  getToken(): string | undefined {
    return this.keycloak.token;
  }

  /** Refreshes the access token if it is due to expire within
   *  `minValiditySeconds`. Returns true if a new token was fetched. */
  async refreshToken(minValiditySeconds = 30): Promise<boolean> {
    try {
      return await this.keycloak.updateToken(minValiditySeconds);
    } catch {
      this.syncState(false);
      return false;
    }
  }
}
