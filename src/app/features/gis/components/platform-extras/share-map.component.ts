import { Component, Input, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { NotificationService } from '../../../../core/services/notification.service';
import { MapService } from '../../services/map.service';
import { PlatformExtrasService, ShareLink } from '../../services/platform-extras.service';

/** Public, read-only link (and embed code) to the current map view. */
@Component({
  selector: 'app-share-map',
  standalone: true,
  imports: [FormsModule, ButtonModule, DatePipe],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      <div class="px__tabs" role="tablist">
        <button type="button" role="tab" class="px__tab" [class.is-active]="tab() === 'new'" (click)="tab.set('new')">New link</button>
        <button type="button" role="tab" class="px__tab" [class.is-active]="tab() === 'links'" (click)="openLinks()">My links</button>
      </div>

      @if (tab() === 'new') {
        <p class="px__intro">Anyone with the link can view this map without signing in — the current view, basemap and the <strong>{{ sharedLayers().length }}</strong> visible layer{{ sharedLayers().length === 1 ? '' : 's' }}. Nobody can edit or download data through it.</p>

        <label class="px__field">
          <span class="px__label">Title</span>
          <input class="px__input" [ngModel]="title()" (ngModelChange)="title.set($event)" maxlength="120" placeholder="e.g. Ward boundaries 2026" />
        </label>

        <label class="px__field">
          <span class="px__label">Description (optional)</span>
          <textarea class="px__textarea" [ngModel]="description()" (ngModelChange)="description.set($event)" maxlength="500" rows="2"></textarea>
        </label>

        <div class="px__field">
          <span class="px__label">Link expires</span>
          <div class="px__seg">
            @for (e of expiries; track e.label) {
              <button type="button" class="px__seg-btn" [class.is-active]="expiry() === e.days" (click)="expiry.set(e.days)">{{ e.label }}</button>
            }
          </div>
        </div>

        @if (externalCount()) {
          <label class="px__check">
            <input type="checkbox" [ngModel]="includeExternal()" (ngModelChange)="includeExternal.set($event)" />
            Include {{ externalCount() }} outside service layer{{ externalCount() === 1 ? '' : 's' }}
          </label>
        }

        <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-share-alt" label="Create public link"
                [loading]="busy()" [disabled]="!title().trim() || (!sharedLayers().length && !externalShared().length)" (click)="create()"></button>
        @if (!sharedLayers().length && !externalShared().length) { <p class="px__hint">Turn on at least one layer to share.</p> }

        @if (created(); as link) {
          <div class="px__card">
            <span class="px__label">Public link</span>
            <div class="px__secret">
              <code>{{ urlOf(link) }}</code>
              <button type="button" class="px__icon-btn" title="Copy link" (click)="copy(urlOf(link))"><i class="pi pi-copy"></i></button>
              <a class="px__icon-btn" [href]="urlOf(link)" target="_blank" rel="noopener" title="Open"><i class="pi pi-external-link"></i></a>
            </div>
            <span class="px__label" style="margin-top: 6px">Embed on a website</span>
            <div class="px__secret">
              <code>{{ embedOf(link) }}</code>
              <button type="button" class="px__icon-btn" title="Copy embed code" (click)="copy(embedOf(link))"><i class="pi pi-copy"></i></button>
            </div>
          </div>
        }
      } @else {
        @if (loadingLinks()) {
          <p class="px__hint">Loading…</p>
        } @else if (!links().length) {
          <p class="px__hint px__hint--center">No public links yet.</p>
        } @else {
          <div class="px__list" style="max-height: none">
            @for (link of links(); track link.id) {
              <div class="px__item">
                <div class="px__item-main">
                  <span class="px__item-title" [title]="link.title">{{ link.title }}</span>
                  <span class="px__item-sub">
                    {{ link.viewCount }} view{{ link.viewCount === 1 ? '' : 's' }} ·
                    @if (link.expired) { expired } @else if (link.expiresAt) { until {{ link.expiresAt | date: 'mediumDate' }} } @else { never expires }
                  </span>
                </div>
                <button type="button" class="px__icon-btn" title="Copy link" (click)="copy(urlOf(link))"><i class="pi pi-copy"></i></button>
                <a class="px__icon-btn" [href]="urlOf(link)" target="_blank" rel="noopener" title="Open"><i class="pi pi-external-link"></i></a>
                <button type="button" class="px__icon-btn px__icon-btn--danger" title="Revoke" (click)="revoke(link)"><i class="pi pi-ban"></i></button>
              </div>
            }
          </div>
        }
      }
    </div>
  `
})
export class ShareMapComponent {
  private readonly map = inject(MapService);
  private readonly extras = inject(PlatformExtrasService);
  private readonly notify = inject(NotificationService);

  @Input() set layers(value: GisLayer[] | null) {
    this.layersSignal.set(value ?? []);
  }
  private readonly layersSignal = signal<GisLayer[]>([]);

  readonly expiries: { label: string; days: number | null }[] = [
    { label: 'Never', days: null },
    { label: '7 days', days: 7 },
    { label: '30 days', days: 30 },
    { label: '90 days', days: 90 }
  ];

  readonly tab = signal<'new' | 'links'>('new');
  readonly title = signal('');
  readonly description = signal('');
  readonly expiry = signal<number | null>(30);
  readonly includeExternal = signal(true);
  readonly busy = signal(false);
  readonly created = signal<ShareLink | null>(null);
  readonly links = signal<ShareLink[]>([]);
  readonly loadingLinks = signal(false);

  /** Visible layers, top first (the map's own draw order). */
  readonly sharedLayers = computed(() => {
    const visible = this.map.layerVisibility();
    const known = new Set(this.layersSignal().map((l) => l.id));
    const order = this.map.layerOrder();
    const ids = order.length ? order : this.layersSignal().map((l) => l.id);
    return ids.filter((id) => known.has(id) && visible[id]);
  });
  readonly externalCount = computed(() => this.map.externalLayers().filter((s) => s.visible).length);
  readonly externalShared = computed(() => (this.includeExternal() ? this.map.externalLayers().filter((s) => s.visible) : []));

  create(): void {
    const view = this.map.viewSnapshot();
    if (!view) return;
    this.busy.set(true);
    this.extras
      .createShare({
        title: this.title().trim(),
        description: this.description().trim() || undefined,
        layerIds: this.sharedLayers(),
        external: this.externalShared(),
        basemap: view.basemap,
        center: view.center,
        zoom: view.zoom,
        expiresInDays: this.expiry()
      })
      .subscribe({
        next: (link) => {
          this.created.set(link);
          this.busy.set(false);
          this.notify.success('Public link created.');
        },
        error: (e) => {
          this.busy.set(false);
          this.notify.error(e?.error?.message ?? 'Could not create the link.');
        }
      });
  }

  openLinks(): void {
    this.tab.set('links');
    this.loadingLinks.set(true);
    this.extras.listShares().subscribe({
      next: (links) => {
        this.links.set(links);
        this.loadingLinks.set(false);
      },
      error: () => this.loadingLinks.set(false)
    });
  }

  revoke(link: ShareLink): void {
    this.notify.confirm({
      header: 'Revoke public link',
      message: `"${link.title}" will stop working for everyone who has it.`,
      confirmLabel: 'Revoke',
      destructive: true,
      accept: () =>
        this.extras.revokeShare(link.id).subscribe({
          next: () => {
            this.links.update((list) => list.filter((l) => l.id !== link.id));
            if (this.created()?.id === link.id) this.created.set(null);
          },
          error: (e) => this.notify.error(e?.error?.message ?? 'Could not revoke the link.')
        })
    });
  }

  urlOf(link: ShareLink): string {
    return `${window.location.origin}/share/${link.token}`;
  }

  embedOf(link: ShareLink): string {
    return `<iframe src="${this.urlOf(link)}?embed=1" width="100%" height="480" style="border:0" loading="lazy" title="${link.title.replace(/"/g, '&quot;')}"></iframe>`;
  }

  copy(text: string): void {
    void navigator.clipboard?.writeText(text).then(() => this.notify.info('Copied to clipboard.'));
  }
}
