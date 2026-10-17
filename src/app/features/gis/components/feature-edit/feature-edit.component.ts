import { Component, Input, OnDestroy, computed, inject, signal } from '@angular/core';
import { NotificationService } from '../../../../core/services/notification.service';
import { FormsModule } from '@angular/forms';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { MessageModule } from 'primeng/message';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { downloadBlob } from '../../../../core/utils/download-blob';
import { MapService } from '../../services/map.service';
import {
  ATTACHMENTS_MODULE_ID,
  EDIT_HISTORY_MODULE_ID,
  FIELD_COLLECTION_MODULE_ID,
  EditSchema,
  EditableFeature,
  FeatureAttachment,
  FeatureHistoryEntry,
  PARCEL_TOOLS_MODULE_ID,
  VectorToolsService
} from '../../services/vector-tools.service';
import { misclosure, parseCogoLegs, traverse } from './cogo';

type InputKind = 'number' | 'date' | 'boolean' | 'text' | 'list';
type Tab = 'attributes' | 'history' | 'files';

const NUMERIC_TYPES = new Set(['integer', 'bigint', 'smallint', 'numeric', 'double precision', 'real']);

/** One feature being edited: `id` null while it is a new, unsaved one. */
interface EditTarget {
  id: number | null;
  original: Record<string, string>;
  values: Record<string, string>;
  geometryRevision: number;
}

/**
 * GIS Edit panel — add, reshape, re-attribute and delete features of an
 * uploaded vector layer, straight into its PostGIS table (VectorToolsService;
 * UPLOAD / MANAGE permission enforced server-side). Field rules drive the
 * form (value lists, required fields). Optional modules add the per-feature
 * edit History, file Attachments, and Parcel tools (split, merge, COGO).
 */
@Component({
  selector: 'app-feature-edit',
  standalone: true,
  imports: [FormsModule, RouterLink, DatePipe, DecimalPipe, ButtonModule, SelectModule, MessageModule],
  templateUrl: './feature-edit.component.html',
  styleUrls: ['../buffer-overlay/buffer-overlay.component.scss', './feature-edit.component.scss']
})
export class FeatureEditComponent implements OnDestroy {
  private readonly mapService = inject(MapService);
  private readonly vectorTools = inject(VectorToolsService);
  private readonly notify = inject(NotificationService);

  @Input() set layers(value: GisLayer[]) {
    this.layersSignal.set(value ?? []);
  }
  private readonly layersSignal = signal<GisLayer[]>([]);

  @Input() set allowedModuleIds(value: ReadonlySet<number>) {
    this.allowedSignal.set(value ?? new Set());
  }
  private readonly allowedSignal = signal<ReadonlySet<number>>(new Set());

  /** Hidden panel: stop drawing / picking and drop the edit target. */
  @Input() set active(value: boolean) {
    if (!value) this.cancel();
  }

  readonly historyAllowed = computed(() => this.allowedSignal().has(EDIT_HISTORY_MODULE_ID));
  readonly filesAllowed = computed(() => this.allowedSignal().has(ATTACHMENTS_MODULE_ID));
  readonly parcelAllowed = computed(() => this.allowedSignal().has(PARCEL_TOOLS_MODULE_ID));
  readonly collectAllowed = computed(() => this.allowedSignal().has(FIELD_COLLECTION_MODULE_ID));

  readonly layerOptions = computed(() =>
    this.layersSignal()
      .filter((l) => l.layerType === 'VECTOR' && l.geometryType)
      .map((l) => ({ label: l.name, value: l.id }))
  );

  readonly layerId = signal<string | null>(null);
  readonly schema = signal<EditSchema | null>(null);
  readonly busy = signal<'schema' | 'pick' | 'draw' | 'save' | 'delete' | 'split' | 'merge' | 'upload' | null>(null);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly target = signal<EditTarget | null>(null);
  readonly confirmDelete = signal(false);
  readonly tab = signal<Tab>('attributes');
  readonly history = signal<FeatureHistoryEntry[] | null>(null);
  readonly attachments = signal<FeatureAttachment[] | null>(null);

  /** Merge: other features picked to be merged into the target. */
  readonly mergeIds = signal<number[]>([]);

  /** COGO entry state. */
  readonly cogoOpen = signal(false);
  readonly cogoStart = signal<[number, number] | null>(null);
  cogoText = '';
  readonly cogoInfo = signal<string | null>(null);

  readonly geometryDirty = computed(() => {
    const t = this.target();
    return !!t && this.mapService.editGeometryRevision() !== t.geometryRevision;
  });

  /** Unsaved attribute or geometry changes on the current target. */
  readonly isDirty = computed(() => {
    const t = this.target();
    if (!t) return false;
    return this.geometryDirty() || Object.entries(t.values).some(([k, v]) => v !== t.original[k]);
  });

