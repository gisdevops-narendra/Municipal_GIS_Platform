import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { DatePipe, SlicePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminService, HealthReport, IntegrityReport, JobsOverview, LogEntry } from '../../../core/services/admin.service';
import { NotificationService } from '../../../core/services/notification.service';
import { environment } from '../../../../environments/environment';
import { ago, bytes, errorText } from './admin-utils';

const SECTION_STYLES = `
  .sx__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-bottom: 18px; }
  .sx__svc { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border: 1px solid var(--color-line); border-radius: 12px; background: var(--color-surface); }
  .sx__dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; background: #16a34a; box-shadow: 0 0 0 4px color-mix(in srgb, #16a34a 18%, transparent); }
  .sx__dot.is-bad { background: #dc2626; box-shadow: 0 0 0 4px color-mix(in srgb, #dc2626 18%, transparent); }
  .sx__svc b { display: block; font-size: 13.5px; }
  .sx__svc span { font-size: 12px; color: var(--color-ink-500); }
  .sx__meter { height: 8px; border-radius: 999px; background: var(--color-surface-alt); overflow: hidden; margin: 6px 0 2px; }
  .sx__meter > span { display: block; height: 100%; border-radius: inherit; background: var(--color-primary-600); }
  .sx__meter > span.is-warn { background: #f59e0b; }
  .sx__meter > span.is-bad { background: #dc2626; }
  .sx__btns { display: flex; flex-wrap: wrap; gap: 8px; }
  .sx__log { margin: 0; padding: 0; list-style: none; }
  .sx__log li { padding: 10px 14px; border-bottom: 1px solid var(--color-line); font-size: 12.5px; }
  .sx__log li:last-child { border-bottom: 0; }
  .sx__log pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; font-size: 11.5px; color: var(--color-ink-700, var(--color-ink-900)); max-height: 220px; overflow: auto; }
  .sx__lvl { display: inline-block; min-width: 52px; padding: 1px 6px; margin-right: 8px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; background: #fef3c7; color: #92400e; text-align: center; }
  .sx__lvl.is-error, .sx__lvl.is-severe { background: #fee2e2; color: #991b1b; }
  .sx__issue { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--color-line); }
  .sx__issue:last-child { border-bottom: 0; }
  .sx__issue i.pi { margin-top: 2px; color: #f59e0b; }
  .sx__issue div { flex: 1; min-width: 0; }
  .sx__issue b { display: block; font-size: 13.5px; word-break: break-all; }
  .sx__issue span { font-size: 12.5px; color: var(--color-ink-500); }
  .sx__ok { display: flex; align-items: center; gap: 10px; padding: 18px; color: #15803d; font-weight: 600; }
`;

// =============================== Health ===============================

