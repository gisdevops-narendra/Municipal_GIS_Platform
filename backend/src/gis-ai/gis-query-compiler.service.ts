import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AggregateMetric,
  AiAttributeFilter,
  AiGisOperation,
  AttrOp,
} from './ai-plan.types';
import type {
  CatalogColumn,
  LayerCatalogEntry,
} from './layer-catalog.service';

/**
 * Thrown when the LLM's plan references a layer/field/value that does not
 * exist in the caller's real, authorised catalog. Surfaced to the user as
 * a clarification prompt rather than a hard error.
 */
export class PlanValidationError extends Error {}

/** The plan names a field the layer does not have — the chat offers the
 *  layer's real fields as clickable choices instead of guessing. */
export class UnknownFieldError extends PlanValidationError {
  constructor(
    readonly layer: LayerCatalogEntry,
    readonly field: string,
  ) {
    super(`"${layer.name}" has no field "${field}". Which field did you mean?`);
  }
}

/** "near" with no distance to a point/line layer — never guessed. */
export class DistanceNeededError extends PlanValidationError {
  constructor(readonly referenceName: string) {
    super(`How close to ${referenceName} counts as “near”?`);
  }
}

const HARD_MAX_ROWS = 5000;
const DEFAULT_ROWS = 2000;
// Matched feature ids go into a GeoServer CQL_FILTER carried on a WMS/WFS
// GET URL; keep the list short enough that the URL stays well under ~8 KB.
// The map highlight uses the same capped set so it matches the Attribute
// Table exactly.
const MAX_RENDERED = 450;
/** Keeps the CQL_FILTER of a WFS/WMS GET request well under GeoServer's
 *  ~8 KB request-line limit (the rest of the URL needs room too). */
const MAX_CQL_CHARS = 3500;
const MAX_DISTANCE_M = 50000;
const HAVING_OPS: Record<string, string> = { '>': '>', '>=': '>=', '<': '<', '<=': '<=', '=': '=' };
const MAX_BUFFER_M = 10000;
const MAX_BUFFER_SOURCES = 5000;
const MAX_GROUPS = 200;
const MAX_NEAREST = 50;
/** "nearest X to each Y": at most this many Y features are answered. */
const MAX_PER_REFERENCE = 200;
/** metric_field names a small model uses for "road length" / "plot area"
 *  when the layer has no such column — computed from the geometry. */
const GEOMETRY_LENGTH = /^(shape_)?(length|len)(_m|_km|_metres|_meters)?$/i;
const GEOMETRY_AREA = /^(shape_)?area(_m2|_sqm|_sq_m|_ha)?$/i;
const LABEL_COLUMN = /^(name|.*_name|name_.*|title|label)$/i;
/** Text identifiers ("valve_id", "gisid") — the fallback label when a
 *  feature's name columns are empty. */
const ID_COLUMN = /(^|_)(id|gisid|code|no)$/i;

const COMPARISON: Partial<Record<AttrOp, string>> = {
  '=': '=',
  '!=': '<>',
  '>': '>',
  '>=': '>=',
  '<': '<',
  '<=': '<=',
};

export interface CompiledQuery {
  sql: string;
  params: unknown[];
  target: LayerCatalogEntry;
  /** ~1-2 line human summary of the compiled operation. */
  summary: string;
  /** select only: counts every match, run when the row limit is hit so the
   *  answer reports the true total, not the cut-off (2,000). */
  countSql?: string;
  /** select only: count + EPSG:4326 extent of every match, for answers
   *  that filter the map layer in GeoServer instead of sending geometries. */
  extentSql?: string;
  /** select only: the LIMIT applied; `limitAsked` = the plan asked for it
   *  ("the 10 tallest"), so the rows ARE the answer. */
  limit?: number;
  limitAsked?: boolean;
  /** select with order_by: the measure ranked on ("the longest river"). */
  ranking?: { field: string; unit: string | null; desc: boolean };
}

export interface CompiledAggregate extends CompiledQuery {
  metric: AggregateMetric;
  /** Column (or "length (m)" / "area (m²)") the metric is computed on. */
  metricLabel: string | null;
  /** What the rows are grouped by, e.g. "Wards.ward_name". */
  groupLabel: string | null;
}

export interface AggregateRow {
  group: string | null;
  value: number | null;
  count: number;
}

export interface CompiledNearest extends CompiledQuery {
  /** Reference set on its own — count, first label, geometry. */
  refSql: string;
  refParams: unknown[];
  reference: LayerCatalogEntry;
  /** One result set per reference feature (see compileNearest). */
  perReference?: boolean;
}

export interface NearestPairRow extends NearestRow {
  refId: number | string;
  refLabel: string | null;
  refGeometry: Record<string, unknown> | null;
}

export interface NearestRow {
  id: number | string;
  label: string | null;
  distanceM: number;
  geometry: Record<string, unknown> | null;
}

export interface CompiledBuffer extends CompiledQuery {
  distanceM: number;
}

export interface ResolvedPoint {
  layer: LayerCatalogEntry;
  lon: number;
  lat: number;
  label: string;
  /** How many features matched the filters (the first one is used). */
  matches: number;
}

export interface ExecutionResult {
  matched: number;
  truncated: boolean;
  /** target-layer primary key values of the matched features (capped). */
  ids: (number | string)[];
  /** matched geometries, EPSG:4326 GeoJSON (capped). */
  geometries: Record<string, unknown>[];
  /** ordered selects: each feature's name and ranked value, in order. */
  ranked?: { label: string | null; value: number | null }[];
}

type Bind = (value: unknown) => string;