  readonly canSplitMerge = computed(() => this.schema()?.geometryType !== 'POINT');

  private sub?: Subscription;

  ngOnDestroy(): void {
    this.cancel();
  }

  selectLayer(layerId: string | null): void {
    this.cancel();
    this.cogoOpen.set(false);
    this.layerId.set(layerId);
    this.schema.set(null);
    this.error.set(null);
    if (!layerId) return;
    this.busy.set('schema');
    this.vectorTools.editSchema(layerId).subscribe({
      next: (schema) => {
        if (this.layerId() !== layerId) return; // another layer picked meanwhile
        this.schema.set(schema);
        this.busy.set(null);
      },
      error: (err: HttpErrorResponse) => this.layerId() === layerId && this.fail(err)
    });
  }

  inputKind(field: { name: string; type: string }): InputKind {
    if (this.schema()?.rules[field.name]?.values?.length) return 'list';
    if (NUMERIC_TYPES.has(field.type)) return 'number';
    if (field.type === 'date') return 'date';
    if (field.type === 'boolean') return 'boolean';
    return 'text';
  }

  ruleValues(field: string): string[] {
    return this.schema()?.rules[field]?.values ?? [];
  }

  isRequired(field: string): boolean {
    return !!this.schema()?.rules[field]?.required;
  }

  // ----- start editing -----

  addFeature(): void {
    const schema = this.schema();
    if (!schema?.geometryType) return;
    if (this.isDirty()) return this.confirmDiscard(() => this.addFeature());
    this.cancel();
    const kind = schema.geometryType === 'POINT' ? 'Point' : schema.geometryType === 'LINE' ? 'Line' : 'Polygon';
    this.busy.set('draw');
    this.sub = this.mapService.beginDraw(kind).subscribe({
      next: (geometry) => {
        this.mapService.clearDraw();
        this.startNew(geometry);
      },
      complete: () => this.busy.set(null)
    });
  }

  private startNew(geometry: Record<string, unknown>): void {
    const schema = this.schema();
    if (!schema) return;
    this.mapService.setEditFeature(geometry);
    const empty = Object.fromEntries(schema.fields.map((f) => [f.name, '']));
    this.target.set({
      id: null,
      original: empty,
      values: { ...empty },
      geometryRevision: this.mapService.editGeometryRevision()
    });
    this.tab.set('attributes');
  }

  pickFeature(): void {
    const layerId = this.layerId();
    if (!layerId) return;
    if (this.isDirty()) return this.confirmDiscard(() => this.pickFeature());
    this.cancel();
    this.busy.set('pick');
    this.sub = this.mapService.pickMapPoint().subscribe(({ lonLat, toleranceM }) => {
      this.vectorTools.featureAt(layerId, lonLat, toleranceM).subscribe({
        next: ({ feature }) => {
          this.busy.set(null);
          if (!feature) {
            this.notice.set('No feature of this layer at that spot — click closer to it.');
            return;
          }
          this.load(feature);
        },
        error: (err: HttpErrorResponse) => this.fail(err)
      });
    });
  }

  private load(feature: EditableFeature): void {
    const values = this.stringify(feature.properties);
    this.mapService.setEditFeature(feature.geometry);
    this.target.set({
      id: feature.id,
      original: values,
      values: { ...values },
      geometryRevision: this.mapService.editGeometryRevision()
    });
    this.confirmDelete.set(false);
    this.mergeIds.set([]);
    this.notice.set(null);
    this.history.set(null);
    this.attachments.set(null);
    if (this.tab() === 'history') this.loadHistory();
    if (this.tab() === 'files') this.loadAttachments();
  }

  // ----- save / delete -----

  setValue(field: string, value: unknown): void {
    this.target.update((t) =>
      t ? { ...t, values: { ...t.values, [field]: value === null || value === undefined ? '' : String(value) } } : t
    );
  }

