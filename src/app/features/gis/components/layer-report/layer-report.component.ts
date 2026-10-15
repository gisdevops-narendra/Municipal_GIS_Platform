import { Component, Input, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { AnalyticsField } from '../../../../core/models/layer-analytics.model';
import { GisLayersService, LayerReportRequest } from '../../../../core/services/gis-layers.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { blobErrorMessage, downloadBlob } from '../../../../core/utils/download-blob';
import { AttributeExternalFilter } from '../attribute-table/attribute-table.component';

/** The Attribute Table's current selection, as published to the workspace. */
export interface TableSelection {
  layerId: string;
  featureIds: string[];
}

type Scope = 'layer' | 'query' | 'selection';

const MAX_FIELDS = 10;
const DEFAULT_FIELDS = 6;

/**
 * Report Generation — a layer data report as a PDF (title, layer details,
 * summary statistics, feature table), built server-side
 * (POST /api/gis/layers/:id/report, VIEW-gated). The scope can be the whole
 * layer, the Attribute Table's current query, or its current selection.
 */
@Component({
  selector: 'app-layer-report',
  standalone: true,
  imports: [FormsModule, ButtonModule, SelectModule, InputTextModule],
  templateUrl: './layer-report.component.html',
  styleUrl: './layer-report.component.scss'
})
export class LayerReportComponent {
  private readonly gisLayersService = inject(GisLayersService);
  private readonly notify = inject(NotificationService);

  @Input() set layers(value: GisLayer[]) {
    this.layersSignal.set(value ?? []);
    this.ensureLayer();
  }
  private readonly layersSignal = signal<GisLayer[]>([]);

  @Input() set queryFilter(value: AttributeExternalFilter | null) {
    this.querySignal.set(value);
  }
  private readonly querySignal = signal<AttributeExternalFilter | null>(null);

  @Input() set selection(value: TableSelection | null) {
    this.selectionSignal.set(value);
  }
  private readonly selectionSignal = signal<TableSelection | null>(null);

  readonly maxFields = MAX_FIELDS;
  readonly layerId = signal<string | null>(null);
  readonly fields = signal<AnalyticsField[]>([]);
  readonly chosen = signal<Set<string>>(new Set());
  readonly scope = signal<Scope>('layer');
  title = '';
  readonly loadingFields = signal(false);
  readonly generating = signal(false);
  readonly error = signal<string | null>(null);

  readonly layerOptions = computed(() =>
    this.layersSignal()
      .filter((l) => l.layerType === 'VECTOR')
      .map((l) => ({ label: l.name, value: l.id }))
  );
  readonly layer = computed(() => this.layersSignal().find((l) => l.id === this.layerId()) ?? null);

  /** The query / selection only count when they belong to the chosen layer. */
  readonly queryForLayer = computed(() => {
    const q = this.querySignal();
    return q && q.layerId === this.layerId() ? q : null;
  });
  readonly selectionForLayer = computed(() => {
    const s = this.selectionSignal();
    return s && s.layerId === this.layerId() && s.featureIds.length > 0 ? s : null;
  });

  /** Falls back to the whole layer when the chosen scope is no longer available. */
  readonly effectiveScope = computed((): Scope => {
    const scope = this.scope();
    if (scope === 'query' && !this.queryForLayer()) return 'layer';
    if (scope === 'selection' && !this.selectionForLayer()) return 'layer';
    return scope;
  });

  readonly chosenList = computed(() => this.fields().filter((f) => this.chosen().has(f.name)).map((f) => f.name));
  readonly atLimit = computed(() => this.chosen().size >= MAX_FIELDS);

  selectLayer(id: string | null): void {
    this.layerId.set(id);
    this.fields.set([]);
    this.chosen.set(new Set());
    this.error.set(null);
    if (!id) return;
    this.loadingFields.set(true);
    this.gisLayersService.analyticsFields(id).subscribe({
      next: (fields) => {
        if (this.layerId() !== id) return;
        this.fields.set(fields);
        this.chosen.set(new Set(fields.slice(0, DEFAULT_FIELDS).map((f) => f.name)));
        this.loadingFields.set(false);
      },
      error: async (err: HttpErrorResponse) => {
        this.loadingFields.set(false);
        this.error.set(await blobErrorMessage(err, 'Could not load the fields of this layer.'));
      }
    });
  }

  toggleField(name: string, on: boolean): void {
    const next = new Set(this.chosen());
    if (on && next.size < MAX_FIELDS) next.add(name);
    if (!on) next.delete(name);
    this.chosen.set(next);
  }

  generate(): void {
    const layer = this.layer();
    const fields = this.chosenList();
    if (!layer || fields.length === 0 || this.generating()) return;
    const scope = this.effectiveScope();
    const request: LayerReportRequest = { fields, scope, title: this.title.trim() || undefined };
    if (scope === 'query') {
      const q = this.queryForLayer()!;
      request.cqlFilter = q.cql;
      request.scopeLabel = q.label;
    } else if (scope === 'selection') {
      request.featureIds = this.selectionForLayer()!.featureIds;
    }

    this.generating.set(true);
    this.error.set(null);
    this.gisLayersService.report(layer.id, request).subscribe({
      next: (blob) => {
        this.generating.set(false);
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        downloadBlob(blob, `${layer.code.toLowerCase()}-report-${stamp}.pdf`);
        this.notify.success(`Report for "${layer.name}" generated.`);
      },
      error: async (err: HttpErrorResponse) => {
        this.generating.set(false);
        this.error.set(
          err.status === 403
            ? 'You do not have permission to report on this layer.'
            : await blobErrorMessage(err, 'Could not generate the report. Please try again.')
        );
      }
    });
  }

  private ensureLayer(): void {
    const options = this.layersSignal().filter((l) => l.layerType === 'VECTOR');
    if (options.length && !options.some((l) => l.id === this.layerId())) {
      this.selectLayer(options[0].id);
    }
  }
}
