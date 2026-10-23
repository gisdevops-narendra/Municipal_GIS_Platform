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

/** What a field is good for in an overview, inferred from its values —
 *  layers are user data, so nothing is keyed on layer or field names
 *  beyond the generic identifier pattern. */
export type FieldRole =
  'id' | 'category' | 'measure' | 'date' | 'text' | 'constant' | 'empty';

export interface FieldProfile {
  name: string;
  kind: FieldKind;
  role: FieldRole;
  nonNull: number;
  distinct: number;
  numeric?: { min: number; max: number; sum: number; mean: number };
}

export interface LayerProfile {
  total: number;
  geometry: {
    kind: 'point' | 'line' | 'polygon' | 'mixed' | null;
    lengthKm?: number;
    areaHa?: number;
  };
  fields: FieldProfile[];
  /** Top values of the most informative category fields. */
  categories: {
    field: string;
    distinct: number;
    values: { value: string; count: number }[];
    otherCount: number;
  }[];
  /** Feature counts per month / year for date fields. */
  timelines: {
    field: string;
    unit: 'month' | 'year';
    points: { period: string; count: number }[];
  }[];
}

/** Overview limits: fields profiled, category / timeline cards built,
 *  values per category card. */
const PROFILE_FIELDS = 80;
const PROFILE_CATEGORIES = 4;
const PROFILE_TIMELINES = 2;
const PROFILE_TOP_VALUES = 6;
/** A field with at most this many values (or few relative to the rows)
 *  reads as a category rather than a measure / free text. */
const CATEGORY_MAX_DISTINCT = 50;

/** Group by: what is measured per group. */
export type GroupMeasure = 'count' | 'sum' | 'avg' | 'length' | 'area';

export interface GroupResult {
  measure: GroupMeasure;
  /** null key = features with no value / outside every area. */
  groups: { key: string | null; count: number; value: number }[];
  /** Everything past the shown groups (not for averages). */
  other?: { groups: number; count: number; value: number };
  /** Area outlines (EPSG:4326 GeoJSON geometry) per key, for a choropleth. */
  shapes?: { key: string | null; geometry: Record<string, unknown> }[];
}

/** A table that backs a layer, with its tenant scope. */
export interface StatsSource {
  table: string;
  workspaceId: string | null;
}

/** Heatmap & Clusters: one point per feature, capped so the payload stays small. */
const DENSITY_POINT_LIMIT = 50000;

export interface DensityPoints {
  /** [lon, lat, weight] in EPSG:4326; weight is 1 without a weight field. */
  points: [number, number, number][];
  total: number;
  truncated: boolean;
  /** Largest weight among the points (1 without a weight field). */
  maxWeight: number;
}

