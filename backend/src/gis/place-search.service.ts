import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';
import { GisAuthorizationService } from './gis-authorization.service';

/** One place a routing stop can be set to. */
export interface PlaceHit {
  label: string;
  layerName: string;
  /** [lon, lat] (EPSG:4326) — a point on / inside the feature. */
  point: [number, number];
}

/** A named feature at / near a clicked point (reverse geocoding). */
export interface ReversePlace {
  layerName: string;
  label: string;
  /** 'within' = polygon containing the point; 'near' = closest point/line. */
  kind: 'within' | 'near';
  distanceM: number | null;
}

/** The column naming a place, best first (any uploaded layer — detected,
 *  never assumed). */
const PLACE_NAME_COLUMNS = [
  /^(name|name_en|name_eng|place_?name|label|title)$/i,
  /^(village|village_?name|town|town_?name|city|locality|station|station_?name|ward_?name|landmark)$/i,
  /^name/i,
  /name/i,
];
/** Columns that look like a name but are not this feature's own. */
const NOT_OWN_NAME = /(state|district|dist|block|sub_?dist|taluka|tehsil|country|adm\d|nearest|src|ds_name|agency|panchayat)/i;
const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const MAX_LAYERS = 30;
const RESULT_LIMIT = 8;
const STATEMENT_TIMEOUT_MS = 1500;
const INDEX_MIN_ROWS = 20_000;
const INFO_CACHE_MS = 10 * 60 * 1000;
const RESULT_CACHE_MS = 60 * 1000;
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

interface TableInfo {
  column: string | null;
  geom: string | null;
  srid: number;
}

/**
 * Fast "search a place by name" for routing stops. Unlike the general map
 * search it reads one name column per point / polygon layer, matches
 * prefixes first (trigram-indexed), stops at a few hits per layer and
 * returns just a point — no shapes, no AI ranking.
 */
