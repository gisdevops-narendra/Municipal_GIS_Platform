import { Component, EventEmitter, Input, OnDestroy, Output, ViewChild, computed, inject, signal } from '@angular/core';
import { NotificationService } from '../../../../core/services/notification.service';
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
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { LayerDigitizeComponent } from '../layer-digitize/layer-digitize.component';
import { EDIT_PANEL_MODULE_ID } from '../../services/vector-tools.service';

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
 * Draw & Mark tool — the app's single feature-editing tool. "Feature layers"
 * is the GIS digitizing workflow: create a layer with its fields (Draw
 * module), or pick any existing one, then draw and edit real, server-stored
 * features (LayerDigitizeComponent, Edit Panel module). "Sketches" are quick
 * temporary markups: shapes (Draw module) and labelled pins (Marking Tool
 * module), kept for this session only (SketchService) on their own overlay.
 */
@Component({
  selector: 'app-sketch',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, TooltipModule, LayerDigitizeComponent],
  templateUrl: './sketch.component.html',
  styleUrl: './sketch.component.scss'
})
export class SketchComponent implements OnDestroy {
  private readonly mapService = inject(MapService);
  private readonly sketchService = inject(SketchService);
  private readonly notify = inject(NotificationService);

  @Input() set workspaceKey(value: string) {
    this.wsKey = value ?? '';
    this.reload();
  }
  private wsKey = '';

  @Input() set allowedModuleIds(value: ReadonlySet<number>) {
    this.allowed.set(value ?? new Set());
  }
  private readonly allowed = signal<ReadonlySet<number>>(new Set());
  readonly allowedModuleIdsValue = this.allowed.asReadonly();

  /** The panel stays mounted while hidden — pause an in-progress draw then,
   *  but keep the session's sketches on the map. */
  @Input() set active(value: boolean) {
    this.isActive.set(value);
    if (!value) this.cancelDrawing();
  }
  readonly isActive = signal(false);

  // ----- Feature layers (passed through to LayerDigitizeComponent) -----
  @Input() layers: GisLayer[] = [];
  @Input() defaultCrs = '';
  @Input() canManage = false;
  @Output() layerCreated = new EventEmitter<GisLayer>();
  @Output() renameLayer = new EventEmitter<{ layer: GisLayer; name: string }>();
  @Output() deleteLayer = new EventEmitter<GisLayer>();
  @Output() openTable = new EventEmitter<string>();
  @Output() editingLayerChange = new EventEmitter<string | null>();
  @Output() featuresSaved = new EventEmitter<void>();
  @Input() tableEdits: { layerId: string; changes: Record<number, Record<string, string>> } | null = null;

  /** Feature layers: creating needs the Draw module, editing the Edit
   *  Panel module; Sketches need Draw or Marking. */
  readonly canDigitize = computed(() => this.allowed().has(DRAW_MODULE_ID) || this.allowed().has(EDIT_PANEL_MODULE_ID));
  @ViewChild(LayerDigitizeComponent) digitize?: LayerDigitizeComponent;

  /** One tab row: Create / Modify (feature layers) and Sketches. */
  readonly tabChoice = signal<'create' | 'modify' | 'sketch' | null>(null);
  readonly tab = computed(() => this.tabChoice() ?? (this.canDigitize() ? 'create' : 'sketch'));

  setTab(tab: 'create' | 'modify' | 'sketch'): void {
    if (tab !== 'sketch') this.cancelDrawing();
    this.tabChoice.set(tab);
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
    const count = this.sketches().length;
    this.notify.confirmDelete({
      header: 'Clear all sketches',
      message: `Delete all ${count} sketch${count === 1 ? '' : 'es'} on this map? This cannot be undone.`,
      accept: () => {
        this.sketchService.clear(this.wsKey);
        this.reload();
      }
    });
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