@Injectable()
export class GisQueryCompilerService {
  private readonly logger = new Logger(GisQueryCompilerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The features an operation starts from, as a selection query. Every
   *  kind uses it: `select` returns it, the others also highlight it. */
  compile(
    operation: AiGisOperation,
    catalog: LayerCatalogEntry[],
    workspaceId: string,
  ): CompiledQuery {
    const target = this.resolveLayer(catalog, operation.target_layer);
    const { params, bind } = this.binder();
    const t = 'tgt';
    const { where, summaryBits } = this.selectionWhere(
      t,
      target,
      operation,
      catalog,
      workspaceId,
      bind,
    );

    const limit = this.clampLimit(operation.limit);
    // "The 10 tallest signals": a real column of the layer (validated like
    // every other field name), never an expression from the plan.
    let orderSql = '';
    let orderSummary = '';
    let rankCols = '';
    let ranking: CompiledQuery['ranking'];
    if (operation.order_by) {
      // A column, else the geometry's own length / area ("longest road"
      // on a layer without a length column).
      const named = target.columns.some(
        (c) => c.name.toLowerCase().replace(/_/g, '') === operation.order_by!.trim().toLowerCase().replace(/_/g, ''),
      );
      let orderExpr: string;
      let orderLabel: string;
      if (named) {
        const col = this.findColumn(target, operation.order_by);
        if (col.kind === 'geometry') {
          throw new PlanValidationError(`Cannot sort by the geometry column "${col.name}".`);
        }
        orderExpr = `${t}."${col.name}"`;
        orderLabel = col.name;
        ranking = { field: col.name, unit: col.unit ?? null, desc: operation.order_desc !== false };
      } else {
        const measured = this.measureExpr(t, target, operation.order_by);
        orderExpr = measured.expr;
        orderLabel = measured.label;
        ranking = { field: measured.label, unit: null, desc: operation.order_desc !== false };
      }
      const dir = operation.order_desc === false ? 'ASC' : 'DESC';
      orderSql = `ORDER BY ${orderExpr} ${dir} NULLS LAST `;
      orderSummary = `, ${dir === 'DESC' ? 'highest' : 'lowest'} ${orderLabel} first${
        operation.limit ? ` (top ${limit})` : ''
      }`;
      // What each ranked feature is called, so the answer names it.
      const label = this.labelColumn(target);
      rankCols = `, ${orderExpr} AS __rank` + (label ? `, ${t}."${label.name}"::text AS __label` : '');
    }
    const sql =
      `SELECT ${t}."${target.pkColumn}" AS __id, ` +
      `ST_AsGeoJSON(ST_Transform(${t}."${target.geomColumn}", 4326), 6) AS __geojson` +
      rankCols +
      ' ' +
      `FROM "${target.table}" ${t} ` +
      (where.length ? `WHERE ${where.join(' AND ')} ` : '') +
      orderSql +
      `LIMIT ${limit}`;

    return {
      sql,
      params,
      target,
      summary: `Select from ${target.name}${
        summaryBits.length ? ' where ' + summaryBits.join(' and ') : ''
      }${orderSummary}.`,
      ranking,
      countSql:
        `SELECT count(*)::int AS n FROM "${target.table}" ${t} ` +
        (where.length ? `WHERE ${where.join(' AND ')}` : ''),
      extentSql:
        `SELECT n, ST_XMin(e) AS minx, ST_YMin(e) AS miny, ST_XMax(e) AS maxx, ST_YMax(e) AS maxy FROM (` +
        `SELECT count(*)::int AS n, ST_Extent(ST_Transform(${t}."${target.geomColumn}", 4326)) AS e ` +
        `FROM "${target.table}" ${t} ` +
        (where.length ? `WHERE ${where.join(' AND ')}` : '') +
        `) x`,
      limit,
      limitAsked: operation.limit != null,
    };
  }

  /**
   * count / sum / avg / min / max over the selected features — optionally
   * grouped by one of their columns, or by the polygons of another layer
   * ("street lights per ward"). Zone grouping assigns each feature to the
   * zone containing its point-on-surface, so a feature is never counted
   * twice, and lists zones with no features as 0.
   */
  compileAggregate(
    operation: AiGisOperation,
    catalog: LayerCatalogEntry[],
    workspaceId: string,
  ): CompiledAggregate {
    const target = this.resolveLayer(catalog, operation.target_layer);
    const { params, bind } = this.binder();
    const t = 'tgt';
    const { where, summaryBits } = this.selectionWhere(
      t,
      target,
      operation,
      catalog,
      workspaceId,
      bind,
    );

    const metric: AggregateMetric = operation.metric ?? 'count';
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(metric)) {
      throw new PlanValidationError(`Unsupported statistic "${metric}".`);
    }
    let valueExpr = `count(${t}."${target.pkColumn}")`;
    let metricLabel: string | null = null;
    if (metric !== 'count') {
      if (!operation.metric_field) {
        throw new PlanValidationError(
          `Which numeric field of "${target.name}" should I ${metric}? Numeric fields: ${this.numericNames(target)}.`,
        );
      }
      const measured = this.measureExpr(t, target, operation.metric_field);
      valueExpr = `${metric}(${measured.expr})`;
      metricLabel = measured.label;
    }
    const value = `(${valueExpr})::float8`;
    const n = `count(${t}."${target.pkColumn}")::int`;

    let sql: string;
    let groupLabel: string | null = null;
    if (operation.group_by_layer) {
      const zones = this.resolveLayer(catalog, operation.group_by_layer);
      if (zones.geometryType && zones.geometryType !== 'POLYGON') {
        throw new PlanValidationError(
          `"${zones.name}" is not a polygon layer, so it cannot group features by area.`,
        );
      }
      const asked = operation.group_by_layer_field
        ? this.findColumn(zones, operation.group_by_layer_field)
        : null;
      // A column with no values (PCMC's zone.name is empty everywhere)
      // would merge every polygon into one "(blank)" group.
      const labelCol = asked && this.hasValues(asked) ? asked : this.areaLabelColumn(zones);
      const z = 'zn';
      const zGeom =
        zones.srid === target.srid
          ? `${z}."${zones.geomColumn}"`
          : `ST_Transform(${z}."${zones.geomColumn}", ${target.srid})`;
      const tGeom = `${t}."${target.geomColumn}"`;
      const on = [
        `${tGeom} && ${zGeom}`,
        `ST_Intersects(${zGeom}, ST_PointOnSurface(${tGeom}))`,
        ...where,
      ];
      const zWhere = zones.isDemo
        ? `WHERE ${z}."gis_workspace_id" = ${bind(workspaceId)} `
        : '';
      const pk = `${z}."${zones.pkColumn}"::text`;
      const grp = labelCol
        ? `coalesce(nullif(trim(${z}."${labelCol.name}"::text), ''), ${pk})`
        : pk;
      // One group per polygon (grouped by its key too), so two zones that
      // share a label are still counted separately.
      sql = this.groupStep(
        `SELECT ${grp} AS grp, ${value} AS val, ${n} AS n ` +
          `FROM "${zones.table}" ${z} LEFT JOIN "${target.table}" ${t} ON ${on.join(' AND ')} ` +
          zWhere +
          `GROUP BY ${z}."${zones.pkColumn}", 1`,
        operation,
        bind,
      );
      groupLabel = `${zones.name}${labelCol ? '.' + labelCol.name : ''}`;
    } else if (operation.group_by) {
      const col = this.findColumn(target, operation.group_by);
      sql = this.groupStep(
        `SELECT ${t}."${col.name}"::text AS grp, ${value} AS val, ${n} AS n ` +
          `FROM "${target.table}" ${t} ` +
          (where.length ? `WHERE ${where.join(' AND ')} ` : '') +
          `GROUP BY 1`,
        operation,
        bind,
      );
      groupLabel = col.name;
    } else {
      sql =
        `SELECT NULL::text AS grp, ${value} AS val, ${n} AS n ` +
        `FROM "${target.table}" ${t} ` +
        (where.length ? `WHERE ${where.join(' AND ')} ` : '');
    }

    return {
      sql,
      params,
      target,
      metric,
      metricLabel,
      groupLabel,
      summary: `${metric}${metricLabel ? ' of ' + metricLabel : ''} of ${target.name}${
        groupLabel ? ' per ' + groupLabel : ''
      }${summaryBits.length ? ' where ' + summaryBits.join(' and ') : ''}${
        groupLabel && operation.having_op ? `, keeping groups with ${metric} ${operation.having_op} ${operation.having_value}` : ''
      }${groupLabel && operation.limit ? `, ${operation.order_desc === false ? 'lowest' : 'top'} ${operation.limit}` : ''}.`,
    };
  }

