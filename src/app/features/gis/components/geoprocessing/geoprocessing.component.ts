import { Component, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { MessageModule } from 'primeng/message';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { GisLayersService } from '../../../../core/services/gis-layers.service';
import { GeoprocessOperation, VectorToolsService } from '../../services/vector-tools.service';

interface OperationDef {
  value: GeoprocessOperation;
  label: string;
  hint: string;
  /** Needs a second (overlay) layer; `polygonOnly` restricts it. */
  overlay?: 'any' | 'polygon';
}

/**
 * Geoprocessing — whole-layer Buffer, Dissolve, Intersect, Clip, Erase and
 * Spatial Join, run in PostGIS and published as a NEW layer (unlike Buffer
 * & Overlay, whose results are temporary map graphics).
 */
@Component({
  selector: 'app-geoprocessing',
  standalone: true,
  imports: [FormsModule, ButtonModule, SelectModule, MessageModule],
  templateUrl: './geoprocessing.component.html',
  styleUrl: '../buffer-overlay/buffer-overlay.component.scss'
})
export class GeoprocessingComponent {
  private readonly vectorTools = inject(VectorToolsService);
  private readonly gisLayers = inject(GisLayersService);

  @Input() set layers(value: GisLayer[]) {
    this.layersSignal.set(value ?? []);
  }
  private readonly layersSignal = signal<GisLayer[]>([]);

  @Output() readonly layerCreated = new EventEmitter<GisLayer>();

  readonly operations: OperationDef[] = [
    { value: 'buffer', label: 'Buffer', hint: 'A polygon around every feature at a fixed distance.' },
    { value: 'dissolve', label: 'Dissolve', hint: 'Merge features — all of them, or those sharing a field value.' },
    { value: 'intersect', label: 'Intersect', hint: 'Only the overlapping parts, with attributes of both layers.', overlay: 'any' },
    { value: 'clip', label: 'Clip', hint: 'The input cut to the area of a polygon layer.', overlay: 'polygon' },
    { value: 'erase', label: 'Erase', hint: 'The input minus the area of a polygon layer.', overlay: 'polygon' },
    { value: 'join', label: 'Spatial join', hint: 'Attach attributes (or a count) of intersecting features of another layer.', overlay: 'any' }
  ];

  readonly operation = signal<GeoprocessOperation>('buffer');
  readonly inputLayerId = signal<string | null>(null);
  readonly overlayLayerId = signal<string | null>(null);
  distance = 100;
  readonly dissolve = signal(false);
  readonly dissolveField = signal<string | null>(null);
  readonly joinMode = signal<'attributes' | 'count'>('attributes');
  outputName = '';
  /** Once the user types a name, stop replacing it with suggestions. */
  private nameEdited = false;

  readonly fieldOptions = signal<{ label: string; value: string }[]>([]);
  readonly running = signal(false);
  readonly error = signal<string | null>(null);
  readonly created = signal<GisLayer | null>(null);

  readonly def = computed(() => this.operations.find((o) => o.value === this.operation())!);

  private readonly vectorLayers = computed(() =>
    this.layersSignal().filter((l) => l.layerType === 'VECTOR' && l.geometryType)
  );
  readonly inputOptions = computed(() => this.vectorLayers().map((l) => ({ label: l.name, value: l.id })));
  readonly overlayOptions = computed(() =>
    this.vectorLayers()
      .filter((l) => this.def().overlay !== 'polygon' || l.geometryType === 'POLYGON')
      .map((l) => ({ label: l.name, value: l.id }))
  );

  setOperation(op: GeoprocessOperation): void {
    this.operation.set(op);
    this.error.set(null);
    this.created.set(null);
    if (!this.overlayOptions().some((o) => o.value === this.overlayLayerId())) this.overlayLayerId.set(null);
    this.suggestName();
  }

  setInput(layerId: string | null): void {
    this.inputLayerId.set(layerId);
    this.dissolveField.set(null);
    this.fieldOptions.set([]);
    this.suggestName();
    if (!layerId) return;
    this.gisLayers.analyticsFields(layerId).subscribe({
      next: (fields) => {
        if (this.inputLayerId() !== layerId) return; // input changed meanwhile
        this.fieldOptions.set(
          fields.filter((f) => f.kind !== 'geometry').map((f) => ({ label: f.name, value: f.name }))
        );
      },
      error: () => this.inputLayerId() === layerId && this.fieldOptions.set([])
    });
  }

  setOverlay(layerId: string | null): void {
    this.overlayLayerId.set(layerId);
    this.suggestName();
  }

  onNameInput(value: string): void {
    this.outputName = value;
    this.nameEdited = value.trim().length > 0;
  }

  private suggestName(): void {
    if (this.nameEdited) return;
    const input = this.vectorLayers().find((l) => l.id === this.inputLayerId());
    if (!input) return;
    const overlay = this.vectorLayers().find((l) => l.id === this.overlayLayerId());
    this.outputName = `${input.name} ${this.def().label.toLowerCase()}${overlay && this.def().overlay ? ` ${overlay.name}` : ''}`;
  }

  run(): void {
    const inputLayerId = this.inputLayerId();
    const def = this.def();
    if (!inputLayerId) return this.error.set('Choose the input layer.');
    if (def.overlay && !this.overlayLayerId()) return this.error.set('Choose the overlay layer.');
    if (def.overlay && this.overlayLayerId() === inputLayerId) {
      return this.error.set('Choose a different overlay layer — it is the same as the input.');
    }
    if (def.value === 'buffer' && !(this.distance > 0)) return this.error.set('Enter a buffer distance above 0.');
    if (!this.outputName.trim()) return this.error.set('Enter a name for the new layer.');

    this.running.set(true);
    this.error.set(null);
    this.created.set(null);
    this.vectorTools
      .geoprocess({
        operation: def.value,
        inputLayerId,
        overlayLayerId: def.overlay ? this.overlayLayerId()! : undefined,
        outputName: this.outputName.trim(),
        ...(def.value === 'buffer' ? { distance: this.distance, dissolve: this.dissolve() } : {}),
        ...(def.value === 'dissolve' && this.dissolveField() ? { dissolveField: this.dissolveField()! } : {}),
        ...(def.value === 'join' ? { joinMode: this.joinMode() } : {})
      })
      .subscribe({
        next: (layer) => {
          this.running.set(false);
          this.created.set(layer);
          this.layerCreated.emit(layer);
        },
        error: (err: HttpErrorResponse) => {
          this.running.set(false);
          const message = err.error?.message;
          this.error.set(Array.isArray(message) ? message.join(' ') : (message ?? 'Geoprocessing failed.'));
        }
      });
  }
}