@Component({
  selector: 'app-admin-health',
  standalone: true,
  imports: [DatePipe],
  styles: SECTION_STYLES,
  template: `
    <header class="ac__head">
      <div>
        <h1 class="ac__title">Health</h1>
        <p class="ac__sub">Is every part of the platform running? Refreshes every 30 seconds.</p>
      </div>
      <button type="button" class="ac__btn" (click)="load()"><i class="pi pi-refresh" [class.pi-spin]="loading()"></i> Check now</button>
    </header>

    @if (report(); as r) {
      <div class="sx__grid">
        @for (s of r.services; track s.name) {
          <div class="sx__svc" [title]="s.detail">
            <span class="sx__dot" [class.is-bad]="!s.ok"></span>
            <span><b>{{ s.name }}</b><span>{{ s.ok ? s.detail : 'Problem: ' + s.detail }} · {{ s.ms }} ms</span></span>
          </div>
        }
        <div class="sx__svc" [title]="titiler()">
          <span class="sx__dot" [class.is-bad]="titiler() !== 'OK'"></span>
          <span><b>Raster tiles (TiTiler)</b><span>{{ titiler() === 'OK' ? 'OK (checked from your browser)' : 'Problem: ' + titiler() }}</span></span>
        </div>
      </div>

      <div class="ac__grid">
        <div class="ac__card">
          <span class="ac__card-head">Server</span>
          @let mem = r.system.memory;
          <p>Memory: <b>{{ bytes(mem.total - mem.available) }}</b> of {{ bytes(mem.total) }} in use</p>
          <div class="sx__meter"><span [class.is-warn]="pct(mem.total - mem.available, mem.total) > 80" [class.is-bad]="pct(mem.total - mem.available, mem.total) > 92" [style.width.%]="pct(mem.total - mem.available, mem.total)"></span></div>
          @if (r.system.swap.total) {
            <p>Swap: {{ bytes(r.system.swap.total - r.system.swap.free) }} of {{ bytes(r.system.swap.total) }} used</p>
          }
          @if (r.system.disk; as d) {
            <p>Disk: <b>{{ bytes(d.total - d.free) }}</b> of {{ bytes(d.total) }} used · {{ bytes(d.free) }} free</p>
            <div class="sx__meter"><span [class.is-warn]="pct(d.total - d.free, d.total) > 85" [class.is-bad]="pct(d.total - d.free, d.total) > 95" [style.width.%]="pct(d.total - d.free, d.total)"></span></div>
          }
          <p>CPU load: {{ r.system.load[0].toFixed(2) }} (1 min) · {{ r.system.cpus }} cores · up {{ uptime(r.system.uptimeSeconds) }}</p>
        </div>
        <div class="ac__card">
          <span class="ac__card-head">GeoServer</span>
          <p>Restarted by the watchdog <b>{{ r.geoserverRestarts7d }}</b> time{{ r.geoserverRestarts7d === 1 ? '' : 's' }} in the last 7 days.</p>
          <div class="sx__btns">
            <button type="button" class="ac__btn" (click)="gs('reload', 'Reload GeoServer settings?', 'Re-reads layers and styles from disk. Map tiles keep working.')"><i class="pi pi-sync"></i> Reload settings</button>
            <button type="button" class="ac__btn" (click)="gs('clear-cache', 'Clear the tile cache?', 'Every cached map tile is deleted and redrawn on demand — maps are slower for a while.')"><i class="pi pi-eraser"></i> Clear tile cache</button>
            <button type="button" class="ac__btn ac__btn--danger" (click)="gs('restart', 'Restart GeoServer?', 'Maps stop drawing for about a minute while it restarts.')"><i class="pi pi-power-off"></i> Restart</button>
          </div>
        </div>
      </div>
      <p class="muted">Checked {{ r.checkedAt | date: 'HH:mm:ss' }}</p>
    } @else {
      <p class="muted">{{ loading() ? 'Checking every service…' : 'The health check could not run.' }}</p>
    }
  `
})
export class AdminHealthComponent implements OnInit, OnDestroy {
  private readonly api = inject(AdminService);
  private readonly notify = inject(NotificationService);
  readonly report = signal<HealthReport | null>(null);
  readonly loading = signal(false);
  readonly titiler = signal('Checking…');
  readonly bytes = bytes;
  private timer: ReturnType<typeof setInterval> | undefined;

  ngOnInit(): void {
    this.load();
    this.timer = setInterval(() => this.load(), 30_000);
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }

  load(): void {
    this.loading.set(true);
    this.api.health().subscribe({
      next: (r) => {
        this.report.set(r);
        this.loading.set(false);
      },
      error: () => this.loading.set(false)
    });
    fetch(`${environment.titilerUrl}/healthz`, { signal: AbortSignal.timeout(6000) })
      .then((r) => this.titiler.set(r.ok ? 'OK' : `HTTP ${r.status}`))
      .catch(() => this.titiler.set('not reachable'));
  }

  pct(part: number, whole: number): number {
    return whole ? Math.round((100 * part) / whole) : 0;
  }

  uptime(s: number): string {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    return d ? `${d} d ${h} h` : `${h} h`;
  }

  gs(action: 'reload' | 'clear-cache' | 'restart', header: string, message: string): void {
    this.notify.confirm({
      header,
      message,
      confirmLabel: 'Go ahead',
      destructive: action === 'restart',
      accept: () =>
        this.api.geoserverAction(action).subscribe({
          next: () => this.notify.success(action === 'restart' ? 'GeoServer is restarting — about a minute.' : 'Done.', 'GeoServer'),
          error: (err) => this.notify.error(errorText(err, 'That did not work.'), 'GeoServer')
        })
    });
  }
}

// =============================== Jobs ===============================

