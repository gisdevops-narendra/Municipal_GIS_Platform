import { CanActivateFn, Router } from '@angular/router';
import { inject } from '@angular/core';
import { createAuthGuard } from 'keycloak-angular';

/** Login redirects remembered per tab, to detect a redirect loop. */
const REDIRECTS_KEY = 'mgp.authRedirects';
const LOOP_WINDOW_MS = 30_000;
const LOOP_MAX_REDIRECTS = 3;

/**
 * Protects a route so it can only be reached by an authenticated user.
 * Unauthenticated visitors are redirected straight to the Keycloak login
 * page (not to our own /login screen), and are returned to the originally
 * requested URL after a successful login.
 *
 * This is authentication only — no roles/permissions are checked here.
 * Authorization (Municipality -> Department -> Role -> Permissions) is a
 * later task.
 *
 * Loop breaker: if Keycloak keeps sending the browser back without the app
 * ending up authenticated (stale callback state after a restart, a token
 * the adapter rejects, …), every load would redirect again — a blank page
 * reloading forever. After LOOP_MAX_REDIRECTS redirects within
 * LOOP_WINDOW_MS this stops, clears the adapter's leftover callback state,
 * and shows /login, where one click starts a clean sign-in.
 */
export const authGuard: CanActivateFn = createAuthGuard<CanActivateFn>(async (_route, state, authData) => {
  const { authenticated, keycloak } = authData;
  const router = inject(Router);
  if (authenticated) {
    clearRedirects();
    return true;
  }

  const recent = recordRedirect();
  if (recent > LOOP_MAX_REDIRECTS) {
    console.error(
      `[auth] Stopped a sign-in redirect loop (${recent} redirects in ${LOOP_WINDOW_MS / 1000} s) — showing /login instead.`
    );
    clearRedirects();
    clearKeycloakCallbackState();
    return router.createUrlTree(['/login'], { queryParams: { signin: 'interrupted' } });
  }

  await keycloak.login({ redirectUri: window.location.origin + state.url });
  return false;
});

/** Adds a redirect timestamp; returns how many fall inside the window. */
function recordRedirect(): number {
  try {
    const now = Date.now();
    const stamps = (JSON.parse(sessionStorage.getItem(REDIRECTS_KEY) || '[]') as number[]).filter(
      (t) => now - t < LOOP_WINDOW_MS
    );
    stamps.push(now);
    sessionStorage.setItem(REDIRECTS_KEY, JSON.stringify(stamps));
    return stamps.length;
  } catch {
    return 0; // storage unavailable — never block sign-in on it
  }
}

export function clearRedirects(): void {
  try {
    sessionStorage.removeItem(REDIRECTS_KEY);
  } catch {
    /* ignore */
  }
}

/** keycloak-js keeps one `kc-callback-<state>` entry per login attempt. */
function clearKeycloakCallbackState(): void {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('kc-callback-'))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}
