import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminService, PlatformUser } from '../../../core/services/admin.service';
import { NotificationService } from '../../../core/services/notification.service';
import { ago, errorText } from './admin-utils';

/** Admin → Users: every person on the platform; invite, edit, password
 *  reset / verification emails, platform-admin rights. */
@Component({
  selector: 'app-admin-users',
  standalone: true,
  imports: [FormsModule, DatePipe],
  template: `
    <header class="ac__head">
      <div>
        <h1 class="ac__title">Users</h1>
        <p class="ac__sub">Every person on the platform. Invite someone, fix their details, or send them a password-reset link.</p>
      </div>
      <button type="button" class="ac__btn ac__btn--primary" (click)="openInvite()"><i class="pi pi-user-plus"></i> Invite user</button>
    </header>

    <div class="ac__toolbar">
      <span class="ac__search">
        <i class="pi pi-search" aria-hidden="true"></i>
        <input type="search" placeholder="Search name, email or account" [value]="q()" (input)="search($any($event.target).value)" aria-label="Search users" />
      </span>
      <span class="muted">{{ total() }} user{{ total() === 1 ? '' : 's' }}</span>
    </div>

    <div class="ac__card ac__card--flush">
      <table class="ac__table">
        <thead><tr><th>Person</th><th class="hide-sm">Account</th><th>Last active</th><th class="hide-sm">Joined</th><th>Status</th><th class="actions"></th></tr></thead>
        <tbody>
          @for (u of rows(); track u.id) {
            <tr (click)="open(u)" class="is-clickable">
              <td>
                <div class="ac__who">
                  <span class="ac__avatar">{{ initials(u) }}</span>
                  <span class="ac__who-text">
                    <span class="ac__who-name">{{ u.fullName }} @if (u.isPlatformAdmin) { <span class="ac__tag">Admin</span> }</span>
                    <span class="ac__who-email">{{ u.email }} @if (u.emailVerified === false) { <span class="ac__tag ac__tag--warn">not verified</span> }</span>
                  </span>
                </div>
              </td>
              <td class="hide-sm">{{ u.account?.name ?? '—' }}</td>
              <td>{{ ago(u.lastSeenAt) }}</td>
              <td class="hide-sm">{{ u.createdAt | date: 'd MMM y' }}</td>
              <td><span class="ac__pill" [attr.data-tone]="u.status === 'ACTIVE' ? 'ok' : 'bad'"><i></i>{{ u.status === 'ACTIVE' ? 'Active' : 'Disabled' }}</span></td>
              <td class="actions"><i class="pi pi-angle-right muted"></i></td>
            </tr>
          } @empty {
            <tr><td colspan="6" class="ac__empty">{{ loading() ? 'Loading…' : 'No users match.' }}</td></tr>
          }
        </tbody>
      </table>
    </div>
    @if (pages() > 1) {
      <div class="ac__pager">
        <button type="button" class="ac__icon-btn" [disabled]="page() <= 1" (click)="go(page() - 1)"><i class="pi pi-chevron-left"></i></button>
        <span class="muted">Page {{ page() }} of {{ pages() }}</span>
        <button type="button" class="ac__icon-btn" [disabled]="page() >= pages()" (click)="go(page() + 1)"><i class="pi pi-chevron-right"></i></button>
      </div>
    }

    @if (inviting()) {
      <div class="ac__drawer-backdrop" (click)="inviting.set(false)"></div>
      <aside class="ac__drawer" role="dialog" aria-modal="true" aria-label="Invite user">
        <header class="ac__drawer-head">
          <span class="ac__drawer-who"><span class="ac__drawer-name">Invite a user</span><span class="ac__drawer-email">They get their own account and an email to set a password</span></span>
          <button type="button" class="ac__icon-btn" (click)="inviting.set(false)"><i class="pi pi-times"></i></button>
        </header>
        <div class="ac__drawer-body">
          <label class="ac__field"><span>Full name</span><input type="text" [(ngModel)]="inviteName" maxlength="120" /></label>
          <label class="ac__field"><span>Email</span><input type="email" [(ngModel)]="inviteEmail" maxlength="200" /></label>
          <p class="muted">The link in the email is valid for 7 days. Emails go through the server in Admin → Email.</p>
        </div>
        <footer class="ac__drawer-foot">
          <button type="button" class="ac__btn" (click)="inviting.set(false)">Cancel</button>
          <button type="button" class="ac__btn ac__btn--primary" [disabled]="busy() || !inviteName.trim() || !inviteEmail.trim()" (click)="invite()">Send invitation</button>
        </footer>
      </aside>
    }

    @if (selected(); as u) {
      <div class="ac__drawer-backdrop" (click)="selected.set(null)"></div>
      <aside class="ac__drawer" role="dialog" aria-modal="true" aria-label="User details">
        <header class="ac__drawer-head">
          <span class="ac__avatar ac__avatar--lg">{{ initials(u) }}</span>
          <span class="ac__drawer-who"><span class="ac__drawer-name">{{ u.fullName }}</span><span class="ac__drawer-email">{{ u.email }}</span></span>
          <button type="button" class="ac__icon-btn" (click)="selected.set(null)"><i class="pi pi-times"></i></button>
        </header>
        <div class="ac__drawer-body">
          <dl class="ac__facts">
            <div><dt>Account</dt><dd>{{ u.account?.name ?? '—' }}</dd></div>
            <div><dt>Last active</dt><dd>{{ ago(u.lastSeenAt) }}</dd></div>
            <div><dt>Joined</dt><dd>{{ u.createdAt | date: 'd MMM y' }}</dd></div>
            <div><dt>Email</dt><dd>{{ u.emailVerified === false ? 'Not verified yet' : u.emailVerified ? 'Verified' : '—' }}</dd></div>
          </dl>
          <span class="ac__card-head ac__card-head--gap">Details</span>
          <label class="ac__field"><span>Full name</span><input type="text" [(ngModel)]="editName" maxlength="120" /></label>
          <label class="ac__field"><span>Email</span><input type="email" [(ngModel)]="editEmail" maxlength="200" /></label>
          <button type="button" class="ac__btn" [disabled]="busy() || (editName.trim() === u.fullName && editEmail.trim().toLowerCase() === u.email)" (click)="save(u)">Save details</button>

          <span class="ac__card-head ac__card-head--gap">Help with signing in</span>
          <div class="ac__btn-row">
            <button type="button" class="ac__btn" [disabled]="busy()" (click)="resetPassword(u)"><i class="pi pi-key"></i> Send password-reset email</button>
            @if (u.emailVerified === false) {
              <button type="button" class="ac__btn" [disabled]="busy()" (click)="verify(u)"><i class="pi pi-envelope"></i> Resend verification</button>
            }
          </div>

          <span class="ac__card-head ac__card-head--gap">Platform admin</span>
          <label class="ac__check"><input type="checkbox" [checked]="u.isPlatformAdmin" (change)="setAdmin(u, $any($event.target).checked)" />
            Can open this Admin console (admins have no map workspace)</label>
        </div>
      </aside>
    }
  `,
  styles: `
    .is-clickable { cursor: pointer; }
    .ac__tag--warn { background: #fef3c7; color: #92400e; }
    .ac__btn-row { display: flex; flex-wrap: wrap; gap: 8px; }
    .ac__drawer-body .ac__field { margin-bottom: 10px; }
  `
})
export class AdminUsersComponent implements OnInit {
  private readonly api = inject(AdminService);
  private readonly notify = inject(NotificationService);

