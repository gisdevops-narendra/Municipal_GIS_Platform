import { Component, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { environment } from '../../../../../environments/environment';
import { NotificationService } from '../../../../core/services/notification.service';

interface StorageOverview {
  municipalityQuotaMb: number | null;
  totalBytes: number;
  breakdown: { tableBytes: number; fileBytes: number; tileBytes: number; attachmentBytes: number };
  largestLayers: { id: string; name: string; layerType: string; totalBytes: number }[];
  measuredAt: string;
}

const MB = 1024 * 1024;

/** Storage: how much space your GIS data uses, against your account's limit (read-only — limits are set by platform admins). */
@Component({
  selector: 'app-storage-usage',
  standalone: true,
  imports: [FormsModule, ButtonModule, DatePipe, DecimalPipe],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      @if (data(); as d) {
        <div class="px__card">
          <span class="px__label">Your storage</span>
          <span class="px__item-title" style="font-size: 18px">
            {{ size(d.totalBytes) }}
            <span class="px__item-sub"> of {{ d.municipalityQuotaMb ? (d.municipalityQuotaMb | number) + ' MB' : 'unlimited' }}</span>
          </span>
          @if (d.municipalityQuotaMb) {
            <div class="bar"><div [style.width.%]="pct(d.totalBytes, d.municipalityQuotaMb)" [style.background]="tone(d.totalBytes, d.municipalityQuotaMb)"></div></div>
            <span class="px__item-sub" style="margin-top: 4px">{{ pct(d.totalBytes, d.municipalityQuotaMb) | number: '1.0-0' }}% used</span>
          }
          <dl class="px__kv" style="margin-top: 6px">
            <dt>Layer tables</dt><dd>{{ size(d.breakdown.tableBytes) }}</dd>
            <dt>Raster files</dt><dd>{{ size(d.breakdown.fileBytes) }}</dd>
            <dt>Tile archives</dt><dd>{{ size(d.breakdown.tileBytes) }}</dd>
            <dt>Attachments</dt><dd>{{ size(d.breakdown.attachmentBytes) }}</dd>
          </dl>
        </div>
        <p class="px__hint">When the limit is reached, new uploads are refused until you delete layers you no longer need. Contact the platform administrator if you need more space.</p>

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
  readonly error = signal<string | null>(null);

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
  }

}
