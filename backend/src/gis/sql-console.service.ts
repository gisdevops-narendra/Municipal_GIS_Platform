import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import AdmZip from 'adm-zip';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import { loadModule, parseSync } from 'libpg-query';
import type { AppUser } from '../auth/types/app-user.type';
import { PlatformSettingsService } from '../platform/platform-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { GdalService } from './gdal.service';
import { GisLayersService } from './gis-layers.service';
import { RasterService } from './raster.service';

/** Admin → Modules switch for this tool. */
export const SQL_CONSOLE_TOOL_ID = 'sql';

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;
const STATEMENT_TIMEOUT_MS = 20_000;
const MAX_SQL_LENGTH = 20_000;
/** Save as layer / export run the whole query. */
const SAVE_TIMEOUT_MS = 120_000;

/** Functions a console query may call: PostGIS (st_*) plus ordinary
 *  aggregate, window, math, text, date and JSON helpers. Anything else —
 *  set_config, pg_* admin functions, dblink, lo_*, query_to_xml … — is
 *  refused, so a query can only read the layers it names. */
const ALLOWED_FUNCTIONS = new Set([
  // aggregates
  'count', 'sum', 'avg', 'min', 'max', 'string_agg', 'array_agg', 'bool_and', 'bool_or', 'every',
  'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp', 'corr',
  'percentile_cont', 'percentile_disc', 'mode', 'json_agg', 'jsonb_agg', 'json_object_agg', 'jsonb_object_agg',
  // window
  'row_number', 'rank', 'dense_rank', 'ntile', 'lag', 'lead', 'first_value', 'last_value', 'nth_value',
  'cume_dist', 'percent_rank',
  // math
  'abs', 'round', 'ceil', 'ceiling', 'floor', 'trunc', 'sqrt', 'cbrt', 'power', 'pow', 'exp', 'ln', 'log', 'log10',
  'mod', 'sign', 'pi', 'degrees', 'radians', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'random', 'width_bucket',
  // text
  'lower', 'upper', 'initcap', 'length', 'char_length', 'character_length', 'octet_length', 'substring', 'substr',
  'trim', 'btrim', 'ltrim', 'rtrim', 'replace', 'translate', 'concat', 'concat_ws', 'left', 'right', 'split_part',
  'position', 'strpos', 'lpad', 'rpad', 'repeat', 'reverse', 'format', 'md5', 'starts_with',
  'regexp_replace', 'regexp_match', 'regexp_matches', 'regexp_split_to_array', 'regexp_split_to_table', 'regexp_count',
  'string_to_array', 'array_to_string', 'array_length', 'cardinality', 'unnest', 'to_char', 'to_number', 'to_date',
  'to_timestamp', 'similarity', 'word_similarity',
  // date / time
  'now', 'date_trunc', 'date_part', 'extract', 'age', 'make_date', 'make_timestamp', 'make_interval',
  'justify_days', 'justify_hours', 'timezone', 'clock_timestamp', 'current_date', 'statement_timestamp',
  // json
  'json_build_object', 'jsonb_build_object', 'json_build_array', 'jsonb_build_array', 'to_json', 'to_jsonb',
  'json_extract_path_text', 'jsonb_extract_path_text', 'jsonb_array_elements', 'json_array_elements',
  'jsonb_each', 'json_each', 'jsonb_object_keys', 'json_object_keys', 'jsonb_typeof', 'jsonb_pretty',
  // misc
  'generate_series', 'num_nulls', 'num_nonnulls', 'geometrytype', 'box2d', 'box3d',
]);

/** Parse-tree nodes a read-only console query never needs. */
const FORBIDDEN_NODES: Record<string, string> = {
  InsertStmt: 'INSERT', UpdateStmt: 'UPDATE', DeleteStmt: 'DELETE', MergeStmt: 'MERGE',
  IntoClause: 'SELECT … INTO', LockingClause: 'FOR UPDATE / FOR SHARE', TableFunc: 'XMLTABLE / JSON_TABLE',
  XmlExpr: 'XML functions', XmlSerialize: 'XMLSERIALIZE',
};

/** Words that can't be a bare table name, so a layer called "Order" gets
 *  the alias order_layer. */
