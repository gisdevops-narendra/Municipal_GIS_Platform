import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild
} from '@angular/core';
import OlMap from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import ImageLayer from 'ol/layer/Image';
import OSM from 'ol/source/OSM';
import ImageWMS from 'ol/source/ImageWMS';
import TileWMS from 'ol/source/TileWMS';
import { transformExtent } from 'ol/proj';
import { defaults as defaultControls } from 'ol/control/defaults';
import { environment } from '../../../../../environments/environment';
import { GisLayer } from '../../../../core/models/gis-layer.model';

const MAP_PROJECTION = 'EPSG:3857';
const LAYER_PROJECTION = 'EPSG:4326';

/**
 * Small stand-alone map showing one published layer over OpenStreetMap,
 * framed to the layer's extent. Used next to the style editor outside the
 * GIS workspace, so style changes can be seen as they are applied: bump
 * `refreshKey` after each apply and the layer image is re-requested.
 */
@Component({
  selector: 'app-layer-preview-map',
  standalone: true,
  template: `<div #mapEl class="lpm"></div>`,
  styles: [
    `
      :host {
        display: block;
        min-height: 320px;
      }
      .lpm {
        width: 100%;
        height: 100%;
        min-height: inherit;
        border: 1px solid var(--color-line);
        border-radius: var(--radius-md);
        overflow: hidden;
        background: var(--color-surface-alt);
      }
    `
  ]
})
export class LayerPreviewMapComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) layer!: GisLayer;
  /** Change it (e.g. Date.now()) to reload the layer with its newest style. */
  @Input() refreshKey = 0;

  @ViewChild('mapEl', { static: true }) private mapEl!: ElementRef<HTMLDivElement>;

  private map: OlMap | null = null;
  private source: ImageWMS | TileWMS | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private fitted = false;

  ngAfterViewInit(): void {
    const qualified = `${this.layer.geoserverWorkspace}:${this.layer.geoserverLayer}`;
    // Same sources as the GIS workspace map (MapService.addWmsLayer).
    const dataLayer =
      this.layer.layerType === 'RASTER'
        ? new TileLayer({
            source: (this.source = new TileWMS({
              url: `${environment.geoserverUrl}/gwc/service/wms`,
              params: { LAYERS: qualified, TILED: true, FORMAT: 'image/png', VERSION: '1.1.1' },
              projection: MAP_PROJECTION,
              transition: 0
            }))
          })
        : new ImageLayer({
            source: (this.source = new ImageWMS({
              url: `${environment.geoserverUrl}/${this.layer.geoserverWorkspace}/wms`,
              params: { LAYERS: qualified, TILED: false },
              projection: MAP_PROJECTION,
              ratio: 1
            }))
          });

    this.map = new OlMap({
      target: this.mapEl.nativeElement,
      layers: [new TileLayer({ source: new OSM() }), dataLayer],
      view: new View({ projection: MAP_PROJECTION, center: [0, 0], zoom: 2 }),
      controls: defaultControls({ rotate: false, attributionOptions: { collapsible: true } })
    });
    // Dialogs animate open, so the container's size settles after init —
    // frame the layer once it has a real size, not before.
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.map) return;
      this.map.updateSize();
      const size = this.map.getSize();
      if (!this.fitted && size && size[0] > 0 && size[1] > 0) {
        this.fitted = true;
        this.fitToLayer();
      }
    });
    this.resizeObserver.observe(this.mapEl.nativeElement);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['refreshKey'] && !changes['refreshKey'].firstChange) {
      this.source?.updateParams({ _style: this.refreshKey });
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.map?.setTarget(undefined);
    this.map = null;
  }

  private fitToLayer(): void {
    const bbox = this.layer.bbox;
    if (!this.map || !bbox) return;
    const extent = transformExtent([bbox.minX, bbox.minY, bbox.maxX, bbox.maxY], LAYER_PROJECTION, MAP_PROJECTION);
    // A single point (or tiny cluster) would otherwise zoom in to max.
    this.map.getView().fit(extent, { size: this.map.getSize(), padding: [32, 32, 32, 32], maxZoom: 17 });
  }
}
