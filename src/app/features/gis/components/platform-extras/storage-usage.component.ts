import { Component, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { environment } from '../../../../../environments/environment';
import { NotificationService } from '../../../../core/services/notification.service';

interface StorageOverview {
  canEditLimits: boolean;
  municipalityQuotaMb: number | null;
  totalBytes: number;
  breakdown: { tableBytes: number; fileBytes: number; tileBytes: number; attachmentBytes: number };
  shared: { bytes: number; layerCount: number } | null;
  departments: { id: string; name: string; quotaMb: number | null; bytes: number; layerCount: number }[];
  largestLayers: { id: string; name: string; departmentId: string | null; layerType: string; totalBytes: number }[];
  measuredAt: string;
}

const MB = 1024 * 1024;

/** Storage: how much space GIS data uses per department, and limits. */
@Component({
  selector: 'app-storage-usage',
  standalone: true,
  imports: [FormsModule, ButtonModule, DatePipe, DecimalPipe],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      @if (data(); as d) {
        <div class="px__card">
          <span class="px__label">{{ d.canEditLimits ? 'Municipality total' : 'Your department' }}</span>
          @if (d.canEditLimits) {
            <span class="px__item-title" style="font-size: 18px">{{ size(d.totalBytes) }}@if (d.municipalityQuotaMb) { <span class="px__item-sub"> of {{ d.municipalityQuotaMb | number }} MB</span> }</span>
            @if (d.municipalityQuotaMb) {
              <div class="bar"><div [style.width.%]="pct(d.totalBytes, d.municipalityQuotaMb)" [style.background]="tone(d.totalBytes, d.municipalityQuotaMb)"></div></div>
            }
          }
          <dl class="px__kv" style="margin-top: 6px">
            <dt>Layer tables</dt><dd>{{ size(d.breakdown.tableBytes) }}</dd>
            <dt>Raster files</dt><dd>{{ size(d.breakdown.fileBytes) }}</dd>
            <dt>Tile archives</dt><dd>{{ size(d.breakdown.tileBytes) }}</dd>
            <dt>Attachments</dt><dd>{{ size(d.breakdown.attachmentBytes) }}</dd>
          </dl>
        </div>

        <div class="px__section">
          <h4>By department</h4>
          <div class="px__list" style="max-height: none">
            @for (dep of d.departments; track dep.id) {
              <div class="px__item" style="flex-wrap: wrap">
                <div class="px__item-main">
                  <span class="px__item-title">{{ dep.name }}</span>
                  <span class="px__item-sub">{{ size(dep.bytes) }} · {{ dep.layerCount }} layer{{ dep.layerCount === 1 ? '' : 's' }}@if (dep.quotaMb) { · limit {{ dep.quotaMb | number }} MB }</span>
                </div>
                @if (d.canEditLimits) {
                  <input class="px__input" style="width: 92px; flex: none" type="number" min="1" placeholder="No limit"
                         [ngModel]="limits[dep.id]" (ngModelChange)="limits[dep.id] = $event" [attr.aria-label]="'Limit in MB for ' + dep.name" title="Limit in MB" />
                }
                @if (dep.quotaMb) {
                  <div class="bar" style="flex-basis: 100%"><div [style.width.%]="pct(dep.bytes, dep.quotaMb)" [style.background]="tone(dep.bytes, dep.quotaMb)"></div></div>
                }
              </div>
            } @empty {
              <p class="px__hint px__hint--center">No departments.</p>
            }
            @if (d.shared) {
              <div class="px__item">
                <div class="px__item-main">
                  <span class="px__item-title">Shared (municipality-owned)</span>
                  <span class="px__item-sub">{{ size(d.shared.bytes) }} · {{ d.shared.layerCount }} layers</span>
                </div>
              </div>
            }
          </div>
        </div>

        @if (d.canEditLimits) {
          <label class="px__field">
            <span class="px__label">Municipality limit (MB)</span>
            <input class="px__input" type="number" min="1" placeholder="No limit" [ngModel]="muniLimit" (ngModelChange)="muniLimit = $event" />
          </label>
          <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-check" label="Save limits" [loading]="saving()" (click)="save()"></button>
          <p class="px__hint">When a limit is reached, new uploads and new layers for it are refused. Existing data is never removed.</p>
        }

        <div class="px__section">
          <h4>Largest layers</h4>
          <div class="px__list">
            @for (l of d.largestLayers; track l.id) {
              <div class="px__item">
                <i class="pi" [class]="'pi ' + (l.layerType === 'RASTER' ? 'pi-image' : 'pi-clone')" style="color: var(--color-ink-500)"></i>
                <div class="px__item-main"><span class="px__item-title" [title]="l.name">{{ l.name }}</span></div>
                <span class="px__mono">{{ size(l.totalBytes) }}</span>
              </div>
            }
          </div>
        </div>

        <div class="px__secret" style="justify-content: space-between">
          <span class="px__item-sub">Measured {{ d.measuredAt | date: 'shortTime' }}</span>
          <button pButton type="button" class="p-button-sm p-button-text" icon="pi pi-refresh" label="Refresh" [loading]="loading()" (click)="load()"></button>
        </div>
      } @else if (loading()) {
        <p class="px__hint">Measuring storage…</p>
      } @else if (error()) {
        <p class="px__error">{{ error() }}</p>
      }
    </div>
  `,
  styles: [
    `
      .bar { height: 6px; border-radius: 3px; background: var(--color-surface-alt); border: 1px solid var(--color-line); overflow: hidden; margin-top: 4px; }
      .bar > div { height: 100%; border-radius: 3px; }
    `
  ]
})
export class StorageUsageComponent {
  private readonly http = inject(HttpClient);
  private readonly notify = inject(NotificationService);

  readonly data = signal<StorageOverview | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  limits: Record<string, number | null> = {};
  muniLimit: number | null = null;

  constructor() {
    this.load();
  }

  size(bytes: number): string {
    if (bytes >= 1024 * MB) return `${(bytes / 1024 / MB).toFixed(2)} GB`;
    if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  pct(bytes: number, quotaMb: number): number {
    return Math.min(100, (bytes / (quotaMb * MB)) * 100);
  }

  tone(bytes: number, quotaMb: number): string {
    const p = this.pct(bytes, quotaMb);
    return p >= 95 ? 'var(--color-error-600)' : p >= 80 ? '#d97706' : 'var(--color-success-600)';
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.http.get<StorageOverview>(`${environment.apiUrl}/gis/storage`).subscribe({
      next: (d) => this.apply(d),
      error: (e) => {
        this.loading.set(false);
        this.error.set(e?.error?.message ?? 'Could not read storage usage.');
      }
    });
  }

  private apply(d: StorageOverview): void {
    this.data.set(d);
    this.loading.set(false);
    this.muniLimit = d.municipalityQuotaMb;
    this.limits = Object.fromEntries(d.departments.map((dep) => [dep.id, dep.quotaMb]));
  }

  save(): void {
    const clean = (v: unknown) => (v === '' || v === null || v === undefined ? null : Math.round(Number(v)));
    this.saving.set(true);
    this.http
      .put<StorageOverview>(`${environment.apiUrl}/gis/storage/limits`, {
        municipalityQuotaMb: clean(this.muniLimit),
        departments: Object.entries(this.limits).map(([id, v]) => ({ id, quotaMb: clean(v) }))
      })
      .subscribe({
        next: (d) => {
          this.saving.set(false);
          this.apply(d);
          this.notify.success('Storage limits saved.');
        },
        error: (e) => {
          this.saving.set(false);
          const m = e?.error?.message;
          this.notify.error(Array.isArray(m) ? m.join(', ') : m ?? 'Could not save the limits.');
        }
      });
  }
}