@Component({
  selector: 'app-admin-jobs',
  standalone: true,
  imports: [DatePipe],
  styles: SECTION_STYLES,
  template: `
    <header class="ac__head">
      <div>
        <h1 class="ac__title">Jobs</h1>
        <p class="ac__sub">Background work running for every account, and the platform's scheduled tasks.</p>
      </div>
      <button type="button" class="ac__btn" (click)="load()"><i class="pi pi-refresh"></i> Refresh</button>
    </header>

    @if (data(); as d) {
      <div class="ac__card">
        <span class="ac__card-head">Scheduled tasks</span>
        <table class="ac__table">
          <thead><tr><th>Task</th><th>When</th><th>Last run</th><th>Result</th><th>Next run</th></tr></thead>
          <tbody>
            @for (s of d.schedules; track s.name) {
              <tr>
                <td><b>{{ s.name }}</b></td>
                <td>{{ s.when }}</td>
                <td>{{ s.lastRun ? (s.lastRun | date: 'd MMM, HH:mm') : '—' }}</td>
                <td>
                  @if (s.lastResult === 'ok') { <span class="ac__pill" data-tone="ok"><i></i>OK</span> }
                  @else if (s.lastResult === 'failed') { <span class="ac__pill" data-tone="bad"><i></i>Failed</span> }
                  @else { <span class="muted">{{ s.lastResult ?? '—' }}</span> }
                </td>
                <td>{{ s.nextRun ? (s.nextRun | date: 'd MMM, HH:mm') : '—' }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <div class="ac__card">
        <span class="ac__card-head">Running now ({{ d.running.length }})</span>
        @for (j of d.running; track j.id) {
          <div class="sx__issue">
            <i class="pi pi-spin pi-spinner"></i>
            <div><b>{{ j.tool }} · {{ j.status }}</b><span>{{ j.stage }} · {{ j.userEmail ?? 'unknown' }} · {{ (j.elapsedMs / 60000).toFixed(1) }} min</span></div>
            <button type="button" class="ac__btn ac__btn--sm ac__btn--danger" [disabled]="!j.cancellable" (click)="cancel(j.id)">Cancel</button>
          </div>
        } @empty {
          <p class="muted">Nothing is running.</p>
        }
      </div>

      <div class="ac__card ac__card--flush">
        <table class="ac__table">
          <thead><tr><th>Recent job (7 days)</th><th>By</th><th>Result</th><th>Started</th></tr></thead>
          <tbody>
            @for (j of d.recent; track j.id) {
              <tr>
                <td><b>{{ j.tool }}</b>@if (j.layerName) { → {{ j.layerName }} }<div class="muted">{{ j.summary }}</div></td>
                <td>{{ j.userEmail ?? '—' }}</td>
                <td><span class="ac__pill" [attr.data-tone]="j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : 'warn'"><i></i>{{ j.status }}</span></td>
                <td>{{ j.createdAt | date: 'd MMM, HH:mm' }}</td>
              </tr>
            } @empty {
              <tr><td colspan="4" class="ac__empty">No jobs in the last 7 days.</td></tr>
            }
          </tbody>
        </table>
      </div>
    } @else {
      <p class="muted">Loading…</p>
    }
  `
})
export class AdminJobsComponent implements OnInit, OnDestroy {
  private readonly api = inject(AdminService);
  private readonly notify = inject(NotificationService);
  readonly data = signal<JobsOverview | null>(null);
  private timer: ReturnType<typeof setInterval> | undefined;

  ngOnInit(): void {
    this.load();
    this.timer = setInterval(() => this.load(), 10_000);
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }

  load(): void {
    this.api.jobs().subscribe({ next: (d) => this.data.set(d), error: () => undefined });
  }

  cancel(id: string): void {
    this.api.cancelJob(id).subscribe({
      next: () => {
        this.notify.success('Job cancelled.');
        this.load();
      },
      error: (err) => this.notify.error(errorText(err, 'The job could not be cancelled.'))
    });
  }
}

// =============================== Logs ===============================