  /** Second step over grouped rows: keep the groups that pass the plan's
   *  threshold ("wards with more than 100 signals"), sort, and keep the
   *  top / lowest N ("top 3 zones", "ward with the fewest"). */
  private groupStep(grouped: string, operation: AiGisOperation, bind: Bind): string {
    let having = '';
    if (operation.having_op != null || operation.having_value != null) {
      const op = HAVING_OPS[String(operation.having_op)];
      const v = Number(operation.having_value);
      if (!op || !Number.isFinite(v)) {
        throw new PlanValidationError('A group threshold needs a comparison and a number, e.g. "more than 100".');
      }
      having = `WHERE g.val ${op} ${bind(v)} `;
    }
    const dir = operation.order_desc === false ? 'ASC' : 'DESC';
    const limit = operation.limit ? Math.min(Math.max(1, Math.trunc(operation.limit)), MAX_GROUPS) : MAX_GROUPS + 1;
    return `SELECT g.grp, g.val, g.n FROM (${grouped}) g ${having}ORDER BY g.val ${dir} NULLS LAST, g.grp LIMIT ${limit}`;
  }

  /** The N selected features closest (straight line) to the reference
   *  features — e.g. the 3 hospitals nearest a named school. */
  compileNearest(
    operation: AiGisOperation,
    catalog: LayerCatalogEntry[],
    workspaceId: string,
  ): CompiledNearest {
    if (!operation.reference_layer) {
      throw new PlanValidationError(
        'Nearest to what? Name the place or layer to measure from.',
      );
    }
    const target = this.resolveLayer(catalog, operation.target_layer);
    const reference = this.resolveLayer(catalog, operation.reference_layer);
    const k = Math.min(
      Math.max(1, Math.trunc(Number(operation.count ?? 1)) || 1),
      MAX_NEAREST,
    );
    const r = 'ref';

    // The reference set on its own, to report "not found" / what it was.
    const refQ = this.binder();
    const refWhere = this.referenceWhere(r, reference, operation, workspaceId, refQ.bind);
    const refLabelExpr = `coalesce(${this.labelExpr(r, reference)}, ${r}."${reference.pkColumn}"::text)`;
    const refSql =
      `SELECT count(*)::int AS n, ` +
      `(array_agg(${refLabelExpr} ORDER BY ${r}."${reference.pkColumn}"))[1] AS label, ` +
      `ST_AsGeoJSON(ST_Transform(ST_Collect(${r}."${reference.geomColumn}"), 4326), 6) AS geojson ` +
      `FROM "${reference.table}" ${r}` +
      (refWhere.length ? ` WHERE ${refWhere.join(' AND ')}` : '');

    // Main query: the same reference filters re-bound, collected into one
    // geometry in the target CRS (an InitPlan, so the KNN index applies).
    const { params, bind } = this.binder();
    const refWhere2 = this.referenceWhere(r, reference, operation, workspaceId, bind);
    const refGeom =
      reference.srid === target.srid
        ? `${r}."${reference.geomColumn}"`
        : `ST_Transform(${r}."${reference.geomColumn}", ${target.srid})`;
    const refCollect =
      `(SELECT ST_Collect(${refGeom}) FROM "${reference.table}" ${r}` +
      (refWhere2.length ? ` WHERE ${refWhere2.join(' AND ')}` : '') +
      ')';

    if (operation.per_reference) {
      return this.compileNearestPerReference(operation, catalog, workspaceId, target, reference, k, refSql, refQ.params);
    }

    const t = 'tgt';
    const { where, summaryBits } = this.selectionWhere(
      t,
      target,
      operation,
      catalog,
      workspaceId,
      bind,
    );
    const tGeom = `${t}."${target.geomColumn}"`;
    if (target.table === reference.table) {
      // "the nearest school to school X" must not answer X itself.
      where.push(`NOT ST_Intersects(${tGeom}, ${refCollect})`);
    }
    const dist =
      target.srid !== 4326
        ? `ST_Distance(${tGeom}, ${refCollect})`
        : `ST_Distance(${tGeom}::geography, ${refCollect}::geography)`;
    const sql =
      `SELECT ${t}."${target.pkColumn}" AS __id, ` +
      `ST_AsGeoJSON(ST_Transform(${tGeom}, 4326), 6) AS __geojson, ` +
      `${this.labelExpr(t, target)} AS __label, ` +
      `${dist}::float8 AS __dist ` +
      `FROM "${target.table}" ${t} ` +
      `WHERE ${[`${refCollect} IS NOT NULL`, ...where].join(' AND ')} ` +
      `ORDER BY ${tGeom} <-> ${refCollect} LIMIT ${k}`;

    return {
      sql,
      params,
      refSql,
      refParams: refQ.params,
      target,
      reference,
      summary: `${k} nearest ${target.name} to ${reference.name}${
        summaryBits.length ? ' where ' + summaryBits.join(' and ') : ''
      }.`,
    };
  }

  /** One dissolved buffer polygon of `distance_meters` around the selected
   *  features, plus its area. */
  compileBuffer(
    operation: AiGisOperation,
    catalog: LayerCatalogEntry[],
    workspaceId: string,
  ): CompiledBuffer {
    const target = this.resolveLayer(catalog, operation.target_layer);
    const d = Number(operation.distance_meters);
    if (!Number.isFinite(d) || d <= 0) {
      throw new PlanValidationError(
        'How wide should the buffer be? Give a distance in metres.',
      );
    }
    if (d > MAX_BUFFER_M) {
      throw new PlanValidationError(
        `That buffer is too wide (maximum ${MAX_BUFFER_M} m).`,
      );
    }
    const { params, bind } = this.binder();
    const t = 'tgt';
    const { where, summaryBits } = this.selectionWhere(
      t,
      target,
      operation,
      catalog,
      workspaceId,
      bind,
    );
    const metric = target.srid !== 4326;
    const dist = bind(d);
    const buffered = metric
      ? `ST_Buffer(src.g, ${dist}, 'quad_segs=8')`
      : `ST_Buffer(src.g::geography, ${dist}, 'quad_segs=8')::geometry`;
    const area = metric ? 'ST_Area(u.g)' : 'ST_Area(u.g::geography)';
    // Simplify the dissolved outline to ~2 % of the width: plenty for
    // display, and keeps the GeoJSON small.
    const tol = metric ? d / 50 : d / 50 / 111320;
    const sql =
      `WITH src AS (SELECT ${t}."${target.geomColumn}" AS g FROM "${target.table}" ${t} ` +
      (where.length ? `WHERE ${where.join(' AND ')} ` : '') +
      `LIMIT ${MAX_BUFFER_SOURCES + 1}), ` +
      `cnt AS (SELECT count(*)::int AS n FROM src), ` +
      `u AS (SELECT ST_Union(${buffered}) AS g FROM src ` +
      `WHERE (SELECT n FROM cnt) <= ${MAX_BUFFER_SOURCES}) ` +
      `SELECT (SELECT n FROM cnt) AS n, ${area}::float8 AS area, ` +
      `ST_AsGeoJSON(ST_Transform(ST_SimplifyPreserveTopology(u.g, ${tol}), 4326), 6) AS geojson FROM u`;

    return {
      sql,
      params,
      target,
      distanceM: d,
      summary: `${d} m buffer around ${target.name}${
        summaryBits.length ? ' where ' + summaryBits.join(' and ') : ''
      }.`,
    };
  }

