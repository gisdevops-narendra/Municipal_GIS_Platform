import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AdminService,
  AnalyticsReport,
  Announcement,
  Branding,
  EmailSettings,
  Maintenance,
  ModulesConfig,
  SecurityReport,
  SecuritySettings
} from '../../../core/services/admin.service';
import { NotificationService } from '../../../core/services/notification.service';
import { environment } from '../../../../environments/environment';
import { ago, errorText } from './admin-utils';

const FORM_STYLES = `
  .st__form { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 18px; }
  .st__form .ac__field input, .st__form .ac__field select, .st__form .ac__field textarea { width: 100%; }
  .st__row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
  .st__note { display: flex; gap: 8px; padding: 10px 12px; border-radius: 8px; background: #fef3c7; color: #78350f; font-size: 13px; margin-bottom: 14px; }
  .st__note code { background: rgba(0,0,0,.06); padding: 1px 5px; border-radius: 4px; word-break: break-all; }
  .st__preview { display: flex; align-items: center; gap: 12px; padding: 14px; border: 1px dashed var(--color-line); border-radius: 12px; margin-top: 12px; }
  .st__preview img { max-height: 44px; max-width: 160px; }
  .st__swatch { width: 36px; height: 36px; border-radius: 8px; border: 1px solid var(--color-line); }
  .st__banner { padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-top: 10px; }
  .st__banner[data-level='info'] { background: #eff6ff; color: #1e3a8a; }
  .st__banner[data-level='warning'] { background: #fef3c7; color: #78350f; }
  .st__banner[data-level='critical'] { background: #fee2e2; color: #7f1d1d; }
  .st__tools { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 6px 14px; }
  .st__chart { display: flex; align-items: flex-end; gap: 2px; height: 120px; padding-top: 8px; }
  .st__chart span { flex: 1; min-width: 3px; background: var(--color-primary-600); border-radius: 3px 3px 0 0; opacity: .85; }
  .st__axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--color-ink-500); margin-top: 4px; }
  .st__kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 18px; }
  .st__kpi { padding: 14px 16px; border: 1px solid var(--color-line); border-radius: 12px; background: var(--color-surface); }
  .st__kpi b { display: block; font-size: 22px; }
  .st__kpi span { font-size: 12px; color: var(--color-ink-500); }
`;

// =============================== Security ===============================