@Component({
  selector: 'app-admin-logs',
  standalone: true,
  imports: [FormsModule, SlicePipe],
  styles: SECTION_STYLES,
  template: `
    <header class="ac__head">
      <div>
        <h1 class="ac__title">Logs</h1>
        <p class="ac__sub">Recent warnings and errors — find problems without a terminal. Newest first.</p>
      </div>
      <button type="button" class="ac__btn" (click)="load()"><i class="pi pi-refresh" [class.pi-spin]="loading()"></i> Refresh</button>
    </header>
    <div class="ac__toolbar">
      <select class="ac__select" [(ngModel)]="source" (ngModelChange)="load()" aria-label="Source">
        <option value="backend">Application (backend)</option>
        <option value="geoserver">Map server (GeoServer)</option>
      </select>
      <select class="ac__select" [(ngModel)]="level" (ngModelChange)="load()" aria-label="Level">
        <option value="">Warnings and errors</option>
        <option value="error">Errors only</option>
        <option value="warn">Warnings only</option>
      </select>
      <span class="ac__search">
        <i class="pi pi-search" aria-hidden="true"></i>
        <input type="search" placeholder="Search" [(ngModel)]="q" (ngModelChange)="searchSoon()" aria-label="Search logs" />
      </span>
      <span class="muted">{{ entries().length }} entries</span>
    </div>
    <div class="ac__card ac__card--flush">
      <ul class="sx__log">
        @for (e of entries(); track $index) {
          <li>
            <span class="sx__lvl" [class.is-error]="e.level === 'error'" [class.is-severe]="e.level === 'severe'">{{ e.level }}</span>
            <span class="muted">{{ e.at.length > 16 ? (e.at | slice: 0 : 19).replace('T', ' ') : e.at }} · {{ e.context }}</span>
            <pre>{{ e.message }}</pre>
          </li>
        } @empty {
          <li class="ac__empty">{{ loading() ? 'Loading…' : error() || 'No warnings or errors — all quiet.' }}</li>
        }
      </ul>
    </div>
    @if (source === 'backend') {
      <p class="muted">Application logs are kept in memory since the last restart (newest 2,000).</p>
    }
  `
})
export class AdminLogsComponent implements OnInit {
  private readonly api = inject(AdminService);
  readonly entries = signal<LogEntry[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  source: 'backend' | 'geoserver' = 'backend';
  level = '';
  q = '';
  private timer: ReturnType<typeof setTimeout> | undefined;

  ngOnInit(): void {
    this.load();
  }

  searchSoon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(), 350);
  }

  load(): void {
    this.loading.set(true);
    this.error.set('');
    this.api.logs(this.source, this.level, this.q).subscribe({
      next: (e) => {
        this.entries.set(e);
        this.loading.set(false);
      },
      error: (err) => {
        this.entries.set([]);
        this.loading.set(false);
        this.error.set(errorText(err, 'Logs could not be read.'));
      }
    });
  }
}

// =============================== Data check ===============================

@Component({
  selector: 'app-admin-integrity',
  standalone: true,
  imports: [DatePipe],
  styles: SECTION_STYLES,
  template: `
    <header class="ac__head">
      <div>
        <h1 class="ac__title">Data check</h1>
        <p class="ac__sub">Compares the database, GeoServer and stored files, and finds anything that doesn't match.</p>
      </div>
      <button type="button" class="ac__btn ac__btn--primary" [disabled]="loading()" (click)="load()"><i class="pi pi-search" [class.pi-spin]="loading()"></i> Run check</button>
    </header>
    @if (report(); as r) {
      <p class="muted">{{ r.counts.layers }} layers · {{ r.counts.geoserverLayers }} GeoServer layers · {{ r.counts.tables }} layer tables · checked {{ r.checkedAt | date: 'HH:mm:ss' }}</p>
      <div class="ac__card ac__card--flush">
        @for (i of r.issues; track i.kind + i.id) {
          <div class="sx__issue">
            <i class="pi pi-exclamation-triangle"></i>
            <div><b>{{ i.title }}</b><span>{{ i.detail }}</span></div>
            @if (i.fixable) {
              <button type="button" class="ac__btn ac__btn--sm" (click)="fix(i.kind, i.id, i.title)">Fix</button>
            }
          </div>
        } @empty {
          <div class="sx__ok"><i class="pi pi-check-circle"></i> Everything matches — no problems found.</div>
        }
      </div>
    } @else {
      <p class="muted">{{ loading() ? 'Checking…' : 'Run the check to look for problems.' }}</p>
    }
  `
})
export class AdminIntegrityComponent implements OnInit {
  private readonly api = inject(AdminService);
  private readonly notify = inject(NotificationService);
  readonly report = signal<IntegrityReport | null>(null);
  readonly loading = signal(false);
  readonly ago = ago;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.integrity().subscribe({
      next: (r) => {
        this.report.set(r);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.notify.error(errorText(err, 'The check could not run.'));
      }
    });
  }

  fix(kind: string, id: string, title: string): void {
    this.notify.confirm({
      header: 'Fix this problem?',
      message: `${title}. This removes the leftover permanently — it belongs to no layer.`,
      confirmLabel: 'Fix',
      destructive: true,
      accept: () =>
        this.api.fixIntegrity(kind, id).subscribe({
          next: () => {
            this.notify.success('Fixed.');
            this.load();
          },
          error: (err) => this.notify.error(errorText(err, 'It could not be fixed.'))
        })
    });
  }
}