  async execute(compiled: CompiledQuery): Promise<ExecutionResult> {
    const rows = await this.readOnly<{
      __id: number | string;
      __geojson: string;
      __rank?: number | string | null;
      __label?: string | null;
    }>(compiled.sql, compiled.params);

    let matched = rows.length;
    let cutOff = matched >= HARD_MAX_ROWS;
    // The row limit was hit: count every match so the answer gives the true
    // total ("3,119 landmarks"), not the limit ("2,000").
    if (compiled.countSql && !compiled.limitAsked && compiled.limit && rows.length >= compiled.limit) {
      const [count] = await this.readOnly<{ n: number }>(compiled.countSql, compiled.params);
      if (count && count.n > matched) {
        matched = count.n;
        cutOff = true;
      }
    }
    const rendered = rows.slice(0, MAX_RENDERED);
    const truncated = cutOff || rendered.length < matched;
    const ids = rendered.map((row) => row.__id);
    const geometries = rendered
      .map((row) => this.parseGeo(row.__geojson))
      .filter((g): g is Record<string, unknown> => g !== null);
    const ranked = compiled.ranking
      ? rendered.slice(0, 10).map((row) => ({
          label: row.__label ?? null,
          value: row.__rank == null ? null : Number(row.__rank),
        }))
      : undefined;

    return { matched, truncated, ids, geometries, ranked };
  }

  /** The column that names a feature ("Pawna River"), from the profiled
   *  data: a name column, or a text column whose value differs for every
   *  feature; values with spaces (names) before codes. */
  private labelColumn(layer: LayerCatalogEntry): CatalogColumn | undefined {
    const score = (c: CatalogColumn) =>
      (c.role === 'name' ? 2 : 0) + (c.uniquePerFeature ? 1 : 0) + (c.spaced ?? 0);
    return layer.columns
      .filter(
        (c) =>
          c.kind === 'text' &&
          (c.role === 'name' || (c.role === 'category' && c.uniquePerFeature)),
      )
      .sort((a, b) => score(b) - score(a))[0];
  }

  async runAggregate(
    compiled: CompiledAggregate,
  ): Promise<{ rows: AggregateRow[]; truncated: boolean }> {
    const rows = await this.readOnly<{
      grp: string | null;
      val: number | null;
      n: number;
    }>(compiled.sql, compiled.params);
    return {
      rows: rows.slice(0, MAX_GROUPS).map((r) => ({
        group: r.grp,
        value: r.val == null ? null : Number(r.val),
        count: Number(r.n),
      })),
      truncated: rows.length > MAX_GROUPS,
    };
  }

  /** "Nearest pumping station to each lake": for every (filtered)
   *  reference feature, its own k nearest targets — a LATERAL KNN join, so
   *  each reference uses the spatial index. Distances in metres. */
  private compileNearestPerReference(
    operation: AiGisOperation,
    catalog: LayerCatalogEntry[],
    workspaceId: string,
    target: LayerCatalogEntry,
    reference: LayerCatalogEntry,
    k: number,
    refSql: string,
    refParams: unknown[],
  ): CompiledNearest {
    const { params, bind } = this.binder();
    const s = 'src';
    const t = 'tgt';
    const srcWhere = this.referenceWhere(s, reference, operation, workspaceId, bind);
    const { where, summaryBits } = this.selectionWhere(t, target, operation, catalog, workspaceId, bind);
    const srcGeom =
      reference.srid === target.srid
        ? `${s}."${reference.geomColumn}"`
        : `ST_Transform(${s}."${reference.geomColumn}", ${target.srid})`;
    const tGeom = `${t}."${target.geomColumn}"`;
    if (target.table === reference.table) {
      where.push(`${t}."${target.pkColumn}" <> ${s}."${reference.pkColumn}"`);
    }
    const dist =
      target.srid !== 4326
        ? `ST_Distance(${tGeom}, ${srcGeom})`
        : `ST_Distance(${tGeom}::geography, ${srcGeom}::geography)`;
    const sql =
      `SELECT ${s}."${reference.pkColumn}" AS __ref_id, ` +
      `coalesce(${this.labelExpr(s, reference)}, ${s}."${reference.pkColumn}"::text) AS __ref_label, ` +
      `ST_AsGeoJSON(ST_Transform(${s}."${reference.geomColumn}", 4326), 6) AS __ref_geojson, n.* ` +
      `FROM "${reference.table}" ${s} CROSS JOIN LATERAL (` +
      `SELECT ${t}."${target.pkColumn}" AS __id, ST_AsGeoJSON(ST_Transform(${tGeom}, 4326), 6) AS __geojson, ` +
      `${this.labelExpr(t, target)} AS __label, ${dist}::float8 AS __dist ` +
      `FROM "${target.table}" ${t} ` +
      (where.length ? `WHERE ${where.join(' AND ')} ` : '') +
      `ORDER BY ${tGeom} <-> ${srcGeom} LIMIT ${k}) n ` +
      (srcWhere.length ? `WHERE ${srcWhere.join(' AND ')} ` : '') +
      `ORDER BY 2, n.__dist LIMIT ${MAX_PER_REFERENCE * k}`;
    return {
      sql,
      params,
      refSql,
      refParams,
      target,
      reference,
      perReference: true,
      summary: `${k} nearest ${target.name} to each ${reference.name}${
        summaryBits.length ? ' where ' + summaryBits.join(' and ') : ''
      }.`,
    };
  }

  /** How many reference features match (to state a capped answer honestly). */
  async referenceCount(compiled: CompiledNearest): Promise<number> {
    const [row] = await this.readOnly<{ n: number }>(compiled.refSql, compiled.refParams);
    return Number(row?.n ?? 0);
  }