@Component({
  selector: 'app-admin-security',
  standalone: true,
  imports: [FormsModule, DatePipe],
  styles: FORM_STYLES,
  template: `
    <header class="ac__head">
      <div>
        <h1 class="ac__title">Security</h1>
        <p class="ac__sub">Password rules, lock-out, two-factor sign-in and session length — plus every API key and public link.</p>
      </div>
    </header>

    @if (report(); as r) {
      @if (!r.canManageRealm) {
        <div class="st__note"><i class="pi pi-lock"></i>
          <span>The backend is not yet allowed to change login settings. Run once on the server:
            <code>docker exec municipal-gis-keycloak /opt/keycloak/bin/kcadm.sh add-roles -r municipal-gis --uusername service-account-municipal-gis-backend --cclientid realm-management --rolename view-realm --rolename manage-realm</code>
            (after <code>kcadm.sh config credentials</code> as the Keycloak admin).</span>
        </div>
      }
      <div class="ac__card">
        <span class="ac__card-head">Passwords</span>
        <div class="st__form">
          <label class="ac__field"><span>Minimum length</span><input type="number" min="0" max="64" [(ngModel)]="s.minLength" /></label>
          <label class="ac__field"><span>At least this many digits</span><input type="number" min="0" max="10" [(ngModel)]="s.digits" /></label>
          <label class="ac__field"><span>Capital letters</span><input type="number" min="0" max="10" [(ngModel)]="s.upperCase" /></label>
          <label class="ac__field"><span>Special characters</span><input type="number" min="0" max="10" [(ngModel)]="s.specialChars" /></label>
          <label class="ac__field"><span>Force a new password every (days, 0 = never)</span><input type="number" min="0" [(ngModel)]="s.expireDays" /></label>
        </div>
        <label class="ac__check"><input type="checkbox" [(ngModel)]="s.notUsername" /> Password may not be the email address</label>
      </div>
      <div class="ac__card">
        <span class="ac__card-head">Sign-in protection</span>
        <label class="ac__check"><input type="checkbox" [(ngModel)]="s.bruteForce" /> Lock an account after repeated wrong passwords</label>
        <div class="st__form">
          <label class="ac__field"><span>Wrong passwords before lock-out</span><input type="number" min="1" max="100" [(ngModel)]="s.failures" [disabled]="!s.bruteForce" /></label>
          <label class="ac__field"><span>Lock for (minutes)</span><input type="number" min="1" max="1440" [(ngModel)]="s.lockMinutes" [disabled]="!s.bruteForce" /></label>
          <label class="ac__field"><span>Sign out after inactivity (minutes)</span><input type="number" min="5" max="1440" [(ngModel)]="s.sessionIdleMinutes" /></label>
        </div>
        <label class="ac__check"><input type="checkbox" [(ngModel)]="s.requireTwoFactor" />
          Require two-factor sign-in (an authenticator app code) — everyone sets it up at their next sign-in</label>
        <div class="st__row"><button type="button" class="ac__btn ac__btn--primary" [disabled]="busy() || !r.canManageRealm" (click)="save()">Save security settings</button></div>
      </div>

      <div class="ac__card ac__card--flush">
        <table class="ac__table">
          <thead><tr><th>API key</th><th>Account</th><th>Last used</th><th>Status</th><th class="actions"></th></tr></thead>
          <tbody>
            @for (k of r.apiKeys; track k.id) {
              <tr>
                <td><b>{{ k.name }}</b><div class="muted">{{ k.prefix }}… · created {{ k.createdAt | date: 'd MMM y' }}</div></td>
                <td>{{ k.account }}</td>
                <td>{{ ago(k.lastUsedAt) }}</td>
                <td><span class="ac__pill" [attr.data-tone]="k.revokedAt ? 'bad' : 'ok'"><i></i>{{ k.revokedAt ? 'Revoked' : 'Active' }}</span></td>
                <td class="actions">@if (!k.revokedAt) { <button type="button" class="ac__btn ac__btn--sm ac__btn--danger" (click)="revokeKey(k.id, k.name)">Revoke</button> }</td>
              </tr>
            } @empty { <tr><td colspan="5" class="ac__empty">No API keys.</td></tr> }
          </tbody>
        </table>
      </div>

      <div class="ac__card ac__card--flush">
        <table class="ac__table">
          <thead><tr><th>Public share link</th><th>Account</th><th>Views</th><th>Status</th><th class="actions"></th></tr></thead>
          <tbody>
            @for (l of r.shareLinks; track l.id) {
              <tr>
                <td><b>{{ l.title }}</b><div class="muted">created {{ l.createdAt | date: 'd MMM y' }}@if (l.expiresAt) { · expires {{ l.expiresAt | date: 'd MMM y' }} }</div></td>
                <td>{{ l.account }}</td>
                <td>{{ l.viewCount }} · {{ ago(l.lastViewedAt) }}</td>
                <td><span class="ac__pill" [attr.data-tone]="l.revokedAt ? 'bad' : 'ok'"><i></i>{{ l.revokedAt ? 'Revoked' : 'Live' }}</span></td>
                <td class="actions">@if (!l.revokedAt) { <button type="button" class="ac__btn ac__btn--sm ac__btn--danger" (click)="revokeLink(l.id, l.title)">Revoke</button> }</td>
              </tr>
            } @empty { <tr><td colspan="5" class="ac__empty">No public links.</td></tr> }
          </tbody>
        </table>
      </div>
    } @else {
      <p class="muted">Loading…</p>
    }
  `
})
export class AdminSecurityComponent implements OnInit {
  private readonly api = inject(AdminService);
  private readonly notify = inject(NotificationService);
  readonly report = signal<SecurityReport | null>(null);
  readonly busy = signal(false);
  readonly ago = ago;
  s: SecuritySettings = { minLength: 0, digits: 0, upperCase: 0, specialChars: 0, notUsername: false, expireDays: 0, bruteForce: false, failures: 5, lockMinutes: 15, sessionIdleMinutes: 30, requireTwoFactor: false };

