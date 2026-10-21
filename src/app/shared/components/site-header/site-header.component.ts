import { Component, Input, computed, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { OnboardingService } from '../../../core/services/onboarding.service';
import {
  ONBOARDING_GUIDE,
  OnboardingRequirement,
  OnboardingStepId,
  onboardingGuide
} from '../../../core/models/onboarding.model';
import { AuthService } from '../../../core/services/auth.service';
import { CurrentUserService } from '../../../core/services/current-user.service';
import { CurrentUser } from '../../../core/models/current-user.model';

const ROLE_LABELS: Record<CurrentUser['systemRole'], string> = {
  MUNICIPALITY_OWNER: 'Municipality Owner',
  DEPARTMENT_HEAD: 'Department Head',
  DEPARTMENT_USER: 'Department User'
};

/** Primary menu, in setup order. `requirement` ties a menu to the Getting
 *  Started step it belongs to (see OnboardingService.isLocked). */
const NAV: { label: string; route: string; requirement: OnboardingRequirement | null; exact?: boolean }[] = [
  { label: 'Departments', route: '/departments', requirement: 'departments' },
  { label: 'Users', route: '/users', requirement: 'users' },
  { label: 'GIS Layers', route: '/gis/layers', requirement: 'data' },
  { label: 'Module Access', route: '/module-access', requirement: 'access' },
  { label: 'Municipal GIS', route: '/gis', requirement: 'complete', exact: true },
  { label: 'Dashboard', route: '/dashboard', requirement: 'complete' }
];

export interface NavItem {
  label: string;
  route: string;
  exact: boolean;
  /** Step number on the Getting Started page; null outside the guide. */
  step: number | null;
  state: 'normal' | 'done' | 'locked';
  /** Tooltip explaining a locked or pending menu. */
  hint: string;
}

interface GuideBar {
  tone: 'todo' | 'done';
  text: string;
  linkLabel: string;
  linkRoute: string;
}

@Component({
  selector: 'app-site-header',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, ButtonModule, TooltipModule],
  templateUrl: './site-header.component.html',
  styleUrl: './site-header.component.scss'
})
export class SiteHeaderComponent {
  /** Hides the account / nav area on screens that already are the login or
   *  registration flow, to avoid redundant navigation. */
  @Input() showActions = true;

