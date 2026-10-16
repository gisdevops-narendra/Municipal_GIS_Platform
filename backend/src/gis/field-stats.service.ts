import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isSafeGeneratedTableName } from './layer-naming.util';
import { equalIntervalBreaks } from './ysld-generator';
import type { ClassificationMethod } from './dto/layer-style.dto';

export type FieldKind =
  'string' | 'number' | 'date' | 'boolean' | 'geometry' | 'other';

export interface AttributeInfo {
  name: string;
  type: string;
  kind: FieldKind;
}

export interface FieldStats {
  field: string;
  kind: FieldKind;
  /** Distinct values (string/other fields), capped — >50 ⇒ suggest graduated. */
  distinct?: (string | number)[];
  distinctTruncated?: boolean;
  /** Numeric fields — summary + ready-to-use class boundaries. */
  numeric?: {
    min: number;
    max: number;
    count: number;
    breaks: number[];
  };
}

const DISTINCT_CAP = 50;

/** Analytics: bars shown per categorical field (the rest fold into
 *  `otherCount`) and histogram bins per numeric field. */
const TOP_CATEGORIES = 12;
const HISTOGRAM_BINS = 10;

export interface FieldSummary {
  field: string;
  kind: FieldKind;
  /** Features in the layer, and how many have a value for this field. */
  total: number;
  nonNull: number;
  numeric?: {
    min: number;
    max: number;
    mean: number;
    sum: number;
    median: number;
    histogram: { from: number; to: number; count: number }[];
  };
  categories?: { value: string; count: number }[];
  distinctCount?: number;
  otherCount?: number;
}

/**
 * Geometry / attribute discovery and classification statistics for the
 * style editor, straight from PostGIS — the exact table backing the layer
 * or upload, with one query for min/max/quantiles. Every field name is
 * whitelisted against `information_schema.columns` before it touches a
 * query; the table name is `isSafeGeneratedTableName`-guarded for uploaded
 * layers, and the fixed `gis_demo_*` names for canonical layers.
 */
