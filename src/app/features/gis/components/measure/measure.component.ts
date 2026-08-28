import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { MapService, MeasureDrawType, MeasureResult } from '../../services/map.service';
import {
  AREA_UNITS,
  AreaUnit,
  LENGTH_UNITS,
  LengthUnit,
  MeasureKind,
  formatArea,
  formatLength
} from '../../services/measure-units';

interface ResultRow {
  label: string;
  value: string;
}

/**
 * Measurement Tool — Distance / Area (+ Perimeter) / Radius-Circle, in the
 * GIS left dock. All maths is geodesic (`ol/sphere` via `MapService`);
 * this component only chooses the mode + units and formats the live result.
 *
 * Reusable: `MapService.startMeasure` and `measure-units.ts` are generic —
 * a future bearing / elevation-profile tool can reuse both. Adding a
 * measurement mode here is a new `KINDS` entry + a `case` in `resultRows`.
 */
@Component({
  selector: 'app-measure',
  standalone: true,
  imports: [FormsModule, ButtonModule, SelectModule],
  templateUrl: './measure.component.html',
  styleUrl: './measure.component.scss'
})
export class MeasureComponent implements OnInit, OnDestroy {
  private readonly mapService = inject(MapService);

  readonly kinds: { value: MeasureKind; label: string }[] = [
    { value: 'distance', label: 'Distance' },
    { value: 'area', label: 'Area' },
    { value: 'radius', label: 'Radius / Circle' }
  ];
  readonly lengthUnits = LENGTH_UNITS;
  readonly areaUnits = AREA_UNITS;

  readonly kind = signal<MeasureKind>('distance');
  readonly lengthUnit = signal<LengthUnit>('m');
  readonly areaUnit = signal<AreaUnit>('m2');
  readonly result = signal<MeasureResult | null>(null);
  readonly drawing = signal(false);

  readonly showAreaUnit = computed(() => this.kind() === 'area' || this.kind() === 'radius');

  readonly resultRows = computed<ResultRow[]>(() => {
    const result = this.result();
    if (!result) return [];
    const len = (metres: number) => formatLength(metres, this.lengthUnit());
    const area = (sq: number) => formatArea(sq, this.areaUnit());

    if (result.type === 'Polygon') {
      return [
        { label: 'Area', value: result.areaM2 != null ? area(result.areaM2) : '—' },
        { label: 'Perimeter', value: len(result.lengthM) }
      ];
    }
    if (result.type === 'Circle') {
      return [
        { label: 'Radius', value: result.radiusM != null ? len(result.radiusM) : '—' },
        { label: 'Diameter', value: result.radiusM != null ? len(result.radiusM * 2) : '—' },
        { label: 'Circumference', value: len(result.lengthM) },
        { label: 'Area', value: result.areaM2 != null ? area(result.areaM2) : '—' }
      ];
    }
    return [{ label: 'Total distance', value: len(result.lengthM) }];
  });

  readonly segments = computed(() => {
    const result = this.result();
    if (!result || result.type === 'Circle' || result.segmentsM.length < 2) return [];
    return result.segmentsM.map((metres, index) => ({
      index: index + 1,
      value: formatLength(metres, this.lengthUnit())
    }));
  });

  ngOnInit(): void {
    // Suppress Identify feature-info popups for the whole time this tool is
    // open — a map click while measuring should only measure.
    this.mapService.setMeasureMode(true);
    this.start();
  }

  ngOnDestroy(): void {
    this.mapService.setMeasureMode(false);
    this.mapService.clearMeasure();
  }

  onKindChange(kind: MeasureKind): void {
    this.kind.set(kind);
    this.start();
  }

  /** (Re)starts drawing for the current measurement mode. */
  start(): void {
    this.mapService.clearMeasure();
    this.result.set(null);
    this.drawing.set(true);
    this.mapService.startMeasure(
      this.drawType(),
      (result) => this.result.set(result),
      (result) => {
        this.result.set(result);
        this.drawing.set(false);
      }
    );
  }

  clear(): void {
    this.mapService.clearMeasure();
    this.result.set(null);
    this.drawing.set(false);
  }

  private drawType(): MeasureDrawType {
    switch (this.kind()) {
      case 'area':
        return 'Polygon';
      case 'radius':
        return 'Circle';
      default:
        return 'LineString';
    }
  }

  get drawHint(): string {
    switch (this.kind()) {
      case 'area':
        return 'Click to add polygon points, double-click to finish.';
      case 'radius':
        return 'Click the centre, then click again to set the radius.';
      default:
        return 'Click to add points, double-click to finish.';
    }
  }
}
