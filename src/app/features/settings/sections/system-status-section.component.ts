import { Component, inject, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SystemService } from '../../../core/services/system.service';
import { ComponentStatus, SystemStatus } from '../../../core/models/system-status.model';
import { FormatService } from '../../../core/services/format.service';

type ComponentKey = 'api' | 'database' | 'postgis' | 'geoserver';

interface Row {
  key: ComponentKey;
  label: string;
}

const ROWS: Row[] = [
  { key: 'api', label: 'Application API' },
  { key: 'database', label: 'Database' },
  { key: 'postgis', label: 'PostGIS (spatial)' },
  { key: 'geoserver', label: 'GeoServer (map tiles)' },
];

/** Settings → System Status. Live connectivity for the platform's
 *  dependencies (`GET /api/system/status`). Refreshes on demand. */
@Component({
  selector: 'app-system-status-section',
  standalone: true,
  imports: [ButtonModule, TagModule],
  template: `
    <div class="head">
      <button
        pButton
        type="button"
        class="p-button-sm p-button-outlined"
        icon="pi pi-refresh"
        label="Refresh"
        [disabled]="loading()"
        (click)="load()"
      ></button>
      @if (status()) {
        <span class="checked">Checked {{ fmt.time(status()!.checkedAt) }}</span>
      }
    </div>

    @if (error()) {
      <p class="error">{{ error() }}</p>
    }

    <ul class="rows">
      @for (row of rows; track row.key) {
        <li class="row">
          <span class="row__label">{{ row.label }}</span>
          @if (component(row.key); as c) {
            <span class="row__detail">
              {{ c.version || c.detail || '' }}
              @if (c.latencyMs !== undefined && c.latencyMs !== null) {
                <span class="row__latency">{{ c.latencyMs }} ms</span>
              }
            </span>
            <p-tag
              [severity]="c.status === 'up' ? 'success' : 'danger'"
              [value]="c.status === 'up' ? 'Operational' : 'Down'"
            />
          } @else {
            <span class="row__detail">—</span>
            <p-tag severity="secondary" [value]="loading() ? 'Checking…' : 'Unknown'" />
          }
        </li>
      }
    </ul>
  `,
  styles: [
    `
      .head {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 12px;
      }
      .checked {
        font-size: 12px;
        color: var(--color-ink-500);
      }
      .error {
        font-size: 13px;
        color: var(--color-error-600);
      }
      .rows {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .row {
        display: grid;
        grid-template-columns: 12rem 1fr auto;
        align-items: center;
        gap: 12px;
        padding: 12px 0;
        border-bottom: 1px solid var(--color-line);
      }
      .row__label {
        font-size: 13.5px;
        font-weight: 600;
        color: var(--color-ink-900);
      }
      .row__detail {
        font-size: 12px;
        font-family: var(--font-mono);
        color: var(--color-ink-500);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .row__latency {
        margin-left: 8px;
        color: var(--color-ink-300);
      }
      @media (max-width: 620px) {
        .row {
          grid-template-columns: 1fr auto;
        }
        .row__detail {
          grid-column: 1 / -1;
        }
      }
    `,
  ],
})
export class SystemStatusSectionComponent {
  private readonly system = inject(SystemService);
  readonly fmt = inject(FormatService);
  readonly rows = ROWS;

  readonly status = signal<SystemStatus | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  constructor() {
    this.load();
  }

  component(key: ComponentKey): ComponentStatus | null {
    const s = this.status();
    return s ? s[key] : null;
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.system.status().subscribe({
      next: (status) => {
        this.status.set(status);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Could not reach the API to check system status.');
        this.loading.set(false);
      },
    });
  }
}
