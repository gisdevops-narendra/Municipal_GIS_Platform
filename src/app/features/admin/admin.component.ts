import { FormsModule } from '@angular/forms';
import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe, JsonPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { NotificationService } from '../../core/services/notification.service';
import { AuthService } from '../../core/services/auth.service';
import { CurrentUserService } from '../../core/services/current-user.service';
import { SettingsDialogService } from '../../core/services/settings-dialog.service';
import { SettingsService } from '../../core/services/settings.service';
import { ThemeService } from '../../core/theme/theme.service';
import { ActiveSession, AdminAccount, AdminService, AdminStats, AdminUser, AuditEntry, BackupList, RetentionSettings, StorageReport } from '../../core/services/admin.service';

type View = 'overview' | 'accounts' | 'activity' | 'sessions' | 'backups' | 'storage';
type StatusFilter = 'all' | 'active' | 'disabled' | 'near-limit';
const MB = 1024 * 1024;

interface ActionMeta {
  label: string;
  icon: string;
  tone: 'ok' | 'info' | 'warn' | 'bad';
}

/** Readable label, icon and colour for every audit action. */
const ACTIONS: Record<string, ActionMeta> = {
  'account.created': { label: 'Account created', icon: 'pi-user-plus', tone: 'ok' },
  'account.email_changed': { label: 'Email changed', icon: 'pi-envelope', tone: 'info' },
  'account.deleted': { label: 'Account deleted', icon: 'pi-user-minus', tone: 'bad' },
  'signup.blocked': { label: 'Sign-up blocked', icon: 'pi-ban', tone: 'bad' },
  'layer.published': { label: 'Layer published', icon: 'pi-upload', tone: 'ok' },
  'layer.updated': { label: 'Layer updated', icon: 'pi-refresh', tone: 'info' },
  'layer.deleted': { label: 'Layer deleted', icon: 'pi-trash', tone: 'warn' },
  'upload.failed': { label: 'Upload failed', icon: 'pi-exclamation-triangle', tone: 'bad' },
  'admin.user_disabled': { label: 'Account disabled', icon: 'pi-lock', tone: 'warn' },
  'admin.user_enabled': { label: 'Account enabled', icon: 'pi-lock-open', tone: 'ok' },
  'admin.storage_limit_changed': { label: 'Storage limit changed', icon: 'pi-database', tone: 'info' },
  'admin.granted': { label: 'Admin granted', icon: 'pi-shield', tone: 'warn' },
  'admin.revoked': { label: 'Admin revoked', icon: 'pi-shield', tone: 'info' },
  'backup.completed': { label: 'Backup completed', icon: 'pi-save', tone: 'ok' },
  'backup.requested': { label: 'Backup requested', icon: 'pi-save', tone: 'info' },
  'backup.restored': { label: 'Backup restored', icon: 'pi-history', tone: 'warn' },
  'restore.requested': { label: 'Restore requested', icon: 'pi-history', tone: 'warn' },
  'restore.dry_run_requested': { label: 'Restore test requested', icon: 'pi-history', tone: 'info' },
  'restore.failed': { label: 'Restore failed', icon: 'pi-history', tone: 'bad' },
  'session.ended': { label: 'Session ended', icon: 'pi-sign-out', tone: 'warn' },
  'session.user_signed_out': { label: 'User signed out everywhere', icon: 'pi-sign-out', tone: 'warn' },
  'storage.cleanup': { label: 'Storage cleaned up', icon: 'pi-trash', tone: 'info' },
  'storage.retention_changed': { label: 'Retention changed', icon: 'pi-sliders-h', tone: 'info' },
  'backup.failed': { label: 'Backup failed', icon: 'pi-save', tone: 'bad' },
  'system.geoserver_restarted': { label: 'GeoServer restarted', icon: 'pi-replay', tone: 'warn' },
  'system.geoserver_restart_failed': { label: 'GeoServer restart failed', icon: 'pi-replay', tone: 'bad' },
};

/**
 * Platform admin console: its own layout (sidebar + content), separate from
 * the map app. Overview (numbers, recent activity, largest accounts),
 * Accounts (table + detail panel: users, storage limit, disable/delete,
 * activity) and the Activity log. Admins only — route guard plus a
 * server-side guard on every /api/admin call.
 */
