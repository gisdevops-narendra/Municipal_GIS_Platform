import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule, CheckboxChangeEvent } from 'primeng/checkbox';
import { SelectModule } from 'primeng/select';
import { MessageModule } from 'primeng/message';
import { TooltipModule } from 'primeng/tooltip';
import { FormsModule } from '@angular/forms';
import { SiteHeaderComponent } from '../../../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../../../shared/components/site-footer/site-footer.component';
import { GisLayersService } from '../../../../core/services/gis-layers.service';
import { CurrentUserService } from '../../../../core/services/current-user.service';
import { DepartmentService } from '../../../../core/services/department.service';
import { CurrentUser } from '../../../../core/models/current-user.model';
import { Department } from '../../../../core/models/department.model';
import {
  GIS_PERMISSIONS,
  GisLayerPermissionMatrix,
  GisPermission
} from '../../../../core/models/gis-layer-permission.model';
import { ManagedRole } from '../../../../core/models/municipality-user.model';

const ROLES: ManagedRole[] = ['DEPARTMENT_HEAD', 'DEPARTMENT_USER'];
const ROLE_LABELS: Record<ManagedRole, string> = {
  DEPARTMENT_HEAD: 'Department Head',
  DEPARTMENT_USER: 'Department User'
};

/** One row the template iterates, department-scoped — mirrors the
 *  backend's GisLayerPermissionGrant shape but is locally mutable so a
 *  newly picked "grant another department" section can render before any
 *  row actually exists server-side yet (Task 8 §5). */
interface DepartmentSection {
  departmentId: string;
  departmentName: string;
  grants: Record<ManagedRole, GisPermission[]>;
}

/**
 * Permission management screen (Task 8 §7): /gis/layers/:id/permissions.
 * Only reachable in practice by whoever has MANAGE on this layer — the
 * Owner unconditionally, or a Department Head/User explicitly granted
 * MANAGE beyond the §4 defaults. Enforced server-side (GET/PUT both
 * 403 without it); this page just surfaces that 403 as a clear message
 * rather than guessing client-side who should see the link (see
 * GisLayersComponent's own comment on the same tradeoff).
 */
@Component({
  selector: 'app-gis-layer-permissions',
  standalone: true,
  imports: [
    FormsModule,
    ButtonModule,
    CheckboxModule,
    SelectModule,
    MessageModule,
    TooltipModule,
    SiteHeaderComponent,
    SiteFooterComponent
  ],
  templateUrl: './gis-layer-permissions.component.html',
  styleUrl: './gis-layer-permissions.component.scss'
})
export class GisLayerPermissionsComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly gisLayersService = inject(GisLayersService);
  private readonly currentUserService = inject(CurrentUserService);
  private readonly departmentService = inject(DepartmentService);

  readonly layerId = this.route.snapshot.paramMap.get('id')!;
  readonly currentUser = signal<CurrentUser | null>(null);
  readonly matrix = signal<GisLayerPermissionMatrix | null>(null);
  readonly sections = signal<DepartmentSection[]>([]);
  readonly allDepartments = signal<Department[]>([]);
  readonly loading = signal(true);
  readonly forbidden = signal(false);
  readonly pageError = signal<string | null>(null);
  readonly saving = signal<string | null>(null);
  readonly addDepartmentId = signal<string | null>(null);

  readonly permissions = GIS_PERMISSIONS;
  readonly roles = ROLES;
  readonly roleLabels = ROLE_LABELS;

  constructor() {
    this.currentUserService.getMe().subscribe({ next: (user) => this.currentUser.set(user) });
    this.departmentService.list().subscribe({
      next: (departments) => this.allDepartments.set(departments.filter((d) => d.status === 'ACTIVE'))
    });
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.pageError.set(null);
    this.forbidden.set(false);
    this.gisLayersService.getPermissions(this.layerId).subscribe({
      next: (matrix) => {
        this.matrix.set(matrix);
        this.sections.set(
          matrix.grants.map((g) => ({ departmentId: g.departmentId, departmentName: g.departmentName, grants: g.grants }))
        );
        this.loading.set(false);
      },
      error: (error: HttpErrorResponse) => {
        this.loading.set(false);
        if (error.status === 403) {
          this.forbidden.set(true);
          return;
        }
        this.pageError.set('Could not load permissions for this layer.');
      }
    });
  }

  /** Departments not already shown as a section — candidates for "grant
   *  another department" (Task 8 §5). */
  get grantableDepartments(): { label: string; value: string }[] {
    const shown = new Set(this.sections().map((s) => s.departmentId));
    return this.allDepartments()
      .filter((d) => !shown.has(d.id))
      .map((d) => ({ label: d.name, value: d.id }));
  }

  addDepartmentSection(): void {
    const departmentId = this.addDepartmentId();
    const department = this.allDepartments().find((d) => d.id === departmentId);
    if (!department) return;
    this.sections.update((sections) => [
      ...sections,
      {
        departmentId: department.id,
        departmentName: department.name,
        grants: { DEPARTMENT_HEAD: [], DEPARTMENT_USER: [] }
      }
    ]);
    this.addDepartmentId.set(null);
  }

  isChecked(section: DepartmentSection, role: ManagedRole, permission: GisPermission): boolean {
    return section.grants[role].includes(permission);
  }

  /** Never allows the caller to change the cell governing their own
   *  (role, department) — mirrors the backend's self-grant guard so the
   *  checkbox is visibly disabled rather than just failing on click. */
  isSelfCell(section: DepartmentSection, role: ManagedRole): boolean {
    const me = this.currentUser();
    return !!me && me.department?.id === section.departmentId && me.systemRole === role;
  }

  toggle(section: DepartmentSection, role: ManagedRole, permission: GisPermission, event: CheckboxChangeEvent): void {
    const granted = !!event.checked;
    const cellKey = `${section.departmentId}:${role}:${permission}`;
    this.saving.set(cellKey);
    this.pageError.set(null);

    this.gisLayersService.setPermission(this.layerId, section.departmentId, role, permission, granted).subscribe({
      next: (matrix) => {
        this.saving.set(null);
        this.matrix.set(matrix);
        this.sections.set(
          matrix.grants.map((g) => ({ departmentId: g.departmentId, departmentName: g.departmentName, grants: g.grants }))
        );
      },
      error: (error: HttpErrorResponse) => {
        this.saving.set(null);
        this.pageError.set(error.error?.message ?? 'Could not update this permission. Please try again.');
      }
    });
  }

  isSaving(section: DepartmentSection, role: ManagedRole, permission: GisPermission): boolean {
    return this.saving() === `${section.departmentId}:${role}:${permission}`;
  }

  back(): void {
    this.router.navigate(['/gis/layers']);
  }
}
