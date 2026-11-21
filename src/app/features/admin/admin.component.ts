import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe, JsonPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { SiteHeaderComponent } from '../../shared/components/site-header/site-header.component';
import { NotificationService } from '../../core/services/notification.service';
import { AdminAccount, AdminService, AdminStats, AuditEntry } from '../../core/services/admin.service';

type Tab = 'overview' | 'accounts' | 'audit';
const MB = 1024 * 1024;

/** Readable labels for audit actions. */
const ACTION_LABELS: Record<string, string> = {
  'account.created': 'Account created',
  'account.email_changed': 'Email changed',
  'account.deleted': 'Account deleted',
  'signup.blocked': 'Sign-up blocked',
  'layer.published': 'Layer published',
  'layer.updated': 'Layer updated',
  'layer.deleted': 'Layer deleted',
  'upload.failed': 'Upload failed',
  'admin.user_disabled': 'User disabled',
  'admin.user_enabled': 'User enabled',
  'admin.storage_limit_changed': 'Storage limit changed',
  'admin.granted': 'Admin granted',
  'admin.revoked': 'Admin revoked',
  'backup.completed': 'Backup completed',
  'backup.failed': 'Backup failed',
};

/**
 * Platform admin: overview numbers, every account (usage, limit, status —
 * set limit / disable / delete) and the audit log. Platform admins only
 * (route guard + server-side guard on every /api/admin call).
 */
@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [ButtonModule, SiteHeaderComponent, DatePipe, DecimalPipe, JsonPipe],
  templateUrl: './admin.component.html',
  styleUrl: './admin.component.scss',
})
export class AdminComponent {
  private readonly api = inject(AdminService);
  private readonly notify = inject(NotificationService);

  readonly tab = signal<Tab>('overview');
  readonly stats = signal<AdminStats | null>(null);

  // accounts
  readonly accounts = signal<AdminAccount[]>([]);
  readonly accountsTotal = signal(0);
  readonly accountsPage = signal(1);
  readonly accountQuery = signal('');
  readonly accountsLoading = signal(false);
  readonly editingQuota = signal<string | null>(null);
  quotaDraft = '';
  readonly busyId = signal<string | null>(null);

