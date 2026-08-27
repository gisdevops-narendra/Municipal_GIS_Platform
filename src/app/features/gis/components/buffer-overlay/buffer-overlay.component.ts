import { Component, EventEmitter, Input, OnDestroy, Output, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription, of, switchMap } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { GeoJsonGeometry } from '../../models/attribute-table.model';
import { AttributeExternalFilter } from '../attribute-table/attribute-table.component';
import { MapService } from '../../services/map.service';
import { WpsService, BufferCap, OverlayOp } from '../../services/wps.service';
import { QueryService } from '../../services/query.service';
import { AttributeTableService } from '../../services/attribute-table.service';
import { LENGTH_UNITS, LengthUnit, toMetres } from '../../services/measure-units';

type Mode = 'buffer' | 'overlay';
type OverlayOperation = 'intersection' | 'union' | 'difference' | 'clip';
type Slot = 'buffer' | 'a' | 'b';
type GeomKind = 'Point' | 'Line' | 'Polygon';

const MAP_PROJ = 'EPSG:3857';
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

  @Input() layers: GisLayer[] = [];
  @Output() queryRun = new EventEmitter<AttributeExternalFilter>();
  @Output() queryCleared = new EventEmitter<void>();

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
            this.queryRun.emit({
              layerId: target.id,
              cql,
              label: `${target.name} · ${this.mode() === 'buffer' ? 'buffer' : this.overlayOp()}`
            });
          },
          error: (err: HttpErrorResponse) => this.fail(err)
        });
      },
      error: (err: HttpErrorResponse) => this.fail(err)
    });
  }

  clear(): void {
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
