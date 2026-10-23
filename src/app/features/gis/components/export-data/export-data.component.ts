import { AttributeTableService } from '../../services/attribute-table.service';
import { Component, Input, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { LAYER_EXPORT_FORMATS, LayerExportFormat, LayerExportFormatOption } from '../../../../core/models/layer-export.model';
import { GisLayersService } from '../../../../core/services/gis-layers.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { blobErrorMessage, downloadBlob } from '../../../../core/utils/download-blob';
import { CrsPickerComponent } from '../crs-picker/crs-picker.component';

/**
 * Export Data tool (Module Access: Export Data, with one child module per
 * format) — downloads a whole layer as GeoJSON / CSV / zipped Shapefile /
 * KML. The file is produced server-side behind the layer's EXPORT
 * permission (GET /api/gis/layers/:id/export); a refusal is shown inline.
 */
@Component({
  selector: 'app-export-data',
  standalone: true,
  imports: [FormsModule, ButtonModule, SelectModule, CrsPickerComponent],
  templateUrl: './export-data.component.html',
  styleUrl: './export-data.component.scss'
})
export class ExportDataComponent {
  private readonly gisLayersService = inject(GisLayersService);
  private readonly notify = inject(NotificationService);
  private readonly attributes = inject(AttributeTableService);

  // Signal-backed inputs so the computed option lists follow later changes.
  @Input() set layers(value: GisLayer[]) {
    this.layersSignal.set(value ?? []);
  }
  private readonly layersSignal = signal<GisLayer[]>([]);

  /** Module Access ids granted to the current user; gates each format. */
  @Input() set allowedModuleIds(value: ReadonlySet<number>) {
    this.allowedSignal.set(value ?? new Set());
  }
  private readonly allowedSignal = signal<ReadonlySet<number>>(new Set());

  readonly layerId = signal<string | null>(null);
  readonly format = signal<LayerExportFormat>('geojson');
  /** Output CRS; '' keeps the layer's own. */
  crs = '';
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  readonly layerOptions = computed(() =>
    this.layersSignal()
      .filter((layer) => layer.layerType === 'VECTOR')
      .map((layer) => ({ label: layer.name, value: layer.id }))
  );

  readonly formatOptions = computed(() => {
    const allowed = this.allowedSignal();
    return LAYER_EXPORT_FORMATS.filter((f) => f.moduleId === undefined || allowed.has(f.moduleId));
  });

  /** The chosen layer, falling back to the first one so the panel is
   *  usable immediately. */
  readonly selectedLayer = computed(() => {
    const layers = this.layersSignal();
    return layers.find((l) => l.id === this.layerId()) ?? layers.find((l) => l.layerType === 'VECTOR') ?? null;
  });

  readonly selectedFormat = computed((): LayerExportFormatOption | null => {
    const options = this.formatOptions();
    return options.find((f) => f.value === this.format()) ?? options.at(0) ?? null;
  });

  /** Export with filter: only features matching one condition. */
  filterOn = false;
  filterField: string | null = null;
  filterOp = '=';
  filterValue = '';
  readonly filterOps = [
    { label: 'equals', value: '=' }, { label: 'is not', value: '!=' }, { label: 'greater than', value: '>' },
    { label: 'less than', value: '<' }, { label: 'contains', value: 'contains' }, { label: 'is empty', value: 'empty' },
    { label: 'is not empty', value: 'notempty' }
  ];
  readonly filterFields = signal<{ label: string; value: string }[]>([]);
  readonly canFilter = computed(() => this.allowedSignal().has(1035));
  private fieldsFor: string | null = null;

  toggleFilter(on: boolean): void {
    this.filterOn = on;
    const layer = this.selectedLayer();
    if (on && layer && this.fieldsFor !== layer.id) {
      this.fieldsFor = layer.id;
      this.filterField = null;
      this.attributes.loadMetadata(layer).subscribe({
        next: ({ fields }) => this.filterFields.set(fields.map((f) => ({ label: f.label, value: f.name }))),
        error: () => this.filterFields.set([])
      });
    }
  }

  download(): void {
    const layer = this.selectedLayer();
    const format = this.selectedFormat();
    if (!layer || !format || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    const filter = this.filterOn && this.filterField ? { field: this.filterField, op: this.filterOp, value: this.filterValue } : undefined;
    const crs = format.value === 'kml' ? undefined : this.crs || undefined;
    this.gisLayersService.export(layer.id, format.value, filter, crs).subscribe({
      next: (blob) => {
        this.busy.set(false);
        downloadBlob(blob, `${layer.code.toLowerCase()}.${format.extension}`);
        this.notify.success(`Exported "${layer.name}" as ${format.label}.`);
      },
      error: async (err: HttpErrorResponse) => {
        this.busy.set(false);
        this.error.set(
          err.status === 403
            ? 'You do not have permission to export this layer.'
            : await blobErrorMessage(err, 'Export failed. Please try again.')
        );
      }
    });
  }
}
