import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Google-style fuzzy feature search, run in PostgreSQL with pg_trgm:
 * typo-tolerant (trigram word similarity), ranked exact > prefix >
 * contains > fuzzy, over each layer's own PostGIS table. Works for any
 * uploaded layer — the searchable columns are read from the table itself.
 *
 * Large tables get GIN trigram indexes on their searchable columns, built
 * lazily in the background one at a time, so search stays fast on
 * village-scale layers without blocking the first request.
 */

export interface FuzzyLayer {
  id: string;
  name: string;
  code: string;
  postgisTable: string;
}

export interface FuzzyFeatureHit {
  layerId: string;
  layerName: string;
  layerCode: string;
  attributes: Record<string, unknown>;
  bbox: [number, number, number, number] | null;
  /** The feature's shape (GeoJSON, EPSG:4326, lightly simplified) for the map highlight. */
  geometry: Record<string, unknown> | null;
  /** A point inside the feature (EPSG:4326) — where its popup is anchored. */
  anchor: [number, number] | null;
  /** The field / value that matched best — what the result is called. */
  matchedField: string;
  label: string;
  score: number;
}

/** Text fields nobody searches by (ids, codes, flags, measures). */
const NON_SEARCH_COLUMN =
  /(^|_)(id|fid|gid|uid|code|cd|status|sta|year|area|length|leng|shape|summer|month)(_|$)|^objectid|code$|_\d+$/i;
const MAX_COLUMNS = 12;
const HITS_PER_LAYER = 10;
/** Word-similarity cut-off: catches "vadodra"→Vadodara (0.63), drops "pune"→Panaji (0.20). */
const FUZZY_THRESHOLD = 0.5;
/** Below this many rows a sequential scan is already fast — no indexes. */
const INDEX_MIN_ROWS = 20_000;
const STATEMENT_TIMEOUT_MS = 8000;
const COLUMN_CACHE_MS = 10 * 60 * 1000;

const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

interface TableInfo {
  columns: string[];
  geom: string | null;
  srid: number;
  rows: number;
}

@Injectable()
export class FuzzySearchService {
  private readonly logger = new Logger(FuzzySearchService.name);
  private readonly tableCache = new Map<string, { at: number; info: Promise<TableInfo> }>();
  /** Tables whose indexes are built / queued — one build at a time. */
  private readonly indexed = new Set<string>();
  private indexQueue: Promise<void> = Promise.resolve();

  constructor(private readonly prisma: PrismaService) {}

  /** Ranked hits across the layers, best first. A failing layer is skipped. */
  async search(layers: FuzzyLayer[], query: string, limit: number): Promise<FuzzyFeatureHit[]> {
    const q = query.trim().slice(0, 100);
    if (q.length < 2) return [];
    const perLayer = await Promise.all(
      layers.map((layer) =>
        this.searchLayer(layer, q).catch((error: Error) => {
          this.logger.warn(`Fuzzy search failed for layer "${layer.code}": ${error.message}`);
          return [] as FuzzyFeatureHit[];
        }),
      ),
    );
    return perLayer
      .flat()
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private async searchLayer(layer: FuzzyLayer, q: string): Promise<FuzzyFeatureHit[]> {
    if (!TABLE_NAME.test(layer.postgisTable)) return [];
    const info = await this.tableInfo(layer.postgisTable);
    if (!info.columns.length) return [];
    if (info.rows >= INDEX_MIN_ROWS) this.ensureIndexes(layer.postgisTable, info.columns);

    // Per column: 3 exact, 2 prefix, 1.5 contains, else word similarity (0–1).
    const scoreOf = (c: string) => `CASE
        WHEN lower(${ident(c)}) = lower($1) THEN 3
        WHEN ${ident(c)} ILIKE $2 THEN 2
        WHEN ${ident(c)} ILIKE $3 THEN 1.5
        ELSE word_similarity($1, ${ident(c)}) END`;
    const scores = info.columns.map(scoreOf);
    // Indexable predicates (GIN trigram supports both ILIKE and <%).
    const where = info.columns.map((c) => `(${ident(c)} ILIKE $3 OR $1 <% ${ident(c)})`).join(' OR ');
    const bbox =
      info.geom === null
        ? 'NULL::float8[]'
        : `(SELECT ARRAY[ST_XMin(b), ST_YMin(b), ST_XMax(b), ST_YMax(b)]
             FROM (SELECT ${info.srid === 4326 ? '' : 'ST_Transform('}t.${ident(info.geom)}${
               info.srid === 4326 ? '' : ', 4326)'
             }::box2d AS b) x)`;
    const geomOut = info.geom ? ` - ${`'${info.geom.replace(/'/g, "''")}'`}` : '';
    const g4326 = info.geom
      ? info.srid === 4326
        ? `t.${ident(info.geom)}`
        : `ST_Transform(t.${ident(info.geom)}, 4326)`
      : null;
    const shape = g4326
      ? `ST_AsGeoJSON(ST_SimplifyPreserveTopology(${g4326}, 0.00001), 6)::json AS geometry,
         (SELECT ARRAY[ST_X(p), ST_Y(p)] FROM (SELECT ST_PointOnSurface(${g4326}) AS p) y) AS anchor,`
      : 'NULL::json AS geometry, NULL::float8[] AS anchor,';

