import { Component, ViewChild, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { EMPTY, Observable, catchError, expand, forkJoin, of, reduce } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { PaginatorModule, PaginatorState } from 'primeng/paginator';
import { TagModule } from 'primeng/tag';
import { MessageModule } from 'primeng/message';
import { TooltipModule } from 'primeng/tooltip';
import { TextareaModule } from 'primeng/textarea';
import { SelectButtonModule } from 'primeng/selectbutton';
import { Menu, MenuModule } from 'primeng/menu';
import { MenuItem, PrimeTemplate } from 'primeng/api';
import { SiteHeaderComponent } from '../../../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../../../shared/components/site-footer/site-footer.component';
import { GisLayersService } from '../../../../core/services/gis-layers.service';
import { GisUploadsService } from '../../../../core/services/gis-uploads.service';
import { CurrentUserService } from '../../../../core/services/current-user.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { CurrentUser } from '../../../../core/models/current-user.model';
import { GisLayer, GisLayerOwnershipType } from '../../../../core/models/gis-layer.model';
import { GisUpload, UploadReviewReport } from '../../../../core/models/gis-upload.model';
import { LAYER_STYLING_MODULE_ID } from '../../../../core/models/module-access.model';
import { ModuleAccessService } from '../../../../core/services/module-access.service';
import { LAYER_EXPORT_FORMATS, LayerExportFormatOption } from '../../../../core/models/layer-export.model';
import { blobErrorMessage, downloadBlob } from '../../../../core/utils/download-blob';
import { StyleGeometry } from '../../../../core/models/layer-style.model';
import { StyleEditorComponent } from '../../components/style-editor/style-editor.component';
import { UploadWizardComponent } from '../../components/upload-wizard/upload-wizard.component';
import { LayerPreviewMapComponent } from '../../components/layer-preview-map/layer-preview-map.component';

/** Uploads are fetched in full (the backend caps a page at 100) so each
 *  layer row can carry its own upload history. */
const UPLOADS_PAGE_SIZE = 100;

/** Statuses with an imported staging table the automated review can read. */
const REVIEWABLE = new Set<GisUpload['status']>(['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISH_FAILED']);

/** Statuses where a person has to do something next (validate, submit,
 *  review or publish) — drives the "Needs action" filter and tile. */
const NEEDS_ACTION = new Set<GisUpload['status']>([
  'DRAFT',
  'IN_REVIEW',
  'APPROVED',
  'PUBLISH_FAILED',
  'FAILED',
  'REJECTED'
]);

const STATUS_LABELS: Record<GisUpload['status'], string> = {
  UPLOAD_PENDING: 'Uploading',
  VALIDATING: 'Validating',
  DRAFT: 'Draft',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  PUBLISHED: 'Published',
  REJECTED: 'Rejected',
  FAILED: 'Failed',
  PUBLISH_FAILED: 'Publish failed'
};

const FORMAT_LABELS: Record<GisUpload['fileFormat'], string> = {
  SHAPEFILE_ZIP: 'Shapefile (ZIP)',
  GEOJSON: 'GeoJSON',
  CSV: 'CSV'
};

type StatusFilter = 'all' | 'published' | 'action';

/** One table row = one layer, keyed by layer code. An upload becomes (or
 *  replaces) the GISLayer with the same code when published, so a row is
 *  either a published layer plus its upload history, or a layer whose
 *  first upload has not been published yet (`layer` is null). */
interface LayerRow {
  code: string;
  name: string;
  ownershipType: GisLayerOwnershipType;
  departmentId: string | null;
  departmentName: string | null;
  layer: GisLayer | null;
  /** Newest first. */
  uploads: GisUpload[];
  /** The newest upload when it is not yet published — the one the
   *  workflow buttons act on. */
  pending: GisUpload | null;
  lastActivity: string | null;
}

/**
 * GIS Layers — one table for both the published layers and the upload
 * workflow (upload → validate → review → publish) that feeds them. The
 * layer list is permission-filtered server-side (GET /api/gis/layers) and
 * the upload list is scoped server-side too (GET /api/gis/uploads).
 *
 * Role checks here are UI hints only; the backend enforces the real
 * MANAGE/EXPORT/APPROVE/PUBLISH permissions.
 */
@Component({
  selector: 'app-gis-layers',
  standalone: true,
  imports: [
    DatePipe,
    FormsModule,
    ButtonModule,
    TableModule,
    DialogModule,
    InputTextModule,
    PaginatorModule,
    TagModule,
    MessageModule,
    TooltipModule,
    TextareaModule,
    SelectButtonModule,
    MenuModule,
    PrimeTemplate,
    SiteHeaderComponent,
    SiteFooterComponent,
    StyleEditorComponent,
    UploadWizardComponent,
    LayerPreviewMapComponent
  ],
  templateUrl: './gis-layers.component.html',
  styleUrl: './gis-layers.component.scss'
})
export class GisLayersComponent {
  private readonly gisLayersService = inject(GisLayersService);
  private readonly uploadsService = inject(GisUploadsService);
  private readonly currentUserService = inject(CurrentUserService);
  private readonly moduleAccessService = inject(ModuleAccessService);
  private readonly router = inject(Router);
  private readonly notify = inject(NotificationService);

  readonly currentUser = signal<CurrentUser | null>(null);
  readonly layers = signal<GisLayer[]>([]);
  readonly uploads = signal<GisUpload[]>([]);
  readonly loading = signal(true);
  /** True once the first load finished — keeps the table mounted while a
   *  later reload (after an action) is in flight. */
  readonly hasLoaded = signal(false);
  readonly pageError = signal<string | null>(null);
  readonly uploadsError = signal<string | null>(null);

  readonly detailRow = signal<LayerRow | null>(null);
  readonly exporting = signal<string | null>(null);
  readonly deleting = signal<string | null>(null);
  readonly styleLayer = signal<GisLayer | null>(null);
  /** Bumped after each live style apply — reloads the preview map image. */
  readonly stylePreviewKey = signal(0);
  private styleChanged = false;

  readonly wizardVisible = signal(false);
  /** Draft upload the wizard continues instead of starting a new one. */
  readonly wizardResume = signal<GisUpload | null>(null);
  readonly detailUpload = signal<GisUpload | null>(null);
  readonly review = signal<UploadReviewReport | null>(null);
  readonly reviewLoading = signal(false);
  readonly reviewError = signal<string | null>(null);
  readonly rejectTarget = signal<GisUpload | null>(null);
  readonly rejectionReason = signal('');
  readonly actionBusy = signal<string | null>(null);

  readonly rows = computed<LayerRow[]>(() => {
    const byCode = new Map<string, GisUpload[]>();
    for (const upload of this.uploads()) {
      const list = byCode.get(upload.layer.code) ?? [];
      list.push(upload);
      byCode.set(upload.layer.code, list);
    }
    for (const list of byCode.values()) {
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    const rows: LayerRow[] = this.layers().map((layer) => {
      const uploads = byCode.get(layer.code) ?? [];
      byCode.delete(layer.code);
      return this.toRow(layer.code, layer, uploads);
    });

    // Layers that exist only as uploads. A PUBLISHED upload with no
    // matching visible layer is a layer this user cannot VIEW — skip it.
    for (const [code, uploads] of byCode) {
      if (uploads[0].status === 'PUBLISHED') continue;
      rows.push(this.toRow(code, null, uploads));
    }

    return rows.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '') || a.name.localeCompare(b.name));
  });

  readonly searchTerm = signal('');
  readonly statusFilter = signal<StatusFilter>('all');
  readonly statusOptions: { label: string; value: StatusFilter }[] = [
    { label: 'All', value: 'all' },
    { label: 'Published', value: 'published' },
    { label: 'Needs action', value: 'action' }
  ];

  readonly filteredRows = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const filter = this.statusFilter();
    return this.rows().filter((row) => {
      if (filter === 'published' && !row.layer) return false;
      if (filter === 'action' && !this.needsAction(row)) return false;
      if (!term) return true;
      return row.name.toLowerCase().includes(term) || (row.departmentName ?? '').toLowerCase().includes(term);
    });
  });

  /** Pagination is client-side over filteredRows. */
  readonly first = signal(0);
  readonly pageSize = signal(10);
  readonly pageSizes = [10, 25, 50];
  readonly pagedRows = computed(() => this.filteredRows().slice(this.first(), this.first() + this.pageSize()));

  readonly publishedCount = computed(() => this.layers().length);
  readonly actionCount = computed(() => this.rows().filter((r) => this.needsAction(r)).length);
  readonly departmentLayerCount = computed(() => this.layers().filter((l) => l.ownershipType === 'DEPARTMENT').length);
  readonly canonicalLayerCount = computed(() => this.layers().filter((l) => l.ownershipType === 'CANONICAL').length);

  /** Layer Styling module (Module Access) — the Style button needs it. */
  private readonly myModuleIds = signal<Set<number>>(new Set());
  readonly canStyle = computed(() => this.myModuleIds().has(LAYER_STYLING_MODULE_ID));

  constructor() {
    this.currentUserService.getMe().subscribe({ next: (user) => this.currentUser.set(user) });
    this.moduleAccessService.getMyModuleIds().subscribe({
      next: ({ moduleIds }) => this.myModuleIds.set(new Set(moduleIds))
    });
    this.loadAll();
  }

  private toRow(code: string, layer: GisLayer | null, uploads: GisUpload[]): LayerRow {
    const latest = uploads[0] ?? null;
    const source = layer ?? latest!.layer;
    return {
      code,
      name: source.name,
      ownershipType: source.ownershipType,
      departmentId: source.departmentId,
      departmentName: source.departmentName,
      layer,
      uploads,
      pending: latest && latest.status !== 'PUBLISHED' ? latest : null,
      lastActivity: latest?.updatedAt ?? null
    };
  }

  // ---------------------------------------------------------------- loading

  loadAll(): void {
    this.loading.set(true);
    this.pageError.set(null);
    this.uploadsError.set(null);
    forkJoin({
      layers: this.gisLayersService.list(),
      uploads: this.fetchAllUploads().pipe(
        catchError(() => {
          this.uploadsError.set('Upload history could not be loaded; only published layers are shown.');
          return of([] as GisUpload[]);
        })
      )
    }).subscribe({
      next: ({ layers, uploads }) => {
        this.layers.set(layers);
        this.uploads.set(uploads);
        this.clampFirst(this.filteredRows().length);
        this.refreshOpenDialogs();
        this.loading.set(false);
        this.hasLoaded.set(true);
      },
      error: () => {
        this.pageError.set('Could not load GIS layers. Please try again.');
        this.loading.set(false);
      }
    });
  }

  private fetchAllUploads(): Observable<GisUpload[]> {
    return this.uploadsService.list(1, UPLOADS_PAGE_SIZE).pipe(
      expand((res) =>
        res.page * UPLOADS_PAGE_SIZE < res.total ? this.uploadsService.list(res.page + 1, UPLOADS_PAGE_SIZE) : EMPTY
      ),
      reduce((all, res) => all.concat(res.items), [] as GisUpload[])
    );
  }

  /** After a reload, point open dialogs at the fresh row/upload objects. */
  private refreshOpenDialogs(): void {
    const row = this.detailRow();
    if (row) {
      this.detailRow.set(this.rows().find((r) => r.code === row.code) ?? null);
    }
    const upload = this.detailUpload();
    if (upload) {
      const fresh = this.uploads().find((u) => u.id === upload.id);
      if (fresh) this.detailUpload.set(fresh);
    }
  }

  onSearchChange(value: string): void {
    this.searchTerm.set(value);
    this.first.set(0);
  }

  onStatusFilterChange(value: StatusFilter | null): void {
    this.statusFilter.set(value ?? 'all');
    this.first.set(0);
  }

  onPageChange(event: PaginatorState): void {
    this.first.set(event.first ?? 0);
    if (event.rows) {
      this.pageSize.set(event.rows);
    }
  }

  /** Keeps the current page in range after the list shrinks. */
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

  // ------------------------------------------------------------ permissions

  get isOwner(): boolean {
    return this.currentUser()?.systemRole === 'MUNICIPALITY_OWNER';
  }

  /** Department Users are view-only — only the Owner and Department
   *  Heads upload GIS data. */
  get canUpload(): boolean {
    const role = this.currentUser()?.systemRole;
    return role === 'MUNICIPALITY_OWNER' || role === 'DEPARTMENT_HEAD';
  }

  /** Owner, or the Department Head of the row's own department — manages
   *  the layer and reviews/publishes its uploads. Deleting stays Owner-only. */
  canManage(row: { ownershipType: GisLayerOwnershipType; departmentId: string | null }): boolean {
    const me = this.currentUser();
    if (!me) return false;
    if (me.systemRole === 'MUNICIPALITY_OWNER') return true;
    return (
      me.systemRole === 'DEPARTMENT_HEAD' &&
      row.ownershipType === 'DEPARTMENT' &&
      !!me.department &&
      row.departmentId === me.department.id
    );
  }

  /** Owner or the uploader — may retry validation / submit for review. */
  canEditUpload(upload: GisUpload): boolean {
    return this.isOwner || upload.uploadedById === this.currentUser()?.id;
  }

  canValidate(upload: GisUpload): boolean {
    return upload.status === 'FAILED' && this.canEditUpload(upload);
  }

  canSubmitForReview(upload: GisUpload): boolean {
    return upload.status === 'DRAFT' && this.canEditUpload(upload);
  }

  canDiscard(upload: GisUpload): boolean {
    return upload.status !== 'PUBLISHED' && this.canEditUpload(upload);
  }

  canApproveOrReject(upload: GisUpload): boolean {
    return upload.status === 'IN_REVIEW' && this.canManage(upload.layer);
  }

  canPublish(upload: GisUpload): boolean {
    return (upload.status === 'APPROVED' || upload.status === 'PUBLISH_FAILED') && this.canManage(upload.layer);
  }

  needsAction(row: LayerRow): boolean {
    return !!row.pending && NEEDS_ACTION.has(row.pending.status);
  }

  // ---------------------------------------------------------------- labels

  statusLabel(status: GisUpload['status']): string {
    return STATUS_LABELS[status] ?? status;
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

  formatLabel(format: GisUpload['fileFormat']): string {
    return FORMAT_LABELS[format] ?? format;
  }

  fileSizeLabel(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  riskSeverity(level: UploadReviewReport['riskLevel']): 'success' | 'warn' | 'danger' {
    return level === 'high' ? 'danger' : level === 'medium' ? 'warn' : 'success';
  }

  /** POLYGON → "Polygon"; raster layers have no geometry type. Unpublished
   *  rows fall back to the geometry detected during validation. */
  geometryLabel(row: LayerRow): string {
    if (row.layer?.layerType === 'RASTER') return 'Raster';
    const g = row.layer?.geometryType ?? row.uploads[0]?.validation.geometryType ?? null;
    return g ? g.charAt(0) + g.slice(1).toLowerCase() : '—';
  }

  // ---------------------------------------------------------- layer dialogs

  viewDetail(row: LayerRow): void {
    this.detailRow.set(row);
  }

  closeDetail(): void {
    this.detailRow.set(null);
  }

  openPermissions(layer: GisLayer): void {
    this.router.navigate(['/gis/layers', layer.id, 'permissions']);
  }

  openStyle(layer: GisLayer): void {
    this.styleChanged = false;
    this.styleLayer.set(layer);
  }

  /** The editor runs in live mode: every change is applied to GeoServer
   *  (debounced) and the preview map reloads to show it. */
  onStyleApplied(): void {
    this.styleChanged = true;
    this.stylePreviewKey.set(Date.now());
  }

  closeStyle(): void {
    this.styleLayer.set(null);
    // Picks up the layer's new hasCustomStyle/styleName.
    if (this.styleChanged) this.loadAll();
  }

  styleGeometryOf(layer: GisLayer): StyleGeometry {
    if (layer.layerType === 'RASTER') return 'raster';
    if (layer.geometryType === 'POINT') return 'point';
    if (layer.geometryType === 'LINE') return 'line';
    return 'polygon';
  }

  /** Hard delete — unpublishes the layer from GeoServer and permanently
   *  drops its data and upload history. Owner-only; the real gate is the
   *  backend. */
  deleteLayer(layer: GisLayer): void {
    this.notify.confirmDelete({
      message: `Delete "${layer.name}"? This unpublishes the layer and permanently removes its data and upload history. This cannot be undone.`,
      accept: () => {
        this.deleting.set(layer.id);
        this.gisLayersService.delete(layer.id).subscribe({
          next: () => {
            this.deleting.set(null);
            this.notify.success(`"${layer.name}" was deleted.`);
            if (this.detailRow()?.layer?.id === layer.id) {
              this.closeDetail();
            }
            this.loadAll();
          },
          error: (error: HttpErrorResponse) => {
            this.deleting.set(null);
            this.notify.error(error.error?.message ?? 'Delete failed. Please try again.');
          }
        });
      }
    });
  }

  /** Discards an unpublished upload (draft, failed, rejected, …) — its
   *  imported data and files are removed; a published layer it would
   *  replace is untouched. */
  discardUpload(upload: GisUpload): void {
    this.notify.confirmDelete({
      message: `Discard the upload "${upload.layer.name}"? Its imported data and file are permanently removed. This cannot be undone.`,
      accept: () => {
        this.deleting.set(upload.id);
        this.uploadsService.discard(upload.id).subscribe({
          next: () => {
            this.deleting.set(null);
            this.notify.success(`Upload "${upload.layer.name}" was discarded.`);
            this.closeDetail();
            this.loadAll();
          },
          error: (error: HttpErrorResponse) => {
            this.deleting.set(null);
            this.notify.error(error.error?.message ?? 'Discard failed. Please try again.');
          }
        });
      }
    });
  }

  /** One popup menu shared by every row — `openExportMenu` records which
   *  layer it was opened for. */
  @ViewChild('exportMenu') private exportMenu?: Menu;
  private exportTarget: GisLayer | null = null;

  readonly exportMenuItems: MenuItem[] = LAYER_EXPORT_FORMATS.map((format) => ({
    label: format.label,
    command: () => {
      if (this.exportTarget) this.export(this.exportTarget, format);
    }
  }));

  openExportMenu(event: Event, layer: GisLayer): void {
    this.exportTarget = layer;
    this.exportMenu?.toggle(event);
  }

  export(layer: GisLayer, format: LayerExportFormatOption = LAYER_EXPORT_FORMATS[0]): void {
    this.exporting.set(layer.id);
    this.gisLayersService.export(layer.id, format.value).subscribe({
      next: (blob) => {
        this.exporting.set(null);
        downloadBlob(blob, `${layer.code.toLowerCase()}.${format.extension}`);
        this.notify.success(`Exported "${layer.name}" as ${format.label}.`);
      },
      error: async (error: HttpErrorResponse) => {
        this.exporting.set(null);
        this.notify.error(await blobErrorMessage(error, 'Export failed. Please try again.'));
      }
    });
  }

  // --------------------------------------------------------- upload workflow

  openWizard(): void {
    // A fresh <app-upload-wizard> is created each time via @if, so its
    // internal state always starts clean.
    this.wizardResume.set(null);
    this.wizardVisible.set(true);
  }

  /** Reopens the wizard on a draft whose columns were never confirmed —
   *  it can't be submitted for review until they are. */
  continueUpload(upload: GisUpload): void {
    this.wizardResume.set(upload);
    this.wizardVisible.set(true);
  }

  needsColumnReview(upload: GisUpload): boolean {
    return upload.status === 'DRAFT' && !!upload.schema && !upload.schema.confirmedAt;
  }

  onWizardClosed(): void {
    this.wizardVisible.set(false);
  }

  onWizardSubmitted(): void {
    this.wizardVisible.set(false);
    this.first.set(0);
    this.loadAll();
  }

  viewUpload(upload: GisUpload): void {
    this.detailUpload.set(upload);
    this.resetReview();
    // The review endpoint is for uploaders / reviewers only; view-only
    // Department Users would just get a 403.
    if (!REVIEWABLE.has(upload.status) || !this.canUpload) return;
    this.reviewLoading.set(true);
    // Drop a response for an upload that is no longer shown.
    const stillShown = () => this.detailUpload()?.id === upload.id;
    this.uploadsService.reviewCheck(upload.id).subscribe({
      next: (report) => {
        if (!stillShown()) return;
        this.reviewLoading.set(false);
        this.review.set(report);
      },
      error: (err: HttpErrorResponse) => {
        if (!stillShown()) return;
        this.reviewLoading.set(false);
        this.reviewError.set(err.error?.message ?? 'The automated review could not run.');
      }
    });
  }

  closeUpload(): void {
    this.detailUpload.set(null);
    this.resetReview();
  }

  private resetReview(): void {
    this.review.set(null);
    this.reviewError.set(null);
    this.reviewLoading.set(false);
  }

  retryValidate(upload: GisUpload): void {
    this.runAction(upload, 'validate', this.uploadsService.validate(upload.id), 'Validation finished.');
  }

  submitForReview(upload: GisUpload): void {
    this.runAction(upload, 'submit', this.uploadsService.submitForReview(upload.id), 'Submitted for review.');
  }

  approve(upload: GisUpload): void {
    this.runAction(upload, 'approve', this.uploadsService.approve(upload.id), 'Upload approved.');
  }

  openRejectDialog(upload: GisUpload): void {
    this.rejectTarget.set(upload);
    this.rejectionReason.set('');
  }

  confirmReject(): void {
    const target = this.rejectTarget();
    if (!target || this.rejectionReason().trim().length < 3) return;
    this.runAction(target, 'reject', this.uploadsService.reject(target.id, this.rejectionReason().trim()), 'Upload rejected.');
    this.rejectTarget.set(null);
  }

  publish(upload: GisUpload): void {
    this.runAction(upload, 'publish', this.uploadsService.publish(upload.id), `"${upload.layer.name}" was published.`);
  }

  private runAction(upload: GisUpload, action: string, request: Observable<GisUpload>, successMessage: string): void {
    this.actionBusy.set(`${upload.id}:${action}`);
    request.subscribe({
      next: () => {
        this.actionBusy.set(null);
        this.notify.success(successMessage);
        this.loadAll();
      },
      error: (error: HttpErrorResponse) => {
        this.actionBusy.set(null);
        this.notify.error(error.error?.message ?? 'Action failed. Please try again.');
      }
    });
  }

  isBusy(upload: GisUpload, action: string): boolean {
    return this.actionBusy() === `${upload.id}:${action}`;
  }
}
