import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild, inject } from '@angular/core';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { FeatureInfoResult, MapService } from '../../services/map.service';

/**
 * OpenLayers map surface only — no layer-panel/feature-info UI of its own.
 * Owns map initialization + click -> GetFeatureInfo wiring; everything
 * else (visibility toggles, results display) is driven through the shared
 * MapService by sibling components under the same page.
 */
@Component({
  selector: 'app-municipal-map',
  standalone: true,
  imports: [],
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
  @Output() featureInfoResults = new EventEmitter<FeatureInfoResult[]>();
  @Output() featureInfoLoading = new EventEmitter<boolean>();
  @Output() featureInfoError = new EventEmitter<string | null>();
  /** Task 9 §4: fires once the OpenLayers map instance exists, so a parent
   *  page can safely call MapService methods (e.g. zoomToLayer) for a
   *  dashboard deep link without racing map initialization. */
  @Output() mapReady = new EventEmitter<void>();

  @ViewChild('mapContainer', { static: true }) private readonly mapContainer!: ElementRef<HTMLDivElement>;

  private initialized = false;

  ngAfterViewInit(): void {
    this.tryInit();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['layers'] && !this.initialized) {
      this.tryInit();
    }
  }

  ngOnDestroy(): void {
    this.mapService.destroy();
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
    this.mapService.onSingleClick((coordinate) => this.onMapClick(coordinate));
    this.mapReady.emit();
  }

  private onMapClick(coordinate: number[]): void {
    this.featureInfoLoading.emit(true);
    this.featureInfoError.emit(null);
    this.mapService.getFeatureInfo(coordinate).subscribe({
      next: (results) => {
        this.featureInfoLoading.emit(false);
        this.featureInfoResults.emit(results);
      },
      error: () => {
        this.featureInfoLoading.emit(false);
        this.featureInfoError.emit('Could not retrieve feature information. Please try again.');
      }
    });
  }
}
