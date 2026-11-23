import { AfterViewInit, Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild, inject, signal } from '@angular/core';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { FeatureInfoResult, MapPin, MapService } from '../../services/map.service';
import { FeatureInfoComponent } from '../feature-info/feature-info.component';
import { StreetViewComponent } from '../platform-extras/street-view.component';
import { NotificationService } from '../../../../core/services/notification.service';
import { copyText } from '../../../../shared/copy-text';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../../../environments/environment';
import { FormsModule } from '@angular/forms';

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
  imports: [FeatureInfoComponent, StreetViewComponent, FormsModule],
  templateUrl: './municipal-map.component.html',
  styleUrl: './municipal-map.component.scss'
})
export class MunicipalMapComponent implements AfterViewInit, OnChanges, OnDestroy {
  protected readonly mapService = inject(MapService);
  private readonly notify = inject(NotificationService);
  private readonly http = inject(HttpClient);

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

  /** Right-click menu: where it is drawn (px in the map) and the WGS84
   *  point it acts on. */
  readonly contextMenu = signal<{ x: number; y: number; lonLat: [number, number]; pin: MapPin | null } | null>(null);
  /** Street View card opened from the menu. */
  readonly streetViewAt = signal<[number, number] | null>(null);

  private initialized = false;
  private resizeObserver: ResizeObserver | null = null;

  ngAfterViewInit(): void {
    this.tryInit();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['layers'] && !this.initialized) {
      this.tryInit();
    } else if (changes['layers'] && this.initialized) {
      this.mapService.syncLayers(this.layers);
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.mapService.destroy();
  }

  onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    const box = this.mapContainer.nativeElement.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const lonLat = this.mapService.lonLatAtPixel([x, y]);
    if (!lonLat) return;
    // Keep the menu inside the map.
    const menuW = 240;
    const menuH = Math.min(440, box.height - 8);
    this.pinEditing.set(false);
    this.pinNote = '';
    this.rotateDeg = String(Math.round(((this.mapService.mapRotation() * 180) / Math.PI + 360) % 360));
    this.contextMenu.set({
      x: Math.max(4, Math.min(x, box.width - menuW - 4)),
      y: Math.max(4, Math.min(y, box.height - menuH - 4)),
      lonLat,
      pin: this.mapService.pinAtPixel([x, y])
    });
  }

  openStreetView(): void {
    const menu = this.contextMenu();
    this.contextMenu.set(null);
    if (menu) this.streetViewAt.set([...menu.lonLat]);
  }

  // ----- pins -----
  readonly pinEditing = signal(false);
  pinNote = '';

  dropPin(): void {
    const menu = this.contextMenu();
    if (!menu) return;
    this.mapService.addPin(menu.lonLat, this.pinNote);
    this.contextMenu.set(null);
  }

  removePin(id: string): void {
    this.mapService.removePin(id);
    this.contextMenu.set(null);
  }

  clearPins(): void {
    this.mapService.clearPins();
    this.contextMenu.set(null);
  }

  // ----- distance & bearing from here -----
  measureFromHere(): void {
    const menu = this.contextMenu();
    this.contextMenu.set(null);
    if (menu) this.mapService.startMeasureFrom(menu.lonLat);
  }

  // ----- rotate -----
  rotateDeg = '0';

  applyRotation(): void {
    const deg = Number(String(this.rotateDeg).replace(',', '.'));
    if (!Number.isFinite(deg)) return;
    this.mapService.setRotationDegrees(deg);
    this.contextMenu.set(null);
  }

  // ----- export this view as a georeferenced image -----
  readonly exporting = signal(false);

  async exportView(format: 'tif' | 'png'): Promise<void> {
    this.contextMenu.set(null);
    this.exporting.set(true);
    try {
      const shot = await this.mapService.captureView();
      if (!shot) {
        this.notify.error('A layer on the map does not allow its image to be exported (no CORS). Turn that layer off and try again, or use Print.', 'Export view');
        return;
      }
      const form = new FormData();
      form.append('file', shot.blob, 'view.png');
      form.append('bbox', shot.bbox.join(','));
      form.append('crs', shot.crs);
      form.append('format', format);
      form.append('name', `map_view_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
      const res = await firstValueFrom(
        this.http.post(`${environment.apiUrl}/gis/raster/georef/view-export`, form, { responseType: 'blob', observe: 'response' })
      );
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? (format === 'tif' ? 'map_view.tif' : 'map_view.zip');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(res.body!);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      this.notify.success(format === 'tif' ? 'GeoTIFF (Web Mercator, EPSG:3857) downloaded.' : 'PNG + world file (.pgw) + .prj downloaded as a ZIP.', 'Export view');
    } catch (error) {
      this.notify.error((error as Error)?.message || 'The view could not be exported.', 'Export view');
    } finally {
      this.exporting.set(false);
    }
  }

  copyViewLink(): void {
    this.contextMenu.set(null);
    const link = this.mapService.viewLink();
    if (!link) return;
    void copyText(link).then((ok) =>
      ok ? this.notify.success('Anyone with access who opens it lands on this view.', 'Link copied') : this.notify.error('Could not copy the link.')
    );
  }

  setHomeView(): void {
    this.contextMenu.set(null);
    if (this.mapService.setHomeView()) this.notify.success('The map now opens here, and Reset returns here.', 'Home view saved');
  }

  clearHomeView(): void {
    this.contextMenu.set(null);
    this.mapService.clearHomeView();
    this.notify.info('Reset goes back to the default view.', 'Home view cleared');
  }

  openGoogleStreetView(): void {
    const menu = this.contextMenu();
    this.contextMenu.set(null);
    if (!menu) return;
    const [lon, lat] = menu.lonLat;
    window.open(`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`, '_blank', 'noopener');
  }

  closeStreetView(): void {
    this.streetViewAt.set(null);
  }

  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: PointerEvent): void {
    if (this.contextMenu() && !(event.target as HTMLElement | null)?.closest('.map-ctx')) this.contextMenu.set(null);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.contextMenu.set(null);
    if (this.mapService.measuringFrom()) this.mapService.stopMeasureFrom(true);
  }

  closePopup(): void {
    this.mapService.closeFeatureInfoPopup();
  }

  /** Docked card (default) vs popup at the clicked point. */
  readonly docked = this.mapService.featureInfoDocked;

  setDocked(value: boolean): void {
    this.mapService.setFeatureInfoDocked(value);
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
