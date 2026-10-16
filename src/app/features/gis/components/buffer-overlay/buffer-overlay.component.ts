import { Component, EventEmitter, Input, OnDestroy, Output, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription, forkJoin, of, switchMap } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { GeoJsonGeometry } from '../../models/attribute-table.model';
import { AttributeExternalFilter } from '../attribute-table/attribute-table.component';
import { MapService, RING_COLORS } from '../../services/map.service';
import { WpsService, BufferCap, OverlayOp } from '../../services/wps.service';
import { QueryService } from '../../services/query.service';
import { AttributeTableService } from '../../services/attribute-table.service';
import { LENGTH_UNITS, LengthUnit, toMetres } from '../../services/measure-units';
import { IMPACT_REPORT_MODULE_ID, VectorToolsService } from '../../services/vector-tools.service';
import { GisLayersService } from '../../../../core/services/gis-layers.service';
import { downloadBlob } from '../../../../core/utils/download-blob';

type Mode = 'buffer' | 'overlay';
type OverlayOperation = 'intersection' | 'union' | 'difference' | 'clip';
type Slot = 'buffer' | 'a' | 'b';
type GeomKind = 'Point' | 'Line' | 'Polygon';

const MAP_PROJ = 'EPSG:3857';
/** Module Access catalog id of MultiBuffer (seed-modules.ts). */
const MULTIBUFFER_MODULE_ID = 187;
/** Module Access catalog id of Overlay (intersect / union / ...). */
const OVERLAY_MODULE_ID = 963;
const MAX_RINGS = 6;
const GEO_PROJ = 'EPSG:4326';

/**
 * Municipal Buffer & Overlay tools — server-side GIS processing via
 * GeoServer WPS (`WpsService`), in the GIS left dock.
 *
 * The panel only assembles operands (a drawn shape, the current selection,
 * or a whole layer's dissolved geometry) and calls one WPS method. Results
 * render on the map's analysis overlay and — optionally — drive the
 * Attribute Table via the same "affected features" filter the Query Builder
 * uses. Adding an operation (convex hull, simplify, voronoi) is a
 * `WpsService` method + a `case` here.
 */
@Component({
  selector: 'app-buffer-overlay',
  standalone: true,
  imports: [FormsModule, ButtonModule, SelectModule, InputTextModule, MessageModule],
  templateUrl: './buffer-overlay.component.html',
  styleUrl: './buffer-overlay.component.scss'
})
export class BufferOverlayComponent implements OnDestroy {
  private readonly mapService = inject(MapService);
  private readonly wps = inject(WpsService);
  private readonly queryService = inject(QueryService);
  private readonly attributes = inject(AttributeTableService);

  /** Signal-backed so `layerOptions` recomputes when the list arrives or
   *  changes (a plain field is read once by `computed()` and cached). */
  @Input() set layers(value: GisLayer[]) {
    this.layersSignal.set(value ?? []);
  }
  get layers(): GisLayer[] {
    return this.layersSignal();
  }
  private readonly layersSignal = signal<GisLayer[]>([]);

  /** Module Access ids granted to the current user — MultiBuffer (multiple
   *  rings) is offered only with its own module. */
  @Input() set allowedModuleIds(value: ReadonlySet<number>) {
    this.allowedSignal.set(value ?? new Set());
  }
  private readonly allowedSignal = signal<ReadonlySet<number>>(new Set());
  readonly multiRingAllowed = computed(() => this.allowedSignal().has(MULTIBUFFER_MODULE_ID));
  readonly overlayAllowed = computed(() => this.allowedSignal().has(OVERLAY_MODULE_ID));
  readonly impactAllowed = computed(() => this.allowedSignal().has(IMPACT_REPORT_MODULE_ID));
  @Output() queryRun = new EventEmitter<AttributeExternalFilter>();
  @Output() queryCleared = new EventEmitter<void>();

  /** False while the panel is kept mounted but hidden. Operands and results
   *  persist; only a live draw interaction is cancelled. */
  private isActive = true;
  @Input() set active(value: boolean) {
    if (value === this.isActive) return;
    this.isActive = value;
    if (!value && this.drawing()) {
      this.drawSub?.unsubscribe();
      this.mapService.cancelDraw();
      this.drawing.set(null);
    }
  }