    const sql = `
      SELECT to_jsonb(t)${geomOut} AS attrs, ${bbox} AS bbox, ${shape}
             s.scores
        FROM ${ident(layer.postgisTable)} t,
             LATERAL (SELECT ARRAY[${scores.join(', ')}]::float8[] AS scores) s
       WHERE ${where}
       ORDER BY (SELECT max(x) FROM unnest(s.scores) x) DESC
       LIMIT ${HITS_PER_LAYER}`;

    const like = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      await tx.$executeRawUnsafe(`SET LOCAL pg_trgm.word_similarity_threshold = ${FUZZY_THRESHOLD}`);
      return tx.$queryRawUnsafe<
        {
          attrs: Record<string, unknown>;
          bbox: number[] | null;
          geometry: Record<string, unknown> | null;
          anchor: number[] | null;
          scores: number[];
        }[]
      >(sql, q, `${like(q)}%`, `%${like(q)}%`);
    });

    return rows.map((row) => {
      let best = 0;
      row.scores.forEach((s, i) => {
        if ((s ?? 0) > (row.scores[best] ?? 0)) best = i;
      });
      const field = info.columns[best];
      const bb = row.bbox && row.bbox.every((n) => Number.isFinite(n)) ? row.bbox : null;
      return {
        layerId: layer.id,
        layerName: layer.name,
        layerCode: layer.code,
        attributes: row.attrs,
        bbox: bb as [number, number, number, number] | null,
        geometry: row.geometry,
        anchor:
          row.anchor && row.anchor.every((n) => Number.isFinite(n))
            ? (row.anchor as [number, number])
            : null,
        matchedField: field,
        label: String(row.attrs[field] ?? layer.name),
        score: row.scores[best] ?? 0,
      };
    });
  }

  /** Searchable text columns (name-like first), geometry column, size. */
  private tableInfo(table: string): Promise<TableInfo> {
    const hit = this.tableCache.get(table);
    if (hit && Date.now() - hit.at < COLUMN_CACHE_MS) return hit.info;
    const info = (async (): Promise<TableInfo> => {
      const cols = await this.prisma.$queryRawUnsafe<{ name: string }[]>(
        `SELECT column_name AS name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
            AND data_type IN ('text', 'character varying', 'character')
          ORDER BY ordinal_position`,
        table,
      );
      const all = cols.map((c) => c.name);
      const useful = all.filter((n) => !NON_SEARCH_COLUMN.test(n));
      const columns = (useful.length ? useful : all)
        .sort((a, b) => Number(!/name/i.test(a)) - Number(!/name/i.test(b)))
        .slice(0, MAX_COLUMNS);
      const [geo] = await this.prisma.$queryRawUnsafe<{ geom: string; srid: number }[]>(
        `SELECT f_geometry_column AS geom, srid FROM geometry_columns
          WHERE f_table_schema = 'public' AND f_table_name = $1 LIMIT 1`,
        table,
      );
      const [size] = await this.prisma.$queryRawUnsafe<{ rows: number }[]>(
        `SELECT GREATEST(reltuples, 0)::float8 AS rows FROM pg_class WHERE relname = $1 AND relkind = 'r'`,
        table,
      );
      return { columns, geom: geo?.geom ?? null, srid: Number(geo?.srid ?? 4326), rows: Number(size?.rows ?? 0) };
    })();
    info.catch(() => this.tableCache.delete(table));
    this.tableCache.set(table, { at: Date.now(), info });
    return info;
  }

  /** Background GIN trigram indexes, one build at a time across tables. */
  private ensureIndexes(table: string, columns: string[]): void {
    if (this.indexed.has(table)) return;
    this.indexed.add(table);
    this.indexQueue = this.indexQueue.then(async () => {
      for (const column of columns) {
        const name = `${table.slice(0, 40)}_trgm_${createHash('md5').update(column).digest('hex').slice(0, 8)}`;
        try {
          await this.prisma.$executeRawUnsafe(
            `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ident(name)}
               ON ${ident(table)} USING gin (${ident(column)} gin_trgm_ops)`,
          );
        } catch (error) {
          this.logger.warn(`Search index on ${table}.${column} failed: ${(error as Error).message}`);
        }
      }
    });
  }
}
