import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { CurrentUserService } from '../services/current-user.service';

/** /admin: platform administrators only — everyone else goes to the map.
 *  UI convenience; every /api/admin call is checked on the server too. */
export const platformAdminGuard: CanActivateFn = () => {
  const router = inject(Router);
  return inject(CurrentUserService)
    .getMe()
    .pipe(
      map((me) => (me.isPlatformAdmin ? true : router.createUrlTree(['/gis']))),
      catchError(() => of(router.createUrlTree(['/gis']))),
    );
};

/** `/start` — where sign-in lands: platform admins go to the Admin page,
 *  everyone else to the map. (Never blocks: on error it goes to the map.) */
export const startPageGuard: CanActivateFn = () => {
  const router = inject(Router);
  return inject(CurrentUserService)
    .getMe()
    .pipe(
      map((me) => router.createUrlTree([me.isPlatformAdmin ? '/admin' : '/gis'])),
      catchError(() => of(router.createUrlTree(['/gis']))),
    );
};

/** Map screens (/gis, /collect): admin accounts have no map workspace, so
 *  they are sent to the Admin page instead. */
export const notPlatformAdminGuard: CanActivateFn = () => {
  const router = inject(Router);
  return inject(CurrentUserService)
    .getMe()
    .pipe(
      map((me) => (me.isPlatformAdmin ? router.createUrlTree(['/admin']) : true)),
      catchError(() => of(true)),
    );
};
