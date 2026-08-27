import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { RegistrationStateService } from '../services/registration-state.service';

/** Prevents jumping straight to /register/review before Step 1 and Step 2
 *  have been filled in. This is UX flow protection for the mock wizard —
 *  not a security boundary (that will live server-side later). */
export const reviewStepGuard: CanActivateFn = () => {
  const state = inject(RegistrationStateService);
  const router = inject(Router);

  if (state.isStep1Complete() && state.isStep2Complete()) {
    return true;
  }
  return router.createUrlTree(['/register/municipality']);
};

/** Prevents landing on /register/success without having submitted the form. */
export const successStepGuard: CanActivateFn = () => {
  const state = inject(RegistrationStateService);
  const router = inject(Router);

  if (state.submitted()) {
    return true;
  }
  return router.createUrlTree(['/register/municipality']);
};