const GROUP_LIMIT = 30;
const AREA_GROUP_LIMIT = 200;
/** Area outlines sent back as a CQL filter stay well under the CQL cap. */
const AREA_WKT_MAX = 6000;

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

  /** Overview of a whole layer: geometry totals, every field's role
   *  (from its fill, cardinality and value shape) and the data behind the
   *  auto-built cards — top values of the best category fields and
   *  month / year counts of date fields. */
  async profile(
    table: string,
    workspaceId: string | null,
  ): Promise<LayerProfile> {
    this.assertTable(table);
    const attributes = (await this.attributes(table, workspaceId)).slice(
      0,
      PROFILE_FIELDS,
    );
    const scope =
      workspaceId && this.isDemoTable(table)
        ? { clause: `WHERE gis_workspace_id = $1`, params: [workspaceId] }
        : { clause: '', params: [] as string[] };
    const colOf = (name: string) => `"${name.replace(/"/g, '')}"`;

    const selects = ['COUNT(*) AS total'];
    attributes.forEach((a, i) => {
      const c = colOf(a.name);
      selects.push(
        `COUNT(${c}) AS n${i}`,
        `COUNT(DISTINCT ${c}::text) AS d${i}`,
      );
      if (a.kind === 'number') {
        selects.push(
          `MIN(${c})::float8 AS min${i}`,
          `MAX(${c})::float8 AS max${i}`,
          `SUM(${c})::float8 AS sum${i}`,
          `AVG(${c})::float8 AS avg${i}`,
          `bool_and(${c}::numeric = trunc(${c}::numeric)) AS int${i}`,
        );
      }
    });
    const [row] = await this.prisma.$queryRawUnsafe<
      Record<string, bigint | number | boolean | null>[]
    >(
      `SELECT ${selects.join(', ')} FROM "${table}" ${scope.clause}`,
      ...scope.params,
    );
    const total = Number(row?.total ?? 0);

    const fields: FieldProfile[] = attributes.map((a, i) => {
      const nonNull = Number(row?.[`n${i}`] ?? 0);
      const distinct = Number(row?.[`d${i}`] ?? 0);
      const numeric =
        a.kind === 'number' && nonNull > 0
          ? {
              min: Number(row?.[`min${i}`] ?? 0),
              max: Number(row?.[`max${i}`] ?? 0),
              sum: Number(row?.[`sum${i}`] ?? 0),
              mean: Number(row?.[`avg${i}`] ?? 0),
            }
          : undefined;
      const integer = row?.[`int${i}`] === true;
      return {
        name: a.name,
        kind: a.kind,
        role: fieldRole(a, nonNull, distinct, numeric, integer),
        nonNull,
        distinct,
        ...(numeric ? { numeric } : {}),
      };
    });

    const categoryFields = fields
      .filter((f) => f.role === 'category')
      .map((f) => ({
        f,
        // Well filled, with a handful of values, makes the best chart.
        score:
          (f.nonNull / Math.max(total, 1)) *
          (f.distinct <= 12 ? 1 : 12 / f.distinct),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, PROFILE_CATEGORIES)
      .map(({ f }) => f);
    const notNull = (c: string) =>
      `${scope.clause ? `${scope.clause} AND` : 'WHERE'} ${c} IS NOT NULL`;

    const categories: LayerProfile['categories'] = [];
    for (const f of categoryFields) {
      const c = colOf(f.name);
      const top = await this.prisma.$queryRawUnsafe<
        { value: string; count: bigint }[]
      >(
        `SELECT ${c}::text AS value, COUNT(*) AS count FROM "${table}" ${notNull(c)}
          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${PROFILE_TOP_VALUES}`,
        ...scope.params,
      );
      const values = top.map((t) => ({
        value: t.value,
        count: Number(t.count),
      }));
      const shown = values.reduce((sum, v) => sum + v.count, 0);
      categories.push({
        field: f.name,
        distinct: f.distinct,
        values,
        otherCount: f.nonNull - shown,
      });
    }

    const timelines: LayerProfile['timelines'] = [];
    const dateFields = fields
      .filter((f) => f.role === 'date')
      .filter((f) => {
        // date_trunc needs a date or timestamp, not a bare time of day.
        const type = attributes.find((a) => a.name === f.name)?.type ?? '';
        return /^(date|timestamp)/i.test(type);
      })
      .slice(0, PROFILE_TIMELINES);
    for (const f of dateFields) {
      const c = colOf(f.name);
      const [span] = await this.prisma.$queryRawUnsafe<
        { days: number | null }[]
      >(
        `SELECT EXTRACT(EPOCH FROM (MAX(${c})::timestamp - MIN(${c})::timestamp)) / 86400 AS days
           FROM "${table}" ${scope.clause}`,
        ...scope.params,
      );
      const unit = Number(span?.days ?? 0) > 3 * 365 ? 'year' : 'month';
      const points = await this.prisma.$queryRawUnsafe<
        { period: string; count: bigint }[]
      >(
        `SELECT to_char(date_trunc('${unit}', ${c}::timestamp), '${unit === 'year' ? 'YYYY' : 'YYYY-MM'}') AS period,
                COUNT(*) AS count
           FROM "${table}" ${notNull(c)}
          GROUP BY 1 ORDER BY 1`,
        ...scope.params,
      );
      timelines.push({
        field: f.name,
        unit,
        points: points.map((p) => ({
          period: p.period,
          count: Number(p.count),
        })),
      });
    }

    return {
      total,
      geometry: await this.geometryProfile(table, scope),
      fields,
      categories,
      timelines,
    };
  }

  /** Group by: `measure` per value of `by` (an attribute of the layer),
   *  or per feature of an area layer when `area` is given — each feature
   *  goes to the area holding its point-on-surface, so nothing is counted
   *  twice. Every field is whitelisted like `summary`. */
  async groupBy(
    target: StatsSource,
    options: {
      by?: string;
      area?: StatsSource & { field: string };
      measure: GroupMeasure;
      measureField?: string;
      /** Also return each area's outline (area grouping only). */
      shapes?: boolean;
    },
  ): Promise<GroupResult> {
    this.assertTable(target.table);
    const attrs = await this.attributes(target.table, target.workspaceId);
    const colOf = (name: string) => `"${name.replace(/"/g, '')}"`;
    const need = (
      list: AttributeInfo[],
      name: string | undefined,
      what: string,
    ) => {
      const a = name ? list.find((x) => x.name === name) : undefined;
      if (!a) throw new BadRequestException(`Choose a valid ${what}.`);
      return a;
    };

    const { measure } = options;
    let agg: string;
    if (measure === 'count') {
      agg = 'COUNT(t.*)';
    } else if (measure === 'sum' || measure === 'avg') {
      const f = need(attrs, options.measureField, 'field to measure');
      if (f.kind !== 'number') {
        throw new BadRequestException('Sum and average need a numeric field.');
      }
      agg = `${measure === 'sum' ? 'SUM' : 'AVG'}(t.${colOf(f.name)})::float8`;
    } else {
      const g = await this.geometryColumn(target.table);
      if (!g) throw new BadRequestException('This layer has no geometry.');
      const geog = `(CASE WHEN ST_SRID(t.${g}) = 4326 THEN t.${g} ELSE ST_Transform(t.${g}, 4326) END)::geography`;
      agg =
        measure === 'length'
          ? `SUM(ST_Length(${geog}))::float8 / 1000`
          : `SUM(ST_Area(${geog}))::float8 / 10000`;
    }

    type Row = { key: string | null; count: bigint; value: number | null };
    const toGroups = (rows: Row[]) =>
      rows.map((r) => ({
        key: r.key,
        count: Number(r.count),
        value: Number(r.value ?? 0),
      }));
    const scoped = (source: StatsSource) =>
      !!source.workspaceId && this.isDemoTable(source.table);

    if (options.area) {
      const area = options.area;
      this.assertTable(area.table);
      const areaAttrs = await this.attributes(area.table, area.workspaceId);
      const label = need(areaAttrs, area.field, 'area name field');
      const ag = await this.geometryColumn(area.table);
      const tg = await this.geometryColumn(target.table);
      if (!ag || !tg) {
        throw new BadRequestException('Both layers need a geometry.');
      }
      const inArea = `ST_Intersects(a.${ag}, ST_PointOnSurface(ST_Transform(t.${tg}, ST_SRID(a.${ag}))))`;
      const params: string[] = [];
      const bind = (value: string) => {
        params.push(value);
        return `$${params.length}`;
      };
      const tScope = scoped(target)
        ? `AND t.gis_workspace_id = ${bind(target.workspaceId!)}`
        : '';
      const aScope = scoped(area)
        ? `a.gis_workspace_id = ${bind(area.workspaceId!)}`
        : '';
      const rows = await this.prisma.$queryRawUnsafe<Row[]>(
        `SELECT a.${colOf(label.name)}::text AS key, COUNT(t.*) AS count, COALESCE(${agg}, 0) AS value
           FROM "${area.table}" a
           LEFT JOIN "${target.table}" t ON ${inArea} ${tScope}
          ${aScope ? `WHERE ${aScope}` : ''}
          GROUP BY 1
          ORDER BY 3 DESC, 1
          LIMIT ${AREA_GROUP_LIMIT}`,
        ...params,
      );
      // What fell outside every area.
      const [outside] = await this.prisma.$queryRawUnsafe<Row[]>(
        `SELECT NULL AS key, COUNT(t.*) AS count, COALESCE(${agg}, 0) AS value
           FROM "${target.table}" t
          WHERE NOT EXISTS (
                SELECT 1 FROM "${area.table}" a
                 WHERE ${inArea} ${aScope ? `AND ${aScope}` : ''}) ${tScope}`,
        ...params,
      );
      const groups = toGroups(rows);
      if (outside && Number(outside.count) > 0) {
        groups.push(...toGroups([outside]));
      }
      if (!options.shapes) return { measure, groups };
      // Lightly simplified (~5 m) so a ward layer stays a small payload.
      const shapeParams = scoped(area) ? [area.workspaceId!] : [];
      const shapes = await this.prisma.$queryRawUnsafe<
        { key: string | null; geometry: string | null }[]
      >(
        `SELECT a.${colOf(label.name)}::text AS key,
                ST_AsGeoJSON(ST_SimplifyPreserveTopology(ST_Transform(ST_Union(a.${ag}), 4326), 0.00005), 6) AS geometry
           FROM "${area.table}" a
          ${shapeParams.length ? 'WHERE a.gis_workspace_id = $1' : ''}
          GROUP BY 1
          LIMIT ${AREA_GROUP_LIMIT}`,
        ...shapeParams,
      );
      return {
        measure,
        groups,
        shapes: shapes
          .filter((r) => r.geometry)
          .map((r) => ({
            key: r.key,
            geometry: JSON.parse(r.geometry!) as Record<string, unknown>,
          })),
      };
    }

    const by = need(attrs, options.by, 'field to group by');
    const params = scoped(target) ? [target.workspaceId!] : [];
    const where = params.length ? 'WHERE t.gis_workspace_id = $1' : '';
    const rows = await this.prisma.$queryRawUnsafe<Row[]>(
      `SELECT t.${colOf(by.name)}::text AS key, COUNT(t.*) AS count, ${agg} AS value
         FROM "${target.table}" t ${where}
        GROUP BY 1
        ORDER BY 3 DESC NULLS LAST, 1
        LIMIT ${GROUP_LIMIT + 1}`,
      ...params,
    );
    const groups = toGroups(rows.slice(0, GROUP_LIMIT));
    if (rows.length <= GROUP_LIMIT || measure === 'avg') {
      return { measure, groups };
    }
    const [all] = await this.prisma.$queryRawUnsafe<
      { groups: bigint; count: bigint; value: number | null }[]
    >(
      `SELECT COUNT(DISTINCT t.${colOf(by.name)}::text) AS groups, COUNT(t.*) AS count, ${agg} AS value
         FROM "${target.table}" t ${where}`,
      ...params,
    );
    const shownCount = groups.reduce((sum, g) => sum + g.count, 0);
    const shownValue = groups.reduce((sum, g) => sum + g.value, 0);
    return {
      measure,
      groups,
      other: {
        groups:
          Number(all?.groups ?? 0) -
          groups.filter((g) => g.key !== null).length,
        count: Number(all?.count ?? 0) - shownCount,
        value: Number(all?.value ?? 0) - shownValue,
      },
    };
  }

  /** One area's outline (all features whose `field` equals `value`,
   *  unioned) as EPSG:4326 WKT, simplified until it fits a CQL filter. */
  async areaShape(
    source: StatsSource,
    field: string,
    value: string | null,
  ): Promise<{ wkt: string | null }> {
    this.assertTable(source.table);
    const attr = (await this.attributes(source.table, source.workspaceId)).find(
      (a) => a.name === field,
    );
    if (!attr) {
      throw new BadRequestException('Choose a valid area name field.');
    }
    const g = await this.geometryColumn(source.table);
    if (!g) throw new BadRequestException('This layer has no geometry.');
    const col = `"${field.replace(/"/g, '')}"`;
    const params: string[] = [];
    const conds: string[] = [];
    if (value === null) {
      conds.push(`${col} IS NULL`);
    } else {
      params.push(value);
      conds.push(`${col}::text = $${params.length}`);
    }
    if (source.workspaceId && this.isDemoTable(source.table)) {
      params.push(source.workspaceId);
      conds.push(`gis_workspace_id = $${params.length}`);
    }
    const tolerances = [0, 0.00002, 0.0001, 0.0005, 0.002, 0.01];
    const texts = tolerances
      .map(
        (t) =>
          `ST_AsText(${t ? `ST_SimplifyPreserveTopology(u.g, ${t})` : 'u.g'}, 6)`,
      )
      .join(', ');
    const [row] = await this.prisma.$queryRawUnsafe<
      { texts: string[] | null }[]
    >(
      `WITH u AS (
         SELECT ST_Transform(ST_Union(${g}), 4326) AS g
           FROM "${source.table}" WHERE ${conds.join(' AND ')}
       )
       SELECT ARRAY[${texts}] AS texts FROM u WHERE u.g IS NOT NULL`,
      ...params,
    );
    const candidates = row?.texts ?? [];
    const wkt = candidates.find((t) => t && t.length <= AREA_WKT_MAX) ?? null;
    if (candidates.length && !wkt) {
      throw new BadRequestException('This area is too detailed to filter by.');
    }
    return { wkt };
  }

  /** Heatmap & Clusters: one EPSG:4326 point per feature (a point on the
   *  surface for lines / polygons), optionally weighted by a numeric field. */
  async densityPoints(
    table: string,
    weightField: string | undefined,
    workspaceId: string | null,
  ): Promise<DensityPoints> {
    this.assertTable(table);
    const g = await this.geometryColumn(table);
    if (!g) {
      throw new BadRequestException('This layer has no geometry.');
    }
    let weight = '1::float8';
    if (weightField) {
      const attribute = (await this.attributes(table, workspaceId)).find(
        (a) => a.name === weightField,
      );
      if (!attribute || attribute.kind !== 'number') {
        throw new BadRequestException(
          `"${weightField}" is not a numeric attribute of this layer.`,
        );
      }
      weight = `"${weightField.replace(/"/g, '')}"::float8`;
    }
    const scope =
      workspaceId && this.isDemoTable(table)
        ? { clause: `AND gis_workspace_id = $1`, params: [workspaceId] }
        : { clause: '', params: [] as string[] };
    const pt = `ST_Transform(CASE WHEN GeometryType(${g}) LIKE '%POINT' THEN ST_Centroid(${g}) ELSE ST_PointOnSurface(${g}) END, 4326)`;
    const rows = await this.prisma.$queryRawUnsafe<
      { x: number; y: number; w: number | null; total: bigint }[]
    >(
      `SELECT ST_X(p)::float8 AS x, ST_Y(p)::float8 AS y, w, COUNT(*) OVER () AS total
         FROM (SELECT ${pt} AS p, ${weight} AS w
                 FROM "${table}"
                WHERE ${g} IS NOT NULL AND NOT ST_IsEmpty(${g}) ${scope.clause}) s
        WHERE w IS NOT NULL AND w > 0
        LIMIT ${DENSITY_POINT_LIMIT}`,
      ...scope.params,
    );
    const total = Number(rows[0]?.total ?? 0);
    let maxWeight = 0;
    const points = rows.map((r): [number, number, number] => {
      const w = Number(r.w);
      if (w > maxWeight) maxWeight = w;
      return [r.x, r.y, w];
    });
    return {
      points,
      total,
      truncated: total > points.length,
      maxWeight: maxWeight || 1,
    };
  }

  // ---- helpers ---------------------------------------------------

  /** The table's first geometry column, quoted — or null. */
  private async geometryColumn(table: string): Promise<string | null> {
    const [row] = await this.prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND udt_name = 'geometry'
        ORDER BY ordinal_position LIMIT 1`,
      table,
    );
    return row ? `"${row.column_name.replace(/"/g, '')}"` : null;
  }

  /** Dominant geometry kind and, for lines / polygons, the geodesic total
   *  length (km) / area (ha). Totals are skipped when the SRID is unknown. */
  private async geometryProfile(
    table: string,
    scope: { clause: string; params: string[] },
  ): Promise<LayerProfile['geometry']> {
    const g = await this.geometryColumn(table);
    if (!g) return { kind: null };
    const types = await this.prisma.$queryRawUnsafe<{ t: string | null }[]>(
      `SELECT DISTINCT GeometryType(${g}) AS t FROM "${table}" ${scope.clause}`,
      ...scope.params,
    );
    const kinds = new Set(
      types
        .map((r) => (r.t ?? '').toUpperCase())
        .filter(Boolean)
        .map((t) =>
          t.includes('POINT')
            ? 'point'
            : t.includes('LINE')
              ? 'line'
              : t.includes('POLYGON')
                ? 'polygon'
                : 'mixed',
        ),
    );
    const kind =
      kinds.size === 0
        ? null
        : kinds.size === 1
          ? ([...kinds][0] as 'point' | 'line' | 'polygon' | 'mixed')
          : 'mixed';
    if (kind !== 'line' && kind !== 'polygon') return { kind };
    const geog = `(CASE WHEN ST_SRID(${g}) = 4326 THEN ${g} ELSE ST_Transform(${g}, 4326) END)::geography`;
    try {
      const [m] = await this.prisma.$queryRawUnsafe<{ v: number | null }[]>(
        kind === 'line'
          ? `SELECT SUM(ST_Length(${geog}))::float8 / 1000 AS v FROM "${table}" ${scope.clause}`
          : `SELECT SUM(ST_Area(${geog}))::float8 / 10000 AS v FROM "${table}" ${scope.clause}`,
        ...scope.params,
      );
      const v = Number(m?.v ?? 0);
      return kind === 'line' ? { kind, lengthKm: v } : { kind, areaHa: v };
    } catch {
      return { kind };
    }
  }

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

