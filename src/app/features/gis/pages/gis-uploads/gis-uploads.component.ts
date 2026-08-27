import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Observable } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { MessageModule } from 'primeng/message';
import { TextareaModule } from 'primeng/textarea';
import { PrimeTemplate } from 'primeng/api';
import { SiteHeaderComponent } from '../../../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../../../shared/components/site-footer/site-footer.component';
import { GisUploadsService } from '../../../../core/services/gis-uploads.service';
import { CurrentUserService } from '../../../../core/services/current-user.service';
import { CurrentUser } from '../../../../core/models/current-user.model';
import { GisUpload } from '../../../../core/models/gis-upload.model';
import { UploadWizardComponent } from '../../components/upload-wizard/upload-wizard.component';

const PAGE_SIZE = 20;

@Component({
  selector: 'app-gis-uploads',
  standalone: true,
  imports: [
    DatePipe,
    FormsModule,
    ButtonModule,
    TableModule,
    DialogModule,
    TagModule,
    MessageModule,
    TextareaModule,
    PrimeTemplate,
    SiteHeaderComponent,
    SiteFooterComponent,
    UploadWizardComponent
  ],
  templateUrl: './gis-uploads.component.html',
  styleUrl: './gis-uploads.component.scss'
})
export class GisUploadsComponent {
  private readonly uploadsService = inject(GisUploadsService);
  private readonly currentUserService = inject(CurrentUserService);

  readonly currentUser = signal<CurrentUser | null>(null);
  readonly uploads = signal<GisUpload[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = PAGE_SIZE;
  readonly loading = signal(true);
  readonly pageError = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);

  readonly wizardVisible = signal(false);
  readonly detailUpload = signal<GisUpload | null>(null);
  readonly rejectTarget = signal<GisUpload | null>(null);
  readonly rejectionReason = signal('');
  readonly actionBusy = signal<string | null>(null);

  constructor() {
    this.currentUserService.getMe().subscribe({ next: (user) => this.currentUser.set(user) });
    this.loadUploads();
  }

  loadUploads(): void {
    this.loading.set(true);
    this.pageError.set(null);
    this.uploadsService.list(this.page(), this.pageSize).subscribe({
      next: (result) => {
        this.uploads.set(result.items);
        this.total.set(result.total);
        this.loading.set(false);
      },
      error: () => {
        this.pageError.set('Could not load uploads. Please try again.');
        this.loading.set(false);
      }
    });
  }

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.total() / this.pageSize));
  }

  nextPage(): void {
    if (this.page() >= this.totalPages) return;
    this.page.update((p) => p + 1);
    this.loadUploads();
  }

  previousPage(): void {
    if (this.page() <= 1) return;
    this.page.update((p) => p - 1);
    this.loadUploads();
  }

  get isOwner(): boolean {
    return this.currentUser()?.systemRole === 'MUNICIPALITY_OWNER';
  }

  isMine(upload: GisUpload): boolean {
    return upload.uploadedById === this.currentUser()?.id;
  }

  canManage(upload: GisUpload): boolean {
    return this.isOwner || this.isMine(upload);
  }

  canValidate(upload: GisUpload): boolean {
    return upload.status === 'FAILED' && this.canManage(upload);
  }

  canSubmitForReview(upload: GisUpload): boolean {
    return upload.status === 'DRAFT' && this.canManage(upload);
  }

  canApproveOrReject(upload: GisUpload): boolean {
    return upload.status === 'IN_REVIEW' && this.isOwner;
  }

  canPublish(upload: GisUpload): boolean {
    return (upload.status === 'APPROVED' || upload.status === 'PUBLISH_FAILED') && this.isOwner;
  }

  statusSeverity(status: GisUpload['status']): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    switch (status) {
      case 'PUBLISHED':
        return 'success';
      case 'DRAFT':
      case 'APPROVED':
        return 'info';
      case 'IN_REVIEW':
      case 'UPLOAD_PENDING':
      case 'VALIDATING':
        return 'warn';
      case 'FAILED':
      case 'PUBLISH_FAILED':
      case 'REJECTED':
        return 'danger';
      default:
        return 'secondary';
    }
  }

  openWizard(): void {
    this.wizardVisible.set(false);
    // Reset then reopen on the next tick isn't needed here — a fresh
    // <app-upload-wizard> instance is created each time via @if, so its
    // own internal state (step, form, selected file) always starts clean.
    this.wizardVisible.set(true);
  }

  onWizardClosed(): void {
    this.wizardVisible.set(false);
  }

  onWizardSubmitted(): void {
    this.wizardVisible.set(false);
    this.page.set(1);
    this.loadUploads();
  }

  viewDetail(upload: GisUpload): void {
    this.detailUpload.set(upload);
  }

  closeDetail(): void {
    this.detailUpload.set(null);
  }

  retryValidate(upload: GisUpload): void {
    this.runAction(upload.id, 'validate', this.uploadsService.validate(upload.id));
  }

  submitForReview(upload: GisUpload): void {
    this.runAction(upload.id, 'submit', this.uploadsService.submitForReview(upload.id));
  }

  approve(upload: GisUpload): void {
    this.runAction(upload.id, 'approve', this.uploadsService.approve(upload.id));
  }

  openRejectDialog(upload: GisUpload): void {
    this.rejectTarget.set(upload);
    this.rejectionReason.set('');
  }

  confirmReject(): void {
    const target = this.rejectTarget();
    if (!target || this.rejectionReason().trim().length < 3) return;
    this.runAction(target.id, 'reject', this.uploadsService.reject(target.id, this.rejectionReason().trim()));
    this.rejectTarget.set(null);
  }

  publish(upload: GisUpload): void {
    this.runAction(upload.id, 'publish', this.uploadsService.publish(upload.id));
  }

  private runAction(uploadId: string, action: string, request: Observable<GisUpload>): void {
    this.actionBusy.set(`${uploadId}:${action}`);
    this.actionError.set(null);
    request.subscribe({
      next: () => {
        this.actionBusy.set(null);
        this.loadUploads();
      },
      error: (error: HttpErrorResponse) => {
        this.actionBusy.set(null);
        this.actionError.set(error.error?.message ?? 'Action failed. Please try again.');
      }
    });
  }

  isBusy(upload: GisUpload, action: string): boolean {
    return this.actionBusy() === `${upload.id}:${action}`;
  }
}
