import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { CurrentUserService } from '../services/current-user.service';

/**
 * Keeps a Department User on the Municipal GIS map: they may only view GIS
 * data, so every other authenticated screen sends them to /gis. The
 * Owner and Department Heads pass through. Pair with authGuard.
 *
 * UI convenience only — the backend independently refuses a Department
 * User's calls to the APIs behind these screens.
 */
export const staffOnlyGuard: CanActivateFn = () => {
  // Angular runs a route's guards concurrently; while signed out, authGuard
  // is already redirecting to Keycloak — don't fire an unauthenticated /me.
  if (!inject(AuthService).isAuthenticatedNow()) {
    return true;
  }
  const router = inject(Router);
  return inject(CurrentUserService)
    .getMe()
    .pipe(
      map((me) => (me.systemRole === 'DEPARTMENT_USER' ? router.createUrlTree(['/gis']) : true)),
      // If /me itself fails, let the page load and surface its own error.
      catchError(() => of(true))
    );
};
