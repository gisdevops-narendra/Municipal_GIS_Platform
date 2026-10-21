import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of, timeout } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { OnboardingService } from '../services/onboarding.service';
import { OnboardingRequirement } from '../models/onboarding.model';

/**
 * Keeps a municipality's Owner on the Getting Started path: a screen whose
 * setup step is not unlocked yet sends them to /setup (with `?locked=` so
 * that page can explain why). Department Heads/Users always pass.
 *
 * Always re-fetches progress, so a step finished a moment ago (e.g. the
 * first department just created) unlocks the next screen immediately.
 * UI convenience only — the backend still enforces every permission.
 */
export const onboardingGuard =
  (requirement: OnboardingRequirement): CanActivateFn =>
  () => {
    if (!inject(AuthService).isAuthenticatedNow()) {
      return true;
    }
    const router = inject(Router);
    const onboarding = inject(OnboardingService);
    return onboarding.refresh().pipe(
      timeout(8000),
      map(() =>
        onboarding.isLocked(requirement)
          ? router.createUrlTree(['/setup'], { queryParams: { locked: requirement } })
          : true
      ),
      // If progress cannot be loaded, never trap the user — let the page load.
      catchError(() => of(true))
    );
  };

/** /setup is the Owner's checklist — other roles go to the Dashboard. */
export const setupPageGuard: CanActivateFn = () => {
  if (!inject(AuthService).isAuthenticatedNow()) {
    return true;
  }
  const router = inject(Router);
  const onboarding = inject(OnboardingService);
  return onboarding.refresh().pipe(
    timeout(8000),
    map(() => (onboarding.role() === 'MUNICIPALITY_OWNER' ? true : router.createUrlTree(['/dashboard']))),
    catchError(() => of(true))
  );
};