  ngOnInit(): void {
    this.load();
  }

  private apply(r: SecurityReport): void {
    this.report.set(r);
    this.s = { ...r.policy, bruteForce: r.bruteForce.enabled, failures: r.bruteForce.failures, lockMinutes: r.bruteForce.lockMinutes, sessionIdleMinutes: r.sessionIdleMinutes, requireTwoFactor: r.requireTwoFactor };
  }

  load(): void {
    this.api.security().subscribe({ next: (r) => this.apply(r), error: () => this.notify.error('Could not load security settings.') });
  }

  save(): void {
    this.busy.set(true);
    this.api.setSecurity(this.s).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.apply(r);
        this.notify.success('Security settings saved.');
      },
      error: (err) => {
        this.busy.set(false);
        this.notify.error(errorText(err, 'The settings could not be saved.'));
      }
    });
  }

  revokeKey(id: string, name: string): void {
    this.notify.confirm({
      header: `Revoke API key "${name}"?`,
      message: 'Systems using this key stop working immediately.',
      confirmLabel: 'Revoke',
      destructive: true,
      accept: () => this.api.revokeApiKey(id).subscribe(() => this.load())
    });
  }

  revokeLink(id: string, title: string): void {
    this.notify.confirm({
      header: `Revoke the public link "${title}"?`,
      message: 'Anyone opening the link sees "link no longer available".',
      confirmLabel: 'Revoke',
      destructive: true,
      accept: () => this.api.revokeShareLink(id).subscribe(() => this.load())
    });
  }
}

// =============================== Email ===============================

@Component({
  selector: 'app-admin-email',
  standalone: true,
  imports: [FormsModule],
  styles: FORM_STYLES,
  template: `
    <header class="ac__head">
      <div>
        <h1 class="ac__title">Email</h1>
        <p class="ac__sub">The mail server for invitations, password resets, verification and alerts.</p>
      </div>
    </header>
    @if (e.host === 'mailpit') {
      <div class="st__note"><i class="pi pi-info-circle"></i>
        <span>Emails currently go to the built-in test inbox (Mailpit) and never reach real people. Enter your organisation's mail server below.</span></div>
    }
    <div class="ac__card">
      <span class="ac__card-head">Mail server (SMTP)</span>
      <div class="st__form">
        <label class="ac__field"><span>Server</span><input type="text" [(ngModel)]="e.host" placeholder="smtp.example.gov.in" /></label>
        <label class="ac__field"><span>Port</span><input type="number" [(ngModel)]="e.port" placeholder="587" /></label>
        <label class="ac__field"><span>Sender address</span><input type="email" [(ngModel)]="e.from" placeholder="gis@example.gov.in" /></label>
        <label class="ac__field"><span>Sender name</span><input type="text" [(ngModel)]="e.fromName" /></label>
      </div>
      <label class="ac__check"><input type="checkbox" [(ngModel)]="e.starttls" /> Use STARTTLS (usually port 587)</label>
      <label class="ac__check"><input type="checkbox" [(ngModel)]="e.ssl" /> Use SSL/TLS (usually port 465)</label>
      <label class="ac__check"><input type="checkbox" [(ngModel)]="e.auth" /> The server needs a username and password</label>
      @if (e.auth) {
        <div class="st__form">
          <label class="ac__field"><span>Username</span><input type="text" [(ngModel)]="e.user" autocomplete="off" /></label>
          <label class="ac__field"><span>Password {{ e.hasPassword ? '(saved — leave empty to keep)' : '' }}</span><input type="password" [(ngModel)]="password" autocomplete="new-password" /></label>
        </div>
      }
      <div class="st__row"><button type="button" class="ac__btn ac__btn--primary" [disabled]="busy()" (click)="save()">Save email settings</button></div>
      @if (keycloakNote()) { <p class="muted">Password-reset emails: {{ keycloakNote() }}</p> }
    </div>
    <div class="ac__card">
      <span class="ac__card-head">Send a test email</span>
      <div class="st__row">
        <input class="ac__input" type="email" [(ngModel)]="testTo" placeholder="you@example.gov.in" aria-label="Test address" />
        <button type="button" class="ac__btn" [disabled]="busy() || !testTo.trim()" (click)="test()"><i class="pi pi-send"></i> Send test</button>
      </div>
      <p class="muted">Test emails use a plain connection; servers that need SSL or a login only work for Keycloak's own emails (password reset, verification).</p>
    </div>
  `
})
export class AdminEmailComponent implements OnInit {
  private readonly api = inject(AdminService);
  private readonly notify = inject(NotificationService);
  readonly busy = signal(false);
  readonly keycloakNote = signal('');
  e: EmailSettings = { host: '', port: 587, from: '', fromName: '', starttls: true, ssl: false, auth: false, user: '' };
  password = '';
  testTo = '';

