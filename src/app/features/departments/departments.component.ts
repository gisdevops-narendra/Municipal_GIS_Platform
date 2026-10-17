import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { PaginatorModule, PaginatorState } from 'primeng/paginator';
import { TextareaModule } from 'primeng/textarea';
import { TagModule } from 'primeng/tag';
import { MessageModule } from 'primeng/message';
import { TooltipModule } from 'primeng/tooltip';
import { PrimeTemplate } from 'primeng/api';
import { SiteHeaderComponent } from '../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../shared/components/site-footer/site-footer.component';
import { DepartmentService } from '../../core/services/department.service';
import { CurrentUserService } from '../../core/services/current-user.service';
import { NotificationService } from '../../core/services/notification.service';
import { Department } from '../../core/models/department.model';

@Component({
  selector: 'app-departments',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    FormsModule,
    ButtonModule,
    TableModule,
    DialogModule,
    InputTextModule,
    PaginatorModule,
    TextareaModule,
    TagModule,
    MessageModule,
    TooltipModule,
    PrimeTemplate,
    SiteHeaderComponent,
    SiteFooterComponent
  ],
  templateUrl: './departments.component.html',
  styleUrl: './departments.component.scss'
})
export class DepartmentsComponent {
  private readonly departmentService = inject(DepartmentService);
  private readonly currentUserService = inject(CurrentUserService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly notify = inject(NotificationService);

  readonly departments = signal<Department[]>([]);
  readonly loading = signal(true);
  readonly isOwner = signal(false);
  readonly pageError = signal<string | null>(null);

  /** Client-side search over the already-fetched (department-scoped)
   *  list — the backend has no search param for departments and a
   *  municipality's department count is small enough that filtering the
   *  in-memory list is simpler than adding one. */
  readonly searchTerm = signal('');
  readonly filteredDepartments = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const all = this.departments();
    if (!term) {
      return all;
    }
    return all.filter(
      (d) => d.name.toLowerCase().includes(term) || d.code.toLowerCase().includes(term)
    );
  });

  /** Pagination is purely client-side over filteredDepartments — the
   *  full list is already small (fetched once) and reused as reference
   *  data elsewhere (dropdowns), so there is no separate paginated
   *  endpoint to call. */
  readonly first = signal(0);
  readonly pageSize = signal(10);
  readonly pageSizes = [10, 25, 50];
  readonly pagedDepartments = computed(() =>
    this.filteredDepartments().slice(this.first(), this.first() + this.pageSize())
  );

  /** At-a-glance summary tiles above the table — turns the otherwise-empty
   *  space above a short list into real context instead of dead air, and
   *  always reflects the full department-scoped list (never the search
   *  filter), so the numbers don't shift as someone types a query. */
  readonly totalDepartments = computed(() => this.departments().length);
  readonly activeDepartmentCount = computed(
    () => this.departments().filter((d) => d.status === 'ACTIVE').length
  );
  readonly inactiveDepartmentCount = computed(
    () => this.totalDepartments() - this.activeDepartmentCount()
  );
  readonly totalAssignedUsers = computed(() =>
    this.departments().reduce((sum, d) => sum + d.userCount, 0)
  );

  readonly dialogVisible = signal(false);
  readonly editingDepartment = signal<Department | null>(null);
  readonly formSubmitting = signal(false);
  readonly formError = signal<string | null>(null);
  /** Department whose status toggle is in flight (blocks double clicks). */
  readonly togglingId = signal<string | null>(null);

  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(150)]],
    code: ['', [Validators.required, Validators.pattern(/^[A-Za-z0-9_-]{2,30}$/)]],
    description: ['', [Validators.maxLength(500)]]
  });

  constructor() {
    this.currentUserService.getMe().subscribe({
      next: (user) => this.isOwner.set(user.systemRole === 'MUNICIPALITY_OWNER'),
      error: () => this.isOwner.set(false)
    });
    this.loadDepartments();
  }

  get f() {
    return this.form.controls;
  }

  loadDepartments(): void {
    this.loading.set(true);
    this.pageError.set(null);
    this.departmentService.list().subscribe({
      next: (departments) => {
        this.departments.set(departments);
        this.clampFirst(this.filteredDepartments().length);
        this.loading.set(false);
      },
      error: () => {
        this.pageError.set('Could not load departments. Please try again.');
        this.loading.set(false);
      }
    });
  }

  onSearchChange(value: string): void {
    this.searchTerm.set(value);
    this.first.set(0);
  }

  onPageChange(event: PaginatorState): void {
    this.first.set(event.first ?? 0);
    if (event.rows) {
      this.pageSize.set(event.rows);
    }
  }

  /** Keeps the current page in range after the underlying list shrinks
   *  (e.g. deleting the last department on the last page) — never leaves
   *  the paginator pointing at a page that no longer exists. */
  private clampFirst(total: number): void {
    if (total === 0) {
      this.first.set(0);
      return;
    }
    const lastPageFirst = Math.floor((total - 1) / this.pageSize()) * this.pageSize();
    if (this.first() > lastPageFirst) {
      this.first.set(lastPageFirst);
    }
  }

  openCreateDialog(): void {
    this.editingDepartment.set(null);
    this.formError.set(null);
    this.form.reset({ name: '', code: '', description: '' });
    this.dialogVisible.set(true);
  }

  openEditDialog(department: Department): void {
    this.editingDepartment.set(department);
    this.formError.set(null);
    this.form.reset({ name: department.name, code: department.code, description: department.description ?? '' });
    this.dialogVisible.set(true);
  }

  closeDialog(): void {
    this.dialogVisible.set(false);
  }

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();
    const request = { name: value.name, code: value.code, description: value.description || undefined };
    this.formSubmitting.set(true);
    this.formError.set(null);

    const editing = this.editingDepartment();
    const save$ = editing ? this.departmentService.update(editing.id, request) : this.departmentService.create(request);

    save$.subscribe({
      next: () => {
        this.formSubmitting.set(false);
        this.dialogVisible.set(false);
        this.notify.success(`"${value.name}" ${editing ? 'updated' : 'created'}.`);
        this.loadDepartments();
      },
      error: (error: HttpErrorResponse) => {
        this.formSubmitting.set(false);
        this.formError.set(this.resolveErrorMessage(error));
      }
    });
  }

  toggleStatus(department: Department): void {
    if (this.togglingId()) return;
    const nextStatus = department.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    this.togglingId.set(department.id);
    this.departmentService.update(department.id, { status: nextStatus }).subscribe({
      next: () => {
        this.togglingId.set(null);
        this.notify.success(
          `"${department.name}" ${nextStatus === 'ACTIVE' ? 'activated' : 'deactivated'}.`
        );
        this.loadDepartments();
      },
      error: (error: HttpErrorResponse) => {
        this.togglingId.set(null);
        this.notify.error(this.resolveErrorMessage(error));
      }
    });
  }

  deleteDepartment(department: Department): void {
    this.notify.confirmDelete({
      message: `Delete "${department.name}"? This cannot be undone.`,
      accept: () => {
        this.departmentService.remove(department.id).subscribe({
          next: () => {
            this.notify.success(`"${department.name}" was deleted.`);
            this.loadDepartments();
          },
          error: (error: HttpErrorResponse) => this.notify.error(this.resolveErrorMessage(error))
        });
      }
    });
  }

  viewUsers(department: Department): void {
    this.router.navigate(['/users'], { queryParams: { departmentId: department.id } });
  }

  statusLabel(status: Department['status']): string {
    return status === 'ACTIVE' ? 'Active' : 'Inactive';
  }

  /** Nest validation errors arrive as `message: string[]`. */
  private resolveErrorMessage(error: HttpErrorResponse): string {
    const message = error.error?.message;
    if (Array.isArray(message)) return message.join('. ');
    return message ?? 'Something went wrong. Please try again.';
  }
}
