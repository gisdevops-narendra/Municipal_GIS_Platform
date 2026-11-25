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
  ModuleTool,
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

const MODULE_STYLES = `
  :host { display: block; }
  .md__stats { display: grid; grid-template-columns: minmax(260px, 1.3fr) repeat(3, minmax(170px, 1fr)); gap: 12px; margin-bottom: 20px; }
  @media (max-width: 1100px) { .md__stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .md__stat { display: flex; align-items: center; gap: 14px; padding: 12px 16px; min-height: 72px; box-sizing: border-box; border: 1px solid var(--color-line); border-radius: 14px; background: var(--color-surface); }
  .md__stat-ico { width: 40px; height: 40px; flex-shrink: 0; border-radius: 10px; display: grid; place-items: center; font-size: 16px;
    background: color-mix(in srgb, var(--color-primary-600) 12%, transparent); color: var(--color-primary-600); }
  .md__stat-ico--warn { background: color-mix(in srgb, #d97706 14%, transparent); color: #d97706; }
  .md__stat b { display: block; font-size: 20px; line-height: 1.2; color: var(--color-ink-900); }
  .md__stat span { font-size: 12px; color: var(--color-ink-500); }
  .md__scope { flex-direction: column; align-items: stretch; justify-content: center; gap: 6px; }
  .md__scope label { text-align: left; font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--color-ink-500); }
  .md__scope select { width: 100%; }

  .md__layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 20px; align-items: start; }
  @media (max-width: 1000px) { .md__layout { grid-template-columns: 1fr; } }

  .md__nav { position: sticky; top: 16px; display: flex; flex-direction: column; max-height: calc(100vh - 32px);
    border: 1px solid var(--color-line); border-radius: 14px; background: var(--color-surface); overflow: hidden; }
  .md__nav-top { padding: 12px; border-bottom: 1px solid var(--color-line); }
  .md__search { width: 100%; box-sizing: border-box; height: 36px; padding: 0 12px 0 32px; border: 1px solid var(--color-line); border-radius: 9px;
    background: var(--color-surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' fill='none' stroke='%23888' stroke-width='2'%3E%3Ccircle cx='6' cy='6' r='5'/%3E%3Cpath d='m10 10 3 3'/%3E%3C/svg%3E") no-repeat 11px center;
    color: var(--color-ink-900); font: inherit; font-size: 13px; }
  .md__search:focus { outline: none; border-color: var(--color-primary-600); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary-600) 22%, transparent); }
  .md__nav-list { overflow-y: auto; padding: 4px 8px 10px; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--color-ink-500) 40%, transparent) transparent; }
  .md__nav-group { margin: 12px 8px 4px; font-size: 11px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: var(--color-ink-500); }
  .md__nav-item { position: relative; width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 12px; border: 0; border-radius: 8px; background: none; outline: none;
    color: var(--color-ink-900); font: inherit; font-size: 13.5px; text-align: left; cursor: pointer; }
  .md__nav-item:hover { background: color-mix(in srgb, var(--color-ink-900) 5%, transparent); }
  .md__nav-item:focus-visible { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--color-primary-600) 50%, transparent); }
  .md__nav-item--on { background: color-mix(in srgb, var(--color-primary-600) 11%, transparent); color: var(--color-primary-600); font-weight: 600; }
  .md__nav-item--on::before { content: ''; position: absolute; left: 0; top: 7px; bottom: 7px; width: 3px; border-radius: 3px; background: var(--color-primary-600); }
  .md__nav-count { font-size: 11.5px; font-weight: 500; color: var(--color-ink-500); font-variant-numeric: tabular-nums; }
  .md__nav-item i { width: 18px; text-align: center; font-size: 14px; opacity: .85; }
  .md__nav-item .md__nav-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .md__dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: #16a34a; }
  .md__dot--part { background: #d97706; }
  .md__dot--off { background: color-mix(in srgb, var(--color-ink-500) 60%, transparent); }
  .md__nav-empty { padding: 24px 12px; text-align: center; font-size: 13px; color: var(--color-ink-500); }

  .md__detail { border: 1px solid var(--color-line); border-radius: 14px; background: var(--color-surface); overflow: hidden; }
  .md__main { position: sticky; top: 16px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .md__hero { display: flex; align-items: center; gap: 16px; padding: 20px 24px; border-bottom: 1px solid var(--color-line); }
  .md__hero-ico { width: 48px; height: 48px; flex-shrink: 0; border-radius: 12px; display: grid; place-items: center; font-size: 20px;
    background: color-mix(in srgb, var(--color-primary-600) 12%, transparent); color: var(--color-primary-600); }
  .md__hero-ico--off { background: color-mix(in srgb, var(--color-ink-500) 14%, transparent); color: var(--color-ink-500); }
  .md__hero-text { flex: 1; min-width: 0; }
  .md__crumb { font-size: 11.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--color-ink-500); }
  .md__hero h2 { margin: 2px 0 4px; font-size: 19px; font-weight: 600; color: var(--color-ink-900); }
  .md__hero p { margin: 0; font-size: 13px; color: var(--color-ink-500); }
  .md__state { display: flex; align-items: center; gap: 12px; padding-left: 16px; }
  .md__badge { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
    background: color-mix(in srgb, #16a34a 14%, transparent); color: #15803d; }
  .md__badge--part { background: color-mix(in srgb, #d97706 15%, transparent); color: #b45309; }
  .md__badge--off { background: color-mix(in srgb, var(--color-ink-500) 15%, transparent); color: var(--color-ink-700); }
  .md__note { display: flex; gap: 10px; align-items: center; margin: 16px 24px 0; padding: 10px 14px; border-radius: 10px; font-size: 13px;
    background: color-mix(in srgb, #d97706 10%, transparent); color: #b45309; }

  .md__body { padding: 8px 24px 24px; }
  .md__feat-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 16px 0 4px; }
  .md__feat-head h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--color-ink-900); }
  .md__feat-head span { font-size: 12.5px; color: var(--color-ink-500); margin-left: 8px; font-weight: 400; }
  .md__actions { display: flex; gap: 4px; }
  .md__link { background: none; border: 1px solid var(--color-line); padding: 0 10px; height: 28px; border-radius: 8px; font: inherit; font-size: 12.5px;
    color: var(--color-ink-700); cursor: pointer; }
  .md__link:hover:not(:disabled) { border-color: var(--color-primary-600); color: var(--color-primary-600); }
  .md__link:disabled { opacity: .45; cursor: default; }
  .md__section { margin-top: 12px; border: 1px solid var(--color-line); border-radius: 12px; overflow: hidden; }
  .md__section-head { display: flex; align-items: center; justify-content: space-between; padding: 9px 14px; font-size: 12px; font-weight: 600;
    letter-spacing: .04em; text-transform: uppercase; color: var(--color-ink-500); background: color-mix(in srgb, var(--color-ink-900) 3%, transparent);
    border-bottom: 1px solid var(--color-line); }
  .md__section-head small { font-weight: 500; letter-spacing: 0; text-transform: none; }
  .md__rows { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); margin: 0 -1px -1px 0; }
  .md__frow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 14px; font-size: 13.5px; color: var(--color-ink-900);
    background: var(--color-surface); box-shadow: inset -1px -1px 0 var(--color-line); cursor: pointer; }
  .md__frow:hover { background: color-mix(in srgb, var(--color-primary-600) 5%, var(--color-surface)); }
  .md__frow--off { color: var(--color-ink-500); }
  .md__frow--locked { cursor: not-allowed; }
  .md__empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 24px; text-align: center; color: var(--color-ink-500); font-size: 13px; }
  .md__empty i { font-size: 22px; opacity: .6; }

  .md__switch { appearance: none; flex-shrink: 0; position: relative; width: 36px; height: 20px; margin: 0; border-radius: 999px;
    background: color-mix(in srgb, var(--color-ink-500) 40%, transparent); cursor: pointer; transition: background .15s; }
  .md__switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s; }
  .md__switch:checked { background: var(--color-primary-600); }
  .md__switch:checked::after { transform: translateX(16px); }
  .md__switch:disabled { opacity: .4; cursor: not-allowed; }
  .md__switch:focus-visible { outline: 2px solid var(--color-primary-600); outline-offset: 2px; }
  .md__switch--lg { width: 44px; height: 24px; }
  .md__switch--lg::after { width: 20px; height: 20px; }
  .md__switch--lg:checked::after { transform: translateX(20px); }

  .md__savebar { display: flex; align-items: center; gap: 12px; padding: 12px 16px 12px 20px;
    border: 1px solid var(--color-line); border-radius: 14px; background: var(--color-surface); box-shadow: 0 6px 18px rgba(0,0,0,.08); }
  .md__savebar span { flex: 1; font-size: 13.5px; color: var(--color-ink-900); }
  .md__savebar span::before { content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 10px; border-radius: 50%; background: #d97706; vertical-align: 1px; }
`;

