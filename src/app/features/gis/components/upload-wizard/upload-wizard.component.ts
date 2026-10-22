import { Component, EventEmitter, Input, OnDestroy, OnInit, Output, computed, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { SelectModule } from 'primeng/select';
import { MessageModule } from 'primeng/message';
import { TagModule } from 'primeng/tag';
import { ProgressBarModule } from 'primeng/progressbar';
import { GisUploadsService } from '../../../../core/services/gis-uploads.service';
import { DepartmentService } from '../../../../core/services/department.service';
import { Department } from '../../../../core/models/department.model';
import { CurrentUser } from '../../../../core/models/current-user.model';
import { GisUpload, GisUploadPreview } from '../../../../core/models/gis-upload.model';
import { MapService } from '../../services/map.service';
import { MunicipalMapComponent } from '../municipal-map/municipal-map.component';
import { StyleEditorComponent } from '../style-editor/style-editor.component';
import { UploadColumnsComponent } from '../upload-columns/upload-columns.component';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { StyleGeometry } from '../../../../core/models/layer-style.model';

type WizardStep = 'FILE_INFO' | 'VALIDATION' | 'COLUMNS' | 'PREVIEW';

const CRS_PATTERN = /^EPSG:\d{4,6}$/;

const STEP_ORDER: WizardStep[] = ['FILE_INFO', 'VALIDATION', 'COLUMNS', 'PREVIEW'];
const ACCEPTED_EXTENSIONS = ['zip', 'geojson', 'json', 'csv'];

/**
 * Upload wizard (Task 7 §22). Deliberately three visible steps, not six:
 * this backend validates synchronously as part of creating the upload
 * (Task 7 §3 permits this for the initial implementation), so "Select
 * File" + "Layer Information" collapse into one step (both are needed in
 * the same multipart request anyway), and "Validation" naturally follows
 * as the result of that same request rather than a separate call. CRS is
 * shown as part of the validation results, not a separate confirmation
 * step, unless the source CRS could not be determined — see the
 * `sourceCrsRequired` banner.
 *
 * One OpenLayers Map per wizard instance for the preview step — same
 * component-provided-MapService pattern as GisWorkspaceComponent (Task 6),
 * kept independent of the main map's own MapService.
 */
@Component({
  selector: 'app-upload-wizard',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    ButtonModule,
    InputTextModule,
    TextareaModule,
    SelectModule,
    MessageModule,
    TagModule,
    ProgressBarModule,
    MunicipalMapComponent,
    StyleEditorComponent,
    UploadColumnsComponent
  ],
  providers: [MapService],
  templateUrl: './upload-wizard.component.html',
  styleUrl: './upload-wizard.component.scss'
})
export class UploadWizardComponent implements OnInit, OnDestroy {
  /** The file transfer in progress — aborted if the wizard is closed, so a
   *  "cancelled" upload doesn't quietly finish in the background. */
  private uploadSub?: Subscription;

  ngOnDestroy(): void {
    this.uploadSub?.unsubscribe();
  }

  @Input({ required: true }) currentUser!: CurrentUser;
  /** An existing DRAFT upload to continue — opens at step 3 (Columns), or
   *  at step 4 if its columns are already confirmed. */
  @Input() resume: GisUpload | null = null;
  @Output() closed = new EventEmitter<void>();
  @Output() submittedForReview = new EventEmitter<GisUpload>();

  private readonly fb = inject(FormBuilder);
  private readonly uploadsService = inject(GisUploadsService);
  private readonly departmentService = inject(DepartmentService);
  private readonly mapService = inject(MapService);

  readonly step = signal<WizardStep>('FILE_INFO');
  readonly departments = signal<Department[]>([]);
  readonly selectedFile = signal<File | null>(null);
  readonly uploading = signal(false);
  readonly uploadPercent = signal(0);
  readonly submitError = signal<string | null>(null);
  readonly upload = signal<GisUpload | null>(null);
  readonly preview = signal<GisUploadPreview | null>(null);
  readonly previewLoading = signal(false);
  readonly submitting = signal(false);
  readonly styleOpen = signal(false);
  readonly dragOver = signal(false);

  readonly stepLabels = ['File & Layer Info', 'Validation', 'Columns', 'Preview & Submit'];
  readonly stepIndex = computed(() => STEP_ORDER.indexOf(this.step()));