const RESERVED = new Set(
  ('all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create ' +
    'current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc ' +
    'distinct do else end except false fetch for foreign from grant group having in initially intersect into lateral ' +
    'leading limit localtime localtimestamp not null offset on only or order placing primary references returning ' +
    'select session_user some symmetric system_user table then to trailing true union unique user using variadic when ' +
    'where window with join left right inner outer full cross natural is isnull notnull like ilike similar verbose ' +
    'freeze overlaps tablesample between').split(' '),
);

interface ConsoleTable {
  alias: string;
  layerId: string;
  name: string;
  geometryType: string | null;
  from: string;
  table: string;
}

class Rollback {
  constructor(readonly result: unknown) {}
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

function aliasFor(name: string): string {
  let a = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!a) a = 'layer';
  if (/^\d/.test(a)) a = `l_${a}`;
  if (RESERVED.has(a)) a = `${a}_layer`;
  return a.slice(0, 60);
}

function pgErrorMessage(err: unknown): string {
  const e = err as { meta?: { message?: string }; message?: string };
  const raw = e?.meta?.message ?? e?.message ?? 'The query failed.';
  const m = /Message: `([\s\S]*?)`/.exec(raw);
  return (m ? m[1] : raw).replace(/^ERROR:\s*/, '').slice(0, 500);
}

/**
 * SQL Console: read-only SELECT queries over the layers the caller may view.
 * Layers are referenced by an alias (shown in the panel); each becomes a CTE
 * over its workspace-filtered table. The text is parsed with PostgreSQL's own
 * parser and refused unless it is one SELECT that reads only those aliases
 * (or its own CTEs) and calls only allowed functions. It then runs in a
 * transaction with a statement timeout and is always rolled back.
 */
