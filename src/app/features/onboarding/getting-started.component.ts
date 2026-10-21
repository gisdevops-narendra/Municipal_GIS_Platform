import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { map } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { ProgressBarModule } from 'primeng/progressbar';
import { TagModule } from 'primeng/tag';
import { SiteHeaderComponent } from '../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../shared/components/site-footer/site-footer.component';
import { OnboardingService } from '../../core/services/onboarding.service';
import { GisWorkspaceService } from '../../core/services/gis-workspace.service';
import { CurrentUserService } from '../../core/services/current-user.service';
import { NotificationService } from '../../core/services/notification.service';
import {
  ONBOARDING_GUIDE,
  OnboardingRequirement,
  OnboardingStepGuide,
  onboardingGuide
} from '../../core/models/onboarding.model';

type StepState = 'done' | 'current' | 'locked' | 'open';

/** Every menu, what it is for — the "map of the platform" panel. */
const MENU_TOUR: { menu: string; icon: string; text: string }[] = [
  { menu: 'Departments', icon: 'pi pi-sitemap', text: 'Municipal departments that own GIS data and group users.' },
  { menu: 'Users', icon: 'pi pi-users', text: 'People who sign in, their role and their department.' },
  { menu: 'GIS Layers', icon: 'pi pi-clone', text: 'Upload, review and publish map data; style layers and set who may see them.' },
  { menu: 'Module Access', icon: 'pi pi-th-large', text: 'Which map tools and modules each role and department may use.' },
  { menu: 'Municipal GIS', icon: 'pi pi-map', text: 'The interactive map: view, query, measure, analyse, print and export.' },
  { menu: 'Dashboard', icon: 'pi pi-chart-bar', text: 'Summary counts of layers, uploads and departments.' },
  { menu: 'Settings', icon: 'pi pi-cog', text: 'Your profile and personal preferences (map defaults, units, theme…).' }
];

/**
 * Getting Started — the Owner's setup checklist for a newly registered
 * municipality. Each step explains what to configure and which menu does
 * it; menus stay locked (see OnboardingService/onboardingGuard) until the
 * steps before them are done, and the Municipal GIS map unlocks once every
 * mandatory step is complete.
 */
@Component({
  selector: 'app-getting-started',
  standalone: true,
  imports: [RouterLink, ButtonModule, MessageModule, ProgressBarModule, TagModule, SiteHeaderComponent, SiteFooterComponent],
  templateUrl: './getting-started.component.html',
  styleUrl: './getting-started.component.scss'
})
export class GettingStartedComponent {
  readonly onboarding = inject(OnboardingService);
  private readonly workspaceService = inject(GisWorkspaceService);
  private readonly notify = inject(NotificationService);
  private readonly router = inject(Router);

  readonly guide = ONBOARDING_GUIDE;
  readonly menuTour = MENU_TOUR;
  readonly municipalityName = signal<string>('');
  readonly loadError = signal<string | null>(null);
  readonly busy = signal<string | null>(null);

  /** `?locked=<step>` — the screen the Owner tried to open too early. */
  private readonly locked = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((p) => p.get('locked') as OnboardingRequirement | null))
  );

  readonly lockedMessage = computed(() => {
    const locked = this.locked();
    const status = this.onboarding.status();
    if (!locked || !status) return null;
    const blocker = this.onboarding.blockingStep(locked);
    if (!blocker) return null;
    const target =
      locked === 'complete' ? 'The Municipal GIS map and Dashboard' : `The ${onboardingGuide(locked).menu} menu`;
    return `${target} unlock${locked === 'complete' ? '' : 's'} after you finish “${onboardingGuide(blocker).title}”.`;
  });

  readonly progress = computed(() => {
    const total = this.onboarding.mandatorySteps().length;
    return total ? Math.round((this.onboarding.mandatoryDone() / total) * 100) : 0;
  });

  constructor() {
    inject(CurrentUserService)
      .getMe()
      .subscribe({ next: (me) => this.municipalityName.set(me.municipality?.name ?? '') });
    this.reload();
  }

  reload(): void {
    this.loadError.set(null);
    this.onboarding.refresh().subscribe({
      error: () => this.loadError.set('Could not load your setup progress. Please try again.')
    });
  }

  stepNumber(index: number): number {
    return index + 1;
  }

  stepStatus(step: OnboardingStepGuide) {
    return this.onboarding.status()?.steps.find((s) => s.id === step.id) ?? null;
  }

  stepState(step: OnboardingStepGuide): StepState {
    const status = this.stepStatus(step);
    if (status?.done) return 'done';
    if (this.onboarding.isLocked(step.id)) return 'locked';
    return this.onboarding.nextStep() === step.id ? 'current' : 'open';
  }

  blockerTitle(step: OnboardingStepGuide): string {
    const blocker = this.onboarding.blockingStep(step.id);
    return blocker ? onboardingGuide(blocker).title : '';
  }

  retryWorkspace(): void {
    this.busy.set('workspace');
    this.workspaceService.retryProvisioning().subscribe({
      next: () => {
        this.busy.set(null);
        this.reload();
      },
      error: (err: HttpErrorResponse) => {
        this.busy.set(null);
        this.notify.error(err.error?.message ?? 'GeoServer is still unreachable. Try again in a minute.');
      }
    });
  }

  acknowledge(step: OnboardingStepGuide): void {
    this.busy.set(step.id);
    this.onboarding.acknowledge(step.id).subscribe({
      next: () => this.busy.set(null),
      error: () => {
        this.busy.set(null);
        this.notify.error('Could not save. Please try again.');
      }
    });
  }

  /** Hides the guide (setup must be complete) and opens the map. */
  finish(): void {
    this.busy.set('finish');
    this.onboarding.setDismissed(true).subscribe({
      next: () => {
        this.busy.set(null);
        this.router.navigateByUrl('/gis');
      },
      error: () => {
        this.busy.set(null);
        this.notify.error('Could not save. Please try again.');
      }
    });
  }

  showGuideAgain(): void {
    this.onboarding.setDismissed(false).subscribe();
  }
}