/** Identifier columns (objectid, fid, valve_id …): counting or averaging
 *  them says nothing. */
const ID_NAME = /(^|_)(id|fid|gid|gisid|objectid|uuid)$|^object_?id$/i;

/** Infers a field's overview role from its type, fill and value shape. */
export function fieldRole(
  attribute: AttributeInfo,
  nonNull: number,
  distinct: number,
  numeric: { min: number; max: number } | undefined,
  integer: boolean,
): FieldRole {
  if (nonNull === 0) return 'empty';
  if (distinct <= 1) return 'constant';
  if (attribute.kind === 'boolean') return 'category';
  if (attribute.kind === 'date') return 'date';
  if (ID_NAME.test(attribute.name)) return 'id';
  const fewValues =
    distinct <= CATEGORY_MAX_DISTINCT && distinct <= Math.max(nonNull * 0.5, 2);
  if (attribute.kind === 'number') {
    // Unique whole numbers packed into a run (1..n) are a key, not a measure.
    if (
      integer &&
      numeric &&
      distinct === nonNull &&
      nonNull > 20 &&
      numeric.max - numeric.min + 1 <= nonNull * 1.5
    ) {
      return 'id';
    }
    return integer && fewValues ? 'category' : 'measure';
  }
  if (attribute.kind === 'string' || attribute.kind === 'other') {
    return fewValues ? 'category' : 'text';
  }
  return 'text';
}

/** Fisher–Jenks optimal classification of sorted `data` into `k` classes —
 *  returns the k + 1 class boundaries. */
function jenks(data: number[], k: number): number[] {
  const n = data.length;
  const lower = Array.from({ length: n + 1 }, () =>
    new Array<number>(k + 1).fill(0),
  );
  const variance = Array.from({ length: n + 1 }, () =>
    new Array<number>(k + 1).fill(Infinity),
  );
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
