import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { SiteHeaderComponent } from '../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../shared/components/site-footer/site-footer.component';
import { CurrentUserService } from '../../core/services/current-user.service';
import { DepartmentService } from '../../core/services/department.service';
import { UserManagementService } from '../../core/services/user-management.service';
import { GisDashboardService } from '../../core/services/gis-dashboard.service';
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
  private readonly departmentService = inject(DepartmentService);
  private readonly userManagementService = inject(UserManagementService);
  private readonly gisDashboardService = inject(GisDashboardService);

  /** Populated from GET /api/me — the authenticated application user and
   *  their municipality, resolved server-side from the Keycloak token.
   *  Never derived from Keycloak token claims alone. */
  readonly currentUser = signal<CurrentUser | null>(null);
  readonly loading = signal(true);
  readonly notRegistered = signal(false);
  readonly errorMessage = signal<string | null>(null);

  /** Simple organization counts from the real backend APIs — no analytics,
   *  no charts, just counts. Left as null if they fail to load (non-fatal:
   *  the rest of the dashboard still renders). */
  readonly departmentCount = signal<number | null>(null);
  readonly userCount = signal<number | null>(null);

  /** Task 9 §1: GIS summary cards — municipality-scoped and already
   *  permission-filtered by the backend (GisDashboardService never
   *  replicates that logic client-side). Left null on failure so the rest
   *  of the dashboard still renders (non-fatal, same pattern as the
   *  department/user counts above). */
  readonly gisSummary = signal<GisDashboardSummary | null>(null);
  readonly gisSummaryLoading = signal(true);

  /** Task 9 §2: per-department GIS layer counts, clickable through to the
   *  map filtered to that department's authorized layers. */
  readonly departmentSummaries = signal<GisDepartmentSummary[]>([]);
  readonly departmentSummariesLoading = signal(true);

  constructor() {
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

    this.departmentService.list().subscribe({ next: (departments) => this.departmentCount.set(departments.length) });
    this.userManagementService.list().subscribe({ next: (users) => this.userCount.set(users.length) });

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
}
