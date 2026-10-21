import { HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Subject, debounceTime, switchMap, catchError, EMPTY, tap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { OnboardingService } from '../services/onboarding.service';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

let refresh$: Subject<void> | null = null;

/**
 * Re-checks Getting Started progress after any successful data change
 * (creating a department, adding a user, publishing a layer…), so the
 * menu locks and the guide bar update on the spot without each screen
 * having to know about onboarding. Debounced; only while the Owner is
 * being guided.
 */
export const onboardingRefreshInterceptor: HttpInterceptorFn = (req, next) => {
  const onboarding = inject(OnboardingService);
  if (!refresh$) {
    refresh$ = new Subject<void>();
    refresh$
      .pipe(
        debounceTime(400),
        switchMap(() => onboarding.refresh().pipe(catchError(() => EMPTY)))
      )
      .subscribe();
  }
  const relevant =
    MUTATING.has(req.method) &&
    req.url.startsWith(environment.apiUrl) &&
    !req.url.startsWith(`${environment.apiUrl}/onboarding`);
  return next(req).pipe(
    tap((event) => {
      if (relevant && event instanceof HttpResponse && onboarding.showGuide()) {
        refresh$!.next();
      }
    })
  );
};