  private readonly auth = inject(AuthService);
  private readonly currentUserService = inject(CurrentUserService);
  readonly onboarding = inject(OnboardingService);
  private readonly router = inject(Router);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects)
    ),
    { initialValue: this.router.url }
  );

  readonly isAuthenticated = this.auth.isAuthenticated;
  readonly user = this.auth.user;

  /** Best-effort enrichment of the profile chip (real name + role +
   *  municipality) from GET /api/me. Failure is silent — the chip falls
   *  back to the Keycloak token's name/email. */
  private readonly me = signal<CurrentUser | null>(null);
  private meRequested = false;
  private onboardingRequested = false;

  constructor() {
    effect(() => {
      if (this.isAuthenticated() && !this.meRequested) {
        this.meRequested = true;
        this.currentUserService.getMe().subscribe({
          next: (user) => this.me.set(user),
          error: () => undefined
        });
      }
    });
    // Getting Started progress drives the guided menu below. Guarded
    // routes refresh it themselves; this covers the unguarded ones.
    effect(() => {
      if (this.isAuthenticated() && !this.onboardingRequested) {
        this.onboardingRequested = true;
        this.onboarding.refresh().subscribe({ error: () => undefined });
      }
    });
    // A profile edit (Settings → Profile) updates the chip right away.
    effect(() => {
      const updated = this.currentUserService.updated();
      if (updated) this.me.set(updated);
    });
  }

  readonly displayName = computed(() => {
    const me = this.me();
    if (me?.name) {
      return me.name;
    }
    const token = this.user();
    if (!token) {
      return '';
    }
    const full = [token.firstName, token.lastName].filter(Boolean).join(' ').trim();
    return full || token.username || token.email || '';
  });

  /** A Department User may only view the Municipal GIS map, so they get
   *  just that link (see staffOnlyGuard). Waits for /api/me so the extra
   *  links never flash for them while it loads. */
  readonly showFullNav = computed(() => {
    const me = this.me();
    return !!me && me.systemRole !== 'DEPARTMENT_USER';
  });

  /** The menu, annotated with setup progress while the Owner is guided:
   *  step numbers, a check once a step is done, and a lock (link disabled)
   *  until the steps before it are finished. */
  readonly navItems = computed<NavItem[]>(() => {
    const guided = this.onboarding.showGuide();
    return NAV.map((item) => {
      const req = item.requirement;
      const stepIndex = req && req !== 'complete' ? ONBOARDING_GUIDE.findIndex((g) => g.id === req) : -1;
      const base = { label: item.label, route: item.route, exact: !!item.exact };
      if (!guided || !req) return { ...base, step: null, state: 'normal' as const, hint: '' };
      if (this.onboarding.isLocked(req)) {
        const blocker = this.onboarding.blockingStep(req);
        return {
          ...base,
          step: stepIndex >= 0 ? stepIndex + 1 : null,
          state: 'locked' as const,
          hint: blocker ? `Locked — finish “${onboardingGuide(blocker).title}” first` : 'Locked'
        };
      }
      const done = req !== 'complete' && this.onboarding.isDone(req);
      return {
        ...base,
        step: stepIndex >= 0 ? stepIndex + 1 : null,
        state: done ? ('done' as const) : ('normal' as const),
        hint: req !== 'complete' ? `Step ${stepIndex + 1}: ${onboardingGuide(req).title}` : ''
      };
    });
  });

  /** One-line guide under the menu on each setup screen: what to do here,
   *  or — once done — where to go next. */
  readonly guideBar = computed<GuideBar | null>(() => {
    if (!this.onboarding.showGuide()) return null;
    const url = this.url();
    if (url.startsWith('/setup')) return null;
    const req = this.onboarding.requirementForUrl(url);
    const next = this.onboarding.nextStep();
    const setup = { linkLabel: 'All setup steps', linkRoute: '/setup' };

    if (req && req !== 'complete') {
      const index = ONBOARDING_GUIDE.findIndex((g) => g.id === req);
      const guide = ONBOARDING_GUIDE[index];
      if (!this.onboarding.isDone(req)) {
        return { tone: 'todo', text: `Step ${index + 1} · ${guide.title}: ${guide.hint}`, ...setup };
      }
      const count = this.onboarding.status()?.steps.find((s) => s.id === req)?.count ?? null;
      return { tone: 'done', ...this.nextLink(`${guide.doneLabel(count)}.`, next) };
    }
    if (this.onboarding.guiding()) {
      return {
        tone: 'todo',
        text: `Setup in progress: ${this.onboarding.mandatoryDone()} of ${this.onboarding.mandatorySteps().length} required steps done.`,
        linkLabel: 'Continue setup',
        linkRoute: '/setup'
      };
    }
    return null;
  });

  private nextLink(prefix: string, next: OnboardingStepId | null): Omit<GuideBar, 'tone'> {
    if (next) {
      const guide = onboardingGuide(next);
      return {
        text: `${prefix} Next: ${guide.title}.`,
        linkLabel: guide.route && !this.onboarding.isLocked(next) ? `Go to ${guide.menu}` : 'All setup steps',
        linkRoute: guide.route && !this.onboarding.isLocked(next) ? guide.route : '/setup'
      };
    }
    return { text: `${prefix} Setup is complete — the Municipal GIS map is unlocked.`, linkLabel: 'Finish setup', linkRoute: '/setup' };
  }

  readonly roleLabel = computed(() => {
    const me = this.me();
    return me ? ROLE_LABELS[me.systemRole] : '';
  });

  readonly secondaryLine = computed(() => {
    const me = this.me();
    if (me) {
      return me.municipality?.name ?? this.user()?.email ?? '';
    }
    return this.user()?.email ?? '';
  });

  readonly initials = computed(() => {
    const source = this.displayName().replace(/@.*/, '').trim();
    const parts = source.split(/[\s._-]+/).filter(Boolean);
    const picked = (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2)) || '?';
    return picked.toUpperCase();
  });

  logout(): void {
    this.auth.logout();
  }
}