  save(): void {
    const layerId = this.layerId();
    const t = this.target();
    const geometry = this.mapService.getEditGeometry();
    if (!layerId || !t || !geometry) return;
    const changed = Object.fromEntries(
      Object.entries(t.values).filter(([key, value]) => value !== t.original[key])
    );
    if (t.id !== null && !this.geometryDirty() && !Object.keys(changed).length) {
      this.notice.set('Nothing changed.');
      return;
    }
    const missing = (this.schema()?.fields ?? [])
      .filter((f) => this.isRequired(f.name) && !t.values[f.name]?.trim())
      .map((f) => f.name);
    if (missing.length) {
      this.error.set(`Required: ${missing.join(', ')}.`);
      return;
    }
    const request =
      t.id === null
        ? this.vectorTools.createFeature(layerId, geometry, changed)
        : this.vectorTools.updateFeature(layerId, t.id, {
            ...(this.geometryDirty() ? { geometry } : {}),
            ...(Object.keys(changed).length ? { properties: changed } : {})
          });
    this.busy.set('save');
    this.error.set(null);
    request.subscribe({
      next: (feature) => {
        this.busy.set(null);
        this.mapService.refreshLayerStyle(layerId);
        this.load(feature);
        this.notice.set(t.id === null ? `Feature #${feature.id} added.` : `Feature #${feature.id} saved.`);
      },
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  remove(): void {
    const layerId = this.layerId();
    const id = this.target()?.id;
    if (!layerId || id === null || id === undefined) return;
    if (!this.confirmDelete()) {
      this.confirmDelete.set(true);
      return;
    }
    this.busy.set('delete');
    this.vectorTools.deleteFeature(layerId, id).subscribe({
      next: () => {
        this.mapService.refreshLayerStyle(layerId);
        this.cancel();
        this.notice.set(`Feature #${id} deleted.`);
      },
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  /** Asks before throwing away unsaved edits, then runs `next`. */
  private confirmDiscard(next: () => void): void {
    this.notify.confirm({
      header: 'Discard unsaved changes?',
      message: 'This feature has edits that have not been saved.',
      confirmLabel: 'Discard',
      destructive: true,
      accept: () => {
        this.cancel();
        next();
      }
    });
  }

  cancel(): void {
    this.error.set(null);
    this.sub?.unsubscribe();
    this.sub = undefined;
    this.mapService.cancelDraw();
    this.mapService.cancelMapPick();
    this.mapService.clearEditFeature();
    this.target.set(null);
    this.history.set(null);
    this.attachments.set(null);
    this.mergeIds.set([]);
    this.confirmDelete.set(false);
    this.busy.set(null);
    this.notice.set(null);
  }

  // ----- parcel tools: split / merge -----

  split(): void {
    const layerId = this.layerId();
    const id = this.target()?.id;
    if (!layerId || id === null || id === undefined) return;
    this.busy.set('split');
    this.notice.set('Draw the cutting line across the feature (double-click to finish).');
    this.sub?.unsubscribe();
    this.sub = this.mapService.beginDraw('Line').subscribe({
      next: (line) => {
        this.mapService.clearDraw();
        this.vectorTools.splitFeature(layerId, id, line).subscribe({
          next: ({ features }) => {
            this.busy.set(null);
            this.mapService.refreshLayerStyle(layerId);
            this.load(features[0]);
            this.notice.set(
              `Split into ${features.length} features (#${features.map((f) => f.id).join(', #')}); the first stays selected.`
            );
          },
          error: (err: HttpErrorResponse) => this.fail(err)
        });
      }
    });
  }

  pickMergeFeature(): void {
    const layerId = this.layerId();
    const id = this.target()?.id;
    if (!layerId || id === null || id === undefined) return;
    this.busy.set('pick');
    this.sub?.unsubscribe();
    this.sub = this.mapService.pickMapPoint().subscribe(({ lonLat, toleranceM }) => {
      this.vectorTools.featureAt(layerId, lonLat, toleranceM).subscribe({
        next: ({ feature }) => {
          this.busy.set(null);
          if (!feature || feature.id === id) {
            this.notice.set('Click another feature of this layer to merge.');
            return;
          }
          this.mergeIds.update((ids) => (ids.includes(feature.id) ? ids : [...ids, feature.id]));
          this.notice.set(null);
        },
        error: (err: HttpErrorResponse) => this.fail(err)
      });
    });
  }

  merge(): void {
    const layerId = this.layerId();
    const id = this.target()?.id;
    const others = this.mergeIds();
    if (!layerId || id === null || id === undefined || !others.length) return;
    this.busy.set('merge');
    this.vectorTools.mergeFeatures(layerId, id, others).subscribe({
      next: (feature) => {
        this.busy.set(null);
        this.mapService.refreshLayerStyle(layerId);
        this.load(feature);
        this.notice.set(`Merged ${others.length + 1} features into #${feature.id}.`);
      },
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  // ----- COGO -----

  toggleCogo(): void {
    this.cancel();
    this.cogoOpen.update((open) => !open);
    this.cogoInfo.set(null);
  }

  pickCogoStart(): void {
    this.busy.set('pick');
    this.sub?.unsubscribe();
    this.sub = this.mapService.pickMapPoint().subscribe(({ lonLat }) => {
      this.busy.set(null);
      this.cogoStart.set(lonLat);
    });
  }

  setCogoStart(text: string): void {
    const [lat, lon] = text.split(/[\s,]+/).map(Number);
    this.cogoStart.set(Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : null);
  }

  cogoStartLabel(): string {
    const p = this.cogoStart();
    return p ? `${p[1].toFixed(7)}, ${p[0].toFixed(7)}` : '';
  }

  buildCogo(): void {
    const start = this.cogoStart();
    const type = this.schema()?.geometryType;
    if (!start) return this.error.set('Set the start point (pick it on the map or type "lat, lon").');
    const legs = parseCogoLegs(this.cogoText);
    if (typeof legs === 'string') return this.error.set(legs);
    const points = traverse(start, legs);
    this.error.set(null);
    let geometry: Record<string, unknown>;
    if (type === 'POLYGON') {
      if (points.length < 3) return this.error.set('A parcel needs at least 3 legs.');
      const gap = misclosure(points);
      const ring = gap < 0.01 ? [...points.slice(0, -1), points[0]] : [...points, points[0]];
      geometry = { type: 'Polygon', coordinates: [ring] };
      this.cogoInfo.set(`Misclosure ${gap.toFixed(3)} m — the ring was closed to the start point.`);
    } else if (type === 'LINE') {
      geometry = { type: 'LineString', coordinates: points };
      this.cogoInfo.set(`${legs.length} leg(s), ${legs.reduce((s, l) => s + l.distance, 0).toFixed(2)} m.`);
    } else {
      geometry = { type: 'Point', coordinates: points[points.length - 1] };
      this.cogoInfo.set('Point placed at the end of the traverse.');
    }
    this.mapService.clearEditFeature();
    this.startNew(geometry);
    this.mapService.zoomToGeometries([geometry]);
  }

  // ----- history / attachments -----

  setTab(tab: Tab): void {
    this.tab.set(tab);
    if (tab === 'history' && !this.history()) this.loadHistory();
    if (tab === 'files' && !this.attachments()) this.loadAttachments();
  }

  private loadHistory(): void {
    const layerId = this.layerId();
    const id = this.target()?.id;
    if (!layerId || id === null || id === undefined || !this.historyAllowed()) return;
    this.vectorTools.history(layerId, id).subscribe({
      next: (entries) => this.history.set(entries),
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  private loadAttachments(): void {
    const layerId = this.layerId();
    const id = this.target()?.id;
    if (!layerId || id === null || id === undefined || !this.filesAllowed()) return;
    this.vectorTools.attachments(layerId, id).subscribe({
      next: (rows) => this.attachments.set(rows),
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  upload(input: HTMLInputElement): void {
    const layerId = this.layerId();
    const id = this.target()?.id;
    const file = input.files?.[0];
    input.value = '';
    if (!layerId || id === null || id === undefined || !file) return;
    this.busy.set('upload');
    this.vectorTools.addAttachment(layerId, id, file, file.name).subscribe({
      next: (row) => {
        this.busy.set(null);
        this.attachments.update((rows) => [row, ...(rows ?? [])]);
      },
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  openAttachment(row: FeatureAttachment): void {
    const layerId = this.layerId();
    if (!layerId) return;
    this.vectorTools.attachmentBlob(layerId, row.id).subscribe({
      next: (blob) => downloadBlob(blob, row.fileName),
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  deleteAttachment(row: FeatureAttachment): void {
    const layerId = this.layerId();
    if (!layerId) return;
    this.notify.confirmDelete({
      header: 'Delete file',
      message: `Delete "${row.fileName}" from this feature? This cannot be undone.`,
      accept: () =>
        this.vectorTools.deleteAttachment(layerId, row.id).subscribe({
          next: () => this.attachments.update((rows) => rows?.filter((r) => r.id !== row.id) ?? null),
          error: (err: HttpErrorResponse) => this.fail(err)
        })
    });
  }

  /** "field: old → new" lines for an UPDATE entry. */
  changes(entry: FeatureHistoryEntry): string[] {
    if (entry.action !== 'UPDATE') return [];
    const before = entry.oldData?.properties ?? {};
    const after = entry.newData?.properties ?? {};
    const lines = Object.keys({ ...before, ...after })
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => `${key}: ${this.show(before[key])} → ${this.show(after[key])}`);
    if (JSON.stringify(entry.oldData?.geometry) !== JSON.stringify(entry.newData?.geometry)) {
      lines.push('geometry reshaped');
    }
    return lines;
  }

  private show(value: unknown): string {
    return value === null || value === undefined || value === '' ? '∅' : String(value);
  }

  private stringify(properties: Record<string, unknown>): Record<string, string> {
    const fields = this.schema()?.fields ?? [];
    return Object.fromEntries(
      fields.map((f) => {
        const value = properties[f.name];
        const text = value === null || value === undefined ? '' : String(value);
        return [f.name, f.type === 'date' ? text.slice(0, 10) : text];
      })
    );
  }

  private fail(err: HttpErrorResponse): void {
    this.busy.set(null);
    const message = err.error?.message;
    this.error.set(Array.isArray(message) ? message.join(' ') : (message ?? 'The request failed.'));
  }
}
