import { Component, Input, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { DensityPoints } from '../../../../core/models/layer-analytics.model';
import { GisLayersService } from '../../../../core/services/gis-layers.service';
import { DensityOptions, MapService } from '../../services/map.service';

/**
 * Heatmap & Clusters tool (Module Access: Heatmap & Clusters) — shows any
 * vector layer as a density heatmap or as count clusters. Lines and polygons
 * contribute one point on their surface; an optional numeric field weights
 * the heatmap. Fields are discovered at runtime, never assumed.
 */
@Component({
  selector: 'app-density-map',
  standalone: true,
  imports: [FormsModule, ButtonModule, SelectModule],
  templateUrl: './density-map.component.html',
  styleUrl: './density-map.component.scss'
})
export class DensityMapComponent implements OnDestroy {
  private readonly gisLayersService = inject(GisLayersService);
  private readonly mapService = inject(MapService);

  @Input() set layers(value: GisLayer[]) {
    this.layersSignal.set(value ?? []);
  }
  private readonly layersSignal = signal<GisLayer[]>([]);

  readonly layerOptions = computed(() =>
    this.layersSignal()
      .filter((layer) => layer.layerType === 'VECTOR')
      .map((layer) => ({ label: layer.name, value: layer.id }))
  );

  readonly layerId = signal<string | null>(null);
  readonly selectedLayer = computed(() => {
    const layers = this.layersSignal();
    return layers.find((l) => l.id === this.layerId()) ?? layers.find((l) => l.layerType === 'VECTOR') ?? null;
  });

  readonly weightOptions = signal<{ label: string; value: string | null }[]>([]);
  readonly weightField = signal<string | null>(null);
  private fieldsFor: string | null = null;

  readonly mode = signal<DensityOptions['mode']>('heatmap');
  readonly radius = signal(15);
  readonly blur = signal(20);
  readonly distance = signal(40);
  readonly opacity = signal(0.85);

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  /** What is on the map now, for the summary line. */
  readonly shown = signal<{ layer: string; weight: string | null; result: DensityPoints } | null>(null);

  private readonly options = computed(
    (): DensityOptions => ({
      mode: this.mode(),
      radius: this.radius(),
      blur: this.blur(),
      distance: this.distance(),
      opacity: this.opacity()
    })
  );

  constructor() {
    effect(() => {
      const layer = this.selectedLayer();
      untracked(() => this.loadFields(layer));
    });
  }

  selectLayer(id: string): void {
    this.layerId.set(id);
    this.error.set(null);
  }

  /** Numeric fields of the chosen layer, offered as heatmap weights. */
  private loadFields(layer: GisLayer | null): void {
    if (!layer || this.fieldsFor === layer.id) return;
    this.fieldsFor = layer.id;
    this.weightField.set(null);
    this.weightOptions.set([{ label: 'None (count features)', value: null }]);
    this.gisLayersService.analyticsFields(layer.id).subscribe({
      next: (fields) =>
        this.weightOptions.set([
          { label: 'None (count features)', value: null },
          ...fields.filter((f) => f.kind === 'number').map((f) => ({ label: f.name, value: f.name }))
        ]),
      error: () => undefined
    });
  }

  setMode(mode: DensityOptions['mode']): void {
    this.mode.set(mode);
    this.mapService.updateDensity(this.options());
  }

  /** Slider changes restyle the overlay in place, no refetch. */
  restyle(): void {
    this.mapService.updateDensity(this.options());
  }

  show(): void {
    const layer = this.selectedLayer();
    if (!layer || this.busy()) return;
    const weight = this.weightField();
    this.busy.set(true);
    this.error.set(null);
    this.gisLayersService.densityPoints(layer.id, weight ?? undefined).subscribe({
      next: (result) => {
        this.busy.set(false);
        if (result.points.length === 0) {
          this.mapService.clearDensity();
          this.shown.set(null);
          this.error.set(weight ? `No features with a positive "${weight}" value.` : 'This layer has no features.');
          return;
        }
        this.mapService.showDensity(result.points, result.maxWeight, this.options());
        this.mapService.zoomToDensity();
        this.shown.set({ layer: layer.name, weight, result });
      },
      error: (err: HttpErrorResponse) => {
        this.busy.set(false);
        this.error.set(
          err.status === 403
            ? (err.error?.message ?? 'You do not have permission to view this layer.')
            : (err.error?.message ?? 'Could not load the layer. Please try again.')
        );
      }
    });
  }

  clear(): void {
    this.mapService.clearDensity();
    this.shown.set(null);
    this.error.set(null);
  }

  zoomTo(): void {
    this.mapService.zoomToDensity();
  }

  ngOnDestroy(): void {
    this.mapService.clearDensity();
  }
}