  ngOnInit(): void {
    this.api.email().subscribe({ next: (e) => (this.e = e), error: () => this.notify.error('Could not load email settings.') });
  }

  save(): void {
    this.busy.set(true);
    this.api.setEmail({ ...this.e, password: this.password || undefined }).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.password = '';
        this.e = r;
        this.keycloakNote.set(r.keycloak === 'updated' ? 'updated too.' : `not updated — ${r.keycloak}`);
        this.notify.success('Email settings saved.');
      },
      error: (err) => {
        this.busy.set(false);
        this.notify.error(errorText(err, 'The settings could not be saved.'));
      }
    });
  }

  test(): void {
    this.busy.set(true);
    this.api.testEmail(this.testTo.trim()).subscribe({
      next: () => {
        this.busy.set(false);
        this.notify.success(`Test email sent to ${this.testTo}.`);
      },
      error: (err) => {
        this.busy.set(false);
        this.notify.error(errorText(err, 'The test email could not be sent.'));
      }
    });
  }
}

// =============================== Branding ===============================

@Component({
  selector: 'app-admin-branding',
  standalone: true,
  imports: [FormsModule],
  styles: FORM_STYLES,
  template: `
    <header class="ac__head">
      <div>
        <h1 class="ac__title">Branding</h1>
        <p class="ac__sub">Name, logo and colour shown on the login page, the header and shared maps.</p>
      </div>
    </header>
    <div class="ac__card">
      <span class="ac__card-head">Name &amp; text</span>
      <div class="st__form">
        <label class="ac__field"><span>Platform name</span><input type="text" maxlength="60" [(ngModel)]="b.platformName" /></label>
        <label class="ac__field"><span>Tagline</span><input type="text" maxlength="120" [(ngModel)]="b.tagline" /></label>
      </div>
      <label class="ac__field"><span>Message on the login page (optional)</span><textarea rows="2" maxlength="500" [(ngModel)]="b.loginMessage"></textarea></label>
      <div class="st__row">
        <label class="ac__check"><input type="checkbox" [ngModel]="!!b.primaryColor" (ngModelChange)="b.primaryColor = $event ? '#0f766e' : null" /> Use my own main colour</label>
        @if (b.primaryColor) { <input type="color" [(ngModel)]="b.primaryColor" aria-label="Main colour" /> }
      </div>
      <div class="st__row"><button type="button" class="ac__btn ac__btn--primary" [disabled]="busy()" (click)="save()">Save branding</button></div>
    </div>
    <div class="ac__card">
      <span class="ac__card-head">Logo</span>
      <div class="st__row">
        <input type="file" accept=".png,.svg,.jpg,.jpeg,.webp" (change)="upload($event)" />
        @if (b.hasLogo) { <button type="button" class="ac__btn ac__btn--danger" (click)="removeLogo()">Remove logo</button> }
      </div>
      <p class="muted">PNG, SVG, JPEG or WEBP under 1 MB. A wide logo about 160 × 44 px looks best.</p>
      <div class="st__preview">
        @if (b.hasLogo) { <img [src]="logoUrl()" alt="Logo preview" /> }
        @else if (b.primaryColor) { <span class="st__swatch" [style.background]="b.primaryColor"></span> }
        <span><b>{{ b.platformName || 'Municipal GIS' }}</b><br /><span class="muted">{{ b.tagline }}</span></span>
      </div>
    </div>
  `
})
export class AdminBrandingComponent implements OnInit {
  private readonly api = inject(AdminService);
  private readonly notify = inject(NotificationService);
  readonly busy = signal(false);
  b: Branding = { platformName: '', tagline: '', loginMessage: '', primaryColor: null, hasLogo: false, logoVersion: 0 };

