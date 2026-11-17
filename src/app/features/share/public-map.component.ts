import { AfterViewInit, Component, ElementRef, OnDestroy, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import OlMap from 'ol/Map';
import View from 'ol/View';
import ImageLayer from 'ol/layer/Image';
import TileLayer from 'ol/layer/Tile';
import ImageWMS from 'ol/source/ImageWMS';
import OSM from 'ol/source/OSM';
import type BaseLayer from 'ol/layer/Base';
import { defaults as defaultControls } from 'ol/control';
import ScaleLine from 'ol/control/ScaleLine';
import OverviewMap from 'ol/control/OverviewMap';
import { fromLonLat } from 'ol/proj';
import { environment } from '../../../environments/environment';
import { BASEMAPS } from '../gis/services/map.service';
import { buildExternalLayer, directFetchText } from '../gis/services/external-layers';
import { PlatformExtrasService, PublicShare } from '../gis/services/platform-extras.service';

interface ViewerLayer {
  key: string;
  name: string;
  kind: string;
  visible: boolean;
  ol: BaseLayer;
}

/** Public, read-only map opened from a Share Map link (no sign-in).
 *  `?embed=1` hides the side panel for iframes. */
@Component({
  selector: 'app-public-map',
  standalone: true,
  template: `
    <div class="pm" [class.pm--embed]="embed">
      @if (!embed) {
        <header class="pm__bar">
          <div class="pm__titles">
            <h1>{{ share()?.title ?? 'Shared map' }}</h1>
            @if (share()?.municipalityName; as m) { <span>{{ m }}</span> }
          </div>
          @if (share()) {
            <button type="button" class="pm__toggle" (click)="panelOpen.set(!panelOpen())" [attr.aria-expanded]="panelOpen()">
              <i class="pi pi-clone" aria-hidden="true"></i> Layers
            </button>
          }
        </header>
      }

      <div class="pm__body">
        <div #mapEl class="pm__map"></div>

        @if (embed && share(); as s) {
          <div class="pm__embed-title">{{ s.title }}</div>
        }

        @if (share() && panelOpen() && !embed) {
          <aside class="pm__panel">
            @if (share()?.description; as d) { <p class="pm__desc">{{ d }}</p> }
            <h2>Layers</h2>
            <ul class="pm__layers">
              @for (l of layers(); track l.key) {
                <li>
                  <label>
                    <input type="checkbox" [checked]="l.visible" (change)="toggle(l)" />
                    <span class="pm__layer-name" [title]="l.name">{{ l.name }}</span>
                    <span class="pm__layer-kind">{{ l.kind }}</span>
                  </label>
                </li>
              } @empty {
                <li class="pm__muted">No layers.</li>
              }
            </ul>
            <p class="pm__muted pm__foot">Read-only map shared by {{ share()?.municipalityName ?? 'the municipality' }}.</p>
          </aside>
        }

        @if (error(); as message) {
          <div class="pm__error">
            <i class="pi pi-link" aria-hidden="true"></i>
            <h2>Map unavailable</h2>
            <p>{{ message }}</p>
          </div>
        } @else if (!share()) {
          <div class="pm__error pm__error--soft"><p>Loading map…</p></div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host { display: block; height: 100vh; height: 100dvh; }
      .pm { display: flex; flex-direction: column; height: 100%; background: var(--color-surface, #fff); color: var(--color-ink-900, #1c2430); }
      .pm__bar { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--color-line, #e3e6ea); }
      .pm__titles { min-width: 0; display: flex; flex-direction: column; }
      .pm__titles h1 { margin: 0; font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pm__titles span { font-size: 12px; color: var(--color-ink-500, #6b7280); }
      .pm__toggle { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border: 1px solid var(--color-line, #e3e6ea); border-radius: 8px; background: var(--color-surface, #fff); color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
      .pm__body { position: relative; flex: 1; min-height: 0; display: flex; }
      .pm__map { flex: 1; min-width: 0; height: 100%; }
      .pm__panel { flex: none; width: 280px; max-width: 85vw; overflow-y: auto; padding: 14px 16px; border-left: 1px solid var(--color-line, #e3e6ea); background: var(--color-surface, #fff); }
      .pm__panel h2 { margin: 0 0 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-ink-500, #6b7280); }
      .pm__desc { margin: 0 0 14px; font-size: 13px; line-height: 1.5; color: var(--color-ink-700, #374151); }
      .pm__layers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
      .pm__layers label { display: flex; align-items: center; gap: 8px; padding: 6px 4px; font-size: 13px; cursor: pointer; border-radius: 6px; }
      .pm__layers label:hover { background: var(--color-surface-alt, #f5f6f8); }
      .pm__layer-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pm__layer-kind { flex: none; font-size: 10px; color: var(--color-ink-500, #6b7280); }
      .pm__muted { font-size: 12px; color: var(--color-ink-500, #6b7280); }
      .pm__foot { margin-top: 16px; }
      .pm__embed-title { position: absolute; top: 8px; left: 8px; max-width: calc(100% - 16px); padding: 4px 10px; border-radius: 6px; background: rgb(255 255 255 / 0.92); font-size: 13px; font-weight: 600; color: #1c2430; box-shadow: 0 1px 3px rgb(0 0 0 / 0.15); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; pointer-events: none; }
      .pm__error { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 24px; text-align: center; background: var(--color-surface, #fff); }
      .pm__error--soft { background: transparent; pointer-events: none; }
      .pm__error h2 { margin: 0; font-size: 18px; }
      .pm__error p { margin: 0; color: var(--color-ink-500, #6b7280); }
      .pm__error .pi { font-size: 28px; color: var(--color-ink-300, #9ca3af); }
      @media (max-width: 640px) {
        .pm__panel { position: absolute; top: 0; right: 0; bottom: 0; z-index: 5; box-shadow: -4px 0 16px rgb(0 0 0 / 0.12); }
      }
    `
  ]
})
export class PublicMapComponent implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly extras = inject(PlatformExtrasService);
  private readonly mapEl = viewChild.required<ElementRef<HTMLElement>>('mapEl');

  readonly embed = this.route.snapshot.queryParamMap.get('embed') === '1';
  readonly share = signal<PublicShare | null>(null);
  readonly error = signal<string | null>(null);
  readonly layers = signal<ViewerLayer[]>([]);
  readonly panelOpen = signal(typeof window === 'undefined' || window.innerWidth > 640);
  readonly visibleCount = computed(() => this.layers().filter((l) => l.visible).length);
  private map: OlMap | null = null;

  ngAfterViewInit(): void {
    const token = this.route.snapshot.paramMap.get('token') ?? '';
    this.extras.openPublicShare(token).subscribe({
      next: (share) => {
        this.share.set(share);
        document.title = `${share.title} — Shared map`;
        this.build(share);
      },
      error: (e) => this.error.set(e?.error?.message ?? 'This map link does not exist, has expired or was revoked.')
    });
  }

  ngOnDestroy(): void {
    this.map?.setTarget(undefined);
    this.map = null;
  }

  toggle(layer: ViewerLayer): void {
    layer.ol.setVisible(!layer.visible);
    this.layers.update((list) => list.map((l) => (l.key === layer.key ? { ...l, visible: !l.visible } : l)));
  }

  private build(share: PublicShare): void {
    const base = (BASEMAPS[share.basemap] ?? BASEMAPS['osm']).build();
    const own: ViewerLayer[] = share.layers.map((l) => ({
      key: l.id,
      name: l.name,
      kind: l.layerType === 'RASTER' ? 'Raster' : 'Vector',
      visible: true,
      ol: new ImageLayer({
        source: new ImageWMS({
          url: `${environment.geoserverUrl}/${l.geoserverWorkspace}/wms`,
          params: { LAYERS: `${l.geoserverWorkspace}:${l.geoserverLayer}` },
          ratio: 1
        })
      })
    }));
    const external: ViewerLayer[] = (share.external ?? []).map((spec, i) => ({
      key: `ext-${i}`,
      name: spec.title,
      kind: spec.kind,
      visible: true,
      ol: buildExternalLayer({ ...spec, id: `ext-${i}`, visible: true }, directFetchText)
    }));
    // Shared top-first; OpenLayers draws the last added on top.
    const stack = [...[...own].reverse(), ...external];
    this.map = new OlMap({
      target: this.mapEl().nativeElement,
      layers: [base, ...stack.map((l) => l.ol)],
      view: new View({ center: fromLonLat(share.center), zoom: share.zoom }),
      controls: defaultControls().extend([
        new ScaleLine({ units: 'metric' }),
        ...(this.embed ? [] : [new OverviewMap({ collapsed: true, tipLabel: 'Overview map', layers: [new TileLayer({ source: new OSM() })] })])
      ])
    });
    this.layers.set([...own, ...external]);
  }
}
