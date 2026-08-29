import {
  Component,
  EventEmitter,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  computed,
  inject,
  signal,
  Input
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { CheckboxModule } from 'primeng/checkbox';
import { TooltipModule } from 'primeng/tooltip';
import { MessageModule } from 'primeng/message';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { AttributeField } from '../../models/attribute-table.model';
import { AttributeExternalFilter } from '../attribute-table/attribute-table.component';
import { MapService } from '../../services/map.service';
import { AttributeTableService } from '../../services/attribute-table.service';
import { QueryService } from '../../services/query.service';
import { SavedQueryService } from '../../services/saved-query.service';
import { compileQuery } from '../../services/ecql-builder';
import {
  ATTR_OPERATORS,
  AttrCondition,
  AttrOperator,
  ConditionGroup,
  QueryDefinition,
  SPATIAL_RELATIONS,
  SavedQuery,
  SpatialGeometryKind,
  emptyCondition,
  emptyGroup,
  emptyQueryDefinition
} from '../../models/query-builder.model';

/**
 * Query Builder — Attribute + Spatial query, living in the GIS left dock.
 *
 * The panel only edits a declarative `QueryDefinition`; `ecql-builder.ts`
 * compiles + validates it, `QueryService` runs it against GeoServer WFS,
 * and the result is surfaced through the workspace (WMS `CQL_FILTER`, the
 * map highlight overlay, and the Attribute Table's locked filter). New
 * operators / spatial relations are added in the model + compiler without
 * touching this component.
 */
@Component({
  selector: 'app-query-builder',
  standalone: true,
  imports: [
    FormsModule,
    ButtonModule,
    SelectModule,
    InputTextModule,
    InputNumberModule,
    CheckboxModule,
    TooltipModule,
    MessageModule
  ],
  templateUrl: './query-builder.component.html',
  styleUrl: './query-builder.component.scss'
})
export class QueryBuilderComponent implements OnChanges, OnDestroy {
  private readonly mapService = inject(MapService);
  private readonly attributeService = inject(AttributeTableService);
  private readonly queryService = inject(QueryService);
  private readonly savedQueryService = inject(SavedQueryService);

  @Input() layers: GisLayer[] = [];
  @Input() initialLayerId: string | null = null;
  @Input() workspaceKey = '';

  /** False while the panel is kept mounted but hidden (another tool is
   *  active). The declarative `def` and results stay put; only a live draw
   *  interaction is cancelled so it can't keep capturing map clicks. */
  private isActive = true;
  @Input() set active(value: boolean) {
    if (value === this.isActive) return;
    this.isActive = value;
    if (!value && this.drawing()) {
      this.mapService.cancelDraw();
      this.drawing.set(null);
    }
  }

  @Output() queryRun = new EventEmitter<AttributeExternalFilter>();
  @Output() queryCleared = new EventEmitter<void>();

  readonly previewLimit = this.queryService.previewLimit;
  readonly relations = SPATIAL_RELATIONS;
  readonly geometryKinds: SpatialGeometryKind[] = ['Rectangle', 'Polygon', 'Line', 'Point'];
  readonly distanceUnits = [
    { label: 'metres', value: 'meters' },
    { label: 'kilometres', value: 'kilometers' }
  ];

  def: QueryDefinition = emptyQueryDefinition();

  readonly fields = signal<AttributeField[]>([]);
  readonly geometryField = signal('geom');
  readonly fieldsLoading = signal(false);
  readonly fieldsError = signal<string | null>(null);

  readonly issues = signal<string[]>([]);
  readonly previewCql = signal<string | null>(null);
  readonly running = signal(false);
  readonly runError = signal<string | null>(null);
  readonly result = signal<{ total: number; truncated: boolean } | null>(null);
  readonly drawing = signal<SpatialGeometryKind | null>(null);

  readonly savedQueries = signal<SavedQuery[]>([]);
  readonly showSave = signal(false);
  saveName = '';

  private drawSub?: Subscription;

  readonly fieldOptions = computed(() =>
    this.fields().map((field) => ({ label: field.label, value: field.name }))
  );

  readonly layerOptions = computed(() =>
    this.layers
      .filter((layer) => layer.layerType === 'VECTOR')
      .map((layer) => ({ label: layer.name, value: layer.id }))
  );

  readonly hasLayers = computed(() => this.layerOptions().length > 0);

  readonly canRun = computed(() => !!this.previewCql() && this.issues().length === 0 && !this.running());

  readonly selectionCount = this.mapService.selectionGeometries;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['workspaceKey']) {
      this.refreshSaved();
    }
    if (changes['layers'] || changes['initialLayerId']) {
      const options = this.layerOptions();
      if (options.length > 0 && !options.some((o) => o.value === this.def.layerId)) {
        const preferred =
          (this.initialLayerId && options.find((o) => o.value === this.initialLayerId)) || options[0];
        this.onLayerChange(preferred.value);
      }
    }
  }

  ngOnDestroy(): void {
    this.drawSub?.unsubscribe();
    this.mapService.cancelDraw();
  }

  // ----- layer + fields -----

  activeLayer(): GisLayer | null {
    return this.layers.find((layer) => layer.id === this.def.layerId) ?? null;
  }

  onLayerChange(layerId: string): void {
    this.def.layerId = layerId;
    this.def.groups = [emptyGroup()];
    this.fields.set([]);
    this.result.set(null);
    this.loadFields();
    this.revalidate();
  }

  private loadFields(): void {
    const layer = this.activeLayer();
    if (!layer) return;
    const cached = this.attributeService.getFields(layer.id);
    if (cached && cached.length > 0) {
      this.fields.set(cached);
      this.geometryField.set(this.attributeService.getGeometryField(layer.id));
      this.revalidate();
      return;
    }
    this.fieldsLoading.set(true);
    this.fieldsError.set(null);
    this.attributeService.loadMetadata(layer).subscribe({
      next: ({ fields, geometryField }) => {
        this.fields.set(fields);
        this.geometryField.set(geometryField);
        this.fieldsLoading.set(false);
        this.revalidate();
      },
      error: () => {
        this.fieldsLoading.set(false);
        this.fieldsError.set('Could not read this layer’s fields.');
      }
    });
  }

  operatorsFor(fieldName: string) {
    const field = this.fields().find((f) => f.name === fieldName);
    return ATTR_OPERATORS.filter((op) => !op.types || (field && op.types.includes(field.type)));
  }

  operatorArity(op: AttrOperator): 0 | 1 | 2 {
    return ATTR_OPERATORS.find((o) => o.op === op)?.arity ?? 1;
  }

  inputTypeFor(fieldName: string): 'text' | 'number' | 'date' {
    const field = this.fields().find((f) => f.name === fieldName);
    if (!field) return 'text';
    if (field.type === 'integer' || field.type === 'number' || field.type === 'id') return 'number';
    if (field.type === 'date') return 'date';
    return 'text';
  }

  // ----- editing the definition -----

  onFieldChange(condition: AttrCondition, value: string): void {
    condition.field = value;
    const allowed = this.operatorsFor(value).map((o) => o.op);
    if (!allowed.includes(condition.operator)) {
      condition.operator = allowed[0] ?? '=';
    }
    this.revalidate();
  }

  onOperatorChange(condition: AttrCondition, value: AttrOperator): void {
    condition.operator = value;
    this.revalidate();
  }

  addCondition(group: ConditionGroup): void {
    group.conditions.push(emptyCondition());
    this.revalidate();
  }

  removeCondition(group: ConditionGroup, condition: AttrCondition): void {
    group.conditions = group.conditions.filter((c) => c !== condition);
    if (group.conditions.length === 0) {
      group.conditions.push(emptyCondition());
    }
    this.revalidate();
  }

  addGroup(): void {
    this.def.groups.push(emptyGroup('AND'));
    this.revalidate();
  }

  removeGroup(group: ConditionGroup): void {
    this.def.groups = this.def.groups.filter((g) => g !== group);
    if (this.def.groups.length === 0) {
      this.def.groups.push(emptyGroup());
    }
    this.revalidate();
  }

  // ----- spatial -----

  toggleSpatial(enabled: boolean): void {
    this.def.spatial.enabled = enabled;
    if (!enabled) {
      this.mapService.clearDraw();
      this.drawing.set(null);
    }
    this.revalidate();
  }

  onRelationChange(): void {
    const relation = this.relations.find((r) => r.relation === this.def.spatial.relation);
    if (relation && !relation.geometry.includes(this.def.spatial.geometryKind)) {
      this.def.spatial.geometryKind = relation.geometry[0];
    }
    this.revalidate();
  }

  allowedGeometryKinds(): SpatialGeometryKind[] {
    return this.relations.find((r) => r.relation === this.def.spatial.relation)?.geometry ?? this.geometryKinds;
  }

  startDraw(kind: SpatialGeometryKind): void {
    this.def.spatial.geometryKind = kind;
    this.def.spatial.source = 'draw';
    this.drawing.set(kind);
    this.drawSub?.unsubscribe();
    this.drawSub = this.mapService.beginDraw(kind).subscribe({
      next: (geometry) => {
        this.def.spatial.geometry = geometry;
        this.drawing.set(null);
        this.revalidate();
      },
      complete: () => this.drawing.set(null)
    });
  }

  cancelDraw(): void {
    this.mapService.cancelDraw();
    this.drawing.set(null);
  }

  useSelection(): void {
    const geometries = this.mapService.selectionGeometries();
    if (geometries.length !== 1) {
      return;
    }
    this.def.spatial.geometry = geometries[0];
    this.def.spatial.source = 'selection';
    this.mapService.clearDraw();
    this.revalidate();
  }

  clearGeometry(): void {
    this.def.spatial.geometry = null;
    this.mapService.clearDraw();
    this.revalidate();
  }

  get spatialRelationHint(): string {
    return this.relations.find((r) => r.relation === this.def.spatial.relation)?.hint ?? '';
  }

  // ----- run / clear / reset -----

  revalidate(): void {
    if (!this.activeLayer() || this.fields().length === 0) {
      this.issues.set([]);
      this.previewCql.set(null);
      return;
    }
    const compiled = compileQuery(this.def, this.fields(), this.geometryField());
    this.issues.set(compiled.issues);
    this.previewCql.set(compiled.cql);
  }

  runQuery(): void {
    const layer = this.activeLayer();
    const cql = this.previewCql();
    if (!layer || !cql || this.issues().length > 0) {
      this.revalidate();
      return;
    }
    this.running.set(true);
    this.runError.set(null);
    this.result.set(null);

    this.queryService.execute(layer, cql).subscribe({
      next: (execution) => {
        this.running.set(false);
        this.result.set({ total: execution.total, truncated: execution.truncated });
        this.mapService.setQueryHighlight(execution.geometries);
        if (execution.geometries.length > 0) {
          this.mapService.zoomToGeometries(execution.geometries);
        }
        this.queryRun.emit({ layerId: layer.id, cql, label: this.buildLabel(layer) });
      },
      error: (err: HttpErrorResponse) => {
        this.running.set(false);
        this.result.set(null);
        this.runError.set(this.describeError(err));
      }
    });
  }

  clearResults(): void {
    this.result.set(null);
    this.runError.set(null);
    this.mapService.clearQueryHighlight();
    this.queryCleared.emit();
  }

  resetBuilder(): void {
    this.def = emptyQueryDefinition(this.def.layerId);
    this.mapService.clearDraw();
    this.drawing.set(null);
    this.clearResults();
    this.revalidate();
  }

  // ----- saved queries -----

  private refreshSaved(): void {
    this.savedQueries.set(this.savedQueryService.list(this.workspaceKey));
  }

  toggleSave(): void {
    this.showSave.update((open) => !open);
    if (this.showSave()) {
      const layer = this.activeLayer();
      this.saveName = layer ? `${layer.name} query` : 'Query';
    }
  }

  confirmSave(): void {
    if (!this.saveName.trim()) return;
    this.savedQueryService.save(this.workspaceKey, this.saveName, this.def);
    this.showSave.set(false);
    this.refreshSaved();
  }

  loadSaved(id: string | null): void {
    const saved = this.savedQueries().find((q) => q.id === id);
    if (!saved) return;
    this.def = structuredClone(saved.definition);
    if (this.def.layerId && !this.layers.some((l) => l.id === this.def.layerId)) {
      this.def.layerId = this.layerOptions()[0]?.value ?? null;
    }
    this.loadFields();
    this.revalidate();
  }

  deleteSaved(id: string, event: Event): void {
    event.stopPropagation();
    this.savedQueryService.remove(this.workspaceKey, id);
    this.refreshSaved();
  }

  // ----- helpers -----

  private buildLabel(layer: GisLayer): string {
    const conditions = this.def.groups.reduce(
      (sum, group) => sum + group.conditions.filter((c) => c.field).length,
      0
    );
    const bits: string[] = [];
    if (conditions > 0) bits.push(`${conditions} condition${conditions === 1 ? '' : 's'}`);
    if (this.def.spatial.enabled && this.def.spatial.geometry) bits.push(this.def.spatial.relation.toLowerCase());
    return `${layer.name}${bits.length ? ' · ' + bits.join(' + ') : ''}`;
  }

  private describeError(err: HttpErrorResponse): string {
    if (err.status === 0) return 'Could not reach the GIS server.';
    if (err.status === 400) return 'The server rejected the query. Check the field values and operators.';
    return `The GIS server returned an error (${err.status}).`;
  }
}
