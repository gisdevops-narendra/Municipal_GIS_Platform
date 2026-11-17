import { Component, DestroyRef, inject, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { Subscription } from 'rxjs';
import { MapService } from '../../services/map.service';
import { PlatformExtrasService, ReverseResult } from '../../services/platform-extras.service';

/** Reverse geocoding: click the map → address and the named places
 *  (from your own layers) at that point. */
@Component({
  selector: 'app-whats-here',
  standalone: true,
  imports: [ButtonModule],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      <p class="px__intro">Click anywhere on the map to see its address and the areas it falls in (ward, village, district… from your layers).</p>

      <button pButton type="button" class="p-button-sm px__btn-block" [icon]="picking() ? 'pi pi-times' : 'pi pi-map-marker'"
              [label]="picking() ? 'Cancel — click the map' : result() ? 'Pick another point' : 'Pick a point on the map'"
              [class.p-button-outlined]="picking()" (click)="picking() ? cancel() : pick()"></button>

      @if (loading()) { <p class="px__hint">Looking up…</p> }
      @if (error(); as message) { <p class="px__error" role="alert">{{ message }}</p> }

      @if (result(); as r) {
        <div class="px__card">
          <span class="px__label">Coordinates (WGS84)</span>
          <div class="px__secret">
            <code>{{ r.lat.toFixed(6) }}, {{ r.lon.toFixed(6) }}</code>
            <button type="button" class="px__icon-btn" title="Copy" (click)="copy(r.lat.toFixed(6) + ', ' + r.lon.toFixed(6))"><i class="pi pi-copy"></i></button>
          </div>
        </div>

        <div class="px__section">
          <h4>Address</h4>
          @if (r.address; as a) {
            <div class="px__card">
              <span class="px__item-title" style="white-space: normal">{{ a.road || a.locality || a.city || 'Address' }}</span>
              <span class="px__item-sub" style="white-space: normal">{{ a.displayName }}</span>
              <div class="px__secret" style="margin-top: 4px">
                <button pButton type="button" class="p-button-sm p-button-text" icon="pi pi-copy" label="Copy address" (click)="copy(a.displayName)"></button>
              </div>
            </div>
          } @else {
            <p class="px__hint">{{ r.addressLookup ? 'No street address found here.' : 'Street-address lookup is switched off on this server.' }}</p>
          }
        </div>

        <div class="px__section">
          <h4>From your layers</h4>
          @if (r.places.length) {
            <dl class="px__kv">
              @for (p of r.places; track p.layerName + p.label) {
                <dt>{{ p.layerName }}</dt>
                <dd>{{ p.label }}@if (p.kind === 'near' && p.distanceM !== null) { <span class="px__item-sub"> · {{ p.distanceM }} m</span> }</dd>
              }
            </dl>
          } @else {
            <p class="px__hint">No named feature of your layers at this point.</p>
          }
        </div>
      }
    </div>
  `
})
export class WhatsHereComponent {
  private readonly map = inject(MapService);
  private readonly extras = inject(PlatformExtrasService);

  readonly picking = signal(false);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<ReverseResult | null>(null);
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
      this.lookup(lonLat);
    });
  }

  cancel(): void {
    this.pickSub?.unsubscribe();
    this.pickSub = null;
    if (this.picking()) this.map.cancelMapPick();
    this.picking.set(false);
  }

  private lookup([lon, lat]: [number, number]): void {
    this.map.markLocation([lon, lat]);
    this.loading.set(true);
    this.error.set(null);
    this.extras.reverse(lon, lat).subscribe({
      next: (r) => {
        this.result.set(r);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(e?.error?.message ?? 'Lookup failed.');
        this.loading.set(false);
      }
    });
  }

  copy(text: string): void {
    void navigator.clipboard?.writeText(text);
  }
}
