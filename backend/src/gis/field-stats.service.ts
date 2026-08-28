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

  // ---- helpers ---------------------------------------------------

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
