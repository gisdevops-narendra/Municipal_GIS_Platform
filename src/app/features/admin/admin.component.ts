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
import { AdminAccount, AdminService, AdminStats, AdminUser, AuditEntry } from '../../core/services/admin.service';

type View = 'overview' | 'accounts' | 'activity';
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
  'backup.failed': { label: 'Backup failed', icon: 'pi-save', tone: 'bad' },
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
  imports: [ButtonModule, DatePipe, DecimalPipe, JsonPipe],
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
    if (view === 'overview') this.loadOverview();
    else if (view === 'accounts') this.loadAccounts();
    else this.loadAudit();
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