@Injectable()
export class FieldStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async attributes(
    table: string,
    workspaceId: string | null,
  ): Promise<AttributeInfo[]> {
    this.assertTable(table);
    const rows = await this.prisma.$queryRawUnsafe<
      { column_name: string; data_type: string; udt_name: string }[]
    >(
      `SELECT column_name, data_type, udt_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      table,
    );
    return rows
      .filter((row) => !this.isInternalColumn(row.column_name, workspaceId))
      .map((row) => ({
        name: row.column_name,
        type: row.data_type,
        kind: this.classifyType(row.data_type, row.udt_name),
      }))
      .filter((attribute) => attribute.kind !== 'geometry');
  }

  async fieldStats(
    table: string,
    field: string,
    options: { method?: ClassificationMethod; classes?: number },
    workspaceId: string | null,
  ): Promise<FieldStats> {
    this.assertTable(table);
    const attributes = await this.attributes(table, workspaceId);
    const attribute = attributes.find((a) => a.name === field);
    if (!attribute) {
      throw new BadRequestException(
        `"${field}" is not an attribute of this layer.`,
      );
    }
    if (attribute.kind === 'geometry') {
      throw new BadRequestException('Cannot classify by the geometry column.');
    }

    const col = `"${field.replace(/"/g, '')}"`;
    const scope =
      workspaceId && this.isDemoTable(table)
        ? { clause: `WHERE gis_workspace_id = $1`, params: [workspaceId] }
        : { clause: '', params: [] as string[] };

    // A `method` means graduated (needs continuous numbers); no method
    // means categorized — distinct values, which works for any field
    // (a `bigint` "zone number" is categorical, not a range).
    const wantsNumeric = !!options.method;

    if (wantsNumeric) {
      if (attribute.kind !== 'number') {
        throw new BadRequestException(
          'Graduated styling needs a numeric field.',
        );
      }
      const [row] = await this.prisma.$queryRawUnsafe<
        { min: number | null; max: number | null; count: bigint }[]
      >(
        `SELECT MIN(${col})::float8 AS min, MAX(${col})::float8 AS max, COUNT(${col}) AS count
           FROM "${table}" ${scope.clause}`,
        ...scope.params,
      );
      const min = row?.min ?? 0;
      const max = row?.max ?? 0;
      const count = Number(row?.count ?? 0);
      const classes = Math.min(Math.max(options.classes ?? 5, 2), 12);
      const breaks =
        options.method === 'quantile'
          ? await this.quantileBreaks(table, col, classes, scope)
          : options.method === 'jenks'
            ? await this.jenksBreaks(table, col, classes, scope, min, max)
            : equalIntervalBreaks(min, max, classes);
      return { field, kind: 'number', numeric: { min, max, count, breaks } };
    }

    const rows = await this.prisma.$queryRawUnsafe<{ v: string | null }[]>(
      `SELECT DISTINCT ${col}::text AS v
         FROM "${table}" ${scope.clause}
        ${scope.clause ? 'AND' : 'WHERE'} ${col} IS NOT NULL
        ORDER BY 1
        LIMIT ${DISTINCT_CAP + 1}`,
      ...scope.params,
    );
    const values = rows.map((r) => r.v).filter((v): v is string => v !== null);
    return {
      field,
      kind: attribute.kind,
      distinct: values.slice(0, DISTINCT_CAP),
      distinctTruncated: values.length > DISTINCT_CAP,
    };
  }

  /** Analytics summary of one field over the whole layer: numbers get
   *  count / min / max / mean / sum / median + an equal-width histogram;
   *  everything else gets its most frequent values. Same field whitelist
   *  and tenant scoping as `fieldStats`. */
  async summary(
    table: string,
    field: string,
    workspaceId: string | null,
  ): Promise<FieldSummary> {
    this.assertTable(table);
    const attribute = (await this.attributes(table, workspaceId)).find(
      (a) => a.name === field,
    );
    if (!attribute) {
      throw new BadRequestException(
        `"${field}" is not an attribute of this layer.`,
      );
    }
    const col = `"${field.replace(/"/g, '')}"`;
    const scope =
      workspaceId && this.isDemoTable(table)
        ? { clause: `WHERE gis_workspace_id = $1`, params: [workspaceId] }
        : { clause: '', params: [] as string[] };
    const notNull = `${scope.clause ? `${scope.clause} AND` : 'WHERE'} ${col} IS NOT NULL`;

    if (attribute.kind === 'number') {
      const [row] = await this.prisma.$queryRawUnsafe<
        {
          total: bigint;
          non_null: bigint;
          min: number | null;
          max: number | null;
          mean: number | null;
          sum: number | null;
          median: number | null;
        }[]
      >(
        `SELECT COUNT(*) AS total, COUNT(${col}) AS non_null,
                MIN(${col})::float8 AS min, MAX(${col})::float8 AS max,
                AVG(${col})::float8 AS mean, SUM(${col})::float8 AS sum,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY ${col})::float8 AS median
           FROM "${table}" ${scope.clause}`,
        ...scope.params,
      );
      const total = Number(row?.total ?? 0);
      const nonNull = Number(row?.non_null ?? 0);
      if (nonNull === 0 || row?.min == null || row?.max == null) {
        return { field, kind: 'number', total, nonNull };
      }
      const { min, max } = row;
      const bins = min === max ? 1 : HISTOGRAM_BINS;
      const width = bins === 1 ? 0 : (max - min) / bins;
      const counts = await this.prisma.$queryRawUnsafe<
        { bin: number; count: bigint }[]
      >(
        bins === 1
          ? `SELECT 1 AS bin, COUNT(*) AS count FROM "${table}" ${notNull}`
          : `SELECT LEAST(width_bucket(${col}::float8, ${min}, ${max}, ${bins}), ${bins}) AS bin,
                    COUNT(*) AS count
               FROM "${table}" ${notNull}
              GROUP BY 1`,
        ...scope.params,
      );
      const byBin = new Map(
        counts.map((c) => [Number(c.bin), Number(c.count)]),
      );
      const histogram = Array.from({ length: bins }, (_, i) => ({
        from: bins === 1 ? min : min + i * width,
        to: bins === 1 ? max : i === bins - 1 ? max : min + (i + 1) * width,
        count: byBin.get(i + 1) ?? 0,
      }));
      return {
        field,
        kind: 'number',
        total,
        nonNull,
        numeric: {
          min,
          max,
          mean: row.mean ?? 0,
          sum: row.sum ?? 0,
          median: row.median ?? 0,
          histogram,
        },
      };
    }

    const [counts] = await this.prisma.$queryRawUnsafe<
      { total: bigint; non_null: bigint; distinct_count: bigint }[]
    >(
      `SELECT COUNT(*) AS total, COUNT(${col}) AS non_null,
              COUNT(DISTINCT ${col}::text) AS distinct_count
         FROM "${table}" ${scope.clause}`,
      ...scope.params,
    );
    const top = await this.prisma.$queryRawUnsafe<
      { value: string; count: bigint }[]
    >(
      `SELECT ${col}::text AS value, COUNT(*) AS count
         FROM "${table}" ${notNull}
        GROUP BY 1
        ORDER BY 2 DESC, 1
        LIMIT ${TOP_CATEGORIES}`,
      ...scope.params,
    );
    const nonNull = Number(counts?.non_null ?? 0);
    const categories = top.map((t) => ({
      value: t.value,
      count: Number(t.count),
    }));
    const shown = categories.reduce((sum, c) => sum + c.count, 0);
    return {
      field,
      kind: attribute.kind,
      total: Number(counts?.total ?? 0),
      nonNull,
      categories,
      distinctCount: Number(counts?.distinct_count ?? 0),
      otherCount: nonNull - shown,
    };
  }

  // ---- helpers ---------------------------------------------------

  /** Jenks natural breaks on a random sample of up to 1000 values (the
   *  O(k·n²) optimisation stays fast); the outer bounds are the true min/max. */
  private async jenksBreaks(
    table: string,
    col: string,
    classes: number,
    scope: { clause: string; params: string[] },
    min: number,
    max: number,
  ): Promise<number[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ v: number }[]>(
      `SELECT ${col}::float8 AS v FROM "${table}" ${scope.clause}
        ${scope.clause ? 'AND' : 'WHERE'} ${col} IS NOT NULL
        ORDER BY random() LIMIT 1000`,
      ...scope.params,
    );
    const values = rows.map((r) => Number(r.v)).sort((a, b) => a - b);
    const k = Math.min(classes, new Set(values).size);
    if (k < 2) return equalIntervalBreaks(min, max, classes);
    const breaks = jenks(values, k).map((n) => Math.round(n * 1e6) / 1e6);
    breaks[0] = min;
    breaks[breaks.length - 1] = max;
    return breaks;
  }

  private async quantileBreaks(
    table: string,
    col: string,
    classes: number,
    scope: { clause: string; params: string[] },
  ): Promise<number[]> {
    const fractions = Array.from(
      { length: classes + 1 },
      (_, i) => i / classes,
    );
    const [row] = await this.prisma.$queryRawUnsafe<{ q: number[] }[]>(
      `SELECT percentile_cont(ARRAY[${fractions.join(',')}]) WITHIN GROUP (ORDER BY ${col})::float8[] AS q
         FROM "${table}" ${scope.clause}`,
      ...scope.params,
    );
    const q = row?.q ?? [];
    return q.length === classes + 1
      ? q.map((n) => Math.round(n * 1e6) / 1e6)
      : [0, 1];
  }

  private assertTable(table: string): void {
    if (isSafeGeneratedTableName(table) || this.isDemoTable(table)) return;
    throw new BadRequestException('This layer cannot be styled by attribute.');
  }

  private isDemoTable(table: string): boolean {
    return (
      table === 'gis_demo_municipal_boundary' ||
      table === 'gis_demo_wards' ||
      table === 'gis_demo_roads'
    );
  }

  private isInternalColumn(name: string, workspaceId: string | null): boolean {
    // GDAL's synthetic FID + the demo tables' tenant column are never
    // meaningful to style by.
    if (name === 'ogc_fid' || name === 'fid') return true;
    if (workspaceId && name === 'gis_workspace_id') return true;
    return false;
  }

  private classifyType(dataType: string, udt: string): FieldKind {
    const t = dataType.toLowerCase();
    if (udt === 'geometry' || udt === 'geography' || t.includes('geometry')) {
      return 'geometry';
    }
    if (
      t.includes('int') ||
      t.includes('numeric') ||
      t.includes('decimal') ||
      t.includes('real') ||
      t.includes('double') ||
      t === 'money'
    ) {
      return 'number';
    }
    if (t.includes('bool')) return 'boolean';
    if (t.includes('date') || t.includes('time')) return 'date';
    if (
      t.includes('char') ||
      t.includes('text') ||
      t === 'name' ||
      t === 'uuid'
    ) {
      return 'string';
    }
    return 'other';
  }
}

