import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { SiteHeaderComponent } from '../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../shared/components/site-footer/site-footer.component';
import { CurrentUserService } from '../../core/services/current-user.service';
import { NotificationService } from '../../core/services/notification.service';
import { GisDashboardService } from '../../core/services/gis-dashboard.service';
import { RasterPin, RasterService } from '../gis/services/raster.service';
import { CurrentUser } from '../../core/models/current-user.model';
import { GisDashboardSummary, GisDepartmentSummary } from '../../core/models/gis-dashboard.model';

const SYSTEM_ROLE_LABELS: Record<CurrentUser['systemRole'], string> = {
  MUNICIPALITY_OWNER: 'Municipality Owner',
  DEPARTMENT_HEAD: 'Department Head',
  DEPARTMENT_USER: 'Department User'
};

@Component({
  selector: 'app-dashboard-placeholder',
  standalone: true,
  imports: [RouterLink, ButtonModule, SiteHeaderComponent, SiteFooterComponent],
  templateUrl: './dashboard-placeholder.component.html',
  styleUrl: './dashboard-placeholder.component.scss'
})
export class DashboardPlaceholderComponent {
  private readonly currentUserService = inject(CurrentUserService);
  private readonly notify = inject(NotificationService);
  private readonly gisDashboardService = inject(GisDashboardService);
  private readonly rasterService = inject(RasterService);

  /** Raster Analysis → Dashboard Pins: result numbers people pinned from
   *  the map. Empty (card hidden) when there are none or on any error. */
  readonly pins = signal<RasterPin[]>([]);

  /** Populated from GET /api/me — the authenticated application user and
   *  their municipality, resolved server-side from the Keycloak token.
   *  Never derived from Keycloak token claims alone. */
  readonly currentUser = signal<CurrentUser | null>(null);
  readonly loading = signal(true);
  readonly notRegistered = signal(false);
  readonly errorMessage = signal<string | null>(null);

  /** Task 9 §1: GIS summary cards — municipality-scoped and already
   *  permission-filtered by the backend (GisDashboardService never
   *  replicates that logic client-side). Left null on failure so the rest
   *  of the dashboard still renders (non-fatal, same pattern as the
   *  department/user counts above). */
  readonly gisSummary = signal<GisDashboardSummary | null>(null);
  readonly gisSummaryLoading = signal(true);

  /** Task 9 §2: per-department GIS layer counts, clickable through to the
   *  map filtered to that department's authorized layers. Rendered as a
   *  small bar-list (name + relative bar) rather than a plain list so a
   *  municipality with many departments reads as a chart, not a wall of
   *  rows — see barWidthPercent(). */
  readonly departmentSummaries = signal<GisDepartmentSummary[]>([]);
  readonly departmentSummariesLoading = signal(true);

  /** Highest layer count among the visible departments — the denominator
   *  for each bar's relative width. Floored at 1 so an all-zero summary
   *  (a brand-new municipality) never divides by zero. */
  private readonly maxDepartmentLayerCount = computed(() =>
    Math.max(1, ...this.departmentSummaries().map((d) => d.layerCount))
  );

  removePin(pin: RasterPin): void {
    this.rasterService.deletePin(pin.id).subscribe({
      next: () => this.pins.update((list) => list.filter((p) => p.id !== pin.id)),
      error: () => this.notify.error('Could not remove the highlight. Please try again.')
    });
  }

  constructor() {
    this.rasterService.pins().subscribe({ next: (list) => this.pins.set(list), error: () => this.pins.set([]) });
    this.currentUserService.getMe().subscribe({
      next: (user) => {
        this.currentUser.set(user);
        this.loading.set(false);
      },
      error: (error: HttpErrorResponse) => {
        this.loading.set(false);
        if (error.status === 404) {
          this.notRegistered.set(true);
          return;
        }
        this.errorMessage.set('We could not load your municipality details. Please try again.');
      }
    });

    this.gisDashboardService.getSummary().subscribe({
      next: (summary) => {
        this.gisSummary.set(summary);
        this.gisSummaryLoading.set(false);
      },
      error: () => this.gisSummaryLoading.set(false)
    });

    this.gisDashboardService.getDepartments().subscribe({
      next: (departments) => {
        this.departmentSummaries.set(departments);
        this.departmentSummariesLoading.set(false);
      },
      error: () => this.departmentSummariesLoading.set(false)
    });
  }

  roleLabel(role: CurrentUser['systemRole']): string {
    return SYSTEM_ROLE_LABELS[role] ?? role;
  }

  /** Bar width for one department's row, relative to the busiest
   *  department. A department with 0 layers still gets a thin visible
   *  stub (4%) so its bar reads as "zero", not as a rendering glitch. */
  barWidthPercent(layerCount: number): number {
    if (layerCount <= 0) {
      return 4;
    }
    return Math.max(6, Math.round((layerCount / this.maxDepartmentLayerCount()) * 100));
  }
}
