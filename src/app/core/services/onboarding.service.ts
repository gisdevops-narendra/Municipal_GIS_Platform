import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, forkJoin, map, of, tap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { CurrentUser } from '../models/current-user.model';
import {
  OnboardingRequirement,
  OnboardingStatus,
  OnboardingStepId
} from '../models/onboarding.model';
import { CurrentUserService } from './current-user.service';

/** Route prefix → the setup step that screen belongs to. Longest first. */
const ROUTE_STEPS: [string, OnboardingRequirement][] = [
  ['/gis/layers', 'data'],
  ['/departments', 'departments'],
  ['/users', 'users'],
  ['/module-access', 'access'],
  ['/dashboard', 'complete'],
  ['/collect', 'complete'],
  ['/gis', 'complete']
];

/**
 * Getting Started progress (GET /api/onboarding) plus the locking rules the
 * header menu and `onboardingGuard` share. Only the Municipality Owner is
 * guided/locked — Department Heads and Users join an already-configured
 * municipality and are never blocked here.
 *
 * Kept fresh by `onboardingRefreshInterceptor` (after any data change) and
 * by the guard (on every navigation to a guarded screen).
 */
@Injectable({ providedIn: 'root' })
export class OnboardingService {
  private readonly http = inject(HttpClient);
  private readonly currentUserService = inject(CurrentUserService);
  private readonly baseUrl = `${environment.apiUrl}/onboarding`;

  readonly status = signal<OnboardingStatus | null>(null);
  readonly role = signal<CurrentUser['systemRole'] | null>(null);

  /** The Owner of a municipality whose mandatory setup is not finished. */
  readonly guiding = computed(() => this.role() === 'MUNICIPALITY_OWNER' && !!this.status() && !this.status()!.setupComplete);

  /** Show the Getting Started menu/guide bar (Owner, not dismissed). */
  readonly showGuide = computed(() => this.role() === 'MUNICIPALITY_OWNER' && !!this.status() && !this.status()!.dismissed);

  readonly mandatorySteps = computed(() => this.status()?.steps.filter((s) => s.mandatory) ?? []);
  readonly mandatoryDone = computed(() => this.mandatorySteps().filter((s) => s.done).length);

  /** First step not yet done (mandatory first, then optional). */
  readonly nextStep = computed<OnboardingStepId | null>(() => {
    const steps = this.status()?.steps ?? [];
    return (steps.find((s) => s.mandatory && !s.done) ?? steps.find((s) => !s.done))?.id ?? null;
  });

  /** Fetches progress (and, the first time, the caller's role). */
  refresh(): Observable<OnboardingStatus> {
    const role$ = this.role()
      ? of(this.role()!)
      : this.currentUserService.getMe().pipe(map((me) => me.systemRole));
    return forkJoin({ role: role$, status: this.http.get<OnboardingStatus>(this.baseUrl) }).pipe(
      tap(({ role, status }) => {
        this.role.set(role);
        this.status.set(status);
      }),
      map(({ status }) => status)
    );
  }

  acknowledge(step: OnboardingStepId): Observable<OnboardingStatus> {
    return this.http
      .post<OnboardingStatus>(`${this.baseUrl}/steps/${step}/acknowledge`, {})
      .pipe(tap((status) => this.status.set(status)));
  }

  setDismissed(dismissed: boolean): Observable<OnboardingStatus> {
    return this.http
      .patch<OnboardingStatus>(this.baseUrl, { dismissed })
      .pipe(tap((status) => this.status.set(status)));
  }

  isDone(step: OnboardingStepId): boolean {
    return !!this.status()?.steps.find((s) => s.id === step)?.done;
  }

  /** A screen is locked until every mandatory step before it is done. */
  isLocked(requirement: OnboardingRequirement): boolean {
    if (!this.guiding()) return false;
    const steps = this.status()!.steps;
    if (requirement === 'complete') return true;
    const index = steps.findIndex((s) => s.id === requirement);
    return steps.slice(0, index).some((s) => s.mandatory && !s.done);
  }

  /** The step that must be finished before `requirement` unlocks. */
  blockingStep(requirement: OnboardingRequirement): OnboardingStepId | null {
    const steps = this.status()?.steps ?? [];
    const index = requirement === 'complete' ? steps.length : steps.findIndex((s) => s.id === requirement);
    return steps.slice(0, index).find((s) => s.mandatory && !s.done)?.id ?? null;
  }

  /** Which setup step (if any) a URL belongs to. */
  requirementForUrl(url: string): OnboardingRequirement | null {
    const path = url.split(/[?#]/)[0];
    return ROUTE_STEPS.find(([prefix]) => path === prefix || path.startsWith(prefix + '/'))?.[1] ?? null;
  }
}