/** Fisher–Jenks optimal classification of sorted `data` into `k` classes —
 *  returns the k + 1 class boundaries. */
function jenks(data: number[], k: number): number[] {
  const n = data.length;
  const lower = Array.from({ length: n + 1 }, () => new Array<number>(k + 1).fill(0));
  const variance = Array.from({ length: n + 1 }, () => new Array<number>(k + 1).fill(Infinity));
  for (let j = 1; j <= k; j++) {
    lower[1][j] = 1;
    variance[1][j] = 0;
  }
  for (let l = 2; l <= n; l++) {
    let sum = 0;
    let sumSq = 0;
    let w = 0;
    let v = 0;
    for (let m = 1; m <= l; m++) {
      const i = l - m + 1;
      const val = data[i - 1];
      w++;
      sum += val;
      sumSq += val * val;
      v = sumSq - (sum * sum) / w;
      if (i > 1) {
        for (let j = 2; j <= k; j++) {
          if (variance[l][j] >= v + variance[i - 1][j - 1]) {
            lower[l][j] = i;
            variance[l][j] = v + variance[i - 1][j - 1];
          }
        }
      }
    }
    lower[l][1] = 1;
    variance[l][1] = v;
  }
  const breaks = new Array<number>(k + 1);
  breaks[k] = data[n - 1];
  breaks[0] = data[0];
  let idx = n;
  for (let j = k; j >= 2; j--) {
    const id = lower[idx][j] - 1;
    breaks[j - 1] = data[id];
    idx = id;
  }
  return breaks;
}
