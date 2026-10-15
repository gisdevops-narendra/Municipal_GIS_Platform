import { Component, Input, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';
import { MapService } from '../../services/map.service';
import { SketchService } from '../../services/sketch.service';
import {
  DRAW_MODULE_ID,
  MARKING_TOOL_MODULE_ID,
  SKETCH_COLORS,
  Sketch,
  SketchKind
} from '../../models/sketch.model';
import { downloadBlob } from '../../../../core/utils/download-blob';

interface KindOption {
  kind: SketchKind;
  label: string;
  icon: string;
  hint: string;
}

const SHAPE_KINDS: KindOption[] = [
  { kind: 'Point', label: 'Point', icon: 'pi pi-circle-fill', hint: 'Click the map to place a point.' },
  { kind: 'Line', label: 'Line', icon: 'pi pi-minus', hint: 'Click to add vertices; double-click to finish.' },
  { kind: 'Polygon', label: 'Polygon', icon: 'pi pi-stop', hint: 'Click to add vertices; double-click to close.' },
  { kind: 'Rectangle', label: 'Rectangle', icon: 'pi pi-th-large', hint: 'Click one corner, then the opposite corner.' },
  { kind: 'Circle', label: 'Circle', icon: 'pi pi-circle', hint: 'Click the centre, then click to set the radius.' },
  { kind: 'Freehand', label: 'Freehand', icon: 'pi pi-pencil', hint: 'Press and drag to draw; release to finish.' }
];
const MARKER_KIND: KindOption = {
  kind: 'Marker',
  label: 'Marker',
  icon: 'pi pi-map-marker',
  hint: 'Click the map to drop the labelled marker.'
};

/**
 * Draw & Mark tool — sketch shapes (Draw module) and drop labelled pins
 * (Marking Tool module) on the map. Sketches persist per workspace in the
 * browser (SketchService) and render on their own map overlay; each kind is
 * offered only when its module is granted.
 */
@Component({
  selector: 'app-sketch',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, TooltipModule],
  templateUrl: './sketch.component.html',
  styleUrl: './sketch.component.scss'
})
export class SketchComponent implements OnDestroy {
  private readonly mapService = inject(MapService);
  private readonly sketchService = inject(SketchService);

  @Input() set workspaceKey(value: string) {
    this.wsKey = value ?? '';
    this.reload();
  }
  private wsKey = '';

  @Input() set allowedModuleIds(value: ReadonlySet<number>) {
    this.allowed.set(value ?? new Set());
  }
  private readonly allowed = signal<ReadonlySet<number>>(new Set());

  /** The panel stays mounted while hidden — pause an in-progress draw then,
   *  but keep the saved sketches on the map. */
  @Input() set active(value: boolean) {
    if (!value) this.cancelDrawing();
  }

  readonly colors = SKETCH_COLORS;
  readonly color = signal(SKETCH_COLORS[0]);
  label = '';
  readonly drawing = signal<KindOption | null>(null);
  readonly error = signal<string | null>(null);
  readonly sketches = signal<Sketch[]>([]);

  readonly kinds = computed(() => {
    const allowed = this.allowed();
    return [
      ...(allowed.has(MARKING_TOOL_MODULE_ID) ? [MARKER_KIND] : []),
      ...(allowed.has(DRAW_MODULE_ID) ? SHAPE_KINDS : [])
    ];
  });

  private drawSub?: Subscription;

  ngOnDestroy(): void {
    this.cancelDrawing();
  }

  start(option: KindOption): void {
    this.error.set(null);
    if (option.kind === 'Marker' && !this.label.trim()) {
      this.error.set('Enter a label for the marker first.');
      return;
    }
    this.cancelDrawing();
    this.drawing.set(option);
    const drawKind = option.kind === 'Marker' ? 'Point' : option.kind;
    this.drawSub = this.mapService.beginDraw(drawKind).subscribe({
      next: (geometry) => {
        this.sketchService.add(this.wsKey, {
          kind: option.kind,
          label: this.label,
          color: this.color(),
          geometry
        });
        this.mapService.clearDraw();
        this.drawing.set(null);
        this.reload();
      },
      complete: () => this.drawing.set(null)
    });
  }

  cancelDrawing(): void {
    this.drawSub?.unsubscribe();
    this.drawSub = undefined;
    if (this.drawing()) {
      this.mapService.clearDraw();
      this.drawing.set(null);
    }
  }

  zoomTo(sketch: Sketch): void {
    this.mapService.zoomToGeometries([sketch.geometry]);
  }

  remove(sketch: Sketch): void {
    this.sketchService.remove(this.wsKey, sketch.id);
    this.reload();
  }

  clearAll(): void {
    this.sketchService.clear(this.wsKey);
    this.reload();
  }

  exportGeoJson(): void {
    const collection = this.sketchService.toFeatureCollection(this.sketches());
    downloadBlob(
      new Blob([JSON.stringify(collection, null, 2)], { type: 'application/geo+json' }),
      `sketches-${this.wsKey || 'map'}.geojson`
    );
  }

  iconFor(kind: SketchKind): string {
    return (kind === 'Marker' ? MARKER_KIND : SHAPE_KINDS.find((k) => k.kind === kind))?.icon ?? 'pi pi-pencil';
  }

  private reload(): void {
    const list = this.sketchService.list(this.wsKey);
    this.sketches.set(list);
    this.mapService.setSketches(list);
  }
}