@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [ButtonModule, DatePipe, DecimalPipe, JsonPipe, FormsModule],
  templateUrl: './admin.component.html',
  styleUrl: './admin.component.scss',
})
export class AdminComponent {
  private readonly api = inject(AdminService);
  private readonly notify = inject(NotificationService);
  private readonly auth = inject(AuthService);
  private readonly settings = inject(SettingsService);
  private readonly theme = inject(ThemeService);
  readonly settingsDialog = inject(SettingsDialogService);

  readonly view = signal<View>('overview');
  readonly navOpen = signal(false);
  readonly me = signal<{ name: string; email: string } | null>(null);
  readonly menuOpen = signal(false);
  readonly isDark = computed(() => {
    this.settings.theme();
    return this.theme.resolvedTheme() === 'dark';
  });

  // ----- overview -----
  readonly stats = signal<AdminStats | null>(null);
  readonly recent = signal<AuditEntry[]>([]);
  readonly allAccounts = signal<AdminAccount[]>([]);
  readonly topStorage = computed(() =>
    [...this.allAccounts()].sort((a, b) => b.usedBytes - a.usedBytes).slice(0, 6),
  );
  readonly maxStorage = computed(() => Math.max(1, ...this.topStorage().map((a) => a.usedBytes)));
  readonly totalStorage = computed(() => this.allAccounts().reduce((s, a) => s + a.usedBytes, 0));

  // ----- accounts -----
  readonly accounts = signal<AdminAccount[]>([]);
  readonly accountsTotal = signal(0);
  readonly accountsPage = signal(1);
  readonly accountQuery = signal('');
  readonly statusFilter = signal<StatusFilter>('all');
  readonly accountsLoading = signal(false);
  readonly rowMenu = signal<string | null>(null);
  readonly busyId = signal<string | null>(null);
  readonly accountPages = computed(() => Math.max(1, Math.ceil(this.accountsTotal() / 25)));
  /** One row per person (sign-in). People in an old shared workspace
   *  each get their own row, tagged as sharing it. */
  readonly rows = computed(() => {
    const f = this.statusFilter();
    return this.accounts()
      .flatMap((a) => a.users.filter((u) => !u.isPlatformAdmin).map((user) => ({ account: a, user })))
      .filter(({ account, user }) =>
        f === 'all'
          ? true
          : f === 'active'
            ? user.status !== 'DISABLED'
            : f === 'disabled'
              ? user.status === 'DISABLED'
              : this.pct(account) >= 80,
      );
  });
  readonly peopleCount = computed(() =>
    this.accounts().reduce((n, a) => n + a.users.filter((u) => !u.isPlatformAdmin).length, 0),
  );

  // ----- detail panel -----
  readonly selected = signal<AdminAccount | null>(null);
  /** The person the detail panel was opened for (its actions apply to them). */
  readonly selectedUser = signal<AdminUser | null>(null);
  readonly selectedActivity = signal<AuditEntry[]>([]);
  quotaDraft = '';

  // ----- activity -----
  readonly audit = signal<AuditEntry[]>([]);
  readonly auditTotal = signal(0);
  readonly auditPage = signal(1);
  readonly auditQuery = signal('');
  readonly auditAction = signal('');
  readonly auditLoading = signal(false);
  readonly expandedAudit = signal<string | null>(null);
  readonly auditPages = computed(() => Math.max(1, Math.ceil(this.auditTotal() / 50)));
  readonly actionOptions = Object.entries(ACTIONS).map(([value, m]) => ({ value, label: m.label }));