  ngOnInit(): void {
    this.api.branding().subscribe({ next: (b) => (this.b = b) });
  }

  logoUrl(): string {
    return `${environment.apiUrl}/platform/logo?v=${this.b.logoVersion}`;
  }

  save(): void {
    this.busy.set(true);
    this.api.setBranding({ platformName: this.b.platformName.trim() || 'Municipal GIS', tagline: this.b.tagline, loginMessage: this.b.loginMessage, primaryColor: this.b.primaryColor }).subscribe({
      next: (b) => {
        this.busy.set(false);
        this.b = b;
        this.notify.success('Branding saved — users see it after reloading the page.');
      },
      error: (err) => {
        this.busy.set(false);
        this.notify.error(errorText(err, 'Branding could not be saved.'));
      }
    });
  }

  upload(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.api.uploadLogo(file).subscribe({
      next: (b) => {
        this.b = b;
        this.notify.success('Logo uploaded.');
      },
      error: (err) => this.notify.error(errorText(err, 'The logo could not be uploaded.'))
    });
  }

  removeLogo(): void {
    this.api.removeLogo().subscribe({ next: (b) => (this.b = b) });
  }
}

// =============================== Announcements ===============================

@Component({
  selector: 'app-admin-notices',
  standalone: true,
  imports: [FormsModule],
  styles: FORM_STYLES,
  template: `
    <header class="ac__head">
      <div>
        <h1 class="ac__title">Announcements</h1>
        <p class="ac__sub">A message banner for every user, and maintenance mode for upgrades.</p>
      </div>
    </header>
    <div class="ac__card">
      <span class="ac__card-head">Banner</span>
      <label class="ac__check"><input type="checkbox" [(ngModel)]="a.enabled" /> Show the banner to everyone</label>
      <label class="ac__field"><span>Message</span><textarea rows="2" maxlength="500" [(ngModel)]="a.message" placeholder="e.g. Maintenance on Sunday 10 pm – 11 pm. Save your work."></textarea></label>
      <div class="st__form">
        <label class="ac__field"><span>Type</span>
          <select [(ngModel)]="a.level"><option value="info">Information (blue)</option><option value="warning">Warning (amber)</option><option value="critical">Critical (red)</option></select>
        </label>
        <label class="ac__field"><span>Hide automatically after (optional)</span><input type="datetime-local" [(ngModel)]="endsLocal" /></label>
      </div>
      @if (a.message) { <div class="st__banner" [attr.data-level]="a.level">{{ a.message }}</div> }
      <div class="st__row"><button type="button" class="ac__btn ac__btn--primary" (click)="saveBanner()">Save banner</button></div>
    </div>
    <div class="ac__card">
      <span class="ac__card-head">Maintenance mode</span>
      <p class="muted">While on, only platform admins can use the platform; everyone else sees the message below.</p>
      <label class="ac__field"><span>Message shown to users</span><textarea rows="2" maxlength="500" [(ngModel)]="m.message"></textarea></label>
      <div class="st__row">
        @if (m.enabled) {
          <span class="ac__pill" data-tone="bad"><i></i>Maintenance mode is ON</span>
          <button type="button" class="ac__btn ac__btn--primary" (click)="setMaintenance(false)">Turn off</button>
        } @else {
          <span class="ac__pill" data-tone="ok"><i></i>Platform is open</span>
          <button type="button" class="ac__btn ac__btn--danger" (click)="setMaintenance(true)">Turn on maintenance mode</button>
        }
      </div>
    </div>
  `
})
export class AdminNoticesComponent implements OnInit {
  private readonly api = inject(AdminService);
  private readonly notify = inject(NotificationService);
  a: Announcement = { enabled: false, message: '', level: 'info', endsAt: null };
  m: Maintenance = { enabled: false, message: '' };
  endsLocal = '';

  ngOnInit(): void {
    this.api.notices().subscribe({
      next: (n) => {
        this.a = n.announcement;
        this.m = n.maintenance;
        this.endsLocal = n.announcement.endsAt ? this.toLocal(n.announcement.endsAt) : '';
      }
    });
  }

