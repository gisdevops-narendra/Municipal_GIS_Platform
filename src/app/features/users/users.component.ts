import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { MessageModule } from 'primeng/message';
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
    SelectModule,
    TagModule,
    MessageModule,
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
  readonly pageError = signal<string | null>(null);

  readonly searchTerm = signal('');
  readonly departmentFilter = signal<string | null>(null);
  readonly statusFilter = signal<MunicipalityUserStatus | null>(null);

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

  readonly dialogVisible = signal(false);
  readonly editingUser = signal<MunicipalityUser | null>(null);
  readonly formSubmitting = signal(false);
  readonly formError = signal<string | null>(null);
  /** Set once, right after a successful create — shown to the Owner so
   *  they can share it with the new user. There is no email/invite
   *  delivery in this task's scope. Cleared as soon as the dialog closes. */
  readonly createdTemporaryPassword = signal<string | null>(null);

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
      next: (user) => this.isOwner.set(user.systemRole === 'MUNICIPALITY_OWNER'),
      error: () => this.isOwner.set(false)
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

  get departmentFormOptions(): { label: string; value: string }[] {
    return this.departments().map((d) => ({ label: d.name, value: d.id }));
  }

  loadUsers(): void {
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
          this.users.set(users);
          this.loading.set(false);
        },
        error: () => {
          this.pageError.set('Could not load users. Please try again.');
          this.loading.set(false);
        }
      });
  }

  onSearchChange(value: string): void {
    this.searchTerm.set(value);
    this.loadUsers();
  }

  onDepartmentFilterChange(value: string | null): void {
    this.departmentFilter.set(value);
    this.loadUsers();
  }

  onStatusFilterChange(value: MunicipalityUserStatus | null): void {
    this.statusFilter.set(value);
    this.loadUsers();
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
    const shouldRefresh = this.editingUser() !== null || this.createdTemporaryPassword() !== null;
    this.dialogVisible.set(false);
    this.createdTemporaryPassword.set(null);
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
    const nextStatus: MunicipalityUserStatus = user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    const apply = () => {
      this.userService.updateStatus(user.id, nextStatus).subscribe({
        next: () => {
          this.notify.success(
            `${user.fullName} was ${nextStatus === 'ACTIVE' ? 'reactivated' : 'deactivated'}.`
          );
          this.loadUsers();
        },
        error: (error: HttpErrorResponse) => this.notify.error(this.resolveErrorMessage(error))
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

  private resolveErrorMessage(error: HttpErrorResponse): string {
    return error.error?.message ?? 'Something went wrong. Please try again.';
  }
}