  private searchTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    inject(CurrentUserService)
      .getMe()
      .subscribe({ next: (u) => this.me.set({ name: u.name, email: u.email }), error: () => undefined });
    this.loadOverview();
  }

  // ===== navigation =====
  go(view: View): void {
    this.view.set(view);
    this.navOpen.set(false);
    clearTimeout(this.backupPoll);
    if (view === 'overview') this.loadOverview();
    else if (view === 'accounts') this.loadAccounts();
    else if (view === 'sessions') this.loadSessions();
    else if (view === 'backups') this.loadBackups();
    else if (view === 'storage') this.loadStorage();
    else this.loadAudit();
  }

  // ===== sessions =====
  readonly sessionList = signal<ActiveSession[]>([]);
  readonly sessionsLoading = signal(false);
  readonly sessionQuery = signal('');
  readonly filteredSessions = computed(() => {
    const q = this.sessionQuery().trim().toLowerCase();
    return q ? this.sessionList().filter((s) => `${s.name} ${s.email} ${s.account ?? ''} ${s.ip}`.toLowerCase().includes(q)) : this.sessionList();
  });
  readonly signedInUsers = computed(() => new Set(this.sessionList().map((s) => s.userId)).size);

  loadSessions(): void {
    this.sessionsLoading.set(true);
    this.api.sessions().subscribe({
      next: (list) => {
        this.sessionList.set(list);
        this.sessionsLoading.set(false);
      },
      error: () => {
        this.sessionsLoading.set(false);
        this.notify.error('Could not load the active sessions.');
      }
    });
  }

  endSession(s: ActiveSession): void {
    this.notify.confirm({
      header: s.current ? 'Sign out this browser?' : `End ${s.name}'s session?`,
      message: s.current ? 'This is your own current session — you will be signed out.' : `The browser at ${s.ip.replace('::ffff:', '')} is signed out at its next request.`,
      confirmLabel: 'End session',
      destructive: true,
      accept: () =>
        this.api.endSession(s.id).subscribe({
          next: () => (s.current ? this.logout() : this.loadSessions()),
          error: () => this.notify.error('The session could not be ended.')
        })
    });
  }

  signOutEverywhere(s: ActiveSession): void {
    this.notify.confirm({
      header: `Sign ${s.name} out everywhere?`,
      message: 'Every browser and device of this person is signed out.',
      confirmLabel: 'Sign out everywhere',
      destructive: true,
      accept: () =>
        this.api.signOutUser(s.userId).subscribe({
          next: () => (s.current ? this.logout() : this.loadSessions()),
          error: () => this.notify.error('Could not sign this person out.')
        })
    });
  }

  ago(iso: string): string {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  }

  // ===== backups =====
  readonly backupList = signal<BackupList | null>(null);
  readonly backupsLoading = signal(false);
  readonly verifying = signal<string | null>(null);
  readonly restoreTarget = signal<string | null>(null);
  restoreParts: Record<'db' | 'geoserver' | 'storage' | 'keycloak', boolean> = { db: true, geoserver: true, storage: true, keycloak: true };
  restoreConfirm = '';
  private backupPoll: ReturnType<typeof setTimeout> | undefined;

  loadBackups(): void {
    this.backupsLoading.set(true);
    clearTimeout(this.backupPoll);
    this.api.backups().subscribe({
      next: (b) => {
        this.backupList.set(b);
        this.backupsLoading.set(false);
        // Keep the page live while a request is queued / running.
        if (this.view() === 'backups' && (b.inProgress || b.requests.some((r) => r.state === 'queued' || r.state === 'running'))) {
          this.backupPoll = setTimeout(() => this.loadBackups(), 5000);
        }
      },
      error: () => {
        this.backupsLoading.set(false);
        // A restore restarts the backend — keep trying while it comes back.
        if (this.view() === 'backups') this.backupPoll = setTimeout(() => this.loadBackups(), 8000);
      }
    });
  }

  backupNow(): void {
    this.api.backupNow().subscribe({
      next: () => {
        this.notify.success('A full backup has started on the server. It takes a few minutes.', 'Backup');
        this.loadBackups();
      },
      error: (err) => this.notify.error(err?.error?.message ?? 'The backup could not be started.', 'Backup')
    });
  }

  verifyBackup(stamp: string): void {
    this.verifying.set(stamp);
    this.api.verifyBackup(stamp).subscribe({
      next: (r) => {
        this.verifying.set(null);
        r.ok ? this.notify.success(r.message, `Backup ${stamp}`) : this.notify.error(r.message, `Backup ${stamp} is damaged`);
      },
      error: () => {
        this.verifying.set(null);
        this.notify.error('The check could not run.');
      }
    });
  }

  downloadBackupFile(stamp: string, file: string): void {
    this.api.backupFile(stamp, file).subscribe({
      next: (blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `municipal-gis-${stamp}-${file}`;
        a.click();
        URL.revokeObjectURL(a.href);
      },
      error: () => this.notify.error('The file could not be downloaded.')
    });
  }

  openRestore(stamp: string): void {
    this.restoreTarget.set(stamp);
    this.restoreParts = { db: true, geoserver: true, storage: true, keycloak: true };
    this.restoreConfirm = '';
  }

  chosenParts(): string[] {
    return (Object.keys(this.restoreParts) as (keyof typeof this.restoreParts)[]).filter((k) => this.restoreParts[k]);
  }

  startRestore(dryRun: boolean): void {
    const stamp = this.restoreTarget();
    if (!stamp) return;
    this.api.restore(stamp, this.chosenParts(), dryRun, this.restoreConfirm.trim()).subscribe({
      next: () => {
        this.restoreTarget.set(null);
        this.notify.success(
          dryRun
            ? 'Test run queued — it checks the backup and lists every step without changing anything.'
            : 'Restore queued. A safety backup of the current state is taken first; the platform is briefly unavailable while it restores.',
          dryRun ? 'Restore test' : 'Restore'
        );
        this.loadBackups();
      },
      error: (err) => this.notify.error(err?.error?.message ?? 'The restore could not be started.', 'Restore')
    });
  }

  readonly downloadMenu = signal<string | null>(null);
  readonly backupsTotal = computed(() => (this.backupList()?.backups ?? []).reduce((t, b) => t + b.totalBytes, 0));

  /** The parts worth downloading (checksums / manifest stay internal). */
  downloadable(b: { files: { name: string; bytes: number }[] }) {
    return b.files.filter((f) => ['db.dump', 'geoserver-data.tar.gz', 'storage.tar', 'keycloak-users.json'].includes(f.name));
  }

  /** "Today", "Yesterday", "3 days ago", or the date. */
  relDay(iso: string): string {
    const d = new Date(iso);
    const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((start(new Date()) - start(d)) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  /** The nightly run at 02:30 local time. */
  nextBackupLabel(): string {
    const now = new Date();
    const next = new Date(now);
    next.setHours(2, 30, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getDate() === now.getDate() ? 'Tonight, 02:30' : 'Tomorrow, 02:30';
  }

  fileLabel(name: string): string {
    return ({ 'db.dump': 'Database', 'geoserver-data.tar.gz': 'Map server settings', 'storage.tar': 'Uploaded files', 'keycloak-realm.json': 'Login settings', 'keycloak-users.json': 'User list', SHA256SUMS: 'Checksums', 'manifest.txt': 'Manifest' } as Record<string, string>)[name] ?? name;
  }

  // ===== storage =====
  readonly storageReport = signal<StorageReport | null>(null);
  readonly storageLoading = signal(false);
  readonly cleaning = signal(false);
  retention: RetentionSettings = { tempDays: 1, georefDays: 0, cacheDays: 0, publishedOriginalsDays: 0, auditDays: 0 };
  readonly storageRows = computed(() => {
    const r = this.storageReport();
    if (!r) return [];
    const label: Record<string, string> = {
      uploads: 'Original upload files',
      rasters: 'Rasters',
      tiles: 'Vector tile archives',
      georef: 'Georeferencer scans',
      cache: 'Imagery download cache',
      temp: 'Temporary files'
    };
    const rows = Object.entries(r.categories).map(([k, v]) => ({ key: k, label: label[k] ?? k, ...v }));
    rows.push({ key: 'db', label: 'Database (layers, accounts)', bytes: r.database.bytes, files: 0 });
    rows.push({ key: 'backups', label: 'Backups', bytes: r.backups.bytes, files: r.backups.files });
    const max = Math.max(1, ...rows.map((x) => x.bytes));
    return rows.sort((a, b) => b.bytes - a.bytes).map((x) => ({ ...x, pct: (100 * x.bytes) / max }));
  });

  loadStorage(): void {
    this.storageLoading.set(true);
    this.api.storage().subscribe({
      next: (r) => {
        this.storageReport.set(r);
        this.retention = { ...r.retention };
        this.storageLoading.set(false);
      },
      error: () => {
        this.storageLoading.set(false);
        this.notify.error('Could not load the storage report.');
      }
    });
  }

  saveRetention(): void {
    this.api.setRetention(this.retention).subscribe({
      next: (r) => {
        this.retention = { ...r };
        this.notify.success('Retention settings saved. The daily cleanup uses them from now on.', 'Storage');
      },
      error: (err) => this.notify.error(err?.error?.message?.toString() ?? 'The settings could not be saved.', 'Storage')
    });
  }

  runCleanup(): void {
    this.notify.confirm({
      header: 'Clean up now?',
      message: 'Deletes what the retention settings allow (temporary files, and anything else you set a period for).',
      confirmLabel: 'Clean up',
      accept: () => {
        this.cleaning.set(true);
        this.api.cleanup().subscribe({
          next: (r) => {
            this.cleaning.set(false);
            this.notify.success(`Freed ${this.bytes(r.freedBytes)}.`, 'Storage cleanup');
            this.loadStorage();
          },
          error: (err) => {
            this.cleaning.set(false);
            this.notify.error(err?.error?.message ?? 'The cleanup failed.', 'Storage cleanup');
          }
        });
      }
    });
  }

  bytes(n: number): string {
    if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
    if (n >= 1048576) return `${(n / 1048576).toFixed(0)} MB`;
    return `${Math.max(0, Math.round(n / 1024))} KB`;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (document.querySelector('.p-confirmdialog')) return;
    if (this.rowMenu()) this.rowMenu.set(null);
    else if (this.selected()) this.closeDetail();
    else this.menuOpen.set(false);
  }

  /** Closes an open row menu when clicking anywhere else. */
  @HostListener('document:click')
  onDocumentClick(): void {
    if (this.rowMenu()) this.rowMenu.set(null);
  }

  initials(name: string | null | undefined, email?: string | null): string {
    const src = (name || email || '?').replace(/@.*/, '').trim();
    const parts = src.split(/[\s._-]+/).filter(Boolean);
    return ((parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : src.slice(0, 2)) || '?').toUpperCase();
  }

  // ===== overview =====
  loadOverview(): void {
    this.api.stats().subscribe({ next: (s) => this.stats.set(s), error: (e) => this.fail(e) });
    this.api.audit({}, 1, 8).subscribe({ next: (p) => this.recent.set(p.items), error: () => undefined });
    this.api.accounts('', 1, 200).subscribe({ next: (p) => this.allAccounts.set(p.items), error: () => undefined });
  }

  // ===== accounts =====
  loadAccounts(): void {
    this.accountsLoading.set(true);
    this.api.accounts(this.accountQuery(), this.accountsPage()).subscribe({
      next: (p) => {
        this.accounts.set(p.items);
        this.accountsTotal.set(p.total);
        this.accountsLoading.set(false);
        this.syncServerDeletes(p.items);
        const sel = this.selected();
        if (sel) {
          const fresh = p.items.find((a) => a.id === sel.id) ?? sel;
          this.selected.set(fresh);
          const u = this.selectedUser();
          if (u) this.selectedUser.set(fresh.users.find((x) => x.id === u.id) ?? u);
        }
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

  tone(a: AdminAccount): 'ok' | 'warn' | 'bad' {
    const p = this.pct(a);
    return p >= 95 ? 'bad' : p >= 80 ? 'warn' : 'ok';
  }

  /** Row "⋯" menu opens upward when there isn't room below it. */
  readonly rowMenuUp = signal(false);

  toggleRowMenu(id: string, event: Event): void {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.rowMenuUp.set(window.innerHeight - rect.bottom < 220);
    this.rowMenu.update((cur) => (cur === id ? null : id));
  }

  // ----- detail panel -----
  openDetail(a: AdminAccount, user: AdminUser | null = a.owner): void {
    this.rowMenu.set(null);
    this.selected.set(a);
    this.selectedUser.set(user);
    this.quotaDraft = a.quotaMb === null ? '' : String(a.quotaMb);
    this.selectedActivity.set([]);
    this.api.audit({ accountId: a.id }, 1, 10).subscribe({
      next: (p) => this.selectedActivity.set(p.items),
      error: () => undefined,
    });
  }

  closeDetail(): void {
    this.selected.set(null);
  }

  saveQuota(a: AdminAccount): void {
    const raw = this.quotaDraft.trim();
    const quota = raw === '' || raw === '0' ? null : Math.round(Number(raw));
    if (quota !== null && (!Number.isFinite(quota) || quota < 1)) {
      this.notify.error('Enter a whole number of MB, or leave it empty for unlimited.');
      return;
    }
    this.busyId.set(a.id);
    this.api.setQuota(a.id, quota).subscribe({
      next: () => {
        this.busyId.set(null);
        this.notify.success(`Storage limit set to ${quota === null ? 'unlimited' : quota.toLocaleString() + ' MB'}.`);
        this.loadAccounts();
      },
      error: (e) => {
        this.busyId.set(null);
        this.fail(e);
      },
    });
  }

  /** Admin actions running in the background, shown as cards in the
   *  corner — the page stays usable while they run. */
  readonly ops = signal<AdminOp[]>([]);
  /** People being deleted right now (their rows show "Deleting…"). */
  readonly deleting = signal<ReadonlySet<string>>(new Set());
  private opSeq = 0;

  private startOp(title: string, detail: string): number {
    const id = ++this.opSeq;
    this.ops.update((l) => [...l, { id, state: 'running', title, detail }]);
    return id;
  }

  private finishOp(id: number, patch: Omit<AdminOp, 'id'>): void {
    this.ops.update((l) => l.map((o) => (o.id === id ? { id, ...patch } : o)));
    // Successes tidy themselves away; errors stay until dismissed.
    if (patch.state === 'done') setTimeout(() => this.dismissOp(id), 10000);
  }

  dismissOp(id: number): void {
    this.ops.update((l) => l.filter((o) => o.id !== id));
  }

  /** Deletes that were already running on the server when this page
   *  loaded (e.g. after a reload): userId → progress card id. */
  private readonly resumed = new Map<string, { opId: number; name: string; email: string }>();
  private resumeTimer?: ReturnType<typeof setTimeout>;

  private syncServerDeletes(items: AdminAccount[]): void {
    const users = new Map(items.flatMap((a) => a.users).map((u) => [u.id, u]));
    for (const u of users.values()) {
      if (u.deleting && !this.deleting().has(u.id)) {
        this.markDeleting(u.id, true);
        const opId = this.startOp(`Deleting ${u.fullName}…`, 'Still running on the server — keep working, this updates by itself.');
        this.resumed.set(u.id, { opId, name: u.fullName, email: u.email });
      }
    }
    for (const [id, r] of this.resumed) {
      const u = users.get(id);
      if (u?.deleting) continue;
      this.resumed.delete(id);
      this.markDeleting(id, false);
      this.finishOp(
        r.opId,
        u
          ? { state: 'error', title: `Couldn't delete ${r.name}`, detail: `${r.email} still exists — the delete stopped. Try again.` }
          : { state: 'done', title: `${r.name} deleted`, detail: `${r.email} no longer exists.` },
      );
      if (!u) this.loadOverview();
    }
    clearTimeout(this.resumeTimer);
    if (this.resumed.size) this.resumeTimer = setTimeout(() => this.loadAccounts(), 5000);
  }

  private markDeleting(id: string, on: boolean): void {
    this.deleting.update((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  toggleStatus(a: AdminAccount, user: AdminUser | null = a.owner): void {
    this.rowMenu.set(null);
    if (!user) return;
    const disable = user.status === 'ACTIVE';
    this.notify.confirm({
      header: disable ? `Disable ${user.fullName}?` : `Enable ${user.fullName}?`,
      message: disable
        ? `${user.email} will be signed out right away and won't be able to sign in. Nothing is deleted — you can enable the account again at any time.`
        : `${user.email} will be able to sign in again.`,
      confirmLabel: disable ? 'Disable account' : 'Enable account',
      destructive: disable,
      accept: () => {
        this.busyId.set(a.id);
        const opId = this.startOp(disable ? 'Disabling account…' : 'Enabling account…', user.email);
        this.api.setUserStatus(user.id, disable ? 'DISABLED' : 'ACTIVE').subscribe({
          next: () => {
            this.busyId.set(null);
            this.finishOp(opId, {
              state: 'done',
              title: disable ? 'Account disabled' : 'Account enabled',
              detail: user.email,
              lines: disable
                ? ['Signed out of every device', "Can't sign in until enabled again", 'All data kept']
                : ['Can sign in again'],
            });
            this.loadAccounts();
            this.loadOverview();
          },
          error: (e: HttpErrorResponse) => {
            this.busyId.set(null);
            this.finishOp(opId, { state: 'error', title: "Couldn't change the account", detail: `${user.email}: ${this.errorText(e)}` });
          },
        });
      },
    });
  }

  deleteAccount(a: AdminAccount, user: AdminUser | null = a.owner): void {
    this.rowMenu.set(null);
    if (!user || this.deleting().has(user.id)) return;
    const wholeAccount = a.users.length === 1;
    const removed = wholeAccount
      ? [
          `${user.fullName} (${user.email}) and their sign-in`,
          `${a.layerCount} layer${a.layerCount === 1 ? '' : 's'} and all uploads`,
          `${this.size(a.usedBytes)} of data, files and the map workspace`,
        ]
      : [
          `${user.fullName} (${user.email}) and their sign-in`,
          `The shared workspace and its ${a.layerCount} layer${a.layerCount === 1 ? '' : 's'} stay — ${a.users.length - 1} other ${a.users.length - 1 === 1 ? 'person still uses' : 'people still use'} it`,
        ];
    this.notify.confirm({
      header: `Delete ${user.fullName}?`,
      message: `This permanently removes: ${removed.join('; ')}. This can't be undone.`,
      confirmLabel: 'Delete permanently',
      destructive: true,
      accept: () => {
        this.closeDetail();
        this.markDeleting(user.id, true);
        const opId = this.startOp(
          `Deleting ${user.fullName}…`,
          wholeAccount
            ? `Removing ${a.layerCount} layer${a.layerCount === 1 ? '' : 's'}, files and the map workspace. Runs in the background — keep working.`
            : `Removing ${user.email}. Runs in the background — keep working.`,
        );
        this.api.deleteUser(user.id).subscribe({
          next: () => {
            this.markDeleting(user.id, false);
            this.finishOp(opId, { state: 'done', title: `${user.fullName} deleted`, detail: `${user.email} no longer exists.`, lines: removed });
            this.loadAccounts();
            this.loadOverview();
          },
          error: (e: HttpErrorResponse) => {
            this.markDeleting(user.id, false);
            this.finishOp(opId, { state: 'error', title: `Couldn't delete ${user.fullName}`, detail: this.errorText(e) });
            this.loadAccounts();
          },
        });
      },
    });
  }

  private errorText(e: HttpErrorResponse): string {
    return (e.error?.message as string) ?? 'Something went wrong. Please try again.';
  }

  // ===== activity =====
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

  showAccountActivity(a: AdminAccount, user: AdminUser | null = a.owner): void {
    this.rowMenu.set(null);
    this.closeDetail();
    this.auditQuery.set(user?.email ?? '');
    this.auditAction.set('');
    this.auditPage.set(1);
    this.view.set('activity');
    this.loadAudit();
  }

  meta(action: string): ActionMeta {
    return ACTIONS[action] ?? { label: action, icon: 'pi-circle', tone: 'info' };
  }

  summary(e: AuditEntry): string {
    const d = e.details ?? {};
    if ('from' in d && 'to' in d) return `${d['from'] ?? 'none'} → ${d['to'] ?? 'none'}`;
    const parts: string[] = [];
    for (const key of ['name', 'email', 'file', 'size', 'reason', 'error']) {
      const v = d[key];
      if (v !== undefined && v !== null && v !== '') parts.push(`${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    return parts.join(' · ');
  }

  // ===== account menu =====
  toggleTheme(): void {
    this.settings.patch({ appearance: { theme: this.isDark() ? 'light' : 'dark' } });
  }

  openSettings(): void {
    this.menuOpen.set(false);
    this.settingsDialog.open();
  }

  logout(): void {
    this.menuOpen.set(false);
    void this.auth.logout();
  }

  private fail(e: HttpErrorResponse): void {
    this.notify.error((e.error?.message as string) ?? 'Something went wrong. Please try again.');
  }
}

interface AdminOp {
  id: number;
  state: 'running' | 'done' | 'error';
  title: string;
  detail: string;
  lines?: string[];
}