  private toLocal(iso: string): string {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  saveBanner(): void {
    this.api.setAnnouncement({ ...this.a, endsAt: this.endsLocal ? new Date(this.endsLocal).toISOString() : null }).subscribe({
      next: (a) => {
        this.a = a;
        this.notify.success(a.enabled ? 'Banner is live.' : 'Banner saved (hidden).');
      },
      error: (err) => this.notify.error(errorText(err, 'The banner could not be saved.'))
    });
  }

  setMaintenance(enabled: boolean): void {
    this.notify.confirm({
      header: enabled ? 'Turn on maintenance mode?' : 'Turn off maintenance mode?',
      message: enabled ? 'Everyone except platform admins is locked out until you turn it off.' : 'Everyone can use the platform again.',
      confirmLabel: enabled ? 'Turn on' : 'Turn off',
      destructive: enabled,
      accept: () =>
        this.api.setMaintenance({ ...this.m, enabled }).subscribe({
          next: (m) => {
            this.m = m;
            this.notify.success(enabled ? 'Maintenance mode is on.' : 'The platform is open again.');
          },
          error: (err) => this.notify.error(errorText(err, 'That did not work.'))
        })
    });
  }
}

// =============================== Modules ===============================

@Component({
  selector: 'app-admin-modules',
  standalone: true,
  imports: [FormsModule],
  styles: FORM_STYLES,
  template: `
    <header class="ac__head">
      <div>
        <h1 class="ac__title">Modules</h1>
        <p class="ac__sub">Switch tools off for everyone, or for one account. Switched-off tools disappear from the map.</p>
      </div>
      <button type="button" class="ac__btn ac__btn--primary" [disabled]="!cfg()" (click)="save()">Save</button>
    </header>
    @if (cfg(); as c) {
      <div class="ac__toolbar">
        <select class="ac__select" [ngModel]="scope()" (ngModelChange)="scope.set($event)" aria-label="Who">
          <option value="">Everyone</option>
          @for (a of c.accounts; track a.id) { <option [value]="a.id">Account: {{ a.name }}</option> }
        </select>
        <span class="muted">{{ offCount() }} tool{{ offCount() === 1 ? '' : 's' }} switched off {{ scope() ? 'for this account' : 'for everyone' }}</span>
      </div>
      @for (g of groups(); track g.name) {
        <div class="ac__card">
          <span class="ac__card-head">{{ g.name }}</span>
          <div class="st__tools">
            @for (t of g.tools; track t.id) {
              <label class="ac__check">
                <input type="checkbox" [checked]="isOn(t.id)" [disabled]="!!scope() && globalOff(t.id)" (change)="toggle(t.id, $any($event.target).checked)" />
                {{ t.label }} @if (!!scope() && globalOff(t.id)) { <span class="muted">(off for everyone)</span> }
              </label>
            }
          </div>
        </div>
      }
    } @else {
      <p class="muted">Loading…</p>
    }
  `
})
export class AdminModulesComponent implements OnInit {
  private readonly api = inject(AdminService);
  private readonly notify = inject(NotificationService);
  readonly cfg = signal<ModulesConfig | null>(null);
  readonly scope = signal('');
  readonly version = signal(0);
  readonly groups = computed(() => {
    const c = this.cfg();
    if (!c) return [];
    const names = [...new Set(c.tools.map((t) => t.group))];
    return names.map((name) => ({ name, tools: c.tools.filter((t) => t.group === name) }));
  });
  readonly offCount = computed(() => {
    this.version();
    return this.offList().length;
  });

  ngOnInit(): void {
    this.api.modules().subscribe({ next: (c) => this.cfg.set(c) });
  }

  private offList(): string[] {
    const c = this.cfg();
    if (!c) return [];
    const scope = this.scope();
    return scope ? (c.switches.perAccount[scope] ??= []) : c.switches.global;
  }

  globalOff(id: string): boolean {
    return !!this.cfg()?.switches.global.includes(id);
  }

  isOn(id: string): boolean {
    this.version();
    return !this.offList().includes(id) && !(this.scope() && this.globalOff(id));
  }

