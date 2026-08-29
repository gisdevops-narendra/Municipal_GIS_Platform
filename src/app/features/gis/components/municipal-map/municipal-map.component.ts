import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild, inject } from '@angular/core';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { FeatureInfoResult, MapService } from '../../services/map.service';
import { FeatureInfoComponent } from '../feature-info/feature-info.component';

/**
 * OpenLayers map surface only — no layer-panel UI of its own. Owns map
 * initialization, the click -> GetFeatureInfo wiring, and the custom
 * on-map Identify popup (an OpenLayers `Overlay` hosting `<app-feature-info>`).
 * Everything else (visibility toggles, attribute-table selection sync) is
 * driven through the shared MapService by sibling components.
 */
@Component({
  selector: 'app-municipal-map',
  standalone: true,
  imports: [FeatureInfoComponent],
  templateUrl: './municipal-map.component.html',
  styleUrl: './municipal-map.component.scss'
})
export class MunicipalMapComponent implements AfterViewInit, OnChanges, OnDestroy {
  private readonly mapService = inject(MapService);

  @Input({ required: true }) layers: GisLayer[] = [];
  /** Optional DOM slots for the scale bar / cursor coordinates — the GIS
   *  workspace docks these in its status bar instead of on the map. */
  @Input() scaleLineTarget?: HTMLElement;
  @Input() mousePositionTarget?: HTMLElement;
  /** Flattened map-click hits, so the Attribute Table can mirror the
   *  selection — the feature info itself now shows in the on-map popup. */
  @Output() featureInfoResults = new EventEmitter<FeatureInfoResult[]>();
  /** Task 9 §4: fires once the OpenLayers map instance exists, so a parent
   *  page can safely call MapService methods (e.g. zoomToLayer) for a
   *  dashboard deep link without racing map initialization. */
  @Output() mapReady = new EventEmitter<void>();

  @ViewChild('mapContainer', { static: true }) private readonly mapContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('featurePopup', { static: true }) private readonly featurePopup!: ElementRef<HTMLDivElement>;

  /** Identify popup state (contents + visibility), owned by MapService. */
  readonly popup = this.mapService.featureInfoPopup;

  private initialized = false;
  private resizeObserver: ResizeObserver | null = null;

  ngAfterViewInit(): void {
    this.tryInit();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['layers'] && !this.initialized) {
      this.tryInit();
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.mapService.destroy();
  }

  closePopup(): void {
    this.mapService.closeFeatureInfoPopup();
  }

  private tryInit(): void {
    if (this.initialized || !this.mapContainer || this.layers.length === 0) {
      return;
    }
    this.initialized = true;
    this.mapService.initMap(this.mapContainer.nativeElement, this.layers, {
      scaleLineTarget: this.scaleLineTarget,
      mousePositionTarget: this.mousePositionTarget
    });
    this.mapService.registerFeatureInfoPopup(this.featurePopup.nativeElement);
    this.mapService.onSingleClick((coordinate) => this.onMapClick(coordinate));

    // The container is detached from the DOM while another route is showing
    // (keep-alive navigation) and its size also changes when docks open /
    // resize — OpenLayers only repaints correctly if told. One observer
    // covers both cases (and supersedes the workspace's setTimeout hack).
    this.resizeObserver = new ResizeObserver(() => this.mapService.updateSize());
    this.resizeObserver.observe(this.mapContainer.nativeElement);

    this.mapReady.emit();
  }

  private onMapClick(coordinate: number[]): void {
    this.mapService.openFeatureInfoPopup(coordinate, { loading: true, error: null, results: [] });
    this.mapService.getFeatureInfo(coordinate).subscribe({
      next: (results) => {
        // Nothing under the click — don't leave an empty card floating.
        if (results.length === 0) {
          this.mapService.closeFeatureInfoPopup();
        } else {
          this.mapService.updateFeatureInfoPopup({ loading: false, error: null, results });
        }
        this.featureInfoResults.emit(results);
      },
      error: () => {
        this.mapService.updateFeatureInfoPopup({
          loading: false,
          error: 'Could not retrieve feature information. Please try again.',
          results: []
        });
      }
    });
  }
}
