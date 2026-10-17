import { Component, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { MessageModule } from 'primeng/message';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { MapService } from '../../services/map.service';
import {
  DataToolsService,
  FIELD_CALCULATOR_MODULE_ID,
  FIELD_RULES_MODULE_ID,
  GEOCODE_MODULE_ID,
  GeocodeResult,
  LayerSnapshot,
  NewFieldType,
  SnapshotComparison,
  TABLE_JOIN_MODULE_ID,
  TOPOLOGY_MODULE_ID,
  TopologyIssue,
  VERSIONS_MODULE_ID
} from '../../services/data-tools.service';

type Tool = 'calc' | 'join' | 'geocode' | 'validate' | 'rules' | 'versions';

interface Field {
  name: string;
  type: string;
}

interface RuleRow {
  field: string;
  type: string;
  required: boolean;
  valuesText: string;
  min: number | null;
  max: number | null;
}

const CHECK_LABELS: Record<TopologyIssue['check'], string> = {
  invalid: 'Invalid geometry',
  empty: 'Empty geometry',
  duplicate: 'Duplicate',
  overlap: 'Overlap',
  gap: 'Gap',
  dangle: 'Dangle',
  rule: 'Field rule',
  outlier: 'Unusual value'
};
const CHECK_COLORS: Record<TopologyIssue['check'], string> = {
  invalid: '#dc2626',
  empty: '#6b7280',
  duplicate: '#9333ea',
  overlap: '#ea580c',
  gap: '#0891b2',
  dangle: '#ca8a04',
  rule: '#2563eb',
  outlier: '#db2777'
};

/**
 * GIS Data Tools — Field Calculator, Table Join, Geocode Addresses,
 * Topology Validation, Field Rules and Versions / Change Detection. Each
 * tab is gated by its own module; layer permissions are enforced server-side.
 */
@Component({
  selector: 'app-data-tools',
  standalone: true,
  imports: [FormsModule, DatePipe, ButtonModule, SelectModule, MessageModule],
  templateUrl: './data-tools.component.html',
  styleUrls: ['../buffer-overlay/buffer-overlay.component.scss', './data-tools.component.scss']
})
export class DataToolsComponent {
  private readonly api = inject(DataToolsService);
  private readonly mapService = inject(MapService);

  @Input() set layers(value: GisLayer[]) {
    this.layersSignal.set(value ?? []);
  }
  private readonly layersSignal = signal<GisLayer[]>([]);

  @Input() set allowedModuleIds(value: ReadonlySet<number>) {
    this.allowedSignal.set(value ?? new Set());
    if (!this.tools().some((t) => t.value === this.tool())) this.tool.set(this.tools()[0]?.value ?? 'calc');
  }
  private readonly allowedSignal = signal<ReadonlySet<number>>(new Set());

  @Output() readonly layerCreated = new EventEmitter<GisLayer>();

  readonly tools = computed(() =>
    [
      { value: 'calc' as Tool, label: 'Calculator', moduleId: FIELD_CALCULATOR_MODULE_ID },
      { value: 'join' as Tool, label: 'Join', moduleId: TABLE_JOIN_MODULE_ID },
      { value: 'geocode' as Tool, label: 'Geocode', moduleId: GEOCODE_MODULE_ID },
      { value: 'validate' as Tool, label: 'Validate', moduleId: TOPOLOGY_MODULE_ID },
      { value: 'rules' as Tool, label: 'Rules', moduleId: FIELD_RULES_MODULE_ID },
      { value: 'versions' as Tool, label: 'Versions', moduleId: VERSIONS_MODULE_ID }
    ].filter((t) => this.allowedSignal().has(t.moduleId))
  );
  readonly tool = signal<Tool>('calc');

  readonly vectorLayers = computed(() =>
    this.layersSignal()
      .filter((l) => l.layerType === 'VECTOR' && l.geometryType)
      .map((l) => ({ label: l.name, value: l.id }))
  );

  readonly layerId = signal<string | null>(null);
  readonly fields = signal<Field[]>([]);
  readonly fieldOptions = computed(() => this.fields().map((f) => ({ label: f.name, value: f.name })));
  readonly running = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  // calculator
  calcField = '';
  readonly calcNew = signal(false);
  calcType: NewFieldType = 'double precision';
  calcExpression = '';
  readonly calcPreview = signal<{ id: number; value: string | null }[] | null>(null);
  readonly newFieldTypes: { label: string; value: NewFieldType }[] = [
    { label: 'Decimal number', value: 'double precision' },
    { label: 'Whole number', value: 'integer' },
    { label: 'Text', value: 'text' },
    { label: 'Date', value: 'date' },
    { label: 'True / false', value: 'boolean' }
  ];
  readonly variables = ['$area', '$length', '$perimeter', '$x', '$y', '$id'];

  // CSV input (join + geocode)
  readonly csvFile = signal<File | null>(null);
  readonly csvHeader = signal<string[]>([]);
  readonly csvOptions = computed(() => this.csvHeader().map((h) => ({ label: h, value: h })));

  // join
  joinLayerKey: string | null = null;
  joinTableKey: string | null = null;
  readonly joinColumns = signal<ReadonlySet<string>>(new Set());

  // geocode
  geoAddressColumn: string | null = null;
  readonly geoRefLayerId = signal<string | null>(null);
  readonly geoRefFields = signal<Field[]>([]);
  geoRefField: string | null = null;
  geoMinScore = 0.6;
  geoOutputName = 'Geocoded addresses';
  readonly geoResult = signal<GeocodeResult | null>(null);

  // validate
  maxGapArea = 100;
  /** Statistical outliers of the numeric fields (robust z-score), each
   *  value judged against the whole layer or against its group. */
  findOutliers = true;
  outlierGroupField: string | null = null;
  readonly issues = signal<TopologyIssue[] | null>(null);
  readonly issueCounts = signal<{ check: TopologyIssue['check']; label: string; count: number; color: string }[]>([]);

  // rules
  readonly ruleRows = signal<RuleRow[]>([]);

  // versions
  readonly snapshots = signal<LayerSnapshot[] | null>(null);
  snapshotName = '';
  compareKey: string | null = null;
  readonly comparison = signal<SnapshotComparison | null>(null);
  readonly confirmRestore = signal<string | null>(null);

  setTool(tool: Tool): void {
    this.tool.set(tool);
    this.error.set(null);
    this.notice.set(null);
    this.mapService.clearAnalysisGeometry();
    this.loadForTool();
  }

  selectLayer(layerId: string | null): void {
    this.layerId.set(layerId);
    this.fields.set([]);
    this.outlierGroupField = null;
    this.issues.set(null);
    this.comparison.set(null);
    this.snapshots.set(null);
    this.calcPreview.set(null);
    this.error.set(null);
    this.notice.set(null);
    this.mapService.clearAnalysisGeometry();
    if (!layerId) return;
    this.api.fieldRules(layerId).subscribe({
      next: ({ fields, rules }) => {
        this.fields.set(fields);
        this.ruleRows.set(
          fields.map((f) => ({
            field: f.name,
            type: f.type,
            required: !!rules[f.name]?.required,
            valuesText: (rules[f.name]?.values ?? []).join(', '),
            min: rules[f.name]?.min ?? null,
            max: rules[f.name]?.max ?? null
          }))
        );
      },
      error: (err: HttpErrorResponse) => this.fail(err)
    });
    this.loadForTool();
  }

  private loadForTool(): void {
    const layerId = this.layerId();
    if (this.tool() === 'versions' && layerId && !this.snapshots()) {
      this.api.snapshots(layerId).subscribe({
        next: (rows) => this.snapshots.set(rows),
        error: (err: HttpErrorResponse) => this.fail(err)
      });
    }
  }

  // ----- Field Calculator -----

  insert(token: string): void {
    this.calcExpression = `${this.calcExpression}${this.calcExpression && !this.calcExpression.endsWith(' ') ? ' ' : ''}${token}`;
  }

  quoteField(name: string): string {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name}"`;
  }

  previewCalc(): void {
    const layerId = this.layerId();
    if (!layerId || !this.calcExpression.trim()) return;
    this.run(this.api.fieldCalculate(layerId, { field: this.calcField || 'preview', expression: this.calcExpression, preview: true }), (r) =>
      this.calcPreview.set(r.preview ?? [])
    );
  }

  runCalc(): void {
    const layerId = this.layerId();
    if (!layerId) return;
    if (!this.calcField.trim()) return this.error.set('Choose or name the field to fill.');
    if (!this.calcExpression.trim()) return this.error.set('Enter an expression.');
    this.run(
      this.api.fieldCalculate(layerId, {
        field: this.calcField.trim(),
        expression: this.calcExpression,
        ...(this.calcNew() ? { newFieldType: this.calcType } : {})
      }),
      (r) => {
        this.notice.set(`"${r.field}" updated on ${r.changed} feature(s).`);
        if (this.calcNew()) this.selectLayer(layerId);
        this.calcNew.set(false);
        this.mapService.refreshLayerStyle(layerId);
      }
    );
  }

  // ----- CSV -----

  onCsv(input: HTMLInputElement): void {
    const file = input.files?.[0] ?? null;
    this.csvFile.set(file);
    this.csvHeader.set([]);
    this.geoResult.set(null);
    if (!file) return;
    file
      .slice(0, 64 * 1024)
      .text()
      .then((text) => {
        const header = csvHeader(text);
        this.csvHeader.set(header);
        this.joinColumns.set(new Set(header));
        this.joinTableKey = header[0] ?? null;
        this.geoAddressColumn = header.find((h) => /addr|address|street|location/i.test(h)) ?? header[0] ?? null;
      });
  }

  toggleJoinColumn(name: string, on: boolean): void {
    this.joinColumns.update((set) => {
      const next = new Set(set);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  runJoin(): void {
    const layerId = this.layerId();
    const file = this.csvFile();
    if (!layerId || !file) return this.error.set('Choose a layer and a CSV file.');
    if (!this.joinLayerKey || !this.joinTableKey) return this.error.set('Choose the matching key on both sides.');
    const columns = this.csvHeader().filter((h) => h !== this.joinTableKey && this.joinColumns().has(h));
    if (!columns.length) return this.error.set('Tick at least one CSV column to bring in.');
    this.run(this.api.joinTable(layerId, file, this.joinLayerKey, this.joinTableKey, columns), (r) => {
      this.notice.set(
        `${r.matchedFeatures} feature(s) matched ${r.csvRows} CSV row(s); ${r.changedFeatures} updated. Fields: ${r.fields.join(', ')}.`
      );
      this.selectLayer(layerId);
      this.mapService.refreshLayerStyle(layerId);
    });
  }

  // ----- Geocode -----

  setGeoRefLayer(layerId: string | null): void {
    this.geoRefLayerId.set(layerId);
    this.geoRefFields.set([]);
    this.geoRefField = null;
    if (!layerId) return;
    this.api.fieldRules(layerId).subscribe({
      next: ({ fields }) => {
        this.geoRefFields.set(fields);
        this.geoRefField = fields.find((f) => /addr|address|street|name/i.test(f.name))?.name ?? null;
      },
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  runGeocode(): void {
    const file = this.csvFile();
    const ref = this.geoRefLayerId();
    if (!file || !this.geoAddressColumn) return this.error.set('Choose a CSV file and its address column.');
    if (!ref || !this.geoRefField) return this.error.set('Choose the address layer and its address field.');
    if (!this.geoOutputName.trim()) return this.error.set('Name the new point layer.');
    this.run(
      this.api.geocode(file, {
        addressColumn: this.geoAddressColumn,
        referenceLayerId: ref,
        referenceField: this.geoRefField,
        outputName: this.geoOutputName.trim(),
        minScore: this.geoMinScore
      }),
      (r) => {
        this.geoResult.set(r);
        this.layerCreated.emit(r.layer);
      }
    );
  }

  // ----- Validate -----

  runValidate(prefix = ''): void {
    const layerId = this.layerId();
    if (!layerId) return;
    this.run(this.api.validate(layerId, this.maxGapArea, { enabled: this.findOutliers, groupField: this.outlierGroupField }), (r) => {
      this.issues.set(r.issues);
      this.issueCounts.set(
        (Object.keys(CHECK_LABELS) as TopologyIssue['check'][])
          .filter((c) => r.counts[c])
          .map((c) => ({ check: c, label: CHECK_LABELS[c], count: r.counts[c], color: CHECK_COLORS[c] }))
      );
      this.mapService.setAnalysisColoredGeometries(
        r.issues
          .filter((i) => i.geometry)
          .map((i) => ({ geometry: i.geometry!, color: CHECK_COLORS[i.check] }))
      );
      this.notice.set(
        prefix +
        (r.issues.length
          ? `${r.issues.length} issue(s) found${r.truncated ? ' (lists capped at 500 per check)' : ''}.`
          : 'No problems found.')
      );
    });
  }

  issueLabel(issue: TopologyIssue): string {
    return CHECK_LABELS[issue.check];
  }

  issueColor(issue: TopologyIssue): string {
    return CHECK_COLORS[issue.check];
  }

  zoomTo(issue: TopologyIssue): void {
    if (issue.geometry) this.mapService.zoomToGeometries([issue.geometry]);
  }

  fix(kind: 'invalid' | 'duplicates' | 'empty'): void {
    const layerId = this.layerId();
    if (!layerId) return;
    this.run(this.api.fix(layerId, kind), (r) => {
      this.mapService.refreshLayerStyle(layerId);
      this.runValidate(`${r.fixed} feature(s) ${kind === 'invalid' ? 'repaired' : 'removed'}. `);
    });
  }

  hasCount(check: TopologyIssue['check']): boolean {
    return this.issueCounts().some((c) => c.check === check);
  }

  // ----- Rules -----

  updateRule(index: number, patch: Partial<RuleRow>): void {
    this.ruleRows.update((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  isNumeric(type: string): boolean {
    return ['integer', 'bigint', 'smallint', 'numeric', 'double precision', 'real'].includes(type);
  }

  saveRules(): void {
    const layerId = this.layerId();
    if (!layerId) return;
    const rules = this.ruleRows().map((r) => ({
      field: r.field,
      required: r.required,
      values: r.valuesText
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
      ...(r.min !== null && Number.isFinite(r.min) ? { min: r.min } : {}),
      ...(r.max !== null && Number.isFinite(r.max) ? { max: r.max } : {})
    }));
    this.run(this.api.setFieldRules(layerId, rules), (r) =>
      this.notice.set(`Saved rules for ${Object.keys(r.rules).length} field(s). The Edit panel enforces them from now on.`)
    );
  }

  // ----- Versions -----

  createSnapshot(): void {
    const layerId = this.layerId();
    if (!layerId) return;
    const name = this.snapshotName.trim() || `Snapshot ${new Date().toLocaleString()}`;
    this.run(this.api.createSnapshot(layerId, name), (row) => {
      this.snapshots.update((rows) => [row, ...(rows ?? [])]);
      this.snapshotName = '';
      this.notice.set(`Saved "${row.name}" (${row.featureCount} features).`);
    });
  }

  compare(snapshot: LayerSnapshot): void {
    const layerId = this.layerId();
    if (!layerId) return;
    this.run(this.api.compare(layerId, snapshot.id, this.compareKey ?? undefined), (r) => {
      this.comparison.set(r);
      const items = [
        ...r.added.features.map((f) => ({ geometry: f.geometry, color: '#16a34a' })),
        ...r.removed.features.map((f) => ({ geometry: f.geometry, color: '#dc2626' })),
        ...r.modified.features.map((f) => ({ geometry: f.geometry, color: '#ea580c' }))
      ].filter((i): i is { geometry: Record<string, unknown>; color: string } => !!i.geometry);
      this.mapService.setAnalysisColoredGeometries(items);
      if (items.length) this.mapService.zoomToGeometries(items.map((i) => i.geometry));
    });
  }

  restore(snapshot: LayerSnapshot): void {
    const layerId = this.layerId();
    if (!layerId) return;
    if (this.confirmRestore() !== snapshot.id) {
      this.confirmRestore.set(snapshot.id);
      return;
    }
    this.confirmRestore.set(null);
    this.run(this.api.restore(layerId, snapshot.id), () => {
      this.mapService.refreshLayerStyle(layerId);
      this.notice.set(`Restored "${snapshot.name}". The data before the restore was saved as a version.`);
      this.snapshots.set(null);
      this.loadForTool();
    });
  }

  deleteSnapshot(snapshot: LayerSnapshot): void {
    const layerId = this.layerId();
    if (!layerId) return;
    this.run(this.api.deleteSnapshot(layerId, snapshot.id), () =>
      this.snapshots.update((rows) => rows?.filter((r) => r.id !== snapshot.id) ?? null)
    );
  }

  zoomToChange(geometry: Record<string, unknown> | null): void {
    if (geometry) this.mapService.zoomToGeometries([geometry]);
  }

  // ----- shared -----

  private run<T>(request: Observable<T>, onResult: (result: T) => void): void {
    this.running.set(true);
    this.error.set(null);
    this.notice.set(null);
    request.subscribe({
      next: (result) => {
        this.running.set(false);
        onResult(result);
      },
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  private fail(err: HttpErrorResponse): void {
    this.running.set(false);
    const message = err.error?.message;
    this.error.set(Array.isArray(message) ? message.join(' ') : (message ?? 'The request failed.'));
  }
}

/** Header row of a CSV (quoted names, comma or semicolon separated). */
function csvHeader(text: string): string[] {
  const line = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (line.match(/;/g)?.length ?? 0) > (line.match(/,/g)?.length ?? 0) ? ';' : ',';
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      out.push(field.trim());
      field = '';
    } else field += c;
  }
  out.push(field.trim());
  return out.filter(Boolean);
}