  toggle(id: string, on: boolean): void {
    const list = this.offList();
    const i = list.indexOf(id);
    if (on && i >= 0) list.splice(i, 1);
    if (!on && i < 0) list.push(id);
    this.version.update((v) => v + 1);
  }

  save(): void {
    const c = this.cfg();
    if (!c) return;
    this.api.setModules(c.switches).subscribe({
      next: (s) => {
        this.cfg.set({ ...c, switches: s });
        this.notify.success('Saved — users see the change after reloading the map.');
      },
      error: (err) => this.notify.error(errorText(err, 'Could not save.'))
    });
  }
}

// =============================== Analytics ===============================

@Component({
  selector: 'app-admin-analytics',
  standalone: true,
  imports: [FormsModule],
  styles: FORM_STYLES,
  template: `
    <header class="ac__head">
      <div>
        <h1 class="ac__title">Analytics</h1>
        <p class="ac__sub">How the platform is used.</p>
      </div>
      <select class="ac__select" [(ngModel)]="days" (ngModelChange)="load()" aria-label="Period">
        <option [ngValue]="7">Last 7 days</option><option [ngValue]="30">Last 30 days</option><option [ngValue]="90">Last 90 days</option><option [ngValue]="365">Last year</option>
      </select>
    </header>
    @if (r(); as r) {
      <div class="st__kpis">
        <div class="st__kpi"><b>{{ r.totals.users }}</b><span>Users</span></div>
        <div class="st__kpi"><b>{{ r.totals.active7 }}</b><span>Active in the last 7 days</span></div>
        <div class="st__kpi"><b>{{ r.totals.active30 }}</b><span>Active in the last 30 days</span></div>
        <div class="st__kpi"><b>{{ r.totals.accounts }}</b><span>Accounts</span></div>
        <div class="st__kpi"><b>{{ r.totals.layers }}</b><span>Layers</span></div>
      </div>
      <div class="ac__grid">
        @for (c of charts(); track c.title) {
          <div class="ac__card">
            <span class="ac__card-head">{{ c.title }} · {{ c.total }}</span>
            <div class="st__chart" role="img" [attr.aria-label]="c.title">
              @for (p of c.points; track p.day) { <span [style.height.%]="p.pct" [title]="p.day + ': ' + p.n"></span> }
            </div>
            <div class="st__axis"><span>{{ c.points[0].day }}</span><span>{{ c.points[c.points.length - 1].day }}</span></div>
          </div>
        }
        <div class="ac__card">
          <span class="ac__card-head">Most-used tools</span>
          @for (t of r.topTools; track t.tool) {
            <div class="ac__kv"><span>{{ t.tool }}</span><b>{{ t.n }}</b></div>
          } @empty { <p class="muted">No tool use recorded yet — it is counted from now on.</p> }
        </div>
      </div>
    } @else {
      <p class="muted">Loading…</p>
    }
  `
})
export class AdminAnalyticsComponent implements OnInit {
  private readonly api = inject(AdminService);
  readonly r = signal<AnalyticsReport | null>(null);
  days = 30;
  readonly charts = computed(() => {
    const r = this.r();
    if (!r) return [];
    const fill = (rows: { day: string; n: number }[]) => {
      const map = new Map(rows.map((x) => [x.day, x.n]));
      const out: { day: string; n: number }[] = [];
      for (let i = r.days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        out.push({ day: d, n: map.get(d) ?? 0 });
      }
      const max = Math.max(1, ...out.map((x) => x.n));
      return out.map((x) => ({ ...x, pct: Math.max(x.n ? 4 : 1, (100 * x.n) / max) }));
    };
    const sum = (rows: { n: number }[]) => rows.reduce((t, x) => t + x.n, 0);
    return [
      { title: 'Active users per day', points: fill(r.activeUsers), total: `${Math.max(0, ...r.activeUsers.map((x) => x.n))} on the busiest day` },
      { title: 'Uploads', points: fill(r.uploads), total: `${sum(r.uploads)} in total` },
      { title: 'New layers', points: fill(r.layersCreated), total: `${sum(r.layersCreated)} in total` }
    ];
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.api.analytics(this.days).subscribe({ next: (r) => this.r.set(r) });
  }
}
