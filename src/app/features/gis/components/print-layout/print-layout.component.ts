import { Component, Input, OnDestroy, inject, signal } from '@angular/core';
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
import { PrintService } from '../../../../core/services/print.service';

type PanelState = 'idle' | 'generating' | 'done' | 'error';

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
  readonly dpiOptions = signal<{ label: string; value: number }[]>([
    { label: '96 dpi', value: 96 },
    { label: '150 dpi', value: 150 },
    { label: '300 dpi', value: 300 }
  ]);

  title = '';
  metadata = '';
  includeLegend = true;
  includeScalebar = true;
  includeNorthArrow = true;
  includeDate = true;

  readonly state = signal<PanelState>('idle');
  readonly errorMsg = signal<string | null>(null);
  readonly lastFilename = signal<string | null>(null);

  /** Live "1 : N" scale readout so the user knows what they'll get. */
  readonly scaleLabel = signal<string>('—');

  private objectUrl: string | null = null;
  private resultFilename = 'municipal-gis-map.pdf';

  constructor() {
    this.refreshScale();
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
              .map((value) => ({ label: `${value} dpi`, value }))
          );
        }
      },
      error: () => undefined
    });
  }

  ngOnDestroy(): void {
    this.releaseObjectUrl();
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
    const denominator = this.mapService.currentScaleDenominator();
    this.scaleLabel.set(
      denominator ? `1 : ${Math.round(denominator).toLocaleString()}` : '—'
    );
  }

  generate(): void {
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
      basemapId: context.basemapId as PrintBasemapId,
      map: {
        center: context.center,
        scale: context.scale,
        rotation: context.rotation,
        projection: context.projection
      },
      layers: context.layers.map((layer) => ({
        layerId: layer.layerId,
        opacity: layer.opacity,
        cqlFilter: layer.cqlFilter ?? undefined
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
            this.fail(JSON.parse(text).message ?? this.genericError(error));
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
    const date = new Date().toISOString().slice(0, 10);
    return `municipal-gis-map-${date}.${this.format()}`;
  }

  private releaseObjectUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