  // audit
  readonly audit = signal<AuditEntry[]>([]);
  readonly auditTotal = signal(0);
  readonly auditPage = signal(1);
  readonly auditQuery = signal('');
  readonly auditAction = signal('');
  readonly auditLoading = signal(false);
  readonly expandedAudit = signal<string | null>(null);
  readonly actionOptions = Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label }));

  readonly accountPages = computed(() => Math.max(1, Math.ceil(this.accountsTotal() / 25)));
  readonly auditPages = computed(() => Math.max(1, Math.ceil(this.auditTotal() / 50)));

  private searchTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.loadStats();
    this.loadAccounts();
    this.loadAudit();
  }

  /** Every tab shows fresh data when opened. */
  setTab(tab: Tab): void {
    this.tab.set(tab);
    if (tab === 'overview') this.loadStats();
    else if (tab === 'accounts') this.loadAccounts();
    else this.loadAudit();
  }

  // ----- overview -----
  loadStats(): void {
    this.api.stats().subscribe({ next: (s) => this.stats.set(s), error: (e) => this.fail(e) });
  }

  // ----- accounts -----
  loadAccounts(): void {
    this.accountsLoading.set(true);
    this.api.accounts(this.accountQuery(), this.accountsPage()).subscribe({
      next: (p) => {
        this.accounts.set(p.items);
        this.accountsTotal.set(p.total);
        this.accountsLoading.set(false);
      },
      error: (e) => {
        this.accountsLoading.set(false);
        this.fail(e);
      },
    });
  }

  searchAccounts(value: string): void {
    this.accountQuery.set(value);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.accountsPage.set(1);
      this.loadAccounts();
    }, 300);
  }

  accountsGo(page: number): void {
    this.accountsPage.set(page);
    this.loadAccounts();
  }

  size(bytes: number): string {
    if (bytes >= 1024 * MB) return `${(bytes / 1024 / MB).toFixed(2)} GB`;
    if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
    return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  }

  pct(a: AdminAccount): number {
    return a.quotaMb ? Math.min(100, (a.usedBytes / (a.quotaMb * MB)) * 100) : 0;
  }

  tone(a: AdminAccount): string {
    const p = this.pct(a);
    return p >= 95 ? 'is-bad' : p >= 80 ? 'is-warn' : 'is-ok';
  }

  startQuota(a: AdminAccount): void {
    this.editingQuota.set(a.id);
    this.quotaDraft = a.quotaMb === null ? '' : String(a.quotaMb);
  }

  saveQuota(a: AdminAccount): void {
    const raw = this.quotaDraft.trim();
    const quota = raw === '' || raw === '0' ? null : Math.round(Number(raw));
    if (quota !== null && (!Number.isFinite(quota) || quota < 1)) {
      this.notify.error('Enter a whole number of MB, or leave empty for unlimited.');
      return;
    }
    this.busyId.set(a.id);
    this.api.setQuota(a.id, quota).subscribe({
      next: () => {
        this.busyId.set(null);
        this.editingQuota.set(null);
        this.notify.success(`Storage limit for ${a.name} set to ${quota === null ? 'unlimited' : quota.toLocaleString() + ' MB'}.`);
        this.loadAccounts();
      },
      error: (e) => {
        this.busyId.set(null);
        this.fail(e);
      },
    });
  }

  toggleStatus(a: AdminAccount): void {
    const user = a.owner;
    if (!user) return;
    const disable = user.status === 'ACTIVE';
    this.notify.confirm({
      header: disable ? 'Disable account' : 'Enable account',
      message: disable
        ? `${user.email} will be signed out and can't sign in until re-enabled. Their data is kept.`
        : `${user.email} will be able to sign in again.`,
      confirmLabel: disable ? 'Disable' : 'Enable',
      destructive: disable,
      accept: () => {
        this.busyId.set(a.id);
        this.api.setUserStatus(user.id, disable ? 'DISABLED' : 'ACTIVE').subscribe({
          next: () => {
            this.busyId.set(null);
            this.notify.success(`${user.email} ${disable ? 'disabled' : 'enabled'}.`);
            this.loadAccounts();
          },
          error: (e) => {
            this.busyId.set(null);
            this.fail(e);
          },
        });
      },
    });
  }

  deleteAccount(a: AdminAccount): void {
    const user = a.owner;
    if (!user) return;
    this.notify.confirm({
      header: 'Delete account permanently',
      message: `Delete ${user.email}${a.users.length === 1 ? ` and all ${a.layerCount} layer(s) of “${a.name}”` : ''}? This can't be undone.`,
      confirmLabel: 'Delete permanently',
      destructive: true,
      accept: () => {
        this.busyId.set(a.id);
        this.api.deleteUser(user.id).subscribe({
          next: () => {
            this.busyId.set(null);
            this.notify.success(`${user.email} deleted.`);
            this.loadAccounts();
            this.loadStats();
          },
          error: (e) => {
            this.busyId.set(null);
            this.fail(e);
          },
        });
      },
    });
  }

  // ----- audit -----
  loadAudit(): void {
    this.auditLoading.set(true);
    this.api.audit({ q: this.auditQuery(), action: this.auditAction() }, this.auditPage()).subscribe({
      next: (p) => {
        this.audit.set(p.items);
        this.auditTotal.set(p.total);
        this.auditLoading.set(false);
      },
      error: (e) => {
        this.auditLoading.set(false);
        this.fail(e);
      },
    });
  }

  searchAudit(value: string): void {
    this.auditQuery.set(value);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.auditPage.set(1);
      this.loadAudit();
    }, 300);
  }

  filterAudit(action: string): void {
    this.auditAction.set(action);
    this.auditPage.set(1);
    this.loadAudit();
  }

  auditGo(page: number): void {
    this.auditPage.set(page);
    this.loadAudit();
  }

  /** Show the activity of one account (from the Accounts tab). */
  showAccountActivity(a: AdminAccount): void {
    this.auditQuery.set(a.owner?.email ?? '');
    this.auditAction.set('');
    this.auditPage.set(1);
    this.tab.set('audit');
    this.loadAudit();
  }

  actionLabel(action: string): string {
    return ACTION_LABELS[action] ?? action;
  }

  actionTone(action: string): string {
    if (action.endsWith('deleted') || action.endsWith('failed') || action.endsWith('disabled') || action.endsWith('blocked')) return 'is-bad';
    if (action.startsWith('admin.')) return 'is-warn';
    return 'is-ok';
  }

  summary(e: AuditEntry): string {
    const d = e.details ?? {};
    const parts: string[] = [];
    for (const key of ['name', 'email', 'file', 'from', 'to', 'reason', 'error']) {
      const v = d[key];
      if (v !== undefined && v !== null && v !== '') parts.push(`${key}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    return parts.join(' · ');
  }

  private fail(e: HttpErrorResponse): void {
    this.notify.error((e.error?.message as string) ?? 'Something went wrong. Please try again.');
  }
}