@Injectable()
export class PlaceSearchService {
  private readonly logger = new Logger(PlaceSearchService.name);
  private readonly infoCache = new Map<string, { at: number; info: Promise<TableInfo> }>();
  private readonly resultCache = new Map<string, { at: number; hits: PlaceHit[] }>();
  private readonly indexed = new Set<string>();
  private indexQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly gisAuth: GisAuthorizationService,
  ) {}

  async search(appUser: AppUser, query: string): Promise<PlaceHit[]> {
    const q = query.trim().replace(/\s+/g, ' ').slice(0, 100);
    if (q.length < 2) return [];
    const cacheKey = `${appUser.municipalityId}|${appUser.id ?? ''}|${q.toLowerCase()}`;
    const cached = this.resultCache.get(cacheKey);
    if (cached && Date.now() - cached.at < RESULT_CACHE_MS) return cached.hits;

    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId: appUser.municipalityId },
    });
    if (!workspace) return [];
    const all = await this.prisma.gISLayer.findMany({
      where: {
        gisWorkspaceId: workspace.id,
        status: 'ACTIVE',
        layerType: 'VECTOR',
        geometryType: { in: ['POINT', 'POLYGON'] },
        postgisTable: { not: null },
      },
      orderBy: { displayOrder: 'asc' },
    });
    const layers = (await this.gisAuth.filterViewable(appUser, all)).slice(0, MAX_LAYERS);

    const perLayer = await Promise.all(
      layers.map((layer) =>
        this.searchLayer(layer.postgisTable as string, layer.name, q).catch(() => [] as (PlaceHit & { rank: number })[]),
      ),
    );
    const lower = q.toLowerCase();
    const hits = perLayer
      .flat()
      .sort((a, b) => a.rank - b.rank || a.label.length - b.label.length)
      .filter((h, i, list) => list.findIndex((o) => o.label.toLowerCase() === h.label.toLowerCase() && o.layerName === h.layerName && Math.abs(o.point[0] - h.point[0]) < 1e-4 && Math.abs(o.point[1] - h.point[1]) < 1e-4) === i)
      .slice(0, RESULT_LIMIT)
      .map(({ rank: _rank, ...hit }) => hit);
    if (!hits.length) this.logger.debug(`No place matches "${lower}".`);
    this.resultCache.set(cacheKey, { at: Date.now(), hits });
    if (this.resultCache.size > 500) this.resultCache.delete(this.resultCache.keys().next().value as string);
    return hits;
  }

  /**
   * "What's here?" from the municipality's own data: the named polygon
   * features containing the point (ward, village, district… whatever was
   * uploaded) and the nearest named point / line features within ~300 m.
   */
  async reverse(appUser: AppUser, lon: number, lat: number): Promise<ReversePlace[]> {
    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId: appUser.municipalityId },
    });
    if (!workspace) return [];
    const all = await this.prisma.gISLayer.findMany({
      where: { gisWorkspaceId: workspace.id, status: 'ACTIVE', layerType: 'VECTOR', postgisTable: { not: null } },
      orderBy: { displayOrder: 'asc' },
    });
    const layers = (await this.gisAuth.filterViewable(appUser, all)).slice(0, MAX_LAYERS);
    const perLayer = await Promise.all(
      layers.map((layer) =>
        this.reverseLayer(layer.postgisTable as string, layer.name, layer.geometryType === 'POLYGON', lon, lat).catch(
          () => [] as ReversePlace[],
        ),
      ),
    );
    return perLayer
      .flat()
      .sort((a, b) => (a.kind === b.kind ? (a.distanceM ?? 0) - (b.distanceM ?? 0) : a.kind === 'within' ? -1 : 1))
      .slice(0, 20);
  }

  private async reverseLayer(table: string, layerName: string, polygon: boolean, lon: number, lat: number): Promise<ReversePlace[]> {
    if (!TABLE_NAME.test(table)) return [];
    const info = await this.tableInfo(table);
    if (!info.geom) return [];
    const column = info.column ?? (await this.layerNamedColumn(table, layerName));
    if (!column) return [];
    const geom = `t.${ident(info.geom)}`;
    const srid = info.srid || 4326;
    const pt = `ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), ${srid})`;
    const near = srid === 4326 ? 0.003 : 300;
    const sql = polygon
      ? `SELECT ${ident(column)}::text AS label, 0::float8 AS dist
           FROM ${ident(table)} t
          WHERE ST_Intersects(${geom}, ${pt}) AND ${ident(column)} IS NOT NULL
          LIMIT 2`
      : `SELECT ${ident(column)}::text AS label,
                ST_Distance(ST_Transform(${geom}, 4326)::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS dist
           FROM ${ident(table)} t
          WHERE ST_DWithin(${geom}, ${pt}, ${near}) AND ${ident(column)} IS NOT NULL
          ORDER BY ${geom} <-> ${pt}
          LIMIT 1`;
    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      return tx.$queryRawUnsafe<{ label: string; dist: number }[]>(sql, lon, lat);
    });
    return rows
      .filter((r) => r.label && r.label.trim())
      .map((r) => ({
        layerName,
        label: r.label.trim(),
        kind: polygon ? ('within' as const) : ('near' as const),
        distanceM: polygon ? null : Math.round(Number(r.dist)),
      }));
  }

  /** A column named after the layer itself ("District" → `district`,
   *  `dist_name`…) or any *name* column — admin-boundary layers often keep
   *  their own name in such a column, which the search picker skips. */
  private async layerNamedColumn(table: string, layerName: string): Promise<string | null> {
    const cols = await this.prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
          AND data_type IN ('text', 'character varying', 'character')
        ORDER BY ordinal_position`,
      table,
    );
    const names = cols.map((c) => c.name);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = norm(layerName);
    return (
      (key && names.find((n) => norm(n) === key || norm(n) === `${key}name`)) ||
      (key && names.find((n) => norm(n).startsWith(key))) ||
      names.find((n) => /name/i.test(n)) ||
      null
    );
  }

  /** Exact (0), prefix (1), word-prefix (2), contains (3) — best first. */
  private async searchLayer(table: string, layerName: string, q: string): Promise<(PlaceHit & { rank: number })[]> {
    if (!TABLE_NAME.test(table)) return [];
    const info = await this.tableInfo(table);
    if (!info.column || !info.geom) return [];
    const col = `t.${ident(info.column)}`;
    const geom = `t.${ident(info.geom)}`;
    const g4326 = info.srid === 4326 || info.srid === 0 ? geom : `ST_Transform(${geom}, 4326)`;
    const like = q.replace(/[\\%_]/g, (m) => `\\${m}`);
    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      return tx.$queryRawUnsafe<{ label: string; x: number; y: number; rank: number }[]>(
        `WITH prefix AS (
           SELECT ${col}::text AS label, ${geom} AS g,
                  CASE WHEN lower(${col}) = lower($1) THEN 0 ELSE 1 END AS rank
             FROM ${ident(table)} t
            WHERE ${col} ILIKE $2 AND ${geom} IS NOT NULL
            ORDER BY 3, length(${col})
            LIMIT ${RESULT_LIMIT}),
         inner_match AS (
           SELECT ${col}::text AS label, ${geom} AS g,
                  CASE WHEN ${col} ILIKE $3 THEN 2 ELSE 3 END AS rank
             FROM ${ident(table)} t
            WHERE ${col} ILIKE $4 AND ${col} NOT ILIKE $2 AND ${geom} IS NOT NULL
              AND (SELECT count(*) FROM prefix) < ${RESULT_LIMIT}
            LIMIT 20)
         SELECT label, ST_X(p) AS x, ST_Y(p) AS y, rank FROM (
           SELECT label, rank, ST_PointOnSurface(${g4326.replace(geom, 'g')}) AS p
             FROM (SELECT * FROM prefix UNION ALL SELECT * FROM inner_match) u) s
          WHERE p IS NOT NULL
          ORDER BY rank, length(label)
          LIMIT ${RESULT_LIMIT}`,
        q,
        `${like}%`,
        `% ${like}%`,
        `%${like}%`,
      );
    });
    return rows.map((r) => ({
      label: r.label,
      layerName,
      point: [Number(r.x), Number(r.y)] as [number, number],
      rank: Number(r.rank),
    }));
  }

  /** The layer's place-name column and geometry column (cached). */
  private tableInfo(table: string): Promise<TableInfo> {
    const hit = this.infoCache.get(table);
    if (hit && Date.now() - hit.at < INFO_CACHE_MS) return hit.info;
    const info = (async (): Promise<TableInfo> => {
      const cols = await this.prisma.$queryRawUnsafe<{ name: string }[]>(
        `SELECT column_name AS name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
            AND data_type IN ('text', 'character varying', 'character')
          ORDER BY ordinal_position`,
        table,
      );
      const names = cols.map((c) => c.name);
      let column: string | null = null;
      for (const pattern of PLACE_NAME_COLUMNS) {
        column = names.find((n) => pattern.test(n) && !NOT_OWN_NAME.test(n)) ?? null;
        if (column) break;
      }
      const [geo] = await this.prisma.$queryRawUnsafe<{ geom: string; srid: number }[]>(
        `SELECT f_geometry_column AS geom, srid FROM geometry_columns
          WHERE f_table_schema = 'public' AND f_table_name = $1 LIMIT 1`,
        table,
      );
      const [size] = await this.prisma.$queryRawUnsafe<{ rows: number }[]>(
        `SELECT GREATEST(reltuples, 0)::float8 AS rows FROM pg_class
          WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
        table,
      );
      if (column && Number(size?.rows ?? 0) >= INDEX_MIN_ROWS) this.ensureIndex(table, column);
      return { column, geom: geo?.geom ?? null, srid: Number(geo?.srid ?? 4326) };
    })();
    info.catch(() => this.infoCache.delete(table));
    this.infoCache.set(table, { at: Date.now(), info });
    return info;
  }

  /** Trigram index for ILIKE on big tables — same name the general search
   *  uses, so an existing one is reused. One build at a time. */
  private ensureIndex(table: string, column: string): void {
    const key = `${table}.${column}`;
    if (this.indexed.has(key)) return;
    this.indexed.add(key);
    const name = `${table.slice(0, 40)}_trgm_${createHash('md5').update(column).digest('hex').slice(0, 8)}`;
    this.indexQueue = this.indexQueue.then(async () => {
      try {
        await this.prisma.$executeRawUnsafe(
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ident(name)}
             ON ${ident(table)} USING gin (${ident(column)} gin_trgm_ops)`,
        );
      } catch (error) {
        this.logger.warn(`Place index on ${key} failed: ${(error as Error).message}`);
      }
    });
  }
}
