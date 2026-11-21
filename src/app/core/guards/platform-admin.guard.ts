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