  async runNearestPerReference(compiled: CompiledNearest): Promise<NearestPairRow[]> {
    const rows = await this.readOnly<{
      __ref_id: number | string;
      __ref_label: string | null;
      __ref_geojson: string | null;
      __id: number | string;
      __geojson: string;
      __label: string | null;
      __dist: number;
    }>(compiled.sql, compiled.params);
    return rows.map((r) => ({
      refId: r.__ref_id,
      refLabel: r.__ref_label,
      refGeometry: this.parseGeo(r.__ref_geojson),
      id: r.__id,
      label: r.__label,
      distanceM: Number(r.__dist),
      geometry: this.parseGeo(r.__geojson),
    }));
  }

  async runNearest(compiled: CompiledNearest): Promise<{
    reference: {
      count: number;
      label: string | null;
      geometry: Record<string, unknown> | null;
    };
    rows: NearestRow[];
  }> {
    const [ref] = await this.readOnly<{
      n: number;
      label: string | null;
      geojson: string | null;
    }>(compiled.refSql, compiled.refParams);
    if (!ref || Number(ref.n) === 0) {
      throw new PlanValidationError(
        `No feature in "${compiled.reference.name}" matches those conditions, so there is nothing to measure from.`,
      );
    }
    const rows = await this.readOnly<{
      __id: number | string;
      __geojson: string;
      __label: string | null;
      __dist: number;
    }>(compiled.sql, compiled.params);
    return {
      reference: {
        count: Number(ref.n),
        label: ref.label,
        geometry: this.parseGeo(ref.geojson),
      },
      rows: rows.map((r) => ({
        id: r.__id,
        label: r.__label,
        distanceM: Number(r.__dist),
        geometry: this.parseGeo(r.__geojson),
      })),
    };
  }

  async runBuffer(compiled: CompiledBuffer): Promise<{
    sources: number;
    areaM2: number | null;
    geometry: Record<string, unknown> | null;
  }> {
    const [row] = await this.readOnly<{
      n: number;
      area: number | null;
      geojson: string | null;
    }>(compiled.sql, compiled.params);
    const sources = Number(row?.n ?? 0);
    if (sources > MAX_BUFFER_SOURCES) {
      throw new PlanValidationError(
        `That would buffer more than ${MAX_BUFFER_SOURCES} features — narrow it down with a condition.`,
      );
    }
    return {
      sources,
      areaM2: row?.area == null ? null : Number(row.area),
      geometry: this.parseGeo(row?.geojson ?? null),
    };
  }

  /** A single location for route / service-area ends: the point-on-surface
   *  of the first feature matching the filters. */
  async resolvePoint(
    catalog: LayerCatalogEntry[],
    layerRef: string,
    filters: AiAttributeFilter[] | undefined,
    workspaceId: string,
  ): Promise<ResolvedPoint> {
    const layer = this.resolveLayer(catalog, layerRef);
    const { params, bind } = this.binder();
    const a = 'pt';
    const where = (filters ?? []).map((f) => this.attrClause(a, layer, f, bind));
    if (layer.isDemo) where.push(`${a}."gis_workspace_id" = ${bind(workspaceId)}`);
    where.push(`${a}."${layer.geomColumn}" IS NOT NULL`);
    const p = `ST_Transform(ST_PointOnSurface(${a}."${layer.geomColumn}"), 4326)`;
    const sql =
      `SELECT ST_X(${p})::float8 AS lon, ST_Y(${p})::float8 AS lat, ` +
      `coalesce(${this.labelExpr(a, layer)}, ${a}."${layer.pkColumn}"::text) AS label, ` +
      `count(*) OVER ()::int AS total ` +
      `FROM "${layer.table}" ${a} WHERE ${where.join(' AND ')} ` +
      `ORDER BY ${a}."${layer.pkColumn}" LIMIT 1`;
    const [row] = await this.readOnly<{
      lon: number;
      lat: number;
      label: string | null;
      total: number;
    }>(sql, params);
    if (!row) {
      throw new PlanValidationError(
        `No feature in "${layer.name}" matches ${
          (filters ?? []).length ? 'those conditions' : 'the request'
        }.`,
      );
    }
    return {
      layer,
      lon: Number(row.lon),
      lat: Number(row.lat),
      label: row.label ?? layer.name,
      matches: Number(row.total),
    };
  }

  /** The road layer for route / service area: the one named in the plan,
   *  else the only line layer, else the line layer that looks like roads. */
  resolveNetwork(
    catalog: LayerCatalogEntry[],
    ref: string | null | undefined,
  ): LayerCatalogEntry {
    if (ref) {
      const layer = this.resolveLayer(catalog, ref);
      if (layer.geometryType && layer.geometryType !== 'LINE') {
        throw new PlanValidationError(
          `"${layer.name}" is not a line layer, so it cannot be routed on.`,
        );
      }
      return layer;
    }
    const lines = catalog.filter((l) => l.geometryType === 'LINE');
    if (lines.length === 1) return lines[0];
    const roads = lines.filter((l) =>
      /road|street|network|highway/i.test(`${l.name} ${l.code}`),
    );
    if (roads.length >= 1) return roads[0];
    throw new PlanValidationError(
      lines.length
        ? `Which road layer should I route on? Line layers: ${lines
            .map((l) => l.name)
            .join(', ')}.`
        : 'There is no road (line) layer to route on.',
    );
  }

  /** ECQL feature filter for the Attribute Table + WMS render — GeoServer's
   *  `IN ('<layer>.<fid>', ...)` feature-id form (the PK is consumed as the
   *  feature id and is not exposed as a queryable attribute). `null` when
   *  nothing matched. */
  /** Count + extent of an exact (condition-filtered) selection. */
  async summarize(
    compiled: CompiledQuery,
  ): Promise<{ matched: number; bbox: [number, number, number, number] | null }> {
    if (!compiled.extentSql) throw new Error('summarize() needs a select compiled by compile()');
    const [row] = await this.readOnly<{ n: number; minx: number | null; miny: number | null; maxx: number | null; maxy: number | null }>(
      compiled.extentSql,
      compiled.params,
    );
    const bbox =
      row && row.minx != null && row.miny != null && row.maxx != null && row.maxy != null
        ? ([row.minx, row.miny, row.maxx, row.maxy] as [number, number, number, number])
        : null;
    return { matched: row?.n ?? 0, bbox };
  }

  /**
   * The plan's selection as an ECQL filter GeoServer applies itself — on
   * the WMS map layer and the Attribute Table's WFS — so every match shows
   * (not the first 450 ids) and no geometries travel to the browser.
   * Field names are validated against the catalog and values coerced and
   * quoted exactly like the SQL path. Returns null whenever the result
   * would not be EXACTLY the SQL selection (an explicit limit / sort, a
   * demo table, a distance filter without GeoServer's querylayer
   * extension or across CRSs, "within" on non-point layers); the caller
   * then falls back to the id filter.
   */
  conditionCql(
    operation: AiGisOperation,
    catalog: LayerCatalogEntry[],
    opts: { queryLayer: boolean },
  ): string | null {
    if (operation.limit != null || operation.order_by) return null;
    const target = this.resolveLayer(catalog, operation.target_layer);
    if (target.isDemo) return null;
    const parts: string[] = [];
    for (const filter of operation.attribute_filters ?? []) {
      const clause = this.attrCql(target, filter);
      if (clause === null) return null;
      parts.push(clause);
    }
    for (const sf of [operation.spatial_filter, ...(operation.spatial_filters ?? [])]) {
      if (!sf) continue;
      const clause = this.spatialCql(target, sf, catalog, opts);
      if (clause === null) return null;
      parts.push(clause);
    }
    return parts.length ? parts.map((p) => `(${p})`).join(' AND ') : 'INCLUDE';
  }

