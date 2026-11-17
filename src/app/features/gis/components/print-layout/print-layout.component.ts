import { Component, Input, OnDestroy, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse, HttpResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { CheckboxModule } from 'primeng/checkbox';
import { MessageModule } from 'primeng/message';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import {
  PrintBasemapId,
  PrintFormat,
  PrintOrientation,
  PrintPageSize,
  PrintReportRequest
} from '../../../../core/models/print.model';
import { MapService } from '../../services/map.service';
import { parseLegend } from '../layer-legend/legend-model';
import { buildPrintLegend } from '../layer-legend/print-legend';
import { PrintService } from '../../../../core/services/print.service';

type PanelState = 'idle' | 'generating' | 'done' | 'error';

/** Size of the printed map area per layout, in points (1/72 in) — must
 *  match the map frames in mapfish-print/gen_print.py. */
const MAP_AREA_PT: Record<string, [number, number]> = {
  'A4 landscape': [600, 474],
  'A4 portrait': [555, 560],
  'A3 landscape': [935, 712],
  'A3 portrait': [794, 860]
};

/** Standard map scales offered besides "current view". */
const FIXED_SCALES = [500, 1000, 2000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];

/** Every live-map basemap id the print backend can actually render — see
 *  PrintBasemapId. */
const PRINTABLE_BASEMAP_IDS: ReadonlySet<PrintBasemapId> = new Set([
  'osm',
  'carto-voyager',
  'carto-dark',
  'topo',
  'none'
]);

/**
 * Print Layout — GIS workspace left dock. Produces a professional map
 * document (A4/A3, portrait/landscape, PDF or PNG) from the **live
 * OpenLayers map** via MapFish Print, proxied by the NestJS backend.
 *
 * Configure → generate → the file downloads directly. There is no
 * in-panel preview: what prints is the current map view, its visible
 * layers and their styling, read straight from the shared MapService —
 * no second map, no dummy data.
 */
@Component({
  selector: 'app-print-layout',
  standalone: true,
  imports: [FormsModule, ButtonModule, SelectModule, InputTextModule, CheckboxModule, MessageModule],
  templateUrl: './print-layout.component.html',
  styleUrl: './print-layout.component.scss'
})
export class PrintLayoutComponent implements OnDestroy {
  private readonly mapService = inject(MapService);
  private readonly printService = inject(PrintService);

  // Layers currently on the map (from the workspace) — used only for the
  // "N layers" hint; the authoritative list is read live from MapService
  // at generate time.
  @Input() layers: GisLayer[] = [];

  readonly pageSizes: { label: string; value: PrintPageSize }[] = [
    { label: 'A4', value: 'A4' },
    { label: 'A3', value: 'A3' }
  ];
  readonly orientationOptions: { label: string; icon: string; value: PrintOrientation }[] = [
    { label: 'Landscape', icon: 'pi pi-stop', value: 'landscape' },
    { label: 'Portrait', icon: 'pi pi-stop', value: 'portrait' }
  ];
  readonly formatOptions: { label: string; icon: string; value: PrintFormat }[] = [
    { label: 'PDF', icon: 'pi pi-file-pdf', value: 'pdf' },
    { label: 'Image', icon: 'pi pi-image', value: 'png' }
  ];

  readonly pageSize = signal<PrintPageSize>('A4');
  readonly orientation = signal<PrintOrientation>('landscape');
  readonly format = signal<PrintFormat>('pdf');
  readonly dpi = signal<number>(150);
  readonly dpiOptions = signal<{ label: string; value: number }[]>([96, 150, 300].map((v) => ({ label: this.dpiLabel(v), value: v })));

  /** 0 = the current map view's scale; otherwise a fixed 1 : N. */
  readonly scaleChoice = signal<number>(0);
  readonly scaleOptions = [
    { label: 'Current view', value: 0 },
    ...FIXED_SCALES.map((n) => ({ label: `1 : ${n.toLocaleString()}`, value: n }))
  ];
  /** Dashed frame on the live map showing exactly what will print. */
  readonly showFrame = signal(true);

  title = '';
  metadata = '';
  includeLegend = true;
  includeScalebar = true;
  includeNorthArrow = true;
  includeDate = true;
  includeOverview = true;
  includeGrid = false;
  preparedBy = '';
  notes = '';

  readonly state = signal<PanelState>('idle');
  readonly errorMsg = signal<string | null>(null);
  readonly lastFilename = signal<string | null>(null);

  /** Live "1 : N" scale readout so the user knows what they'll get. */
  readonly scaleLabel = signal<string>('—');

  private objectUrl: string | null = null;
  private resultFilename = 'municipal-gis-map.pdf';

  constructor() {
    // Follow the live view — the panel stays open while the user pans and
    // zooms, and a stale scale would not match what gets printed.
    effect(() => {
      this.mapService.viewRevision();
      this.mapService.centerRevision();
      this.pageSize();
      this.orientation();
      this.scaleChoice();
      this.showFrame();
      untracked(() => {
        this.refreshScale();
        this.drawFrame();
      });
    });
    // MapFish capabilities are advisory — the panel stays fully usable if
    // the call fails (the defaults above still apply).
    this.printService.capabilities().subscribe({
      next: (caps) => {
        const map = caps.layouts?.[0]?.attributes?.find((a) => a.name === 'map');
        const suggestions = map?.clientParams?.['dpiSuggestions'];
        if (Array.isArray(suggestions) && suggestions.length > 0) {
          this.dpiOptions.set(
            suggestions
              .filter((v): v is number => typeof v === 'number')
              .map((value) => ({ label: this.dpiLabel(value), value }))
          );
        }
      },
      error: () => undefined
    });
  }

  ngOnDestroy(): void {
    this.releaseObjectUrl();
    this.mapService.setPrintFrame(null);
  }

  /** Panel hidden (another tool shown): hide the frame too. */
  @Input() set active(value: boolean) {
    this.isActive = value;
    this.drawFrame();
  }
  private isActive = true;

  private dpiLabel(value: number): string {
    if (value <= 96) return `${value} dpi · draft`;
    if (value <= 150) return `${value} dpi · recommended`;
    return `${value} dpi · high quality`;
  }

  /** The scale that will be printed. */
  private printScale(): number | null {
    return this.scaleChoice() || this.mapService.currentScaleDenominator();
  }

  /** Map units covered by the printed map area at the print scale. */
  private drawFrame(): void {
    const scale = this.printScale();
    const area = MAP_AREA_PT[`${this.pageSize()} ${this.orientation()}`];
    if (!this.isActive || !this.showFrame() || !scale || !area) {
      this.mapService.setPrintFrame(null);
      return;
    }
    const metres = (pt: number) => (pt / 72) * 0.0254 * scale;
    this.mapService.setPrintFrame({ widthM: metres(area[0]), heightM: metres(area[1]) });
  }

  /** Zooms the map so the whole print area is in view. */
  fitFrame(): void {
    const scale = this.printScale();
    const area = MAP_AREA_PT[`${this.pageSize()} ${this.orientation()}`];
    const view = this.mapService.viewSnapshot();
    if (!scale || !area || !view) return;
    const half = (pt: number) => ((pt / 72) * 0.0254 * scale) / 2;
    const [lon, lat] = view.center;
    // Map units (EPSG:3857) → degrees, for the 4326 extent helper.
    const k = 180 / 20037508.34;
    const cx = (lon * 20037508.34) / 180;
    const cy = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * (20037508.34 / Math.PI);
    const toLat = (y: number) => (Math.atan(Math.exp((y / 20037508.34) * Math.PI)) * 360) / Math.PI - 90;
    const pad = 1.08;
    const w = half(area[0]) * pad;
    const h = half(area[1]) * pad;
    this.mapService.zoomToExtent4326([(cx - w) * k, toLat(cy - h), (cx + w) * k, toLat(cy + h)]);
  }

  /** Falls back to OpenStreetMap when the live map's active basemap isn't
   *  one the print backend can render (currently the Esri basemaps — see
   *  PrintBasemapId) — printing must never hard-fail just because the map
   *  happens to be showing satellite/street imagery. */
  private toPrintBasemapId(basemapId: string): PrintBasemapId {
    return PRINTABLE_BASEMAP_IDS.has(basemapId as PrintBasemapId)
      ? (basemapId as PrintBasemapId)
      : 'osm';
  }

  /** Marks any prior result/error stale once the user changes an option. */
  optionChanged(): void {
    if (this.state() !== 'generating') {
      this.state.set('idle');
      this.errorMsg.set(null);
    }
  }

  setOrientation(value: PrintOrientation): void {
    this.orientation.set(value);
    this.optionChanged();
  }

  setFormat(value: PrintFormat): void {
    this.format.set(value);
    this.optionChanged();
  }

  /** Recomputes the scale readout from the current view. */
  refreshScale(): void {
    const denominator = this.printScale();
    this.scaleLabel.set(
      denominator ? `1 : ${Math.round(denominator).toLocaleString()}` : '—'
    );
  }

  async generate(): Promise<void> {
    const context = this.mapService.getPrintContext();
    if (!context) {
      this.fail('The map is still loading — try again in a moment.');
      return;
    }
    if (context.layers.length === 0) {
      this.fail('Turn on at least one layer before printing.');
      return;
    }

    this.releaseObjectUrl();
    this.state.set('generating');
    this.errorMsg.set(null);
    this.refreshScale();

    // The app's own legend symbols (PNG icons), not GeoServer's legend image.
    const legends = this.includeLegend
      ? await Promise.all(
          context.layers.map(async (l) =>
            buildPrintLegend(l.name, parseLegend(await this.mapService.legendJsonById(l.layerId)))
          )
        )
      : [];

    const request: PrintReportRequest = {
      pageSize: this.pageSize(),
      orientation: this.orientation(),
      format: this.format(),
      dpi: this.dpi(),
      title: this.title.trim() || undefined,
      metadata: this.metadata.trim() || undefined,
      includeLegend: this.includeLegend,
      includeScalebar: this.includeScalebar,
      includeNorthArrow: this.includeNorthArrow,
      includeDate: this.includeDate,
      includeOverview: this.includeOverview,
      includeGrid: this.includeGrid,
      preparedBy: this.preparedBy.trim() || undefined,
      notes: this.notes.trim() || undefined,
      basemapId: this.toPrintBasemapId(context.basemapId),
      map: {
        center: context.center,
        scale: this.scaleChoice() || context.scale,
        // OpenLayers works in radians, MapFish in degrees.
        rotation: (context.rotation * 180) / Math.PI,
        projection: context.projection
      },
      layers: context.layers.map((layer, i) => ({
        layerId: layer.layerId,
        opacity: layer.opacity,
        cqlFilter: layer.cqlFilter ?? undefined,
        legend: legends[i]
      }))
    };

    this.printService.report(request).subscribe({
      next: (response) => this.handleReport(response),
      error: (error: HttpErrorResponse) => this.handleError(error)
    });
  }

  /** Re-triggers the download of the last generated file (e.g. if the
   *  browser suppressed the automatic one). */
  downloadAgain(): void {
    this.triggerDownload();
  }

  private handleReport(response: HttpResponse<Blob>): void {
    const blob = response.body;
    if (!blob || blob.size === 0) {
      this.fail('The print service returned an empty document.');
      return;
    }
    this.resultFilename = this.filenameFrom(response);
    this.objectUrl = URL.createObjectURL(blob);
    this.lastFilename.set(this.resultFilename);
    this.state.set('done');
    this.triggerDownload();
  }

  private triggerDownload(): void {
    if (!this.objectUrl) return;
    const anchor = document.createElement('a');
    anchor.href = this.objectUrl;
    anchor.download = this.resultFilename;
    anchor.click();
  }

  private handleError(error: HttpErrorResponse): void {
    if (error.status === 0) {
      this.fail('Could not reach the print service. Check your connection and try again.');
      return;
    }
    // responseType is 'blob', so a JSON error body arrives as a Blob.
    if (error.error instanceof Blob) {
      error.error
        .text()
        .then((text) => {
          try {
            const message = JSON.parse(text).message;
            this.fail(Array.isArray(message) ? message.join('. ') : message ?? this.genericError(error));
          } catch {
            this.fail(this.genericError(error));
          }
        })
        .catch(() => this.fail(this.genericError(error)));
      return;
    }
    this.fail(error.error?.message ?? this.genericError(error));
  }

  private genericError(error: HttpErrorResponse): string {
    return error.status === 503
      ? 'The print service is busy or unavailable. Please try again shortly.'
      : `The map could not be generated (error ${error.status || 'unknown'}).`;
  }

  private fail(message: string): void {
    this.state.set('error');
    this.errorMsg.set(message);
  }

  private filenameFrom(response: HttpResponse<Blob>): string {
    const header = response.headers.get('content-disposition');
    const match = header && /filename="?([^"]+)"?/.exec(header);
    if (match) return match[1];
    const d = new Date(); // local date, not UTC
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `municipal-gis-map-${date}.${this.format()}`;
  }

  private releaseObjectUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