@Injectable()
export class SqlConsoleService {
  private parserReady: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gisLayers: GisLayersService,
    private readonly settings: PlatformSettingsService,
    private readonly raster: RasterService,
    private readonly gdal: GdalService,
    private readonly config: ConfigService,
  ) {}

  private async assertEnabled(appUser: AppUser): Promise<void> {
    const m = await this.settings.get('modules');
    const off = [...(m.global ?? []), ...(m.perAccount?.[appUser.municipalityId] ?? [])];
    if (off.includes(SQL_CONSOLE_TOOL_ID)) throw new ForbiddenException('The SQL Console is switched off.');
  }

  /** Vector layers the caller can view, with stable aliases. */
  private async consoleTables(appUser: AppUser): Promise<ConsoleTable[]> {
    const workspace = await this.prisma.gISWorkspace.findUnique({ where: { municipalityId: appUser.municipalityId } });
    if (!workspace) throw new NotFoundException('GIS workspace not found.');
    const layers = await this.prisma.gISLayer.findMany({
      where: { gisWorkspaceId: workspace.id, status: 'ACTIVE', layerType: 'VECTOR' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const used = new Set<string>();
    const out: ConsoleTable[] = [];
    for (const l of layers) {
      let src: { table: string; from: string };
      try {
        src = await this.gisLayers.vectorSource(appUser, l.id, 'view');
      } catch {
        continue; // not viewable / no PostGIS data
      }
      const base = aliasFor(l.name);
      let alias = base;
      for (let i = 2; used.has(alias); i++) alias = `${base}_${i}`;
      used.add(alias);
      out.push({ alias, layerId: l.id, name: l.name, geometryType: l.geometryType ?? null, from: src.from, table: src.table });
    }
    return out;
  }

  async tables(appUser: AppUser) {
    await this.assertEnabled(appUser);
    const tables = await this.consoleTables(appUser);
    const cols = tables.length
      ? await this.prisma.$queryRawUnsafe<{ table_name: string; column_name: string; udt_name: string }[]>(
          `SELECT table_name, column_name, udt_name FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = ANY($1::text[]) ORDER BY table_name, ordinal_position`,
          [...new Set(tables.map((t) => t.table))],
        )
      : [];
    return tables.map((t) => ({
      alias: t.alias,
      layerId: t.layerId,
      name: t.name,
      geometryType: t.geometryType,
      fields: cols
        .filter((c) => c.table_name === t.table && c.column_name !== 'gis_workspace_id')
        .map((c) => ({ name: c.column_name, type: c.udt_name })),
    }));
  }

  private async parse(sql: string): Promise<{ stmts: { stmt: Record<string, unknown>; stmt_location?: number; stmt_len?: number }[] }> {
    this.parserReady ??= Promise.resolve(loadModule());
    await this.parserReady;
    try {
      return parseSync(sql) as never;
    } catch (err) {
      const e = err as { message: string; sqlDetails?: { cursorPosition?: number } };
      throw fail(`Syntax error: ${e.message}`, e.sqlDetails?.cursorPosition);
    }
  }

  /** Throws unless the tree is a plain read of allowed tables/functions;
   *  returns the layer aliases it reads and the query's own CTE names. */
  private check(tree: unknown, aliases: Set<string>): { used: Set<string>; ctes: Set<string> } {
    const ctes = new Set<string>();
    const collect = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(collect);
      if (!n || typeof n !== 'object') return;
      for (const [k, v] of Object.entries(n)) {
        if (k === 'CommonTableExpr' && v && typeof (v as { ctename?: unknown }).ctename === 'string') {
          ctes.add((v as { ctename: string }).ctename);
        }
        collect(v);
      }
    };
    collect(tree);

    const used = new Set<string>();
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      for (const [k, v] of Object.entries(n)) {
        const loc = (v as { location?: number } | null)?.location;
        if (k in FORBIDDEN_NODES) throw fail(`${FORBIDDEN_NODES[k]} is not allowed — the SQL Console is read-only.`, loc);
        if ((k === 'intoClause' || k === 'lockingClause') && v) {
          throw fail('SELECT … INTO and FOR UPDATE are not allowed — the SQL Console is read-only.');
        }
        if (k === 'RangeVar') {
          const rv = v as { schemaname?: string; catalogname?: string; relname: string };
          if (rv.schemaname || rv.catalogname) {
            throw fail(`"${rv.schemaname}.${rv.relname}": use the layer names listed in the panel, without a schema.`, loc);
          }
          // A layer alias always gets its own outer CTE, even when the query
          // also defines a WITH of that name, so no scope falls through to a
          // real table.
          if (aliases.has(rv.relname)) {
            used.add(rv.relname);
          } else if (!ctes.has(rv.relname)) {
            throw fail(`Unknown table "${rv.relname}". Use one of the layer names listed in the panel.`, loc);
          }
        }
        if (k === 'FuncCall') {
          const names = ((v as { funcname?: { String?: { sval?: string } }[] }).funcname ?? []).map((p) => p.String?.sval ?? '');
          const fn = (names[names.length - 1] ?? '').toLowerCase();
          const schemaOk = names.length === 1 || (names.length === 2 && names[0] === 'pg_catalog');
          if (!schemaOk || !(fn.startsWith('st_') || ALLOWED_FUNCTIONS.has(fn))) {
            throw fail(`Function "${names.join('.')}" is not available in the SQL Console.`, loc);
          }
        }
        walk(v);
      }
    };
    walk(tree);
    return { used, ctes };
  }

  /** A WITH name that matches a real table could be referenced outside its
   *  own scope, where PostgreSQL would read the real table instead. */
  private async assertCteNamesFree(ctes: Set<string>, aliases: Set<string>): Promise<void> {
    const names = [...ctes].filter((n) => !aliases.has(n));
    if (!names.length) return;
    const clash = await this.prisma.$queryRawUnsafe<{ relname: string }[]>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = ANY($1::text[]) AND (n.nspname = ANY(current_schemas(true)) OR n.nspname LIKE 'pg_temp%')
        LIMIT 1`,
      names,
    );
    if (clash.length) throw fail(`Choose another name for WITH "${clash[0].relname}".`);
  }

  /** Validates the text and returns it wrapped with one CTE per layer it reads. */
  private async prepare(appUser: AppUser, sqlText: string, params?: Record<string, string>) {
    await this.assertEnabled(appUser);
    const raw = (sqlText ?? '').trim();
    if (!raw) throw fail('Write a SELECT query first.');
    if (raw.length > MAX_SQL_LENGTH) throw fail('The query is too long.');
    const text = substituteParams(raw, params ?? {});

    const parsed = await this.parse(text);
    if (parsed.stmts.length !== 1) throw fail('Run one SELECT statement at a time.');
    const [only] = parsed.stmts;
    if (!only.stmt || !('SelectStmt' in only.stmt)) throw fail('Only SELECT queries can be run.', only.stmt_location ?? 0);

    const tables = await this.consoleTables(appUser);
    const byAlias = new Map(tables.map((t) => [t.alias, t]));
    const aliasSet = new Set(byAlias.keys());
    const { used, ctes: userCtes } = this.check(only.stmt, aliasSet);
    await this.assertCteNamesFree(userCtes, aliasSet);

    // The statement exactly as PostgreSQL saw it (drops a trailing ";").
    const start = only.stmt_location ?? 0;
    const body = only.stmt_len ? text.slice(start, start + only.stmt_len) : text.slice(start);
    const ctes = [...used].map((a) => `${quoteIdent(a)} AS (SELECT * FROM ${byAlias.get(a)!.from} src)`);
    const wrapped = `${ctes.length ? `WITH ${ctes.join(',\n')}\n` : ''}SELECT * FROM (\n${body}\n) AS q`;

    // Belt and braces: the combined text must still be one plain SELECT.
    const recheck = await this.parse(wrapped);
    if (recheck.stmts.length !== 1 || !('SelectStmt' in recheck.stmts[0].stmt)) {
      throw fail('The query could not be run safely.');
    }
    return { wrapped, used, tables: tables.filter((t) => used.has(t.alias)) };
  }

  /** Creates a temp view over the query and returns its columns. */
  private async openView(tx: Tx, wrapped: string, timeoutMs: number) {
    const view = `sqlc_${randomBytes(6).toString('hex')}`;
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = 3000`);
    await tx.$executeRawUnsafe(`CREATE TEMP VIEW ${view} AS ${wrapped}`);
    const columns = await tx.$queryRawUnsafe<{ name: string; type: string; base: string }[]>(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, t.typname AS base
         FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      `pg_temp.${view}`,
    );
    return { view: `pg_temp.${view}`, columns };
  }

  private toHttpError(err: unknown, timeoutMs: number): never {
    if (err instanceof HttpException) throw err;
    const msg = pgErrorMessage(err);
    if (/statement timeout/i.test(msg)) {
      throw fail(`The query took longer than ${Math.round(timeoutMs / 1000)} s and was stopped. Add a WHERE or LIMIT.`);
    }
    throw fail(msg);
  }

  async run(appUser: AppUser, sqlText: string, limitIn?: number, params?: Record<string, string>) {
    const limit = Math.min(Math.max(Math.floor(limitIn ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const { wrapped, used } = await this.prepare(appUser, sqlText, params);
    const t0 = Date.now();
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const { view, columns } = await this.openView(tx, wrapped, STATEMENT_TIMEOUT_MS);
          // From here on nothing may write.
          await tx.$executeRawUnsafe(`SET LOCAL transaction_read_only = on`);
          const proj = columns.map((c) => {
            const col = `v.${quoteIdent(c.name)}`;
            if (c.base === 'geometry') {
              return `CASE WHEN ST_SRID(${col}) = 0 THEN ST_AsGeoJSON(${col}, 7)::jsonb ELSE ST_AsGeoJSON(ST_Transform(${col}, 4326), 7)::jsonb END AS ${quoteIdent(c.name)}`;
            }
            if (c.base === 'geography') return `ST_AsGeoJSON(${col}, 7)::jsonb AS ${quoteIdent(c.name)}`;
            return `${col} AS ${quoteIdent(c.name)}`;
          });
          const rows = proj.length
            ? await tx.$queryRawUnsafe<{ row: Record<string, unknown> }[]>(
                `SELECT to_jsonb(r) AS row FROM (SELECT ${proj.join(', ')} FROM ${view} v LIMIT ${limit + 1}) r`,
              )
            : [];
          const geometryColumns = columns.filter((c) => GEOM_TYPES.has(c.base)).map((c) => c.name);
          throw new Rollback({
            columns: columns.map((c) => ({ name: c.name, type: c.type, geometry: geometryColumns.includes(c.name) })),
            rows: rows.slice(0, limit).map((r) => r.row),
            truncated: rows.length > limit,
            limit,
            geometryColumn: geometryColumns[0] ?? null,
            tables: [...used],
          });
        },
        { timeout: STATEMENT_TIMEOUT_MS + 5000, maxWait: 5000 },
      );
    } catch (err) {
      if (err instanceof Rollback) return { ...(err.result as object), ms: Date.now() - t0 };
      this.toHttpError(err, STATEMENT_TIMEOUT_MS);
    }
    throw fail('The query returned nothing.');
  }

  /** Query plan (EXPLAIN, not run) with plain-language hints. */
  async explain(appUser: AppUser, sqlText: string, params?: Record<string, string>) {
    const { wrapped, tables } = await this.prepare(appUser, sqlText, params);
    const aliasOf = new Map(tables.map((t) => [t.table, t.alias]));
    try {
      const [row] = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET TRANSACTION READ ONLY`);
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = 10000`);
          return tx.$queryRawUnsafe<Record<string, unknown>[]>(`EXPLAIN (FORMAT JSON) ${wrapped}`);
        },
        { timeout: 15000, maxWait: 5000 },
      );
      // The single column is called "QUERY PLAN"; it may arrive as text.
      const rawPlan = Object.values(row ?? {})[0];
      const planJson = (typeof rawPlan === 'string' ? JSON.parse(rawPlan) : rawPlan) as { Plan: PlanNode }[];
      const root = (planJson?.[0] ?? { Plan: null }).Plan;
      const hints: string[] = [];
      const lines: { depth: number; label: string; rows: number; cost: number }[] = [];
      const visit = (n: PlanNode, depth: number) => {
        const rel = n['Relation Name'] ? aliasOf.get(n['Relation Name']) ?? n['Relation Name'] : null;
        const label = [n['Node Type'], n['Join Type'] ? `(${n['Join Type']})` : '', rel ? `on ${rel}` : '', n['Index Name'] ? `using ${n['Index Name']}` : '']
          .filter(Boolean)
          .join(' ');
        lines.push({ depth, label, rows: n['Plan Rows'] ?? 0, cost: n['Total Cost'] ?? 0 });
        if (n['Node Type'] === 'Seq Scan' && (n['Plan Rows'] ?? 0) > 100_000) {
          hints.push(`Reads every row of ${rel} (~${Math.round(n['Plan Rows']!).toLocaleString('en')}) — a WHERE on an indexed field or a smaller area will be faster.`);
        }
        if (n['Node Type'] === 'Nested Loop' && (n['Total Cost'] ?? 0) > 1e7) {
          hints.push('A large join compares many pairs — use ST_Intersects / ST_DWithin (they use the spatial index) rather than ST_Distance < x.');
        }
        if (n['Node Type'] === 'Sort' && (n['Plan Rows'] ?? 0) > 1_000_000) hints.push('Sorting over a million rows — add a LIMIT or filter first.');
        for (const c of n.Plans ?? []) visit(c, depth + 1);
      };
      if (root) visit(root, 0);
      return { totalCost: root?.['Total Cost'] ?? 0, estimatedRows: root?.['Plan Rows'] ?? 0, lines, hints: [...new Set(hints)] };
    } catch (err) {
      this.toHttpError(err, 10000);
    }
  }

  /** Writes the query result to `table` (geometry → `geom` in `srid`,
   *  one geometry family, columns renamed to safe names). */
  private async materialize(
    tx: Tx,
    wrapped: string,
    table: string,
    opts: { srid: number; requireGeometry: boolean; unlogged: boolean },
  ): Promise<{ geometryType: 'POINT' | 'LINE' | 'POLYGON' | null; rows: number }> {
    const { view, columns } = await this.openView(tx, wrapped, SAVE_TIMEOUT_MS);
    const geomCol = columns.find((c) => GEOM_TYPES.has(c.base));
    if (!geomCol && opts.requireGeometry) throw fail('The result has no geometry column — select a geom column to make a layer.');
    const used = new Set(['feat_id', 'geom']);
    const cols = columns
      .filter((c) => !GEOM_TYPES.has(c.base))
      .map((c) => `v.${quoteIdent(c.name)} AS ${quoteIdent(uniqueName(safeName(c.name), used))}`);
    let geometryType: 'POINT' | 'LINE' | 'POLYGON' | null = null;
    let geomSql = '';
    let where = '';
    if (geomCol) {
      const g = `v.${quoteIdent(geomCol.name)}${geomCol.base === 'geography' ? '::geometry' : ''}`;
      const [dim] = await tx.$queryRawUnsafe<{ d: number }[]>(
        `SELECT ST_Dimension(${g}) AS d FROM ${view} v WHERE ${g} IS NOT NULL AND NOT ST_IsEmpty(${g}) GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
      );
      if (!dim) throw fail('Every geometry in the result is empty.');
      const d = Math.min(Math.max(Number(dim.d), 0), 2);
      geometryType = (['POINT', 'LINE', 'POLYGON'] as const)[d];
      const multi = ['MultiPoint', 'MultiLineString', 'MultiPolygon'][d];
      const fixed = `CASE WHEN ST_SRID(${g}) = 0 THEN ST_SetSRID(ST_Force2D(${g}), ${opts.srid}) ELSE ST_Transform(ST_Force2D(${g}), ${opts.srid}) END`;
      geomSql = `ST_Multi(ST_CollectionExtract(${fixed}, ${d + 1}))::geometry(${multi}, ${opts.srid}) AS geom`;
      where = `WHERE ${g} IS NOT NULL AND ST_Dimension(${g}) = ${d}`;
    }
    const select = [...cols, geomSql].filter(Boolean).join(', ');
    if (!select) throw fail('The result has no columns.');
    const n = await tx.$executeRawUnsafe(
      `CREATE ${opts.unlogged ? 'UNLOGGED ' : ''}TABLE "${table}" AS SELECT ${select} FROM ${view} v ${where}`,
    );
    await tx.$executeRawUnsafe(`DROP VIEW ${view}`);
    return { geometryType, rows: Number(n) };
  }

  /** Saves the result as a new vector layer of the workspace. */
  async saveAsLayer(appUser: AppUser, dto: { sql: string; params?: Record<string, string>; name: string; description?: string }) {
    const name = dto.name.trim();
    if (!name) throw fail('Give the new layer a name.');
    const { wrapped, used } = await this.prepare(appUser, dto.sql, dto.params);
    const output = await this.raster.prepareVectorOutput(appUser, name);
    const srid = Number(/(\d+)$/.exec(output.workspace.defaultCrs ?? '')?.[1]) || 4326;
    let made: { geometryType: 'POINT' | 'LINE' | 'POLYGON' | null; rows: number };
    try {
      made = await this.prisma.$transaction(
        async (tx) => {
          const m = await this.materialize(tx, wrapped, output.table, { srid, requireGeometry: true, unlogged: false });
          if (!m.rows) throw fail('The query returned no features to save.');
          await tx.$executeRawUnsafe(`ALTER TABLE "${output.table}" ADD COLUMN feat_id SERIAL PRIMARY KEY`);
          return m;
        },
        { timeout: SAVE_TIMEOUT_MS + 10000, maxWait: 5000 },
      );
    } catch (err) {
      await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${output.table}"`).catch(() => undefined);
      this.toHttpError(err, SAVE_TIMEOUT_MS);
    }
    const layer = await this.raster.publishVectorTable(appUser, output, {
      name,
      geometryType: made.geometryType!,
      description: dto.description?.trim() || `SQL Console result from ${[...used].join(', ') || 'a query'}.`,
      rasterAnalysis: false,
      srs: `EPSG:${srid}`,
    });
    return { layer, features: made.rows };
  }

  /** The full result as a file (CSV, Excel, GeoJSON, KML or zipped Shapefile; WGS84). */
  async export(appUser: AppUser, dto: { sql: string; params?: Record<string, string>; format: SqlExportFormat }) {
    const { wrapped } = await this.prepare(appUser, dto.sql, dto.params);
    const staging = `sqlx_${randomUUID().replace(/-/g, '')}`;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sqlx-'));
    const spec = EXPORT_FORMATS[dto.format];
    try {
      const made = await this.prisma.$transaction(
        (tx) => this.materialize(tx, wrapped, staging, { srid: 4326, requireGeometry: spec.geometry, unlogged: true }),
        { timeout: SAVE_TIMEOUT_MS + 10000, maxWait: 5000 },
      );
      if (!made.rows) throw fail('The query returned no rows to export.');
      const out = path.join(dir, dto.format === 'shapefile' ? 'shp' : `query-result.${spec.ext}`);
      await this.gdal.exportTable({
        connection: {
          host: this.config.getOrThrow<string>('POSTGIS_HOST'),
          port: this.config.getOrThrow<string>('POSTGIS_PORT'),
          database: this.config.getOrThrow<string>('POSTGIS_DATABASE'),
          user: this.config.getOrThrow<string>('POSTGIS_USER'),
          password: this.config.getOrThrow<string>('POSTGIS_PASSWORD'),
        },
        table: staging,
        driver: spec.driver,
        outPath: out,
        layerName: 'query_result',
      });
      if (dto.format === 'shapefile') {
        const zip = new AdmZip();
        for (const f of await readdir(out)) zip.addLocalFile(path.join(out, f));
        return { filename: 'query-result.zip', body: zip.toBuffer(), contentType: 'application/zip' };
      }
      return { filename: `query-result.${spec.ext}`, body: await readFile(out), contentType: spec.contentType };
    } catch (err) {
      this.toHttpError(err, SAVE_TIMEOUT_MS);
    } finally {
      await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${staging}"`).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ----- saved queries -----

  async listSaved(appUser: AppUser) {
    await this.assertEnabled(appUser);
    const rows = await this.prisma.gISSavedQuery.findMany({
      where: { municipalityId: appUser.municipalityId, OR: [{ createdById: appUser.id }, { shared: true }] },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, sql: r.sql, shared: r.shared, updatedAt: r.updatedAt, mine: r.createdById === appUser.id }));
  }

  async saveQuery(appUser: AppUser, dto: { name: string; description?: string; sql: string; shared?: boolean }, id?: string) {
    await this.assertEnabled(appUser);
    const data = { name: dto.name.trim(), description: dto.description?.trim() || null, sql: dto.sql, shared: dto.shared === true };
    if (!data.name) throw fail('Give the query a name.');
    if (id) {
      await this.ownSaved(appUser, id);
      const r = await this.prisma.gISSavedQuery.update({ where: { id }, data });
      return { ...r, mine: true };
    }
    const r = await this.prisma.gISSavedQuery.create({ data: { ...data, municipalityId: appUser.municipalityId, createdById: appUser.id } });
    return { ...r, mine: true };
  }

  async deleteSaved(appUser: AppUser, id: string) {
    await this.ownSaved(appUser, id);
    await this.prisma.gISSavedQuery.delete({ where: { id } });
    return { success: true };
  }

  private async ownSaved(appUser: AppUser, id: string) {
    const row = await this.prisma.gISSavedQuery.findFirst({ where: { id, municipalityId: appUser.municipalityId } });
    if (!row) throw new NotFoundException('Saved query not found.');
    if (row.createdById !== appUser.id) throw new ForbiddenException('Only the person who saved this query can change it.');
    return row;
  }
}