  readonly lengthUnits = LENGTH_UNITS;
  readonly geomKinds: GeomKind[] = ['Polygon', 'Line', 'Point'];
  readonly operations: { value: OverlayOperation; label: string; hint: string }[] = [
    { value: 'intersection', label: 'Intersection', hint: 'The area shared by A and B' },
    { value: 'union', label: 'Union', hint: 'The combined area of A and B' },
    { value: 'difference', label: 'Difference', hint: 'A with the part of B removed' },
    { value: 'clip', label: 'Clip', hint: 'A clipped to the outline of B' }
  ];

  readonly mode = signal<Mode>('buffer');

  // ----- buffer -----
  readonly bufferGeom = signal<GeoJsonGeometry | null>(null);
  bufferDistance = 500;
  readonly bufferUnit = signal<LengthUnit>('m');
  readonly bufferCap = signal<BufferCap>('round');
  /** MultiBuffer: several distances at once, drawn as concentric bands. */
  readonly multiRing = signal(false);
  ringDistancesText = '100, 250, 500';
  readonly ringResults = signal<{ label: string; color: string; count: number | null }[] | null>(null);

  // ----- overlay -----
  readonly overlayOp = signal<OverlayOperation>('intersection');
  readonly operandA = signal<GeoJsonGeometry | null>(null);
  readonly operandB = signal<GeoJsonGeometry | null>(null);
  readonly operandBLayer = signal<string | null>(null);

  // ----- shared -----
  readonly targetLayerId = signal<string | null>(null);
  readonly drawing = signal<Slot | null>(null);
  readonly running = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<{ empty: boolean; affected: number | null } | null>(null);
  /** Impact Report source: the last run's affected-features area. */
  private readonly impact = signal<{
    layerId: string;
    layerName: string;
    geometry: Record<string, unknown>;
    distance: number;
    cql: string;
    label: string;
  } | null>(null);
  readonly canExportImpact = computed(() => this.impactAllowed() && !!this.impact());
  readonly impactBusy = signal<'csv' | 'pdf' | null>(null);
  private readonly vectorTools = inject(VectorToolsService);
  private readonly gisLayers = inject(GisLayersService);

  private drawSub?: Subscription;

  readonly layerOptions = computed(() =>
    this.layers.filter((l) => l.layerType === 'VECTOR').map((l) => ({ label: l.name, value: l.id }))
  );

  readonly opHint = computed(() => this.operations.find((o) => o.value === this.overlayOp())?.hint ?? '');
  readonly selection = this.mapService.selectionGeometries;

  ngOnDestroy(): void {
    this.drawSub?.unsubscribe();
    this.mapService.cancelDraw();
  }

  setMode(mode: Mode): void {
    this.mode.set(mode);
    this.error.set(null);
    this.result.set(null);
    this.impact.set(null);
  }

  // ----- operand capture -----

  draw(kind: GeomKind, slot: Slot): void {
    this.drawing.set(slot);
    this.error.set(null);
    this.drawSub?.unsubscribe();
    this.drawSub = this.mapService.beginDraw(kind).subscribe({
      next: (geometry) => this.setOperand(slot, geometry as GeoJsonGeometry),
      complete: () => this.drawing.set(null)
    });
  }

  cancelDraw(): void {
    this.mapService.cancelDraw();
    this.drawing.set(null);
  }

  useSelection(slot: Slot): void {
    const geometries = this.mapService.selectionGeometries();
    if (geometries.length === 0) {
      this.error.set('Select one or more features on the map / attribute table first.');
      return;
    }
    const geometry =
      geometries.length === 1
        ? (geometries[0] as GeoJsonGeometry)
        : ({ type: 'GeometryCollection', geometries } as unknown as GeoJsonGeometry);
    this.setOperand(slot, geometry);
  }

  clearOperand(slot: Slot): void {
    this.setOperand(slot, null);
  }

