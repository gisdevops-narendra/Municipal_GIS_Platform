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
  group: string;
  /** Needs a second (overlay) layer; `polygonOnly` restricts it. */
  overlay?: 'any' | 'polygon';
  /** Input must be this geometry type. */
  input?: 'POINT' | 'LINE' | 'POLYGON';
  /** A number the tool needs (metres), with its label and default. */
  param?: { label: string; value: number; min?: number };
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

  /** Granted module ids — the newer tool groups each have their own module. */
  @Input() set allowedModuleIds(value: ReadonlySet<number>) {
    this.allowedSignal.set(value ?? new Set());
  }
  private readonly allowedSignal = signal<ReadonlySet<number>>(new Set());
  private static readonly GROUP_MODULE: Partial<Record<GeoprocessOperation, number>> = {
    symdifference: 1031, merge: 1031, nearest: 1032, selectbylocation: 1032, voronoi: 1032,
    centroids: 1033, convexhull: 1033, envelope: 1033, simplify: 1033, explode: 1033,
    polygonstolines: 1033, linestopolygons: 1033, pointsalonglines: 1033, squaregrid: 1034, hexgrid: 1034
  };

  readonly operations: OperationDef[] = [
    { value: 'intersect', group: 'Overlay', label: 'Intersect', hint: 'Only the overlapping parts, with attributes of both layers.', overlay: 'any' },
    { value: 'clip', group: 'Overlay', label: 'Clip', hint: 'The input cut to the area of a polygon layer.', overlay: 'polygon' },
    { value: 'erase', group: 'Overlay', label: 'Erase', hint: 'The input minus the area of a polygon layer.', overlay: 'polygon' },
    { value: 'symdifference', group: 'Overlay', label: 'Symmetrical Difference', hint: 'The parts covered by only one of the two layers.', overlay: 'any' },
    { value: 'merge', group: 'Overlay', label: 'Merge', hint: 'Two layers of the same type combined into one (shared fields kept, plus the source layer).', overlay: 'any' },
    { value: 'buffer', group: 'Proximity', label: 'Buffer', hint: 'A polygon around every feature at a fixed distance.', param: { label: 'Distance (m)', value: 100 } },
    { value: 'nearest', group: 'Proximity', label: 'Nearest Join', hint: 'Each feature gets the nearest feature of another layer and the distance to it (m).', overlay: 'any' },
    { value: 'selectbylocation', group: 'Proximity', label: 'Select by Location', hint: 'Features that intersect — or lie within a distance of — another layer.', overlay: 'any', param: { label: 'Within distance (m, 0 = intersecting)', value: 0, min: 0 } },
    { value: 'voronoi', group: 'Proximity', label: 'Voronoi (Thiessen) Polygons', hint: 'The area closest to each point — e.g. the service area of every facility.', input: 'POINT' },
    { value: 'centroids', group: 'Geometry', label: 'Centroids', hint: 'A point inside every feature (always within the shape).' },
    { value: 'convexhull', group: 'Geometry', label: 'Convex Hull', hint: 'The smallest convex polygon enclosing the whole layer.' },
    { value: 'envelope', group: 'Geometry', label: 'Bounding Boxes', hint: 'A rectangle around every feature.' },
    { value: 'simplify', group: 'Geometry', label: 'Simplify', hint: 'Fewer vertices within a tolerance; shapes stay valid.', param: { label: 'Tolerance (m)', value: 5 } },
    { value: 'explode', group: 'Geometry', label: 'Explode Multipart', hint: 'Multi-part features split into single parts.' },
    { value: 'polygonstolines', group: 'Geometry', label: 'Polygons → Lines', hint: 'The outline of every polygon as a line.', input: 'POLYGON' },
    { value: 'linestopolygons', group: 'Geometry', label: 'Lines → Polygons', hint: 'Closed lines turned into polygons.', input: 'LINE' },
    { value: 'pointsalonglines', group: 'Geometry', label: 'Points Along Lines', hint: 'A point at a fixed spacing along every line (e.g. chainage, pole positions).', input: 'LINE', param: { label: 'Spacing (m)', value: 50 } },
    { value: 'dissolve', group: 'Summarise', label: 'Dissolve', hint: 'Merge features — all of them, or those sharing a field value.' },
    { value: 'join', group: 'Summarise', label: 'Spatial Join', hint: 'Attach attributes (or a count) of intersecting features of another layer.', overlay: 'any' },
    { value: 'squaregrid', group: 'Summarise', label: 'Square Grid', hint: 'A grid of square cells over the layer, with the number of features in each.', param: { label: 'Cell size (m)', value: 250 } },
    { value: 'hexgrid', group: 'Summarise', label: 'Hexagon Grid', hint: 'A grid of hexagons over the layer, with the number of features in each.', param: { label: 'Cell size (m)', value: 250 } }
  ];

  /** The picker, grouped. */
  readonly operationGroups = computed(() => {
    const allowed = this.allowedSignal();
    const ok = (o: OperationDef) => {
      const id = GeoprocessingComponent.GROUP_MODULE[o.value];
      return id === undefined || allowed.has(id);
    };
    return ['Overlay', 'Proximity', 'Geometry', 'Summarise']
      .map((label) => ({ label, items: this.operations.filter((o) => o.group === label && ok(o)) }))
      .filter((g) => g.items.length);
  });

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
  readonly inputOptions = computed(() =>
    this.vectorLayers()
      .filter((l) => !this.def().input || l.geometryType === this.def().input)
      .map((l) => ({ label: l.name, value: l.id }))
  );
  readonly overlayOptions = computed(() =>
    this.vectorLayers()
      .filter((l) => this.def().overlay !== 'polygon' || l.geometryType === 'POLYGON')
      .map((l) => ({ label: l.name, value: l.id }))
  );

  setOperation(op: GeoprocessOperation): void {
    this.operation.set(op);
    this.error.set(null);
    const def = this.def();
    if (def.param) this.distance = def.param.value;
    if (def.input && this.inputLayerId() && !this.inputOptions().some((o) => o.value === this.inputLayerId())) this.setInput(null);
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
    if (def.param && !(this.distance >= (def.param.min ?? 0.0001))) return this.error.set(`Enter a value for "${def.param.label}".`);
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
        ...(def.param ? { distance: this.distance } : {}),
        ...(def.value === 'buffer' ? { dissolve: this.dissolve() } : {}),
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