/** Scales a raster logo down to at most 800 × 400 px (PNG keeps transparency);
 *  SVGs and already-small images are returned as they are. */
async function shrinkLogo(file: File): Promise<File> {
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 800 / bmp.width, 400 / bmp.height);
  if (scale === 1 && file.size <= 1024 * 1024) {
    bmp.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('encode failed');
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.png', { type: 'image/png' });
}

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
      <p class="muted">PNG, SVG, JPEG or WEBP. Large images are resized automatically. A wide logo about 160 × 44 px looks best.</p>
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

  async upload(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const picked = input.files?.[0];
    input.value = '';
    if (!picked) return;
    let file: File;
    try {
      file = await shrinkLogo(picked);
    } catch {
      this.notify.error('This image could not be read. Use a PNG, SVG, JPEG or WEBP file.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      this.notify.error('The logo must be under 5 MB.');
      return;
    }
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

interface ModuleSection { name: string; items: { id: string; label: string }[] }

/** Icon and one-line description per tool (falls back to a generic icon). */
const TOOL_META: Record<string, { icon: string; desc: string }> = {
  'map-controls': { icon: 'pi pi-map', desc: 'Basic map behaviour: panning, basemaps, click-to-identify, search and layer styling.' },
  assistant: { icon: 'pi pi-comments', desc: 'Ask questions about map data in plain language.' },
  attributes: { icon: 'pi pi-table', desc: 'Browse and edit the attribute table of a layer.' },
  'whats-here': { icon: 'pi pi-map-marker', desc: 'Everything at a clicked location across all layers.' },
  bookmarks: { icon: 'pi pi-bookmark', desc: 'Save and jump back to map views.' },
  weather: { icon: 'pi pi-cloud', desc: 'Current weather and forecast on the map.' },
  'air-stations': { icon: 'pi pi-chart-scatter', desc: 'Live air quality readings from monitoring stations.' },
  hazards: { icon: 'pi pi-exclamation-triangle', desc: 'Earthquake, flood and other hazard alerts.' },
  sensors: { icon: 'pi pi-wifi', desc: 'Live IoT sensor readings.' },
  tourism: { icon: 'pi pi-ticket', desc: 'Points of interest for visitors.' },
  'buildings-3d': { icon: 'pi pi-box', desc: 'Extruded 3D building view.' },
  query: { icon: 'pi pi-filter', desc: 'Select features by attribute or location.' },
  measure: { icon: 'pi pi-arrows-h', desc: 'Measure distances and areas.' },
  buffer: { icon: 'pi pi-circle', desc: 'Buffer zones and overlays.' },
  geoprocessing: { icon: 'pi pi-cog', desc: 'Overlay, proximity, geometry and summary operations on layers.' },
  data: { icon: 'pi pi-database', desc: 'Field, data-quality, import and history tools for vector layers.' },
  sketch: { icon: 'pi pi-pencil', desc: 'Draw shapes, place markers and edit features.' },
  advanced: { icon: 'pi pi-directions', desc: 'Routing, nearest facility, tracing and service areas on a network.' },
  'network-planning': { icon: 'pi pi-sitemap', desc: 'Plan and analyse network coverage.' },
  raster: { icon: 'pi pi-images', desc: 'Raster data, terrain, imagery analysis and decision support.' },
  heatmap: { icon: 'pi pi-sun', desc: 'Heatmaps and point clusters.' },
  statistics: { icon: 'pi pi-chart-bar', desc: 'Statistics and charts of layer fields.' },
  groundwater: { icon: 'pi pi-filter-fill', desc: 'Groundwater levels and well readings.' },
  outbreak: { icon: 'pi pi-exclamation-circle', desc: 'Track and map disease outbreaks.' },
  'ev-charging': { icon: 'pi pi-bolt', desc: 'EV charging site planning.' },
  'osm-import': { icon: 'pi pi-cloud-download', desc: 'Download OpenStreetMap data as layers.' },
  'add-service': { icon: 'pi pi-globe', desc: 'Add external WMS / WFS / XYZ services.' },
  catalog: { icon: 'pi pi-book', desc: 'Browse every dataset available to the account.' },
  print: { icon: 'pi pi-print', desc: 'Print-ready map layouts (PDF / PNG).' },
  reports: { icon: 'pi pi-file', desc: 'Generated reports.' },
  export: { icon: 'pi pi-download', desc: 'Download layers in common GIS formats.' },
  share: { icon: 'pi pi-share-alt', desc: 'Share a map by link.' },
  integrations: { icon: 'pi pi-key', desc: 'API keys and webhooks for other systems.' },
  storage: { icon: 'pi pi-server', desc: 'Storage used by the account.' },
  workspace: { icon: 'pi pi-briefcase', desc: 'Workspace information and settings.' }
};

@Component({
  selector: 'app-admin-modules',
  standalone: true,
  imports: [FormsModule],
  styles: [FORM_STYLES, MODULE_STYLES],
  template: `
    <header class="ac__head">
      <div>
        <h1 class="ac__title">Modules</h1>
        <p class="ac__sub">Control which map tools and features are available — for everyone, or for a single account.</p>
      </div>
    </header>
    @if (cfg(); as c) {
      <div class="md__stats">
        <div class="md__stat md__scope">
          <label for="md-scope">Applies to</label>
          <select id="md-scope" class="ac__select" [ngModel]="scope()" (ngModelChange)="scope.set($event)">
            <option value="">Everyone</option>
            @for (a of c.accounts; track a.id) { <option [value]="a.id">{{ a.name }}</option> }
          </select>
        </div>
        <div class="md__stat"><span class="md__stat-ico"><i class="pi pi-th-large"></i></span><div><b>{{ totals().toolsOn }} / {{ totals().tools }}</b><span>Tools enabled</span></div></div>
        <div class="md__stat"><span class="md__stat-ico"><i class="pi pi-list-check"></i></span><div><b>{{ totals().featsOn }} / {{ totals().feats }}</b><span>Features enabled</span></div></div>
        <div class="md__stat"><span class="md__stat-ico md__stat-ico--warn"><i class="pi pi-eye-slash"></i></span><div><b>{{ totals().off }}</b><span>Switched off</span></div></div>
      </div>

      <div class="md__layout">
        <nav class="md__nav" aria-label="Tools">
          <div class="md__nav-top">
            <input class="md__search" type="search" placeholder="Search tools and features" [ngModel]="query()" (ngModelChange)="query.set($event)" aria-label="Search" />
          </div>
          <div class="md__nav-list">
            @for (g of navGroups(); track g.name) {
              <div class="md__nav-group">{{ g.name }}</div>
              @for (t of g.tools; track t.id) {
                <button type="button" class="md__nav-item" [class.md__nav-item--on]="t === selected()" (click)="selectedId.set(t.id)">
                  <i [class]="icon(t.id)"></i>
                  <span class="md__nav-label">{{ t.label }}</span>
                  @if (t.children?.length) { <span class="md__nav-count">{{ isOn(t.id) ? featsOn(t) : 0 }}/{{ t.children!.length }}</span> }
                  <span class="md__dot" [class.md__dot--part]="status(t) === 'part'" [class.md__dot--off]="status(t) === 'off'" [attr.title]="statusText(t)"></span>
                </button>
              }
            } @empty {
              <div class="md__nav-empty">Nothing matches “{{ query() }}”.</div>
            }
          </div>
        </nav>

        <div class="md__main">
        @if (selected(); as t) {
          @let on = isOn(t.id);
          @let kids = t.children ?? [];
          <section class="md__detail">
            <div class="md__hero">
              <span class="md__hero-ico" [class.md__hero-ico--off]="!on"><i [class]="icon(t.id)"></i></span>
              <div class="md__hero-text">
                <div class="md__crumb">{{ t.group }}</div>
                <h2>{{ t.label }}</h2>
                <p>{{ desc(t.id) }}</p>
              </div>
              <div class="md__state">
                <span class="md__badge" [class.md__badge--part]="status(t) === 'part'" [class.md__badge--off]="status(t) === 'off'">{{ statusText(t) }}</span>
                <input type="checkbox" class="md__switch md__switch--lg" role="switch" [attr.aria-label]="'Enable ' + t.label"
                  [checked]="on" [disabled]="locked(t.id)" (change)="toggle(t.id, $any($event.target).checked)" />
              </div>
            </div>
            @if (locked(t.id)) {
              <div class="md__note"><i class="pi pi-lock"></i> Switched off for everyone. Change it under “Everyone” to manage it per account.</div>
            } @else if (!on) {
              <div class="md__note"><i class="pi pi-eye-slash"></i> Hidden from the map{{ scope() ? ' for this account' : '' }}. Turn the tool on to manage its features.</div>
            }
            <div class="md__body">
              @if (kids.length) {
                <div class="md__feat-head">
                  <h3>Features<span>{{ featsOn(t) }} of {{ kids.length }} enabled</span></h3>
                  <div class="md__actions">
                    <button type="button" class="md__link" [disabled]="!on" (click)="setAll(kids, true)">Enable all</button>
                    <button type="button" class="md__link" [disabled]="!on" (click)="setAll(kids, false)">Disable all</button>
                  </div>
                </div>
                @for (sec of sections(t); track sec.name) {
                  <div class="md__section">
                    @if (sec.name) {
                      <div class="md__section-head">{{ sec.name }}<small>{{ countOn(sec.items) }} / {{ sec.items.length }}</small></div>
                    }
                    <div class="md__rows">
                      @for (k of sec.items; track k.id) {
                        <label class="md__frow" [class.md__frow--off]="!on || !isOn(k.id)" [class.md__frow--locked]="!on || locked(k.id)">
                          <span>{{ k.label }}</span>
                          <input type="checkbox" class="md__switch" role="switch" [checked]="on && isOn(k.id)" [disabled]="!on || locked(k.id)"
                            (change)="toggle(k.id, $any($event.target).checked)" />
                        </label>
                      }
                    </div>
                  </div>
                }
              } @else {
                <div class="md__empty"><i class="pi pi-check-circle"></i>This tool has no separate features — the switch above turns the whole tool on or off.</div>
              }
            </div>
          </section>
        }
        @if (dirty()) {
          <div class="md__savebar">
            <span>You have unsaved changes</span>
            <button type="button" class="ac__btn" (click)="discard()">Discard</button>
            <button type="button" class="ac__btn ac__btn--primary" (click)="save()">Save changes</button>
          </div>
        }
        </div>
      </div>
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
  readonly query = signal('');
  readonly selectedId = signal('');
  readonly version = signal(0);
  readonly dirty = signal(false);
  private saved = '';
  private savedRaw = '';

  readonly navGroups = computed(() => {
    const tools = this.cfg()?.tools ?? [];
    const q = this.query().trim().toLowerCase();
    const match = (t: ModuleTool) =>
      !q || t.label.toLowerCase().includes(q) || t.group.toLowerCase().includes(q) || (t.children ?? []).some((k) => k.label.toLowerCase().includes(q));
    return [...new Set(tools.map((t) => t.group))]
      .map((name) => ({ name, tools: tools.filter((t) => t.group === name && match(t)) }))
      .filter((g) => g.tools.length);
  });

  readonly selected = computed(() => {
    const visible = this.navGroups().flatMap((g) => g.tools);
    return visible.find((t) => t.id === this.selectedId()) ?? visible[0] ?? null;
  });

  readonly totals = computed(() => {
    this.version();
    const tools = this.cfg()?.tools ?? [];
    let feats = 0;
    let featsOn = 0;
    for (const t of tools) {
      feats += t.children?.length ?? 0;
      if (this.isOn(t.id)) featsOn += this.featsOn(t);
    }
    const toolsOn = tools.filter((t) => this.isOn(t.id)).length;
    return { tools: tools.length, toolsOn, feats, featsOn, off: tools.length - toolsOn + (feats - featsOn) };
  });

  ngOnInit(): void {
    this.api.modules().subscribe({ next: (c) => this.load(c) });
  }

  private load(c: ModulesConfig): void {
    this.saved = this.snapshot(c.switches);
    this.savedRaw = JSON.stringify(c.switches);
    this.cfg.set(c);
    this.dirty.set(false);
    this.version.update((v) => v + 1);
  }

  icon(id: string): string {
    return TOOL_META[id]?.icon ?? 'pi pi-wrench';
  }

  desc(id: string): string {
    return TOOL_META[id]?.desc ?? '';
  }

  /** Features of a tool by section; a search narrows them unless it matches the tool itself. */
  sections(t: ModuleTool): ModuleSection[] {
    const q = this.query().trim().toLowerCase();
    const all = !q || t.label.toLowerCase().includes(q) || t.group.toLowerCase().includes(q);
    const out: ModuleSection[] = [];
    for (const k of t.children ?? []) {
      if (!all && !k.label.toLowerCase().includes(q)) continue;
      const name = k.section ?? '';
      let sec = out.find((x) => x.name === name);
      if (!sec) out.push((sec = { name, items: [] }));
      sec.items.push(k);
    }
    return out;
  }

  /** Off-list for the current scope; `create` adds a missing per-account list (only when editing). */
  private offList(create = false): string[] {
    const c = this.cfg();
    if (!c) return [];
    const scope = this.scope();
    if (!scope) return c.switches.global;
    if (create) return (c.switches.perAccount[scope] ??= []);
    return c.switches.perAccount[scope] ?? [];
  }

  /** Order-independent form of the switches, ignoring empty per-account lists. */
  private snapshot(sw: ModulesConfig['switches']): string {
    const per = Object.entries(sw.perAccount ?? {})
      .filter(([, l]) => l?.length)
      .map(([k, l]) => [k, [...l].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify({ global: [...sw.global].sort(), per });
  }

  /** Switched off for everyone while editing one account. */
  locked(id: string): boolean {
    return !!this.scope() && !!this.cfg()?.switches.global.includes(id);
  }

  isOn(id: string): boolean {
    this.version();
    return !this.offList().includes(id) && !this.locked(id);
  }

  featsOn(t: ModuleTool): number {
    return this.countOn(t.children ?? []);
  }

  countOn(items: { id: string }[]): number {
    this.version();
    return items.filter((k) => this.isOn(k.id)).length;
  }

  status(t: ModuleTool): 'on' | 'part' | 'off' {
    if (!this.isOn(t.id)) return 'off';
    const n = t.children?.length ?? 0;
    return n && this.featsOn(t) < n ? 'part' : 'on';
  }

  statusText(t: ModuleTool): string {
    const st = this.status(t);
    return st === 'off' ? 'Disabled' : st === 'part' ? 'Partially enabled' : 'Enabled';
  }

  toggle(id: string, on: boolean): void {
    const list = this.offList(true);
    const i = list.indexOf(id);
    if (on && i >= 0) list.splice(i, 1);
    if (!on && i < 0) list.push(id);
    this.version.update((v) => v + 1);
    this.dirty.set(this.snapshot(this.cfg()!.switches) !== this.saved);
  }

  setAll(items: { id: string }[], on: boolean): void {
    for (const k of items) if (!this.locked(k.id)) this.toggle(k.id, on);
  }

  discard(): void {
    const c = this.cfg();
    if (c) this.load({ ...c, switches: JSON.parse(this.savedRaw) });
  }

  save(): void {
    const c = this.cfg();
    if (!c) return;
    this.api.setModules(c.switches).subscribe({
      next: (s) => {
        this.load({ ...c, switches: s });
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