  readonly ownershipOptions = [
    {
      value: 'DEPARTMENT' as const,
      label: 'Department',
      description: 'Owned and maintained by one department',
      icon: 'pi-building'
    },
    {
      value: 'CANONICAL' as const,
      label: 'Canonical',
      description: 'Municipality-wide reference layer',
      icon: 'pi-globe'
    }
  ];

  /** Layer name last auto-filled from a file name — replaced when another
   *  file is picked, but never once the user has typed their own. */
  private suggestedName = '';

  readonly form = this.fb.nonNullable.group({
    layerName: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(150)]],
    description: [''],
    ownershipType: ['DEPARTMENT' as 'CANONICAL' | 'DEPARTMENT', Validators.required],
    departmentId: [''],
    sourceCrs: [''],
    latitudeField: [''],
    longitudeField: [''],
    xField: [''],
    yField: ['']
  });

  ngOnInit(): void {
    if (this.resume) {
      this.upload.set(this.resume);
      if (this.resume.schema?.confirmedAt) {
        this.goToPreview();
      } else {
        this.step.set('COLUMNS');
      }
    }

    this.departmentService.list().subscribe({
      next: (departments) => {
        this.departments.set(departments.filter((d) => d.status === 'ACTIVE'));
      }
    });

    if (this.currentUser.systemRole !== 'MUNICIPALITY_OWNER') {
      // A Department Head/User may only ever upload DEPARTMENT layers to
      // their own department (Task 7 §12/§26, Task 8 §4) — the backend
      // enforces this regardless, but the form reflects it directly
      // rather than letting the user pick something that will just be
      // rejected.
      this.form.patchValue({
        ownershipType: 'DEPARTMENT',
        departmentId: this.currentUser.department?.id ?? ''
      });
    }
  }

  get f() {
    return this.form.controls;
  }

  get isOwner(): boolean {
    return this.currentUser.systemRole === 'MUNICIPALITY_OWNER';
  }

  get departmentOptions(): { label: string; value: string }[] {
    return this.departments().map((d) => ({ label: d.name, value: d.id }));
  }

  get isCsv(): boolean {
    return (this.selectedFile()?.name ?? '').toLowerCase().endsWith('.csv');
  }

  onFileInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.setFile(input.files?.[0] ?? null);
    input.value = '';
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(true);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(false);
    this.setFile(event.dataTransfer?.files?.[0] ?? null);
  }

  clearFile(input: HTMLInputElement): void {
    input.value = '';
    this.selectedFile.set(null);
    this.submitError.set(null);
  }

  fileExt(file: File): string {
    return (file.name.split('.').pop() ?? '').toUpperCase();
  }

  fileKind(file: File): string {
    const ext = this.fileExt(file);
    if (ext === 'ZIP') return 'Shapefile (ZIP)';
    if (ext === 'CSV') return 'CSV table';
    return 'GeoJSON';
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  selectOwnership(value: 'CANONICAL' | 'DEPARTMENT'): void {
    this.form.patchValue({ ownershipType: value });
    this.onOwnershipChange(value);
  }

  private setFile(file: File | null): void {
    this.submitError.set(null);
    if (!file) return;
    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      this.submitError.set('Unsupported file type. Upload a Shapefile ZIP, GeoJSON, or CSV file.');
      return;
    }
    this.selectedFile.set(file);

    const current = this.f.layerName.value.trim();
    if (!current || current === this.suggestedName) {
      this.suggestedName = this.nameFromFile(file.name);
      this.form.patchValue({ layerName: this.suggestedName });
    }
  }

  /** "ward_boundaries-2024.geojson" → "Ward Boundaries 2024". */
  private nameFromFile(filename: string): string {
    return filename
      .replace(/\.[^.]+$/, '')
      .replace(/[_\-.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .slice(0, 150);
  }

  onOwnershipChange(value: 'CANONICAL' | 'DEPARTMENT'): void {
    if (value === 'CANONICAL') {
      this.form.patchValue({ departmentId: '' });
    }
  }

  submitUpload(): void {
    const file = this.selectedFile();
    if (!file) {
      this.submitError.set('Select a file to upload.');
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();
    if (value.ownershipType === 'DEPARTMENT' && !value.departmentId) {
      this.submitError.set('Select a department.');
      return;
    }
    if ((value.xField || value.yField) && !CRS_PATTERN.test(value.sourceCrs)) {
      this.submitError.set('Specify a valid sourceCrs (e.g. "EPSG:32643") when using X/Y columns.');
      return;
    }

    this.uploading.set(true);
    this.uploadPercent.set(0);
    this.submitError.set(null);

    this.uploadSub = this.uploadsService
      .create(file, {
        layerName: value.layerName,
        description: value.description || undefined,
        ownershipType: value.ownershipType,
        departmentId: value.ownershipType === 'DEPARTMENT' ? value.departmentId : undefined,
        sourceCrs: value.sourceCrs || undefined,
        latitudeField: value.latitudeField || undefined,
        longitudeField: value.longitudeField || undefined,
        xField: value.xField || undefined,
        yField: value.yField || undefined
      })
      .subscribe({
        next: (event) => {
          if (event.type === 'progress') {
            this.uploadPercent.set(event.percent);
          } else {
            this.uploading.set(false);
            this.upload.set(event.upload);
            this.step.set('VALIDATION');
          }
        },
        error: (error: HttpErrorResponse) => {
          this.uploading.set(false);
          this.submitError.set(this.resolveErrorMessage(error));
        }
      });
  }

  /** Step 3: review the imported columns (names, types, meanings). */
  goToColumns(): void {
    this.submitError.set(null);
    this.step.set('COLUMNS');
  }

  /** The user approved the column changes: the data now has them. The
   *  preview is rebuilt so it shows the new column names. */
  onColumnsConfirmed(updated: GisUpload): void {
    this.upload.set(updated);
    this.preview.set(null);
    this.goToPreview();
  }

  goToPreview(): void {
    const current = this.upload();
    if (!current) return;
    this.step.set('PREVIEW');
    this.previewLoading.set(true);
    this.uploadsService.preview(current.id).subscribe({
      next: (preview) => {
        this.preview.set(preview);
        this.previewLoading.set(false);
      },
      error: () => {
        this.previewLoading.set(false);
      }
    });
  }

  /** computed(), not a plain getter: MunicipalMapComponent's [layers]
   *  input relies on reference stability (its ngOnChanges fallback would
   *  otherwise fire on every unrelated change-detection cycle if this
   *  returned a fresh object literal each time it's read). computed()
   *  only recalculates — and only produces a new reference — when
   *  `preview`/`upload` actually change. */
  readonly previewLayer = computed<GisLayer | null>(() => {
    const preview = this.preview();
    const current = this.upload();
    if (!preview || !current) return null;
    return {
      id: 'preview',
      name: current.layer.name,
      code: 'PREVIEW',
      description: null,
      layerType: 'VECTOR',
      geoserverWorkspace: preview.geoserverWorkspace,
      geoserverLayer: preview.geoserverLayer,
      geometryType: current.validation.geometryType,
      visibleByDefault: true,
      displayOrder: 1,
      ownershipType: 'DEPARTMENT',
      departmentId: null,
      departmentName: null,
      version: 1,
      bbox: preview.bbox
    };
  });

  /** A single-element array wrapping previewLayer(), memoized the same
   *  way — MunicipalMapComponent's [layers] input needs array reference
   *  stability too, not just the object inside it (a template expression
   *  like `[previewLayer()!]` would allocate a new array on every
   *  change-detection cycle even though the object inside is stable). */
  readonly previewLayers = computed<GisLayer[]>(() => {
    const layer = this.previewLayer();
    return layer ? [layer] : [];
  });

  previewGeometry(): StyleGeometry {
    const g = this.upload()?.validation.geometryType;
    if (g === 'POINT') return 'point';
    if (g === 'LINE') return 'line';
    return 'polygon';
  }

  toggleStyle(event: Event): void {
    event.preventDefault();
    this.styleOpen.update((open) => !open);
  }

  onStyleApplied(): void {
    this.mapService.refreshLayerStyle('preview');
  }

  submitForReview(): void {
    const current = this.upload();
    if (!current) return;
    this.submitting.set(true);
    this.uploadsService.submitForReview(current.id).subscribe({
      next: (updated) => {
        this.submitting.set(false);
        this.submittedForReview.emit(updated);
      },
      error: (error: HttpErrorResponse) => {
        this.submitting.set(false);
        this.submitError.set(this.resolveErrorMessage(error));
      }
    });
  }

  backToFileInfo(): void {
    this.step.set('FILE_INFO');
    this.upload.set(null);
    this.preview.set(null);
  }

  close(): void {
    this.closed.emit();
  }

  private resolveErrorMessage(error: HttpErrorResponse): string {
    const message = error.error?.message;
    if (Array.isArray(message)) return message.join('. ');
    return message ?? 'Something went wrong. Please try again.';
  }
}
