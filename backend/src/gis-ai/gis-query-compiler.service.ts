import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
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

const HARD_MAX_ROWS = 5000;
const DEFAULT_ROWS = 2000;
// Matched feature ids go into a GeoServer CQL_FILTER carried on a WMS/WFS
// GET URL; keep the list short enough that the URL stays well under ~8 KB.
// The map highlight uses the same capped set so it matches the Attribute
// Table exactly.
const MAX_RENDERED = 450;
const MAX_DISTANCE_M = 50000;

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
}

export interface ExecutionResult {
  matched: number;
  truncated: boolean;
  /** target-layer primary key values of the matched features (capped). */
  ids: (number | string)[];
  /** matched geometries, EPSG:4326 GeoJSON (capped). */
  geometries: Record<string, unknown>[];
}

@Injectable()
export class GisQueryCompilerService {
  private readonly logger = new Logger(GisQueryCompilerService.name);

  constructor(private readonly prisma: PrismaService) {}

  compile(
    operation: AiGisOperation,
    catalog: LayerCatalogEntry[],
    workspaceId: string,
  ): CompiledQuery {
    if (operation.kind !== 'select') {
      throw new PlanValidationError(
        'Only feature-selection queries are supported right now.',
      );
    }
    const target = this.resolveLayer(catalog, operation.target_layer);
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    const t = 'tgt';
    const where: string[] = [];

    for (const filter of operation.attribute_filters ?? []) {
      where.push(this.attrClause(t, target, filter, bind));
    }
    if (target.isDemo) {
      where.push(`${t}."gis_workspace_id" = ${bind(workspaceId)}`);
    }

    const summaryBits: string[] = [];
    if ((operation.attribute_filters ?? []).length > 0) {
      summaryBits.push(
        `${operation.attribute_filters!.length} attribute condition(s)`,
      );
    }

    if (operation.spatial_filter) {
      const sf = operation.spatial_filter;
      const ref = this.resolveLayer(catalog, sf.reference_layer);
      const r = 'ref';

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
    }

    const limit = this.clampLimit(operation.limit);
    const sql =
      `SELECT ${t}."${target.pkColumn}" AS __id, ` +
      `ST_AsGeoJSON(ST_Transform(${t}."${target.geomColumn}", 4326), 6) AS __geojson ` +
      `FROM "${target.table}" ${t} ` +
      (where.length ? `WHERE ${where.join(' AND ')} ` : '') +
      `LIMIT ${limit}`;

    return {
      sql,
      params,
      target,
      summary: `Select from ${target.name}${
        summaryBits.length ? ' where ' + summaryBits.join(' and ') : ''
      }.`,
    };
  }

  async execute(compiled: CompiledQuery): Promise<ExecutionResult> {
    const rows = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '20s'");
        return tx.$queryRawUnsafe<{ __id: number | string; __geojson: string }[]>(
          compiled.sql,
          ...compiled.params,
        );
      },
      { timeout: 25000, maxWait: 5000 },
    );

    const matched = rows.length;
    const rendered = rows.slice(0, MAX_RENDERED);
    const truncated = matched >= HARD_MAX_ROWS || rendered.length < matched;
    const ids = rendered.map((row) => row.__id);
    const geometries = rendered
      .map((row) => {
        try {
          return JSON.parse(row.__geojson) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((g): g is Record<string, unknown> => g !== null);

    return { matched, truncated, ids, geometries };
  }

  /** ECQL feature filter for the Attribute Table + WMS render — GeoServer's
   *  `IN ('<layer>.<fid>', ...)` feature-id form (the PK is consumed as the
   *  feature id and is not exposed as a queryable attribute). `null` when
   *  nothing matched. */
  buildCql(target: LayerCatalogEntry, ids: (number | string)[]): string | null {
    if (ids.length === 0) return null;
    const list = ids
      .map(
        (id) =>
          `'${target.geoserverLayer}.${String(id).replace(/'/g, "''")}'`,
      )
      .join(',');
    return `IN (${list})`;
  }

  // --------------------------------------------------------------------

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
      throw new PlanValidationError(
        `Layer "${layer.name}" has no field "${fieldName}". Available fields: ${layer.columns
          .map((c) => c.name)
          .join(', ')}.`,
      );
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
    bind: (v: unknown) => string,
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
    bind: (v: unknown) => string,
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
