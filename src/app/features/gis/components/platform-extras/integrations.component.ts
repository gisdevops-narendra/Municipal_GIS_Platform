import { Input, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { environment } from '../../../../../environments/environment';
import { NotificationService } from '../../../../core/services/notification.service';
import { ApiKey, PlatformExtrasService, Webhook } from '../../services/platform-extras.service';

const EVENT_LABELS: Record<string, string> = {
  'feature.created': 'Feature added',
  'feature.updated': 'Feature edited',
  'feature.deleted': 'Feature deleted',
  'layer.published': 'Layer published'
};

/** API keys (read access for outside systems) and webhooks — Owner only. */
@Component({
  selector: 'app-integrations',
  standalone: true,
  imports: [FormsModule, ButtonModule, DatePipe],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      <div class="px__tabs" role="tablist">
        <button type="button" role="tab" class="px__tab" [class.is-active]="tab() === 'keys'" (click)="tab.set('keys')">API keys</button>
        <button type="button" role="tab" class="px__tab" [class.is-active]="tab() === 'hooks'" (click)="tab.set('hooks')">Webhooks</button>
      </div>

      @if (tab() === 'keys') {
        <p class="px__intro">Let outside systems read your layers through the OGC API – Features endpoint. A key acts with <strong>your</strong> layer permissions, read-only.</p>

        <div class="px__card">
          <label class="px__field">
            <span class="px__label">Key name</span>
            <input class="px__input" [ngModel]="keyName()" (ngModelChange)="keyName.set($event)" maxlength="80" placeholder="e.g. Property tax system" />
          </label>
          <div class="px__field">
            <span class="px__label">Expires</span>
            <div class="px__seg">
              @for (e of expiries; track e.label) {
                <button type="button" class="px__seg-btn" [class.is-active]="keyExpiry() === e.days" (click)="keyExpiry.set(e.days)">{{ e.label }}</button>
              }
            </div>
          </div>
          <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-key" label="Create API key"
                  [loading]="busy()" [disabled]="!keyName().trim()" (click)="createKey()"></button>
        </div>

        @if (newKey(); as key) {
          <div class="px__card">
            <span class="px__label">Your new key</span>
            <div class="px__secret">
              <code>{{ key }}</code>
              <button type="button" class="px__icon-btn" title="Copy" (click)="copy(key)"><i class="pi pi-copy"></i></button>
            </div>
            <p class="px__warn">Copy it now — it will not be shown again.</p>
            <span class="px__label" style="margin-top: 4px">Try it</span>
            <div class="px__secret">
              <code>{{ curlExample(key) }}</code>
              <button type="button" class="px__icon-btn" title="Copy" (click)="copy(curlExample(key))"><i class="pi pi-copy"></i></button>
            </div>
          </div>
        }

        <div class="px__section">
          <h4>Active keys</h4>
          @if (keys().length) {
            <div class="px__list">
              @for (k of keys(); track k.id) {
                <div class="px__item">
                  <div class="px__item-main">
                    <span class="px__item-title">{{ k.name }}</span>
                    <span class="px__item-sub"><span class="px__mono">{{ k.prefix }}…</span> · {{ k.lastUsedAt ? 'used ' + (k.lastUsedAt | date: 'short') : 'never used' }}</span>
                  </div>
                  @if (k.expired) { <span class="px__badge px__badge--bad">expired</span> }
                  <button type="button" class="px__icon-btn px__icon-btn--danger" title="Revoke" (click)="revokeKey(k)"><i class="pi pi-ban"></i></button>
                </div>
              }
            </div>
          } @else {
            <p class="px__hint">No API keys yet.</p>
          }
        </div>

        <div class="px__section">
          <h4>Endpoints</h4>
          <dl class="px__kv">
            <dt>Collections</dt><dd class="px__mono">/gis/ogc/collections</dd>
            <dt>Features</dt><dd class="px__mono">/gis/ogc/collections/&#123;id&#125;/items</dd>
            <dt>Header</dt><dd class="px__mono">X-API-Key: mgp_…</dd>
          </dl>
        </div>
      } @else {
        <p class="px__intro">Send a signed HTTP POST to another system whenever your data changes. Verify the <span class="px__mono">X-MGP-Signature</span> header (HMAC-SHA256 of the body with the webhook secret).</p>

        <div class="px__card">
          <label class="px__field">
            <span class="px__label">Name</span>
            <input class="px__input" [ngModel]="hookName()" (ngModelChange)="hookName.set($event)" maxlength="80" placeholder="e.g. Complaint system" />
          </label>
          <label class="px__field">
            <span class="px__label">Payload URL</span>
            <input class="px__input" type="url" [ngModel]="hookUrl()" (ngModelChange)="hookUrl.set($event)" placeholder="https://example.org/hooks/gis" />
          </label>
          <div class="px__field">
            <span class="px__label">Events</span>
            <div class="px__checks">
              <label class="px__check"><input type="checkbox" [checked]="hookEvents().has('*')" (change)="toggleEvent('*')" /> All events</label>
              @for (e of events; track e) {
                <label class="px__check"><input type="checkbox" [disabled]="hookEvents().has('*')" [checked]="hookEvents().has('*') || hookEvents().has(e)" (change)="toggleEvent(e)" /> {{ label(e) }}</label>
              }
            </div>
          </div>
          <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-send" label="Add webhook"
                  [loading]="busy()" [disabled]="!hookName().trim() || !hookUrl().trim() || !hookEvents().size" (click)="createHook()"></button>
        </div>

        @if (newSecret(); as secret) {
          <div class="px__card">
            <span class="px__label">Signing secret</span>
            <div class="px__secret">
              <code>{{ secret }}</code>
              <button type="button" class="px__icon-btn" title="Copy" (click)="copy(secret)"><i class="pi pi-copy"></i></button>
            </div>
            <p class="px__warn">Copy it now — it will not be shown again.</p>
          </div>
        }

        <div class="px__section">
          <h4>Webhooks</h4>
          @if (hooks().length) {
            <div class="px__list">
              @for (h of hooks(); track h.id) {
                <div class="px__item">
                  <input type="checkbox" [checked]="h.active" (change)="toggleActive(h)" [attr.aria-label]="'Active: ' + h.name" title="Active" />
                  <div class="px__item-main">
                    <span class="px__item-title" [title]="h.url">{{ h.name }}</span>
                    <span class="px__item-sub" [title]="h.lastError ?? ''">
                      {{ h.events.includes('*') ? 'All events' : h.events.map(label).join(', ') }}
                    </span>
                  </div>
                  @if (h.lastDeliveredAt) {
                    <span class="px__badge" [class.px__badge--ok]="!h.lastError" [class.px__badge--bad]="!!h.lastError" [title]="h.lastError ?? 'Delivered'">
                      {{ h.lastStatus ?? 'ERR' }}
                    </span>
                  }
                  <button type="button" class="px__icon-btn" title="Send test" (click)="test(h)"><i class="pi pi-bolt"></i></button>
                  <button type="button" class="px__icon-btn px__icon-btn--danger" title="Delete" (click)="deleteHook(h)"><i class="pi pi-trash"></i></button>
                </div>
              }
            </div>
          } @else {
            <p class="px__hint">No webhooks yet.</p>
          }
        </div>
      }
    </div>
  `
})
export class IntegrationsComponent {
  /** Open one tab / tool, e.g. picked from the workspace tool search. */
  @Input() set openSub(value: { parent: string; sub: string } | null) {
    if (value?.parent === 'integrations') this.tab.set(value.sub as 'keys' | 'hooks');
  }

  private readonly extras = inject(PlatformExtrasService);
  private readonly notify = inject(NotificationService);

  readonly events = Object.keys(EVENT_LABELS);
  readonly expiries: { label: string; days: number | null }[] = [
    { label: 'Never', days: null },
    { label: '30 days', days: 30 },
    { label: '90 days', days: 90 },
    { label: '1 year', days: 365 }
  ];

  readonly tab = signal<'keys' | 'hooks'>('keys');
  readonly busy = signal(false);
  readonly keys = signal<ApiKey[]>([]);
  readonly keyName = signal('');
  readonly keyExpiry = signal<number | null>(365);
  readonly newKey = signal<string | null>(null);
  readonly hooks = signal<Webhook[]>([]);
  readonly hookName = signal('');
  readonly hookUrl = signal('');
  readonly hookEvents = signal<Set<string>>(new Set(['*']));
  readonly newSecret = signal<string | null>(null);

  constructor() {
    this.extras.listApiKeys().subscribe((k) => this.keys.set(k));
    this.extras.listWebhooks().subscribe((h) => this.hooks.set(h));
  }

  label = (event: string): string => EVENT_LABELS[event] ?? event;

  curlExample(key: string): string {
    return `curl -H "X-API-Key: ${key}" ${environment.apiUrl}/gis/ogc/collections`;
  }

  createKey(): void {
    this.busy.set(true);
    this.extras.createApiKey(this.keyName().trim(), this.keyExpiry()).subscribe({
      next: ({ key, ...row }) => {
        this.newKey.set(key);
        this.keys.update((list) => [row, ...list]);
        this.keyName.set('');
        this.busy.set(false);
      },
      error: (e) => this.fail(e, 'Could not create the key.')
    });
  }

  revokeKey(k: ApiKey): void {
    this.notify.confirm({
      header: 'Revoke API key',
      message: `Systems using "${k.name}" will lose access immediately.`,
      confirmLabel: 'Revoke',
      destructive: true,
      accept: () =>
        this.extras.revokeApiKey(k.id).subscribe({
          next: () => this.keys.update((list) => list.filter((x) => x.id !== k.id)),
          error: (e) => this.fail(e, 'Could not revoke the key.')
        })
    });
  }

  toggleEvent(event: string): void {
    this.hookEvents.update((set) => {
      const next = new Set(set);
      if (next.has(event)) next.delete(event);
      else next.add(event);
      if (event === '*' && next.has('*')) return new Set(['*']);
      return next;
    });
  }

  createHook(): void {
    this.busy.set(true);
    this.extras.createWebhook({ name: this.hookName().trim(), url: this.hookUrl().trim(), events: [...this.hookEvents()] }).subscribe({
      next: ({ secret, ...row }) => {
        this.newSecret.set(secret);
        this.hooks.update((list) => [row, ...list]);
        this.hookName.set('');
        this.hookUrl.set('');
        this.busy.set(false);
      },
      error: (e) => this.fail(e, 'Could not add the webhook.')
    });
  }

  toggleActive(h: Webhook): void {
    this.extras.updateWebhook(h.id, { active: !h.active }).subscribe({
      next: (row) => this.hooks.update((list) => list.map((x) => (x.id === row.id ? row : x))),
      error: (e) => this.fail(e, 'Could not update the webhook.')
    });
  }

  test(h: Webhook): void {
    this.extras.testWebhook(h.id).subscribe({
      next: (res) => {
        if (res.ok) this.notify.success(`Test delivered (HTTP ${res.status}).`);
        else this.notify.warn(`Test failed: ${res.error ?? 'no response'}.`);
        this.extras.listWebhooks().subscribe((list) => this.hooks.set(list));
      },
      error: (e) => this.fail(e, 'Could not send the test.')
    });
  }

  deleteHook(h: Webhook): void {
    this.notify.confirmDelete({
      message: `Delete webhook "${h.name}"?`,
      accept: () =>
        this.extras.deleteWebhook(h.id).subscribe({
          next: () => this.hooks.update((list) => list.filter((x) => x.id !== h.id)),
          error: (e) => this.fail(e, 'Could not delete the webhook.')
        })
    });
  }

  copy(text: string): void {
    void navigator.clipboard?.writeText(text).then(() => this.notify.info('Copied to clipboard.'));
  }

  private fail(e: { error?: { message?: string | string[] } }, fallback: string): void {
    this.busy.set(false);
    const m = e?.error?.message;
    this.notify.error(Array.isArray(m) ? m.join(', ') : m ?? fallback);
  }
}
