import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { TagModule } from 'primeng/tag';
import { MessageModule } from 'primeng/message';
import { PrimeTemplate } from 'primeng/api';
import { SiteHeaderComponent } from '../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../shared/components/site-footer/site-footer.component';
import { DepartmentService } from '../../core/services/department.service';
import { CurrentUserService } from '../../core/services/current-user.service';
import { Department } from '../../core/models/department.model';

@Component({
  selector: 'app-departments',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    ButtonModule,
    TableModule,
    DialogModule,
    InputTextModule,
    TextareaModule,
    TagModule,
    MessageModule,
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

  readonly departments = signal<Department[]>([]);
  readonly loading = signal(true);
  readonly isOwner = signal(false);
  readonly pageError = signal<string | null>(null);

  readonly dialogVisible = signal(false);
  readonly editingDepartment = signal<Department | null>(null);
  readonly formSubmitting = signal(false);
  readonly formError = signal<string | null>(null);

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
    this.departmentService.list().subscribe({
      next: (departments) => {
        this.departments.set(departments);
        this.loading.set(false);
      },
      error: () => {
        this.pageError.set('Could not load departments. Please try again.');
        this.loading.set(false);
      }
    });
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
        this.loadDepartments();
      },
      error: (error: HttpErrorResponse) => {
        this.formSubmitting.set(false);
        this.formError.set(this.resolveErrorMessage(error));
      }
    });
  }

  toggleStatus(department: Department): void {
    const nextStatus = department.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    this.pageError.set(null);
    this.departmentService.update(department.id, { status: nextStatus }).subscribe({
      next: () => this.loadDepartments(),
      error: (error: HttpErrorResponse) => this.pageError.set(this.resolveErrorMessage(error))
    });
  }

  deleteDepartment(department: Department): void {
    if (!confirm(`Delete "${department.name}"? This cannot be undone.`)) {
      return;
    }
    this.pageError.set(null);
    this.departmentService.remove(department.id).subscribe({
      next: () => this.loadDepartments(),
      error: (error: HttpErrorResponse) => this.pageError.set(this.resolveErrorMessage(error))
    });
  }

  viewUsers(department: Department): void {
    this.router.navigate(['/users'], { queryParams: { departmentId: department.id } });
  }

  private resolveErrorMessage(error: HttpErrorResponse): string {
    return error.error?.message ?? 'Something went wrong. Please try again.';
  }
}