  private cqlValue(col: CatalogColumn, raw: unknown): string {
    const v = this.coerce(col, raw, col.name);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  }

  private attrCql(layer: LayerCatalogEntry, filter: AiAttributeFilter): string | null {
    const col = this.findColumn(layer, filter.field);
    const name = `"${col.name}"`;
    if (filter.op === 'is_null') return `${name} IS NULL`;
    if (filter.op === 'is_not_null') return `${name} IS NOT NULL`;
    if (filter.op === 'in' || filter.op === 'not_in') {
      const list = this.valueList(filter);
      if (list.length === 0) return null;
      const inList = `${name} IN (${list.map((v) => this.cqlValue(col, v)).join(', ')})`;
      // SQL's NOT IN never matches NULL; GeoServer's would — keep them equal.
      return filter.op === 'in' ? inList : `NOT (${inList}) AND ${name} IS NOT NULL`;
    }
    if (filter.op === 'between') {
      if (filter.value == null || filter.value2 == null) return null;
      return `${name} BETWEEN ${this.cqlValue(col, filter.value)} AND ${this.cqlValue(col, filter.value2)}`;
    }
    if (filter.op === 'like' || filter.op === 'ilike') {
      if (col.kind !== 'text') return null; // the SQL casts to text; ECQL cannot
      const raw = String(filter.value ?? '');
      const pattern = raw.includes('%') ? raw : `%${raw}%`;
      return `${name} ${filter.op === 'ilike' ? 'ILIKE' : 'LIKE'} '${pattern.replace(/'/g, "''")}'`;
    }
    const op = COMPARISON[filter.op];
    if (!op || filter.value == null) return null;
    // SQL's <> never matches NULL; GeoServer's would (3,120 vs 3,119).
    if (op === '<>') return `${name} <> ${this.cqlValue(col, filter.value)} AND ${name} IS NOT NULL`;
    return `${name} ${op} ${this.cqlValue(col, filter.value)}`;
  }

  /** Distance to / overlap with ANOTHER layer, evaluated by GeoServer:
   *  collectGeometries(queryCollection(...)) needs the querylayer
   *  extension. DWITHIN (distance) is used for every relation because
   *  it handles a geometry collection reliably; a distance of 0 is
   *  "touches or overlaps", which equals "within" only for points. */
  private spatialCql(
    target: LayerCatalogEntry,
    sf: NonNullable<AiGisOperation['spatial_filter']>,
    catalog: LayerCatalogEntry[],
    opts: { queryLayer: boolean },
  ): string | null {
    if (!opts.queryLayer) return null;
    const ref = this.resolveLayer(catalog, sf.reference_layer);
    if (ref.isDemo || ref.srid !== target.srid || target.srid === 4326) return null;
    const inner: string[] = [];
    for (const filter of sf.reference_filters ?? []) {
      const clause = this.attrCql(ref, filter);
      if (clause === null) return null;
      inner.push(clause);
    }
    const innerCql = inner.length ? inner.join(' AND ') : 'INCLUDE';
    const collection =
      `collectGeometries(queryCollection('${ref.geoserverWorkspace}:${ref.geoserverLayer}', ` +
      `'${ref.geomColumn}', '${innerCql.replace(/'/g, "''")}'))`;
    const geom = `"${target.geomColumn}"`;
    const d = Number(sf.distance_meters);
    const hasDistance = Number.isFinite(d) && d > 0;
    if (hasDistance && d > MAX_DISTANCE_M) return null;
    switch (sf.relation) {
      case 'within_distance':
        if (hasDistance) return `DWITHIN(${geom}, ${collection}, ${d}, meters)`;
        return target.geometryType === 'POINT' ? `DWITHIN(${geom}, ${collection}, 0, meters)` : null;
      case 'within':
        return target.geometryType === 'POINT' ? `DWITHIN(${geom}, ${collection}, 0, meters)` : null;
      case 'intersects':
        return `DWITHIN(${geom}, ${collection}, 0, meters)`;
      case 'disjoint':
        return `NOT DWITHIN(${geom}, ${collection}, ${hasDistance ? d : 0}, meters)`;
      default:
        return null;
    }
  }

