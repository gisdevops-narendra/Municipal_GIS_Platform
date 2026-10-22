import { Component, EventEmitter, Input, Output, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';
import { Menu, MenuModule } from 'primeng/menu';
import type { MenuItem } from 'primeng/api';
import { GisGeometryType, GisLayer } from '../../../../core/models/gis-layer.model';
import { NotificationService } from '../../../../core/services/notification.service';
import { MapService } from '../../services/map.service';
import { DRAW_MODULE_ID } from '../../models/sketch.model';
import { BlankFieldType, EDIT_PANEL_MODULE_ID, VectorToolsService } from '../../services/vector-tools.service';
import { FeatureEditComponent } from '../feature-edit/feature-edit.component';

interface FieldDraft {
  key: number;
  name: string;
  type: BlankFieldType;
}

const GEOMETRY_OPTIONS: { value: GisGeometryType; label: string; icon: string }[] = [
  { value: 'POINT', label: 'Point', icon: 'pi pi-circle-fill' },
  { value: 'LINE', label: 'Line', icon: 'pi pi-minus' },
  { value: 'POLYGON', label: 'Polygon', icon: 'pi pi-stop' }
];

const FIELD_TYPES: { value: BlankFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'integer', label: 'Integer' },
  { value: 'decimal', label: 'Decimal' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Yes / No' }
];

/** Common CRSs for Indian municipalities; any other EPSG code can be typed. */
const CRS_PRESETS = [
  { value: 'EPSG:4326', label: 'EPSG:4326 · WGS 84 (lat/lon)' },
  { value: 'EPSG:3857', label: 'EPSG:3857 · Web Mercator' },
  { value: 'EPSG:32642', label: 'EPSG:32642 · UTM zone 42N' },
  { value: 'EPSG:32643', label: 'EPSG:32643 · UTM zone 43N' },
  { value: 'EPSG:32644', label: 'EPSG:32644 · UTM zone 44N' },
  { value: 'EPSG:32645', label: 'EPSG:32645 · UTM zone 45N' },
  { value: 'EPSG:32646', label: 'EPSG:32646 · UTM zone 46N' }
];
const OTHER_CRS = 'other';
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const RESERVED_FIELDS = new Set(['geom', 'ogc_fid', 'fid', 'gis_workspace_id']);

/**
 * Draw & Mark → Feature layers: a QGIS / ArcGIS-style digitizing workflow
 * and the app's only feature-editing tool. Create a Point / Line / Polygon
 * layer (name, CRS, attribute fields) as a real PostGIS layer, or pick any
 * existing one, then digitize and edit its features through the Edit
 * panel locked to that layer (attribute form, reshape / move, snapping,
 * validation, delete). The layer itself can be shown / hidden, renamed,
 * deleted, or opened in the Attribute Table — renames / deletes go through
 * the workspace's own confirmed actions.
 */
@Component({
  selector: 'app-layer-digitize',
  standalone: true,
  imports: [FormsModule, ButtonModule, SelectModule, InputTextModule, TooltipModule, MenuModule, FeatureEditComponent],
  templateUrl: './layer-digitize.component.html',
  styleUrls: ['../buffer-overlay/buffer-overlay.component.scss', './layer-digitize.component.scss']
})
export class LayerDigitizeComponent {
  private readonly vectorTools = inject(VectorToolsService);
  private readonly mapService = inject(MapService);
  private readonly notify = inject(NotificationService);

  @Input() set layers(value: GisLayer[]) {
    this.layersSignal.set(value ?? []);
    // The layer being edited was deleted elsewhere.
    const id = this.layerId();
    if (id && !this.layersSignal().some((l) => l.id === id) && !this.pendingId) this.setLayer(null);
    if (this.pendingId && this.layersSignal().some((l) => l.id === this.pendingId)) this.pendingId = null;
  }
  readonly layersSignal = signal<GisLayer[]>([]);

  @Input() set allowedModuleIds(value: ReadonlySet<number>) {
    this.allowed.set(value ?? new Set());
  }
  readonly allowed = signal<ReadonlySet<number>>(new Set());

  /** The workspace's storage CRS — the default for new layers. */
  @Input() defaultCrs = '';
  /** Rename / delete are offered to those who may manage layers. */
  @Input() canManage = false;
  @Input() active = false;

  @Output() layerCreated = new EventEmitter<GisLayer>();
  @Output() renameLayer = new EventEmitter<{ layer: GisLayer; name: string }>();
  @Output() deleteLayer = new EventEmitter<GisLayer>();
  @Output() openTable = new EventEmitter<string>();
  /** The layer in this edit session (null when none / no edit access) —
   *  its Attribute Table becomes editable. */
  @Output() editingLayerChange = new EventEmitter<string | null>();
  /** Features of the editing layer were written here. */
  @Output() featuresSaved = new EventEmitter<void>();
  /** Attribute edits saved in the Attribute Table, for the open feature. */
  @Input() tableEdits: { layerId: string; changes: Record<number, Record<string, string>> } | null = null;

  readonly geometryOptions = GEOMETRY_OPTIONS;
  readonly fieldTypes = FIELD_TYPES;
  readonly otherCrs = OTHER_CRS;

  readonly canEdit = computed(() => this.allowed().has(EDIT_PANEL_MODULE_ID));
  readonly layerId = signal<string | null>(null);
  /** A just-created layer not yet in the reloaded layer list. */
  private pendingId: string | null = null;
  private pendingLayer: GisLayer | null = null;

  readonly canCreate = computed(() => this.allowed().has(DRAW_MODULE_ID));

  /** Every editable vector layer: the ones drawn here first, then existing
   *  (uploaded / derived) layers. */
  readonly layerGroups = computed(() => {
    const option = (l: GisLayer) => ({ label: l.name, value: l.id, geometry: l.geometryType! });
    const editable = this.layersSignal().filter((l) => l.layerType === 'VECTOR' && l.geometryType);
    const drawn = editable.filter((l) => l.drawnLayer).map(option);
    const existing = editable.filter((l) => !l.drawnLayer).map(option);
    return [
      ...(drawn.length ? [{ label: 'Drawn layers', items: drawn }] : []),
      ...(existing.length ? [{ label: 'Existing layers', items: existing }] : [])
    ];
  });
  readonly layerCount = computed(() => this.layerGroups().reduce((n, g) => n + g.items.length, 0));

  readonly layer = computed(
    () =>
      this.layersSignal().find((l) => l.id === this.layerId()) ??
      (this.pendingLayer?.id === this.layerId() ? this.pendingLayer : null)
  );

  readonly visible = computed(() => {
    const id = this.layerId();
    return id ? this.mapService.layerVisibility()[id] !== false : false;
  });

  // ----- new layer form -----
  readonly creating = signal(false);
  readonly saving = signal(false);
  readonly formError = signal<string | null>(null);
  newName = '';
  newGeometry: GisGeometryType = 'POINT';
  newCrs = '';
  customCrs = '';
  readonly fields = signal<FieldDraft[]>([]);
  private nextKey = 1;

  readonly crsOptions = computed(() => {
    const presets = CRS_PRESETS.filter((p) => p.value !== this.defaultCrs);
    return [
      ...(this.defaultCrs ? [{ value: this.defaultCrs, label: `${this.defaultCrs} · workspace default` }] : []),
      ...presets,
      { value: OTHER_CRS, label: 'Other EPSG code…' }
    ];
  });

  // ----- rename -----
  readonly renaming = signal(false);
  renameText = '';

  @ViewChild('fe') fe?: FeatureEditComponent;

  /** ArcGIS Pro-style split: Create (feature templates) / Modify — the
   *  tabs live in the Draw & Mark header. */
  readonly view = signal<'create' | 'modify'>('create');
  @Input('view') set viewInput(value: 'create' | 'modify') {
    this.view.set(value);
  }
  @Output() viewChange = new EventEmitter<'create' | 'modify'>();
  readonly search = signal('');
  private readonly closedGroups = signal<ReadonlySet<string>>(new Set());

  /** The template being drawn into, for the Create banner. */
  readonly drawingTemplate = computed(() => {
    const id = this.layerId();
    if (!id || this.fe?.busy() !== 'draw') return null;
    for (const g of this.templateGroups()) {
      const t = g.items.find((i) => i.id === id);
      if (t) return t;
    }
    const l = this.layer();
    return l ? { id: l.id, name: l.name, geometry: l.geometryType! } : null;
  });

  isGroupOpen(label: string): boolean {
    return !this.closedGroups().has(label) || !!this.search().trim();
  }

  toggleGroup(label: string): void {
    const next = new Set(this.closedGroups());
    if (next.has(label)) next.delete(label);
    else next.add(label);
    this.closedGroups.set(next);
  }

  /** One template per editable layer, grouped, filtered by the search. */
  readonly templateGroups = computed(() => {
    const term = this.search().trim().toLowerCase();
    return this.layerGroups()
      .map((g) => ({
        label: g.label,
        items: g.items
          .filter((o) => !term || o.label.toLowerCase().includes(term))
          .map((o) => ({ id: o.value, name: o.label, geometry: o.geometry }))
      }))
      .filter((g) => g.items.length);
  });

  /** Layer options menu (⋯): visibility, zoom, table, then manage. */
  readonly layerMenuItems = computed((): MenuItem[] => {
    const l = this.layer();
    if (!l) return [];
    return [
      { label: this.visible() ? 'Hide on map' : 'Show on map', icon: this.visible() ? 'pi pi-eye-slash' : 'pi pi-eye', command: () => this.toggleVisible() },
      { label: 'Zoom to layer', icon: 'pi pi-search-plus', disabled: !l.bbox, command: () => this.zoomTo() },
      { label: 'Open attribute table', icon: 'pi pi-table', command: () => this.openTable.emit(l.id) },
      ...(this.canManage
        ? [
            { separator: true },
            { label: 'Rename layer', icon: 'pi pi-pencil', command: () => this.startRename() },
            { label: 'Delete layer', icon: 'pi pi-trash', styleClass: 'dg__menu-danger', command: () => this.remove() }
          ]
        : [])
    ];
  });

  setView(view: 'create' | 'modify'): void {
    if (view === 'create' && this.fe?.busy() === 'pick') this.fe.cancel();
    if (this.view() === view) return;
    this.view.set(view);
    this.viewChange.emit(view);
  }

  /** Create: pick a template → that layer becomes the editing layer and
   *  drawing starts; the drawn feature opens in Modify for its attributes. */
  startTemplate(id: string): void {
    const begin = () => {
      this.setLayer(id);
      this.mapService.setLayerVisibility(id, true);
      // The editor mounts with the layer — wait a tick for it on first use.
      setTimeout(() => this.fe?.requestAdd(id));
    };
    if (this.fe?.isDirty()) {
      this.notify.confirm({
        header: 'Discard unsaved changes?',
        message: 'The feature open in Modify has edits that have not been saved.',
        confirmLabel: 'Discard',
        destructive: true,
        accept: () => {
          this.fe?.cancel();
          begin();
        }
      });
      return;
    }
    begin();
  }

  isDrawing(id: string): boolean {
    return this.layerId() === id && this.fe?.busy() === 'draw';
  }

  openLayerMenu(event: Event, menu: Menu): void {
    menu.toggle(event);
  }

  kindIcon(type: GisGeometryType | null | undefined): string {
    return type === 'POINT' ? 'pi pi-map-marker' : type === 'LINE' ? 'pi pi-wave-pulse' : 'pi pi-stop';
  }

    geometryLabel(type: GisGeometryType | null | undefined): string {
    return GEOMETRY_OPTIONS.find((g) => g.value === type)?.label ?? 'Vector';
  }

  geometryIcon(type: GisGeometryType | null | undefined): string {
    return GEOMETRY_OPTIONS.find((g) => g.value === type)?.icon ?? 'pi pi-map';
  }

  selectLayer(id: string | null): void {
    this.renaming.set(false);
    this.setLayer(id);
    if (id) this.mapService.setLayerVisibility(id, true);
  }

  private setLayer(id: string | null): void {
    this.layerId.set(id);
    this.editingLayerChange.emit(id && this.canEdit() ? id : null);
  }

  startCreate(): void {
    this.creating.set(true);
    this.formError.set(null);
    this.newName = '';
    this.newGeometry = 'POINT';
    this.newCrs = this.defaultCrs || CRS_PRESETS[0].value;
    this.customCrs = '';
    this.fields.set([{ key: this.nextKey++, name: 'name', type: 'text' }]);
  }

  cancelCreate(): void {
    this.creating.set(false);
    this.formError.set(null);
  }

  addField(): void {
    this.fields.update((list) => [...list, { key: this.nextKey++, name: '', type: 'text' }]);
  }

  removeField(key: number): void {
    this.fields.update((list) => list.filter((f) => f.key !== key));
  }

  updateField(key: number, patch: Partial<FieldDraft>): void {
    this.fields.update((list) => list.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  }

  /** First problem with a field row, for its inline hint. */
  fieldProblem(field: FieldDraft): string | null {
    const name = field.name.trim();
    if (!name) return 'Enter a name.';
    if (!FIELD_NAME.test(name)) return 'Letters, digits and _ only; start with a letter.';
    if (RESERVED_FIELDS.has(name.toLowerCase())) return 'Reserved name.';
    const lower = name.toLowerCase();
    if (this.fields().filter((f) => f.name.trim().toLowerCase() === lower).length > 1) return 'Duplicate name.';
    return null;
  }

  create(): void {
    const name = this.newName.trim();
    const crs = this.newCrs === OTHER_CRS ? this.customCrs.trim().toUpperCase() : this.newCrs;
    if (!name) return this.formError.set('Enter a layer name.');
    if (!/^EPSG:\d{4,6}$/.test(crs)) return this.formError.set('Enter the CRS as EPSG:code, e.g. EPSG:32643.');
    const bad = this.fields().find((f) => this.fieldProblem(f));
    if (bad) return this.formError.set(`Field "${bad.name || '(unnamed)'}": ${this.fieldProblem(bad)}`);

    this.saving.set(true);
    this.formError.set(null);
    this.vectorTools
      .createBlankLayer({
        name,
        geometryType: this.newGeometry,
        crs,
        fields: this.fields().map((f) => ({ name: f.name.trim().toLowerCase(), type: f.type }))
      })
      .subscribe({
        next: (layer) => {
          this.saving.set(false);
          this.creating.set(false);
          this.pendingId = layer.id;
          this.pendingLayer = layer;
          this.setLayer(layer.id);
          this.notify.success(`Layer "${layer.name}" created — start adding features.`);
          this.layerCreated.emit(layer);
        },
        error: (err: HttpErrorResponse) => {
          this.saving.set(false);
          const message = err.error?.message;
          this.formError.set(Array.isArray(message) ? message.join('. ') : (message ?? 'Could not create the layer.'));
        }
      });
  }

  // ----- layer actions -----

  toggleVisible(): void {
    const id = this.layerId();
    if (id) this.mapService.setLayerVisibility(id, !this.visible());
  }

  zoomTo(): void {
    const layer = this.layer();
    if (layer?.bbox) this.mapService.zoomToLayer(layer);
  }

  startRename(): void {
    this.renameText = this.layer()?.name ?? '';
    this.renaming.set(true);
  }

  confirmRename(): void {
    const layer = this.layer();
    const name = this.renameText.trim();
    this.renaming.set(false);
    if (layer && name && name !== layer.name) this.renameLayer.emit({ layer, name });
  }

  remove(): void {
    const layer = this.layer();
    if (layer) this.deleteLayer.emit(layer);
  }
}
