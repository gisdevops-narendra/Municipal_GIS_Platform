import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, EventEmitter, OnInit, Output, computed, inject, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { GisUpload, GisUploadStatus } from '../../../../core/models/gis-upload.model';
import { GisUploadsService } from '../../../../core/services/gis-uploads.service';
import { NotificationService } from '../../../../core/services/notification.service';

type Filter = 'all' | 'failed' | 'unfinished' | 'published';
type Kind = 'published' | 'failed' | 'processing' | 'unfinished';

/** An upload still "processing" after this long is treated as stuck. */
const STUCK_MS = 15 * 60 * 1000;
const PAGE_SIZE = 20;

/** Every upload of this workspace with its outcome — retry failed ones,
 *  finish unfinished ones, discard what isn't needed, jump to the layer. */
@Component({
  selector: 'app-upload-history',
  standalone: true,
  imports: [DatePipe, ButtonModule],
  templateUrl: './upload-history.component.html',
  styleUrl: './upload-history.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UploadHistoryComponent implements OnInit {
  private readonly api = inject(GisUploadsService);
  private readonly notify = inject(NotificationService);

  /** Re-process this upload in the upload wizard. */
  @Output() retry = new EventEmitter<GisUpload>();
  /** Show this published layer on the map. */
  @Output() showLayer = new EventEmitter<string>();
  @Output() uploadNew = new EventEmitter<void>();

  readonly items = signal<GisUpload[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly filter = signal<Filter>('all');
  readonly discarding = signal<string | null>(null);
  readonly expanded = signal<string | null>(null);

  readonly counts = computed(() => {
    const c = { all: this.items().length, failed: 0, unfinished: 0, published: 0 };
    for (const u of this.items()) {
      const k = this.kind(u);
      if (k === 'failed') c.failed++;
      else if (k === 'published') c.published++;
      else c.unfinished++;
    }
    return c;
  });

  readonly visible = computed(() => {
    const f = this.filter();
    return this.items().filter((u) => {
      const k = this.kind(u);
      return f === 'all' || (f === 'failed' ? k === 'failed' : f === 'published' ? k === 'published' : k === 'processing' || k === 'unfinished');
    });
  });

  readonly hasMore = computed(() => this.items().length < this.total());

  ngOnInit(): void {
    this.load();
  }

  load(more = false): void {
    const page = more ? this.page() + 1 : 1;
    this.loading.set(true);
    this.error.set(null);
    this.api.list(page, PAGE_SIZE).subscribe({
      next: (p) => {
        this.items.update((cur) => (more ? [...cur, ...p.items] : p.items));
        this.total.set(p.total);
        this.page.set(page);
        this.loading.set(false);
      },
      error: (e: HttpErrorResponse) => {
        this.loading.set(false);
        this.error.set((e.error?.message as string) ?? 'Could not load your uploads.');
      },
    });
  }

  kind(u: GisUpload): Kind {
    const s: GisUploadStatus = u.status;
    if (s === 'PUBLISHED') return 'published';
    if (s === 'FAILED' || s === 'PUBLISH_FAILED') return 'failed';
    if ((s === 'VALIDATING' || s === 'UPLOAD_PENDING') && Date.now() - new Date(u.updatedAt).getTime() < STUCK_MS) {
      return 'processing';
    }
    return 'unfinished';
  }

  statusLabel(u: GisUpload): string {
    switch (this.kind(u)) {
      case 'published':
        return 'On map';
      case 'processing':
        return 'Processing…';
      case 'failed':
        return u.status === 'PUBLISH_FAILED' ? 'Publish failed' : 'Failed';
      default:
        return u.status === 'VALIDATING' || u.status === 'UPLOAD_PENDING' ? 'Stopped' : 'Not finished';
    }
  }

  /** One plain sentence about what went wrong (or what's left to do). */
  reason(u: GisUpload): string | null {
    const k = this.kind(u);
    if (k === 'failed') {
      const errs = u.validation.summary?.errors ?? [];
      return u.errorMessage || (errs.length ? errs.join(' ') : 'Processing failed.');
    }
    if (k === 'unfinished') {
      return u.status === 'VALIDATING' || u.status === 'UPLOAD_PENDING'
        ? 'Processing stopped before it finished (e.g. the server restarted).'
        : 'Processed but never added to the map.';
    }
    return null;
  }

  size(bytes: number): string {
    if (!bytes) return '0 KB';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  geometry(u: GisUpload): string | null {
    const g = u.validation.geometryType;
    const n = u.validation.featureCount;
    if (!g && n == null) return null;
    const label = g ? g.charAt(0) + g.slice(1).toLowerCase() : '';
    return n != null ? `${n.toLocaleString()} ${label.toLowerCase() || 'feature'}${n === 1 ? '' : 's'}` : label;
  }

  toggle(id: string): void {
    this.expanded.update((cur) => (cur === id ? null : id));
  }

  discard(u: GisUpload): void {
    this.notify.confirm({
      header: 'Discard this upload?',
      message: `“${u.layer.name}” (${u.filename}) and its uploaded file will be removed. Nothing on the map changes.`,
      confirmLabel: 'Discard',
      destructive: true,
      accept: () => {
        this.discarding.set(u.id);
        this.api.discard(u.id).subscribe({
          next: () => {
            this.discarding.set(null);
            this.items.update((l) => l.filter((x) => x.id !== u.id));
            this.total.update((t) => Math.max(t - 1, 0));
            this.notify.success(`“${u.layer.name}” discarded.`, 'Upload discarded');
          },
          error: (e: HttpErrorResponse) => {
            this.discarding.set(null);
            this.notify.error((e.error?.message as string) ?? 'Could not discard the upload.');
          },
        });
      },
    });
  }
}
