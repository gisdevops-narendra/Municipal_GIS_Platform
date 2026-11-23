import { Component, EventEmitter, OnDestroy, OnInit, Output, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpEventType } from '@angular/common/http';
import { NotificationService } from '../../../../core/services/notification.service';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { GeorefSession, GeoreferenceService } from '../../services/georeference.service';
import { GeoreferencerComponent } from './georeferencer.component';

/** Raster Analysis → Georeferencer: upload a scanned map / toposheet (image
 *  or PDF), resume earlier sessions, and open the full-screen workspace. */
@Component({
  selector: 'app-georef-panel',
  standalone: true,
  imports: [FormsModule, DatePipe, GeoreferencerComponent],
  template: `
    <p class="bo__hint">
      Place a scanned map, plan or toposheet on the map with ground control points (GCPs) — the QGIS Georeferencer workflow:
      pick points on the scan, match them on a reference map or type their coordinates, check the residuals, preview, then
      publish a georeferenced raster (downloadable as GeoTIFF).
    </p>
    <label class="bo__field">
      <span class="bo__label">Scanned map — PNG, JPEG, TIFF, BMP, GIF, WEBP, JPEG 2000 or PDF</span>
      <input type="file" class="ra__file" accept=".png,.jpg,.jpeg,.tif,.tiff,.bmp,.gif,.webp,.jp2,.pdf" (change)="onFile($event)" [disabled]="uploading() !== null" />
    </label>
    @if (isPdf()) {
      <label class="bo__field">
        <span class="bo__label">PDF resolution (DPI) — 300 is sharp for 1:50,000 sheets; 600 for fine detail (4× larger)</span>
        <select class="bo__input" [(ngModel)]="dpi">
          <option [ngValue]="150">150 DPI</option>
          <option [ngValue]="200">200 DPI</option>
          <option [ngValue]="300">300 DPI</option>
          <option [ngValue]="400">400 DPI</option>
          <option [ngValue]="600">600 DPI</option>
        </select>
      </label>
    }
    <button type="button" class="p-button p-button-sm bo__run" [disabled]="!file || uploading() !== null" (click)="upload()">
      <i class="pi pi-upload" aria-hidden="true"></i>&nbsp;{{ uploading() !== null ? 'Uploading ' + uploading() + '%' : 'Upload & open' }}
    </button>

    <div class="grp__list">
      <span class="bo__label">Your scans</span>
      @for (s of sessions(); track s.id) {
        <div class="grp__item">
          <button type="button" class="grp__open" (click)="open(s)" [disabled]="s.status === 'failed'">
            <b>{{ s.name }}</b>
            <span>
              @if (s.status === 'processing') { <i class="pi pi-spin pi-spinner"></i> {{ s.stage ?? 'Preparing…' }} }
              @else if (s.status === 'failed') { <span class="grp__err">Failed: {{ s.error }}</span> }
              @else { {{ s.gcps.length }} GCPs · {{ s.outputs.length }} published · {{ s.updatedAt | date: 'd MMM, HH:mm' }} }
            </span>
          </button>
          <button type="button" class="grp__del" (click)="remove(s)" [attr.aria-label]="'Delete ' + s.name"><i class="pi pi-trash"></i></button>
        </div>
      } @empty {
        <p class="bo__hint">No scans yet.</p>
      }
    </div>

    @if (openId(); as id) {
      <app-georeferencer [sessionId]="id" (closed)="close()" (layerCreated)="layerCreated.emit($event)" />
    }
  `,
  styles: `
    .grp__list { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; }
    .grp__item { display: flex; align-items: stretch; gap: 4px; }
    .grp__open {
      flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 6px 8px;
      border: 1px solid var(--color-line); border-radius: 6px; background: var(--color-surface); color: var(--color-ink-900);
      font: inherit; font-size: 12px; text-align: left; cursor: pointer;
      span { color: var(--color-ink-500); }
      &:hover:not(:disabled) { border-color: var(--color-primary-600); }
    }
    .grp__del { border: 0; background: transparent; color: var(--color-ink-500); cursor: pointer; &:hover { color: #dc2626; } }
    .grp__err { color: #b91c1c; }
  `
})
export class GeorefPanelComponent implements OnInit, OnDestroy {
  private readonly api = inject(GeoreferenceService);
  private readonly notify = inject(NotificationService);

  @Output() readonly layerCreated = new EventEmitter<GisLayer>();

  readonly sessions = signal<GeorefSession[]>([]);
  readonly uploading = signal<number | null>(null);
  readonly openId = signal<string | null>(null);
  readonly isPdf = signal(false);
  file: File | null = null;
  dpi = 300;
  private poll: ReturnType<typeof setTimeout> | undefined;

  ngOnInit(): void {
    this.refresh();
  }

  ngOnDestroy(): void {
    clearTimeout(this.poll);
  }

  private refresh(): void {
    clearTimeout(this.poll);
    this.api.list().subscribe({
      next: (list) => {
        this.sessions.set(list);
        // Keep the list live while a scan is being prepared.
        if (list.some((s) => s.status === 'processing')) this.poll = setTimeout(() => this.refresh(), 3000);
      },
      error: () => this.sessions.set([])
    });
  }

  onFile(event: Event): void {
    this.file = (event.target as HTMLInputElement).files?.[0] ?? null;
    this.isPdf.set(!!this.file && /\.pdf$/i.test(this.file.name));
  }

  upload(): void {
    if (!this.file) return;
    this.uploading.set(0);
    this.api.upload(this.file, this.dpi).subscribe({
      next: (event) => {
        if (event.type === HttpEventType.UploadProgress && event.total) {
          this.uploading.set(Math.round((100 * event.loaded) / event.total));
        } else if (event.type === HttpEventType.Response && event.body) {
          this.uploading.set(null);
          this.file = null;
          this.refresh();
          this.openId.set(event.body.id);
        }
      },
      error: (err) => {
        this.uploading.set(null);
        this.notify.error(err?.error?.message ?? 'The scan could not be uploaded.', 'Georeferencer');
      }
    });
  }

  open(s: GeorefSession): void {
    this.openId.set(s.id);
  }

  close(): void {
    this.openId.set(null);
    this.refresh();
  }

  remove(s: GeorefSession): void {
    this.notify.confirm({
      header: `Delete "${s.name}"?`,
      message: 'The scan and its GCPs are removed. Layers already published from it stay.',
      confirmLabel: 'Delete',
      destructive: true,
      accept: () => this.api.remove(s.id).subscribe(() => this.refresh())
    });
  }
}
