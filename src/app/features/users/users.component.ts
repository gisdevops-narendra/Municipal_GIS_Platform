import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { PaginatorModule, PaginatorState } from 'primeng/paginator';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { MessageModule } from 'primeng/message';
import { TooltipModule } from 'primeng/tooltip';
import { PrimeTemplate } from 'primeng/api';
import { SiteHeaderComponent } from '../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../shared/components/site-footer/site-footer.component';
import { UserManagementService } from '../../core/services/user-management.service';
import { DepartmentService } from '../../core/services/department.service';
import { CurrentUserService } from '../../core/services/current-user.service';
import { NotificationService } from '../../core/services/notification.service';
import { ManagedRole, MunicipalityUser, MunicipalityUserStatus } from '../../core/models/municipality-user.model';
import { Department } from '../../core/models/department.model';
import { CustomValidators } from '../../shared/validators/custom-validators';

interface FilterOption {
  label: string;
  value: string | null;
}

@Component({
  selector: 'app-users',
  standalone: true,
  imports: [
    DatePipe,
    ReactiveFormsModule,
    FormsModule,
    ButtonModule,
    TableModule,
    DialogModule,
    InputTextModule,
    PaginatorModule,
    SelectModule,
    TagModule,
    MessageModule,
    TooltipModule,
    PrimeTemplate,
    SiteHeaderComponent,
    SiteFooterComponent
  ],
  templateUrl: './users.component.html',
  styleUrl: './users.component.scss'
})
export class UsersComponent {
  private readonly userService = inject(UserManagementService);
  private readonly departmentService = inject(DepartmentService);
  private readonly currentUserService = inject(CurrentUserService);
  private readonly route = inject(ActivatedRoute);
  private readonly fb = inject(FormBuilder);
  private readonly notify = inject(NotificationService);

  readonly users = signal<MunicipalityUser[]>([]);
  readonly departments = signal<Department[]>([]);
  readonly loading = signal(true);
  readonly isOwner = signal(false);
  /** A Department Head may delete (but not create/edit/deactivate) a
   *  Department User within their own department — see canDelete(). */
  readonly isDepartmentHead = signal(false);
  readonly currentDepartmentId = signal<string | null>(null);
  readonly pageError = signal<string | null>(null);

  readonly searchTerm = signal('');
  readonly departmentFilter = signal<string | null>(null);
  readonly statusFilter = signal<MunicipalityUserStatus | null>(null);

  /** Pagination is client-side over the already server-filtered list
   *  (search/department/status are applied by the backend in loadUsers) —
   *  the paginator only slices the current filtered result set. */
  readonly first = signal(0);
  readonly pageSize = signal(10);
  readonly pageSizes = [10, 25, 50];
  readonly pagedUsers = computed(() => this.users().slice(this.first(), this.first() + this.pageSize()));

  readonly statusOptions: FilterOption[] = [
    { label: 'All statuses', value: null },
    { label: 'Active', value: 'ACTIVE' },
    { label: 'Disabled', value: 'DISABLED' }
  ];

  /** Task 8: exactly the two roles an Owner may assign — the Owner role
   *  itself is never assignable through this screen. */
  readonly roleOptions: { label: string; value: ManagedRole }[] = [
    { label: 'Department User', value: 'DEPARTMENT_USER' },
    { label: 'Department Head', value: 'DEPARTMENT_HEAD' }
  ];

  /** At-a-glance summary tiles above the table — turns the otherwise-empty
   *  space above a short list into real context instead of dead air.
   *  Reflects the currently active search/department/status filter (the
   *  same set the table below shows), not a separate unfiltered total. */
  readonly totalUsersShown = computed(() => this.users().length);
  readonly activeUsersCount = computed(
    () => this.users().filter((u) => u.status === 'ACTIVE').length
  );
  readonly disabledUsersCount = computed(() => this.totalUsersShown() - this.activeUsersCount());
  readonly departmentHeadCount = computed(
    () => this.users().filter((u) => u.systemRole === 'DEPARTMENT_HEAD').length
  );

  readonly dialogVisible = signal(false);
  readonly editingUser = signal<MunicipalityUser | null>(null);
  readonly formSubmitting = signal(false);
  readonly formError = signal<string | null>(null);
  /** Set once, right after a successful create — shown to the Owner so
   *  they can share it with the new user. There is no email/invite
   *  delivery in this task's scope. Cleared as soon as the dialog closes. */
  readonly createdTemporaryPassword = signal<string | null>(null);
  readonly passwordCopied = signal(false);
  /** User whose status toggle is in flight (blocks double clicks). */
  readonly togglingId = signal<string | null>(null);
  /** Search is debounced, and only the latest request may update the
   *  table — otherwise a slow early response overwrites newer results. */
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private loadSeq = 0;