  buildCql(target: LayerCatalogEntry, ids: (number | string)[]): string | null {
    if (ids.length === 0) return null;
    // Numeric keys: filter on the key column with ranges ("ogc_fid BETWEEN
    // 1 AND 450 OR ogc_fid IN (512,530)"). The feature-id form below costs
    // ~16 characters per id, and 450 ids made the WFS/WMS GET URL ~8 KB —
    // over GeoServer's limit, so the Attribute Table and the map highlight
    // failed with "Could not reach the GIS server".
    const numeric = ids.map((id) => Number(id));
    if (numeric.every((n) => Number.isInteger(n))) {
      const sorted = [...new Set(numeric)].sort((a, b) => a - b);
      const ranges: string[] = [];
      const singles: number[] = [];
      for (let i = 0; i < sorted.length; ) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
        if (j - i >= 2) ranges.push(`"${target.pkColumn}" BETWEEN ${sorted[i]} AND ${sorted[j]}`);
        else for (let k = i; k <= j; k++) singles.push(sorted[k]);
        i = j + 1;
      }
      const parts = [...ranges];
      if (singles.length) parts.push(`"${target.pkColumn}" IN (${singles.join(',')})`);
      const cql = parts.join(' OR ');
      if (cql.length <= MAX_CQL_CHARS) return cql;
    }
    // Feature ids, as many as fit in a safe URL length (the rest are still
    // on the map highlight and in the answer's count).
    const list: string[] = [];
    let length = 5;
    for (const id of ids) {
      const item = `'${target.geoserverLayer}.${String(id).replace(/'/g, "''")}'`;
      if (length + item.length + 1 > MAX_CQL_CHARS) break;
      list.push(item);
      length += item.length + 1;
    }
    return `IN (${list.join(',')})`;
  }

  // --------------------------------------------------------------------

  /** Every compiled statement runs here: one read-only transaction with a
   *  statement timeout, parameters bound — never interpolated. */
  private async readOnly<T>(sql: string, params: unknown[]): Promise<T[]> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '20s'");
        return tx.$queryRawUnsafe<T[]>(sql, ...params);
      },
      { timeout: 25000, maxWait: 5000 },
    );
  }

  private binder(): { params: unknown[]; bind: Bind } {
    const params: unknown[] = [];
    return {
      params,
      bind: (value: unknown) => {
        params.push(value);
        return `$${params.length}`;
      },
    };
  }

  /** WHERE clauses selecting the operation's starting features: its
   *  attribute filters, its optional spatial filter (EXISTS subquery) and
   *  the workspace scope of the shared demo tables. */
  private selectionWhere(
    t: string,
    target: LayerCatalogEntry,
    operation: AiGisOperation,
    catalog: LayerCatalogEntry[],
    workspaceId: string,
    bind: Bind,
  ): { where: string[]; summaryBits: string[] } {
    const where: string[] = [];
    const summaryBits: string[] = [];

    for (const filter of operation.attribute_filters ?? []) {
      where.push(this.attrClause(t, target, filter, bind));
    }
    if (target.isDemo) {
      where.push(`${t}."gis_workspace_id" = ${bind(workspaceId)}`);
    }
    if ((operation.attribute_filters ?? []).length > 0) {
      summaryBits.push(
        `${operation.attribute_filters!.length} attribute condition(s)`,
      );
    }

    const spatial = [operation.spatial_filter, ...(operation.spatial_filters ?? [])].filter(
      (sf): sf is NonNullable<AiGisOperation['spatial_filter']> => !!sf,
    );
    spatial.forEach((sf, i) => {
      const ref = this.resolveLayer(catalog, sf.reference_layer);
      const r = i === 0 ? 'ref' : `ref${i}`;

      const subWhere: string[] = [this.spatialPredicate(t, target, r, ref, sf, bind)];
      for (const filter of sf.reference_filters ?? []) {
        subWhere.push(this.attrClause(r, ref, filter, bind));
      }
      if (ref.isDemo) {
        subWhere.push(`${r}."gis_workspace_id" = ${bind(workspaceId)}`);
      }

      const negate = sf.relation === 'disjoint';
      where.push(
        `${negate ? 'NOT ' : ''}EXISTS (SELECT 1 FROM "${ref.table}" ${r} WHERE ${subWhere.join(
          ' AND ',
        )})`,
      );
      summaryBits.push(
        `${sf.relation}${
          sf.distance_meters ? ` ${sf.distance_meters} m` : ''
        } of ${ref.name}`,
      );
    });
    return { where, summaryBits };
  }

  private referenceWhere(
    r: string,
    reference: LayerCatalogEntry,
    operation: AiGisOperation,
    workspaceId: string,
    bind: Bind,
  ): string[] {
    const where = (operation.reference_filters ?? []).map((f) =>
      this.attrClause(r, reference, f, bind),
    );
    if (reference.isDemo) {
      where.push(`${r}."gis_workspace_id" = ${bind(workspaceId)}`);
    }
    return where;
  }

  /** A numeric column, or the geometry's length / area in metres when the
   *  plan names one the layer does not have ("total road length"). */
  private measureExpr(
    t: string,
    layer: LayerCatalogEntry,
    field: string,
  ): { expr: string; label: string } {
    const needle = field.trim().toLowerCase();
    const col =
      layer.columns.find((c) => c.name.toLowerCase() === needle) ??
      layer.columns.find(
        (c) => c.name.toLowerCase().replace(/_/g, '') === needle.replace(/_/g, ''),
      );
    if (col) {
      if (col.kind !== 'integer' && col.kind !== 'number') {
        throw new PlanValidationError(
          `"${col.name}" is not numeric. Numeric fields of "${layer.name}": ${this.numericNames(layer)}.`,
        );
      }
      return { expr: `${t}."${col.name}"`, label: col.name };
    }
    const g = `${t}."${layer.geomColumn}"`;
    const metric = layer.srid !== 4326;
    if (GEOMETRY_LENGTH.test(needle) && layer.geometryType === 'LINE') {
      return {
        expr: metric ? `ST_Length(${g})` : `ST_Length(${g}::geography)`,
        label: 'length (m)',
      };
    }
    if (GEOMETRY_AREA.test(needle) && layer.geometryType === 'POLYGON') {
      return {
        expr: metric ? `ST_Area(${g})` : `ST_Area(${g}::geography)`,
        label: 'area (m²)',
      };
    }
    throw new PlanValidationError(
      `Layer "${layer.name}" has no numeric field "${field}". Numeric fields: ${this.numericNames(layer)}.`,
    );
  }

  private numericNames(layer: LayerCatalogEntry): string {
    const names = layer.columns
      .filter(
        (c) =>
          (c.kind === 'integer' || c.kind === 'number') &&
          c.name !== 'ogc_fid' &&
          c.name !== 'id',
      )
      .map((c) => c.name);
    if (layer.geometryType === 'LINE') names.push('length');
    if (layer.geometryType === 'POLYGON') names.push('area');
    return names.length ? names.join(', ') : 'none';
  }

  /** Text columns are sampled when the catalog is built; none sampled means
   *  the column is empty. Non-text columns are assumed populated. */
  private hasValues(col: CatalogColumn): boolean {
    return col.kind !== 'text' || col.sampleValues.length > 0;
  }

  /** How people name one area of `layer`: its number column when it has
   *  one ("zone 13" -> zone_no, "ward 5" -> ward_no), else a populated
   *  name-like column, else any populated text column. */
  private areaLabelColumn(layer: LayerCatalogEntry): CatalogColumn | null {
    const stem = layer.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/s$/, '');
    const numbered = layer.columns.find((c) =>
      [`${stem}_no`, `${stem}no`, `${stem}_number`, `${stem}_num`].includes(c.name.toLowerCase()),
    );
    if (numbered) return numbered;
    const text = layer.columns.filter(
      (c) => c.kind === 'text' && c.name !== 'gis_workspace_id' && this.hasValues(c),
    );
    return text.find((c) => LABEL_COLUMN.test(c.name)) ?? text[0] ?? null;
  }

  /** SQL naming one feature for a person: its first non-empty name-like
   *  column, else a text identifier (valve_id, gisid), else null. */
  private labelExpr(alias: string, layer: LayerCatalogEntry): string {
    const text = layer.columns.filter(
      (c) => c.kind === 'text' && c.name !== 'gis_workspace_id',
    );
    const picks = [
      ...text.filter((c) => LABEL_COLUMN.test(c.name)),
      ...text.filter((c) => ID_COLUMN.test(c.name)),
    ].slice(0, 4);
    if (picks.length === 0) return 'NULL::text';
    return `coalesce(${picks
      .map((c) => `nullif(trim(${alias}."${c.name}"::text), '')`)
      .join(', ')})`;
  }

  private parseGeo(text: string | null): Record<string, unknown> | null {
    if (!text) return null;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private resolveLayer(
    catalog: LayerCatalogEntry[],
    ref: string,
  ): LayerCatalogEntry {
    const needle = ref.trim().toLowerCase();
    const exact =
      catalog.find((l) => l.code.toLowerCase() === needle) ??
      catalog.find((l) => l.name.toLowerCase() === needle) ??
      catalog.find((l) => l.layerId === ref);
    if (exact) return exact;
    const partial = catalog.filter(
      (l) =>
        l.name.toLowerCase().includes(needle) ||
        needle.includes(l.name.toLowerCase()) ||
        l.code.toLowerCase().includes(needle),
    );
    if (partial.length === 1) return partial[0];
    throw new PlanValidationError(
      `I couldn't match "${ref}" to one of your layers (${catalog
        .map((l) => l.name)
        .join(', ')}).`,
    );
  }

  private findColumn(
    layer: LayerCatalogEntry,
    fieldName: string,
  ): CatalogColumn {
    const needle = fieldName.trim().toLowerCase();
    const col =
      layer.columns.find((c) => c.name.toLowerCase() === needle) ??
      layer.columns.find((c) => c.name.toLowerCase().replace(/_/g, '') === needle.replace(/_/g, ''));
    if (!col) {
      throw new UnknownFieldError(layer, fieldName);
    }
    return col;
  }

  private coerce(col: CatalogColumn, raw: unknown, label: string): unknown {
    if (col.kind === 'integer' || col.kind === 'id') {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new PlanValidationError(`"${label}" needs a number.`);
      }
      return Math.trunc(n);
    }
    if (col.kind === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new PlanValidationError(`"${label}" needs a number.`);
      }
      return n;
    }
    if (col.kind === 'boolean') {
      return /^(true|1|yes|y)$/i.test(String(raw));
    }
    return String(raw);
  }

  private attrClause(
    alias: string,
    layer: LayerCatalogEntry,
    filter: AiAttributeFilter,
    bind: Bind,
  ): string {
    const col = this.findColumn(layer, filter.field);
    const ref = `${alias}."${col.name}"`;

    if (filter.op === 'is_null') return `${ref} IS NULL`;
    if (filter.op === 'is_not_null') return `${ref} IS NOT NULL`;

    if (filter.op === 'in' || filter.op === 'not_in') {
      const list = this.valueList(filter);
      if (list.length === 0) {
        throw new PlanValidationError(`"${col.name}" needs at least one value.`);
      }
      const placeholders = list
        .map((v) => bind(this.coerce(col, v, col.name)))
        .join(', ');
      return `${ref} ${filter.op === 'in' ? 'IN' : 'NOT IN'} (${placeholders})`;
    }

    if (filter.op === 'between') {
      if (filter.value == null || filter.value2 == null) {
        throw new PlanValidationError(
          `"${col.name}" BETWEEN needs a lower and an upper value.`,
        );
      }
      return `${ref} BETWEEN ${bind(
        this.coerce(col, filter.value, col.name),
      )} AND ${bind(this.coerce(col, filter.value2, col.name))}`;
    }

    if (filter.op === 'like' || filter.op === 'ilike') {
      const raw = String(filter.value ?? '');
      const pattern = raw.includes('%') ? raw : `%${raw}%`;
      return `${ref}::text ${filter.op === 'ilike' ? 'ILIKE' : 'LIKE'} ${bind(
        pattern,
      )}`;
    }

    const sqlOp = COMPARISON[filter.op];
    if (!sqlOp) {
      throw new PlanValidationError(`Unsupported operator "${filter.op}".`);
    }
    if (filter.value == null) {
      throw new PlanValidationError(`"${col.name}" ${filter.op} needs a value.`);
    }
    return `${ref} ${sqlOp} ${bind(this.coerce(col, filter.value, col.name))}`;
  }

  private valueList(filter: AiAttributeFilter): (string | number | boolean)[] {
    if (Array.isArray(filter.values) && filter.values.length > 0) {
      return filter.values;
    }
    if (typeof filter.value === 'string') {
      return filter.value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    if (filter.value != null) return [filter.value];
    return [];
  }

  private spatialPredicate(
    tAlias: string,
    target: LayerCatalogEntry,
    rAlias: string,
    ref: LayerCatalogEntry,
    sf: NonNullable<AiGisOperation['spatial_filter']>,
    bind: Bind,
  ): string {
    const tGeom = `${tAlias}."${target.geomColumn}"`;
    const rGeomRaw = `${rAlias}."${ref.geomColumn}"`;
    // ref geometry aligned to the target CRS (SRIDs are validated integers
    // read from geometry_columns, never user input).
    const rGeom =
      ref.srid === target.srid
        ? rGeomRaw
        : `ST_Transform(${rGeomRaw}, ${target.srid})`;

    const hasDistance =
      sf.distance_meters != null && Number(sf.distance_meters) > 0;
    // A small local model sometimes emits `within_distance` with a 0/absent
    // distance when the user means plain containment ("signals in zone 12").
    // Treat that as `within` rather than rejecting it.
    if (sf.relation === 'within_distance' && !hasDistance) {
      // "in zone 12" said as within_distance: containment is right for a
      // polygon reference. For points / lines ST_Within is almost always
      // empty ("signals near landmarks" returned 0) — ask for a distance.
      if (ref.geometryType !== 'POLYGON') throw new DistanceNeededError(ref.name);
      return `ST_Within(${tGeom}, ${rGeom})`;
    }

    const wantsDistance =
      sf.relation === 'within_distance' ||
      (sf.relation === 'disjoint' && sf.distance_meters != null);

    if (wantsDistance) {
      const d = Number(sf.distance_meters);
      if (!Number.isFinite(d) || d <= 0) {
        throw new PlanValidationError(
          'A proximity query needs a positive distance in metres.',
        );
      }
      if (d > MAX_DISTANCE_M) {
        throw new PlanValidationError(
          `That distance is too large (maximum ${MAX_DISTANCE_M} m).`,
        );
      }
      if (target.srid !== 4326 && ref.srid === target.srid) {
        // fast path — projected CRS in metres, GIST-index friendly
        return `ST_DWithin(${tGeom}, ${rGeomRaw}, ${bind(d)})`;
      }
      return `ST_DWithin(ST_Transform(${tGeom}, 4326)::geography, ST_Transform(${rGeomRaw}, 4326)::geography, ${bind(
        d,
      )})`;
    }

    switch (sf.relation) {
      case 'intersects':
      case 'disjoint': // NOT EXISTS wraps this
        return `ST_Intersects(${tGeom}, ${rGeom})`;
      case 'within':
        return `ST_Within(${tGeom}, ${rGeom})`;
      case 'contains':
        return `ST_Contains(${tGeom}, ${rGeom})`;
      default:
        throw new PlanValidationError(
          `Unsupported spatial relation "${sf.relation}".`,
        );
    }
  }

  private clampLimit(requested: number | null | undefined): number {
    if (requested == null || !Number.isFinite(requested)) return DEFAULT_ROWS;
    return Math.min(Math.max(1, Math.trunc(requested)), HARD_MAX_ROWS);
  }
}
