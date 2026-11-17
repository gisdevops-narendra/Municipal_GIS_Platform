import { Component, DestroyRef, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { Subscription } from 'rxjs';
import { MapService } from '../../services/map.service';
import { PlatformExtrasService, StreetImage } from '../../services/platform-extras.service';

/** Street-level imagery at a clicked point: Mapillary photos in the panel
 *  (when the server has a token) plus links to outside street viewers. */
@Component({
  selector: 'app-street-view',
  standalone: true,
  imports: [ButtonModule, DatePipe],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      @if (fixed()) {
        <div class="px__item" style="padding: 0">
          <div class="px__item-main">
            <span class="px__item-title">Street View</span>
            @if (point(); as p) { <span class="px__item-sub px__mono">{{ p[1].toFixed(5) }}, {{ p[0].toFixed(5) }}</span> }
          </div>
          <button type="button" class="px__icon-btn" aria-label="Close" (click)="closed.emit()"><i class="pi pi-times"></i></button>
        </div>
      } @else {
        <p class="px__intro">Click a street on the map to see street-level photos of that spot.</p>

        <button pButton type="button" class="p-button-sm px__btn-block" [icon]="picking() ? 'pi pi-times' : 'pi pi-camera'"
                [label]="picking() ? 'Cancel — click the map' : point() ? 'Pick another point' : 'Pick a point on the map'"
                [class.p-button-outlined]="picking()" (click)="picking() ? cancel() : pick()"></button>
      }

      @if (point(); as p) {
        <div class="px__section">
          <h4>Open in</h4>
          <div class="px__links">
            <a class="px__link-btn" [href]="links().google" target="_blank" rel="noopener noreferrer"><i class="pi pi-external-link"></i>Google Street View</a>
            <a class="px__link-btn" [href]="links().mapillary" target="_blank" rel="noopener noreferrer"><i class="pi pi-external-link"></i>Mapillary</a>
            <a class="px__link-btn" [href]="links().kartaview" target="_blank" rel="noopener noreferrer"><i class="pi pi-external-link"></i>KartaView</a>
            <a class="px__link-btn" [href]="links().maps" target="_blank" rel="noopener noreferrer"><i class="pi pi-external-link"></i>Google Maps</a>
          </div>
        </div>

        <div class="px__section">
          <h4>Nearby photos</h4>
          @if (loading()) {
            <p class="px__hint">Searching photos…</p>
          } @else if (configured() === false) {
            <p class="px__hint">In-app photos need a Mapillary token on the server (MAPILLARY_ACCESS_TOKEN). Use the links above meanwhile.</p>
          } @else if (error()) {
            <p class="px__error">{{ error() }}</p>
          } @else if (!images().length) {
            <p class="px__hint">No Mapillary photos within ~200 m.</p>
          } @else {
            @if (current(); as img) {
              <a [href]="img.viewerUrl" target="_blank" rel="noopener noreferrer" title="Open in Mapillary">
                @if (img.thumbUrl) { <img class="px__thumb" [src]="img.thumbUrl" alt="Street-level photo near the picked point" /> }
              </a>
              <span class="px__item-sub">{{ img.distanceM }} m away@if (img.capturedAt) { · {{ img.capturedAt | date: 'mediumDate' }} }</span>
            }
            <div class="px__list">
              @for (img of images(); track img.id; let i = $index) {
                <div class="px__item px__item--click" [style.background]="i === index() ? 'var(--color-surface-alt)' : null" (click)="index.set(i)">
                  <i class="pi pi-image" aria-hidden="true"></i>
                  <div class="px__item-main">
                    <span class="px__item-title">Photo {{ i + 1 }} · {{ img.distanceM }} m</span>
                    <span class="px__item-sub">{{ img.capturedAt ? (img.capturedAt | date: 'mediumDate') : 'Date unknown' }}</span>
                  </div>
                </div>
              }
            </div>
          }
        </div>
      }
    </div>
  `
})
export class StreetViewComponent {
  private readonly map = inject(MapService);
  private readonly extras = inject(PlatformExtrasService);

  /** Opened at a given point (map right-click) instead of picking one. */
  @Input() set at(value: [number, number] | null) {
    this.fixed.set(!!value);
    if (value) this.load(value);
  }
  @Output() readonly closed = new EventEmitter<void>();
  readonly fixed = signal(false);

  readonly picking = signal(false);
  readonly point = signal<[number, number] | null>(null);
  readonly loading = signal(false);
  readonly configured = signal<boolean | null>(null);
  readonly error = signal<string | null>(null);
  readonly images = signal<StreetImage[]>([]);
  readonly index = signal(0);
  readonly current = computed(() => this.images()[this.index()] ?? null);
  readonly links = computed(() => {
    const [lon, lat] = this.point() ?? [0, 0];
    return {
      google: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`,
      maps: `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`,
      mapillary: `https://www.mapillary.com/app/?lat=${lat}&lng=${lon}&z=17`,
      kartaview: `https://kartaview.org/map/@${lat},${lon},17z`
    };
  });
  private pickSub: Subscription | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.cancel();
      this.map.markLocation(null);
    });
  }

  pick(): void {
    this.cancel();
    this.picking.set(true);
    this.pickSub = this.map.pickMapPoint().subscribe(({ lonLat }) => {
      this.picking.set(false);
      this.load(lonLat);
    });
  }

  cancel(): void {
    this.pickSub?.unsubscribe();
    this.pickSub = null;
    if (this.picking()) this.map.cancelMapPick();
    this.picking.set(false);
  }

  private load(lonLat: [number, number]): void {
    this.point.set(lonLat);
    this.map.markLocation(lonLat);
    this.loading.set(true);
    this.error.set(null);
    this.images.set([]);
    this.index.set(0);
    this.extras.streetImagery(lonLat[0], lonLat[1]).subscribe({
      next: (res) => {
        this.configured.set(res.configured);
        this.images.set(res.images);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(e?.error?.message ?? 'Could not load photos.');
        this.loading.set(false);
      }
    });
  }
}