type Tx = Prisma.TransactionClient;

interface PlanNode {
  'Node Type': string;
  'Join Type'?: string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Plan Rows'?: number;
  'Total Cost'?: number;
  Plans?: PlanNode[];
}

export type SqlExportFormat = 'csv' | 'xlsx' | 'geojson' | 'kml' | 'shapefile';

const EXPORT_FORMATS: Record<SqlExportFormat, { driver: 'CSV' | 'XLSX' | 'GeoJSON' | 'KML' | 'ESRI Shapefile'; ext: string; contentType: string; geometry: boolean }> = {
  csv: { driver: 'CSV', ext: 'csv', contentType: 'text/csv; charset=utf-8', geometry: false },
  xlsx: { driver: 'XLSX', ext: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', geometry: false },
  geojson: { driver: 'GeoJSON', ext: 'geojson', contentType: 'application/geo+json', geometry: true },
  kml: { driver: 'KML', ext: 'kml', contentType: 'application/vnd.google-earth.kml+xml', geometry: true },
  shapefile: { driver: 'ESRI Shapefile', ext: 'zip', contentType: 'application/zip', geometry: true },
};

const GEOM_TYPES = new Set(['geometry', 'geography']);

function fail(message: string, position?: number): BadRequestException {
  return new BadRequestException(position === undefined || position === null ? { message } : { message, position });
}

function safeName(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 55);
  return !s ? 'col' : /^\d/.test(s) ? `c_${s}` : s;
}

function uniqueName(name: string, used: Set<string>): string {
  let n = name;
  for (let i = 2; used.has(n); i++) n = `${name}_${i}`;
  used.add(n);
  return n;
}

/** Replaces :name placeholders (outside strings, comments and ::casts) with
 *  quoted literals; the result is validated like any other query text. */
function substituteParams(sql: string, params: Record<string, string>): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'" || ch === '"') {
      const end = sql.indexOf(ch, i + 1);
      const stop = end < 0 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
    } else if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
    } else if (ch === ':' && next === ':') {
      out += '::';
      i += 2;
    } else if (ch === ':' && /[A-Za-z_]/.test(next ?? '')) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1))!;
      const key = m[0];
      if (!(key in params)) throw fail(`Fill in the parameter :${key}.`);
      const v = String(params[key]).trim();
      out += /^-?\d+(\.\d+)?$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`;
      i += 1 + key.length;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}