  private setOperand(slot: Slot, geometry: GeoJsonGeometry | null): void {
    if (slot === 'buffer') this.bufferGeom.set(geometry);
    else if (slot === 'a') this.operandA.set(geometry);
    else this.operandB.set(geometry);
    this.drawing.set(null);
  }

  operandLabel(geometry: GeoJsonGeometry | null): string {
    return geometry ? (geometry['type'] as string) : 'not set';
  }

  // ----- run -----

  runBuffer(): void {
    const geometry = this.bufferGeom();
    if (!geometry) {
      this.error.set('Draw a geometry or use the current selection first.');
      return;
    }
    if (this.multiRing() && this.multiRingAllowed()) {
      this.runMultiBuffer(geometry);
      return;
    }
    if (!(this.bufferDistance > 0)) {
      this.error.set('Enter a buffer distance greater than zero.');
      return;
    }
    this.begin();
    const wkt = this.mapService.wktFromGeoJson(geometry, GEO_PROJ, MAP_PROJ);
    const metres = toMetres(this.bufferDistance, this.bufferUnit());
    const latitude = this.mapService.centreLatitude(geometry);

    this.wps.buffer(wkt, metres, latitude, this.bufferCap()).subscribe({
      next: (result3857) => this.handleResult(result3857),
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  runOverlay(): void {
    const a = this.operandA();
    if (!a) {
      this.error.set('Set operand A (draw or use the selection).');
      return;
    }
    this.begin();
    const wktA = this.mapService.wktFromGeoJson(a, GEO_PROJ, MAP_PROJ);
    const op = (this.overlayOp() === 'clip' ? 'intersection' : this.overlayOp()) as OverlayOp;

    this.operandBWkt()
      .pipe(
        switchMap((wktB) => {
          if (!wktB) {
            this.error.set('Set operand B (draw, use the selection, or choose a layer).');
            this.running.set(false);
            return of<GeoJsonGeometry | null>(null);
          }
          return this.wps.overlay(op, wktA, wktB);
        })
      )
      .subscribe({
        next: (result3857) => {
          if (!this.running()) return; // stopped by the validation branch above
          this.handleResult(result3857);
        },
        error: (err: HttpErrorResponse) => this.fail(err)
      });
  }

  private operandBWkt() {
    const layerId = this.operandBLayer();
    if (layerId) {
      const layer = this.layers.find((l) => l.id === layerId);
      if (!layer) return of<string | null>(null);
      return this.queryService.layerGeometries(layer).pipe(
        switchMap((geoms) => {
          if (geoms.length === 0) return of<string | null>(null);
          const wkts = geoms.map((g) => this.mapService.wktFromGeoJson(g, GEO_PROJ, MAP_PROJ));
          if (wkts.length === 1) return of(wkts[0]);
          return this.wps.union(wkts).pipe(
            switchMap((unioned) =>
              of(unioned ? this.mapService.wktFromGeoJson(unioned as Record<string, unknown>, MAP_PROJ, MAP_PROJ) : null)
            )
          );
        })
      );
    }
    const b = this.operandB();
    return of(b ? this.mapService.wktFromGeoJson(b, GEO_PROJ, MAP_PROJ) : null);
  }

  private handleResult(result3857: GeoJsonGeometry | null): void {
    if (!result3857 || this.isEmpty(result3857)) {
      this.mapService.clearAnalysisGeometry();
      this.result.set({ empty: true, affected: null });
      this.running.set(false);
      return;
    }
    const result4326 = this.mapService.reprojectGeoJson(
      result3857 as Record<string, unknown>,
      MAP_PROJ,
      GEO_PROJ
    );
    this.mapService.setAnalysisGeometry(result4326);
    this.mapService.zoomToGeometries([result4326]);

    const targetId = this.targetLayerId();
    const target = targetId ? this.layers.find((l) => l.id === targetId) : null;
    if (!target) {
      this.result.set({ empty: false, affected: null });
      this.running.set(false);
      this.queryCleared.emit();
      return;
    }

    // "affected features": features of the target layer intersecting the result
    this.attributes.loadMetadata(target).subscribe({
      next: ({ geometryField }) => {
        const wkt4326 = this.mapService.wktFromGeoJson(result4326, GEO_PROJ, GEO_PROJ);
        const cql = `INTERSECTS("${geometryField}", SRID=4326;${wkt4326})`;
        this.queryService.execute(target, cql).subscribe({
          next: (execution) => {
            this.result.set({ empty: false, affected: execution.total });
            this.running.set(false);
            const label = `${target.name} · ${this.mode() === 'buffer' ? 'buffer' : this.overlayOp()}`;
            this.impact.set({ layerId: target.id, layerName: target.name, geometry: result4326, distance: 0, cql, label });
            this.queryRun.emit({ layerId: target.id, cql, label });
          },
          error: (err: HttpErrorResponse) => this.fail(err)
        });
      },
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  /** One WPS buffer per distance (in parallel), then — with a target
   *  layer — a feature count per band: within distance i of the input but
   *  not within distance i-1. Bands are counted with DWITHIN on the small
   *  input geometry rather than INTERSECTS on the ring polygons, which
   *  would push two ~100-vertex polygons per band into the WFS GET URL and
   *  overflow GeoServer's request-line limit. */
  private runMultiBuffer(geometry: GeoJsonGeometry): void {
    const distances = parseRingDistances(this.ringDistancesText);
    if (typeof distances === 'string') {
      this.error.set(distances);
      return;
    }
    this.begin();
    const unit = this.bufferUnit();
    const wkt = this.mapService.wktFromGeoJson(geometry, GEO_PROJ, MAP_PROJ);
    const latitude = this.mapService.centreLatitude(geometry);
    forkJoin(distances.map((d) => this.wps.buffer(wkt, toMetres(d, unit), latitude, this.bufferCap()))).subscribe({
      next: (results3857) => this.handleRings(geometry, distances, results3857),
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  private handleRings(input: GeoJsonGeometry, distances: number[], results3857: (GeoJsonGeometry | null)[]): void {
    if (results3857.some((r) => !r || this.isEmpty(r))) {
      this.mapService.clearAnalysisGeometry();
      this.result.set({ empty: true, affected: null });
      this.running.set(false);
      return;
    }
    const rings = results3857.map((r) =>
      this.mapService.reprojectGeoJson(r as Record<string, unknown>, MAP_PROJ, GEO_PROJ)
    );
    this.mapService.setAnalysisRings(rings);
    this.mapService.zoomToGeometries([rings[rings.length - 1]]);

    const unit = this.bufferUnit();
    this.ringResults.set(
      distances.map((d, i) => ({
        label: `${i === 0 ? 0 : distances[i - 1]}–${d} ${unit}`,
        color: RING_COLORS[Math.min(i, RING_COLORS.length - 1)],
        count: null
      }))
    );

    const targetId = this.targetLayerId();
    const target = targetId ? this.layers.find((l) => l.id === targetId) : null;
    if (!target) {
      this.result.set({ empty: false, affected: null });
      this.running.set(false);
      this.queryCleared.emit();
      return;
    }

    this.attributes.loadMetadata(target).subscribe({
      next: ({ geometryField }) => {
        const origin = `SRID=4326;${this.mapService.wktFromGeoJson(input, GEO_PROJ, GEO_PROJ)}`;
        const inside = distances.map(
          (d) => `DWITHIN("${geometryField}", ${origin}, ${toMetres(d, unit)}, meters)`
        );
        const bandCql = inside.map((cql, i) => (i === 0 ? cql : `${cql} AND NOT ${inside[i - 1]}`));
        forkJoin(bandCql.map((cql) => this.queryService.execute(target, cql))).subscribe({
          next: (executions) => {
            const counts = executions.map((e) => e.total);
            this.ringResults.update((bands) => bands?.map((band, i) => ({ ...band, count: counts[i] })) ?? null);
            this.result.set({ empty: false, affected: counts.reduce((sum, c) => sum + c, 0) });
            this.running.set(false);
            this.impact.set({
              layerId: target.id,
              layerName: target.name,
              geometry: input as Record<string, unknown>,
              distance: toMetres(Math.max(...distances), unit),
              cql: inside[inside.length - 1],
              label: `${target.name} · multibuffer`
            });
            this.queryRun.emit({
              layerId: target.id,
              cql: inside[inside.length - 1],
              label: `${target.name} · multibuffer`
            });
          },
          error: (err: HttpErrorResponse) => this.fail(err)
        });
      },
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  /** Impact Report: affected features (attributes, distance, location) as CSV. */
  downloadImpactCsv(): void {
    const impact = this.impact();
    if (!impact) return;
    this.impactBusy.set('csv');
    this.vectorTools.impactCsv(impact.layerId, impact.geometry, impact.distance).subscribe({
      next: (blob) => {
        this.impactBusy.set(null);
        downloadBlob(blob, `${impact.layerName.replace(/[^\w-]+/g, '_')}_impact.csv`);
      },
      error: (err: HttpErrorResponse) => {
        this.impactBusy.set(null);
        this.fail(err);
      }
    });
  }

  /** Impact Report: the existing layer PDF report, scoped to the affected features. */
  downloadImpactPdf(): void {
    const impact = this.impact();
    if (!impact) return;
    this.impactBusy.set('pdf');
    this.gisLayers
      .analyticsFields(impact.layerId)
      .pipe(
        switchMap((fields) =>
          this.gisLayers.report(impact.layerId, {
            title: `Impact report — ${impact.layerName}`,
            fields: fields.filter((f) => f.kind !== 'geometry').slice(0, 10).map((f) => f.name),
            scope: 'query',
            cqlFilter: impact.cql,
            scopeLabel: impact.label
          })
        )
      )
      .subscribe({
        next: (blob) => {
          this.impactBusy.set(null);
          downloadBlob(blob, `${impact.layerName.replace(/[^\w-]+/g, '_')}_impact.pdf`);
        },
        error: (err: HttpErrorResponse) => {
          this.impactBusy.set(null);
          this.fail(err);
        }
      });
  }

  clear(): void {
    this.impact.set(null);
    this.ringResults.set(null);
    this.mapService.clearAnalysisGeometry();
    this.mapService.clearDraw();
    this.bufferGeom.set(null);
    this.operandA.set(null);
    this.operandB.set(null);
    this.operandBLayer.set(null);
    this.result.set(null);
    this.error.set(null);
    this.drawing.set(null);
    this.queryCleared.emit();
  }

  private begin(): void {
    this.ringResults.set(null);
    this.running.set(true);
    this.error.set(null);
    this.result.set(null);
    this.mapService.clearAnalysisGeometry();
  }

  private fail(err: HttpErrorResponse): void {
    this.running.set(false);
    this.result.set(null);
    this.error.set(
      err.status === 0
        ? 'Could not reach the GIS processing service.'
        : `The GIS processing service returned an error (${err.status || 'unknown'}).`
    );
  }

  private isEmpty(geometry: GeoJsonGeometry): boolean {
    const type = geometry['type'] as string;
    if (type === 'GeometryCollection') {
      return ((geometry['geometries'] as unknown[]) ?? []).length === 0;
    }
    return this.flatLen(geometry['coordinates']) === 0;
  }

  private flatLen(value: unknown): number {
    if (typeof value === 'number') return 1;
    if (Array.isArray(value)) return value.reduce((sum: number, v) => sum + this.flatLen(v), 0);
    return 0;
  }
}

/** "100, 250 500" → [100, 250, 500]: positive, de-duplicated, ascending,
 *  2..MAX_RINGS values. Returns an error message instead when invalid. */
export function parseRingDistances(text: string): number[] | string {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  const values = parts.map(Number);
  if (values.some((v) => !Number.isFinite(v) || v <= 0)) {
    return 'Ring distances must be positive numbers, e.g. "100, 250, 500".';
  }
  const unique = [...new Set(values)].sort((a, b) => a - b);
  if (unique.length < 2) {
    return 'Enter at least two different ring distances.';
  }
  if (unique.length > MAX_RINGS) {
    return `Enter at most ${MAX_RINGS} ring distances.`;
  }
  return unique;
}
