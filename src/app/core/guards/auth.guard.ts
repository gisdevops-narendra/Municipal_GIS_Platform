import { CanActivateFn } from '@angular/router';
import { createAuthGuard } from 'keycloak-angular';

/**
 * Protects a route so it can only be reached by an authenticated user.
 * Unauthenticated visitors are redirected straight to the Keycloak login
 * page (not to our own /login screen), and are returned to the originally
 * requested URL after a successful login.
 *
 * This is authentication only — no roles/permissions are checked here.
 * Authorization (Municipality -> Department -> Role -> Permissions) is a
 * later task.
 */
export const authGuard: CanActivateFn = createAuthGuard<CanActivateFn>(async (_route, state, authData) => {
  const { authenticated, keycloak } = authData;
  if (authenticated) {
    return true;
  }

  await keycloak.login({ redirectUri: window.location.origin + state.url });
  return false;
});
