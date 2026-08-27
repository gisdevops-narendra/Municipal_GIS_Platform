/**
 * Pure unit conversion + formatting for the Measurement Tool. No OpenLayers,
 * no Angular — all measurement maths that isn't geometry lives here so it is
 * testable and reusable by future measurement features (elevation profiles,
 * bearing, coordinate readouts, …).
 *
 * Inputs are always SI (metres / square metres) as returned by
 * `ol/sphere` — this module only converts and labels them.
 */

export type MeasureKind = 'distance' | 'area' | 'radius';

export type LengthUnit = 'm' | 'km' | 'ft' | 'mi';
export type AreaUnit = 'm2' | 'ha' | 'km2' | 'ft2' | 'ac';

export interface UnitOption<T> {
  value: T;
  label: string;
}

export const LENGTH_UNITS: UnitOption<LengthUnit>[] = [
  { value: 'm', label: 'metres' },
  { value: 'km', label: 'kilometres' },
  { value: 'ft', label: 'feet' },
  { value: 'mi', label: 'miles' }
];

export const AREA_UNITS: UnitOption<AreaUnit>[] = [
  { value: 'm2', label: 'square metres' },
  { value: 'ha', label: 'hectares' },
  { value: 'km2', label: 'square kilometres' },
  { value: 'ft2', label: 'square feet' },
  { value: 'ac', label: 'acres' }
];

const METRES_PER: Record<LengthUnit, number> = {
  m: 1,
  km: 1000,
  ft: 0.3048,
  mi: 1609.344
};

const SQ_METRES_PER: Record<AreaUnit, number> = {
  m2: 1,
  ha: 10_000,
  km2: 1_000_000,
  ft2: 0.09290304,
  ac: 4046.8564224
};

const LENGTH_SUFFIX: Record<LengthUnit, string> = { m: 'm', km: 'km', ft: 'ft', mi: 'mi' };
const AREA_SUFFIX: Record<AreaUnit, string> = { m2: 'm²', ha: 'ha', km2: 'km²', ft2: 'ft²', ac: 'ac' };

export function convertLength(metres: number, unit: LengthUnit): number {
  return metres / METRES_PER[unit];
}

/** Inverse of `convertLength` — a value in `unit` expressed in metres. */
export function toMetres(value: number, unit: LengthUnit): number {
  return value * METRES_PER[unit];
}

export function convertArea(squareMetres: number, unit: AreaUnit): number {
  return squareMetres / SQ_METRES_PER[unit];
}

function trim(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  const decimals = abs >= 100 ? 0 : abs >= 1 ? 2 : 3;
  return value.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

export function formatLength(metres: number, unit: LengthUnit): string {
  return `${trim(convertLength(metres, unit))} ${LENGTH_SUFFIX[unit]}`;
}

export function formatArea(squareMetres: number, unit: AreaUnit): string {
  return `${trim(convertArea(squareMetres, unit))} ${AREA_SUFFIX[unit]}`;
}

/** A short label for a live map tooltip — kept terse. */
export function tooltipLabel(
  kind: MeasureKind,
  totals: { lengthM?: number; areaM2?: number; radiusM?: number },
  lengthUnit: LengthUnit,
  areaUnit: AreaUnit
): string {
  if (kind === 'area' && totals.areaM2 != null) {
    return formatArea(totals.areaM2, areaUnit);
  }
  if (kind === 'radius' && totals.radiusM != null) {
    return `r ${formatLength(totals.radiusM, lengthUnit)}`;
  }
  if (totals.lengthM != null) {
    return formatLength(totals.lengthM, lengthUnit);
  }
  return '';
}