  readonly form = this.fb.nonNullable.group({
    fullName: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(150)]],
    email: [''],
    mobileNumber: ['', [Validators.required, CustomValidators.indianMobile()]],
    departmentId: [''],
    role: ['DEPARTMENT_USER' as ManagedRole, Validators.required]
  });

  constructor() {
    const initialDepartment = this.route.snapshot.queryParamMap.get('departmentId');
    if (initialDepartment) {
      this.departmentFilter.set(initialDepartment);
    }

    this.currentUserService.getMe().subscribe({
      next: (user) => {
        this.isOwner.set(user.systemRole === 'MUNICIPALITY_OWNER');
        this.isDepartmentHead.set(user.systemRole === 'DEPARTMENT_HEAD');
        this.currentDepartmentId.set(user.department?.id ?? null);
      },
      error: () => {
        this.isOwner.set(false);
        this.isDepartmentHead.set(false);
        this.currentDepartmentId.set(null);
      }
    });
    this.departmentService.list().subscribe({ next: (departments) => this.departments.set(departments) });
    this.loadUsers();
  }

  get f() {
    return this.form.controls;
  }

  get departmentOptions(): FilterOption[] {
    return [{ label: 'All departments', value: null }, ...this.departments().map((d) => ({ label: d.name, value: d.id }))];
  }

  /** Active departments, plus the edited user's current one (even if it
   *  has since been deactivated) so the form never shows a blank value. */
  get departmentFormOptions(): { label: string; value: string }[] {
    const current = this.editingUser()?.department?.id;
    return this.departments()
      .filter((d) => d.status === 'ACTIVE' || d.id === current)
      .map((d) => ({ label: d.name, value: d.id }));
  }

  get hasFilters(): boolean {
    return !!(this.searchTerm() || this.departmentFilter() || this.statusFilter());
  }

  loadUsers(): void {
    const seq = ++this.loadSeq;
    this.loading.set(true);
    this.pageError.set(null);
    this.userService
      .list({
        departmentId: this.departmentFilter() ?? undefined,
        status: this.statusFilter() ?? undefined,
        search: this.searchTerm() || undefined
      })
      .subscribe({
        next: (users) => {
          if (seq !== this.loadSeq) return;
          this.users.set(users);
          this.clampFirst(users.length);
          this.loading.set(false);
        },
        error: () => {
          if (seq !== this.loadSeq) return;
          this.pageError.set('Could not load users. Please try again.');
          this.loading.set(false);
        }
      });
  }

  onSearchChange(value: string): void {
    this.searchTerm.set(value);
    this.first.set(0);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.loadUsers(), 300);
  }

  onDepartmentFilterChange(value: string | null): void {
    this.departmentFilter.set(value);
    this.first.set(0);
    this.loadUsers();
  }

  onStatusFilterChange(value: MunicipalityUserStatus | null): void {
    this.statusFilter.set(value);
    this.first.set(0);
    this.loadUsers();
  }

  onPageChange(event: PaginatorState): void {
    this.first.set(event.first ?? 0);
    if (event.rows) {
      this.pageSize.set(event.rows);
    }
  }

  /** Keeps the current page in range after the underlying list shrinks
   *  (e.g. deleting the last user on the last page) — never leaves the
   *  paginator pointing at a page that no longer exists. */
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
    this.editingUser.set(null);
    this.createdTemporaryPassword.set(null);
    this.formError.set(null);
    this.form.reset({ fullName: '', email: '', mobileNumber: '', departmentId: '', role: 'DEPARTMENT_USER' });
    this.f.email.setValidators([Validators.required, Validators.email]);
    this.f.email.updateValueAndValidity();
    this.dialogVisible.set(true);
  }

  openEditDialog(user: MunicipalityUser): void {
    this.editingUser.set(user);
    this.createdTemporaryPassword.set(null);
    this.formError.set(null);
    this.form.reset({
      fullName: user.fullName,
      email: user.email,
      mobileNumber: user.mobileNumber,
      departmentId: user.department?.id ?? '',
      role: user.systemRole === 'DEPARTMENT_HEAD' ? 'DEPARTMENT_HEAD' : 'DEPARTMENT_USER'
    });
    this.f.email.clearValidators();
    this.f.email.updateValueAndValidity();
    this.dialogVisible.set(true);
  }

  closeDialog(): void {
    // Only a create leaves unseen changes (edits reload on save).
    const shouldRefresh = this.createdTemporaryPassword() !== null;
    this.dialogVisible.set(false);
    this.createdTemporaryPassword.set(null);
    this.passwordCopied.set(false);
    if (shouldRefresh) {
      this.loadUsers();
    }
  }

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();
    this.formSubmitting.set(true);
    this.formError.set(null);

    const editing = this.editingUser();
    if (editing) {
      this.userService
        .update(editing.id, {
          fullName: value.fullName,
          mobileNumber: value.mobileNumber,
          departmentId: value.departmentId || null,
          role: value.role
        })
        .subscribe({
          next: () => {
            this.formSubmitting.set(false);
            this.dialogVisible.set(false);
            this.notify.success(`${value.fullName} updated.`);
            this.loadUsers();
          },
          error: (error: HttpErrorResponse) => {
            this.formSubmitting.set(false);
            this.formError.set(this.resolveErrorMessage(error));
          }
        });
      return;
    }

    this.userService
      .create({
        fullName: value.fullName,
        email: value.email,
        mobileNumber: value.mobileNumber,
        departmentId: value.departmentId || undefined,
        role: value.role
      })
      .subscribe({
        next: (result) => {
          this.formSubmitting.set(false);
          this.createdTemporaryPassword.set(result.temporaryPassword);
        },
        error: (error: HttpErrorResponse) => {
          this.formSubmitting.set(false);
          this.formError.set(this.resolveErrorMessage(error));
        }
      });
  }

  toggleStatus(user: MunicipalityUser): void {
    if (this.togglingId()) return;
    const nextStatus: MunicipalityUserStatus = user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    const apply = () => {
      this.togglingId.set(user.id);
      this.userService.updateStatus(user.id, nextStatus).subscribe({
        next: () => {
          this.togglingId.set(null);
          this.notify.success(
            `${user.fullName} was ${nextStatus === 'ACTIVE' ? 'reactivated' : 'deactivated'}.`
          );
          this.loadUsers();
        },
        error: (error: HttpErrorResponse) => {
          this.togglingId.set(null);
          this.notify.error(this.resolveErrorMessage(error));
        }
      });
    };

    if (nextStatus === 'ACTIVE') {
      apply();
      return;
    }

    this.notify.confirm({
      header: 'Deactivate user',
      message: `Deactivate ${user.fullName}? They will immediately lose access to the application.`,
      confirmLabel: 'Deactivate',
      destructive: true,
      accept: apply
    });
  }

  /** Mirrors the server-side rule in UsersService.deleteUser: the Owner
   *  may delete anyone but the Owner; a Department Head may only delete a
   *  Department User within their own department. Client-side only for
   *  UI gating — the backend re-enforces this regardless. */
  canDelete(user: MunicipalityUser): boolean {
    if (user.systemRole === 'MUNICIPALITY_OWNER') {
      return false;
    }
    if (this.isOwner()) {
      return true;
    }
    return (
      this.isDepartmentHead() &&
      user.systemRole === 'DEPARTMENT_USER' &&
      user.department?.id === this.currentDepartmentId()
    );
  }

  deleteUser(user: MunicipalityUser): void {
    this.notify.confirmDelete({
      message: `Delete ${user.fullName}? This permanently removes their account and cannot be undone.`,
      accept: () => {
        this.userService.remove(user.id).subscribe({
          next: () => {
            this.notify.success(`${user.fullName} was deleted.`);
            this.loadUsers();
          },
          error: (error: HttpErrorResponse) => this.notify.error(this.resolveErrorMessage(error))
        });
      }
    });
  }

  copyTemporaryPassword(password: string): void {
    navigator.clipboard?.writeText(password).then(
      () => this.passwordCopied.set(true),
      () => this.notify.error('Could not copy — select the password and copy it manually.')
    );
  }

  /** Nest validation errors arrive as `message: string[]`. */
  private resolveErrorMessage(error: HttpErrorResponse): string {
    const message = error.error?.message;
    if (Array.isArray(message)) return message.join('. ');
    return message ?? 'Something went wrong. Please try again.';
  }
}