  readonly rows = signal<PlatformUser[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pages = signal(1);
  readonly q = signal('');
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly inviting = signal(false);
  readonly selected = signal<PlatformUser | null>(null);
  readonly ago = ago;
  inviteName = '';
  inviteEmail = '';
  editName = '';
  editEmail = '';
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  ngOnInit(): void {
    this.load();
  }

  initials(u: PlatformUser): string {
    return (u.fullName || u.email).split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  }

  load(): void {
    this.loading.set(true);
    this.api.users(this.q(), this.page()).subscribe({
      next: (r) => {
        this.rows.set(r.rows);
        this.total.set(r.total);
        this.pages.set(Math.max(1, Math.ceil(r.total / r.pageSize)));
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.notify.error('Could not load users.');
      }
    });
  }

  search(value: string): void {
    this.q.set(value);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page.set(1);
      this.load();
    }, 300);
  }

  go(p: number): void {
    this.page.set(p);
    this.load();
  }

  open(u: PlatformUser): void {
    this.selected.set(u);
    this.editName = u.fullName;
    this.editEmail = u.email;
  }

  openInvite(): void {
    this.inviteName = '';
    this.inviteEmail = '';
    this.inviting.set(true);
  }

  private act(obs: import('rxjs').Observable<unknown>, ok: string, after?: () => void): void {
    this.busy.set(true);
    obs.subscribe({
      next: () => {
        this.busy.set(false);
        this.notify.success(ok);
        after?.();
      },
      error: (err) => {
        this.busy.set(false);
        this.notify.error(errorText(err, 'That did not work.'));
      }
    });
  }

  invite(): void {
    this.busy.set(true);
    this.api.inviteUser(this.inviteEmail.trim(), this.inviteName.trim()).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.inviting.set(false);
        r.emailed
          ? this.notify.success(`Invitation sent to ${r.email}.`, 'User invited')
          : this.notify.info(`${r.email} was created, but the email could not be sent — check Admin → Email, then use "Send password-reset email".`, 'User invited');
        this.load();
      },
      error: (err) => {
        this.busy.set(false);
        this.notify.error(errorText(err, 'The user could not be invited.'));
      }
    });
  }

  save(u: PlatformUser): void {
    const change: { fullName?: string; email?: string } = {};
    if (this.editName.trim() !== u.fullName) change.fullName = this.editName.trim();
    if (this.editEmail.trim().toLowerCase() !== u.email) change.email = this.editEmail.trim();
    this.act(this.api.updateUser(u.id, change), 'Details saved.', () => {
      this.selected.set(null);
      this.load();
    });
  }

  resetPassword(u: PlatformUser): void {
    this.act(this.api.sendPasswordReset(u.id), `Password-reset email sent to ${u.email} (valid 24 h).`);
  }

  verify(u: PlatformUser): void {
    this.act(this.api.sendVerification(u.id), `Verification email sent to ${u.email}.`);
  }

  setAdmin(u: PlatformUser, value: boolean): void {
    this.notify.confirm({
      header: value ? `Make ${u.fullName} a platform admin?` : `Remove admin rights from ${u.fullName}?`,
      message: value ? 'They can manage every account, backups and settings in this console.' : 'They lose access to this console.',
      confirmLabel: value ? 'Make admin' : 'Remove',
      destructive: !value,
      accept: () => this.act(this.api.setPlatformAdmin(u.id, value), 'Saved.', () => {
        this.selected.set(null);
        this.load();
      }),
      reject: () => this.load()
    });
  }
}
