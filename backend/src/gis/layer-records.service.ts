import { NotFoundException, BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AppUser } from '../auth/types/app-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { CqlColumn, cqlToSql } from './cql-to-sql';
import { FEAT_ID } from './ensure-feat-id.util';
import { LayerRecordsQueryDto } from './dto/layer-records.dto';
import { GisLayersService } from './gis-layers.service';

const GEOM = 'geom';
const FID = FEAT_ID;
const MAX_LIMIT = 25_000;
/** Longest a single records query may run. */
const STATEMENT_TIMEOUT_MS = 30_000;

interface TableInfo {
  columns: Map<string, CqlColumn>;
  srid: number;
  at: number;
}

/**
 * Layer data read straight from PostGIS for the map tools (Attribute Table,
 * Query Builder, selection, identify …). The caller must be allowed to view
 * the layer (checked by GisLayersService.vectorSource); filters arrive as
 * the ECQL the tools already build and are translated to parameterised SQL.
 * Responses keep the WFS GeoJSON shape (ids "<layer>.<fid>", numberMatched)
 * so the tools didn't have to change how they read results.
 */
@Injectable()
export class LayerRecordsService {
  private readonly tableCache = new Map<string, TableInfo>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly gisLayers: GisLayersService,
  ) {}

  /** Shortest ground distance (metres, on the ellipsoid) between two
   *  features of a layer, plus the shortest connecting line (EPSG:4326). */
  async distance(appUser: AppUser, layerId: string, a: number, b: number) {
    const { from } = await this.gisLayers.vectorSource(appUser, layerId, 'view');
    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = 15000`);
      return tx.$queryRawUnsafe<{ metres: number | null; line: string | null }[]>(
        `SELECT ST_Distance(ST_Transform(x."${GEOM}", 4326)::geography, ST_Transform(y."${GEOM}", 4326)::geography)::float8 AS metres,
                ST_AsGeoJSON(ST_Transform(ST_ShortestLine(x."${GEOM}", y."${GEOM}"), 4326), 7) AS line
           FROM ${from} x, ${from} y
          WHERE x."${FID}" = $1 AND y."${FID}" = $2`,
        a,
        b,
      );
    }, { timeout: 20000 });
    const row = rows[0];
    if (!row || row.metres === null) throw new NotFoundException('One of the features was not found or has no geometry.');
    return { metres: row.metres, line: row.line ? (JSON.parse(row.line) as Record<string, unknown>) : null };
  }

  async query(appUser: AppUser, layerId: string, q: LayerRecordsQueryDto) {
    const { layer, table, from } = await this.gisLayers.vectorSource(appUser, layerId, 'view');
    const info = await this.tableInfo(table);
    const prefix = layer.geoserverLayer || table;

    const parts: string[] = [];
    const params: unknown[] = [];
    if (q.filter?.trim()) {
      const f = cqlToSql(q.filter, { columns: info.columns, geometryColumn: GEOM, srid: info.srid, fidColumn: FID, alias: 't' }, params.length + 1);
      parts.push(f.sql);
      params.push(...f.params);
    }
    if (q.featureIds?.length) {
      const ids = q.featureIds.map((id) => Number(String(id).split('.').pop())).filter(Number.isSafeInteger);
      params.push(ids);
      parts.push(`t."${FID}" = ANY($${params.length}::bigint[])`);
    }
    const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';

    const limit = Math.min(Math.max(q.limit ?? 100, 0), MAX_LIMIT);
    const offset = Math.max(q.offset ?? 0, 0);

    let order = `t."${FID}"`;
    const orderParams: unknown[] = [];
    if (q.near) {
      const [lon, lat] = q.near;
      orderParams.push(lon, lat);
      const n = params.length;
      order = `t."${GEOM}" <-> ST_Transform(ST_SetSRID(ST_MakePoint($${n + 1}, $${n + 2}), 4326), ${info.srid}), t."${FID}"`;
    } else if (q.sortField) {
      if (!info.columns.has(q.sortField)) throw new BadRequestException(`Unknown column "${q.sortField}".`);
      const dir = q.sortDir === 'desc' ? 'DESC NULLS LAST' : 'ASC NULLS LAST';
      order = `t."${q.sortField.replace(/"/g, '""')}" ${dir}, t."${FID}"`;
    }

    const geometry = q.geometry === false ? 'NULL::json' : `ST_AsGeoJSON(ST_Transform(t."${GEOM}", 4326), 7)::json`;
    // feat_id stays in the attributes: users see it (read-only).
    const properties = q.properties === false ? `'{}'::jsonb` : `to_jsonb(t) - '${GEOM}'`;
    const select = `SELECT t."${FID}" AS fid, ${geometry} AS geometry, ${properties} AS properties
                      FROM ${from} t ${where}
                     ORDER BY ${order}
                     LIMIT ${limit} OFFSET ${offset}`;
    const count = `SELECT count(*)::int AS n FROM ${from} t ${where}`;

    try {
      const [rows, matched] = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        const r = limit > 0
          ? await tx.$queryRawUnsafe<{ fid: bigint | number; geometry: unknown; properties: Record<string, unknown> }[]>(select, ...params, ...orderParams)
          : [];
        const c = q.count === false ? null : (await tx.$queryRawUnsafe<{ n: number }[]>(count, ...params))[0]?.n ?? 0;
        return [r, c] as const;
      }, { timeout: STATEMENT_TIMEOUT_MS + 5000 });

      const features = rows.map((r) => ({
        type: 'Feature' as const,
        id: `${prefix}.${r.fid}`,
        geometry: r.geometry ?? null,
        geometry_name: GEOM,
        properties: r.properties ?? {},
      }));
      return {
        type: 'FeatureCollection' as const,
        features,
        numberMatched: matched ?? features.length,
        numberReturned: features.length,
        geometryField: GEOM,
        columns: [...info.columns.entries()].map(([name, c]) => ({ name, type: c.type })),
      };
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      const message = this.pgMessage(e);
      if (message) throw new BadRequestException(message);
      throw e;
    }
  }

  /** Columns (minus geometry / feature id) and SRID, cached briefly so
   *  paging doesn't re-read the catalog every time. */
  private async tableInfo(table: string): Promise<TableInfo> {
    const hit = this.tableCache.get(table);
    if (hit && Date.now() - hit.at < 60_000) return hit;
    const [cols, srid] = await Promise.all([
      this.prisma.$queryRawUnsafe<{ column_name: string; data_type: string }[]>(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
        table,
      ),
      this.prisma.$queryRawUnsafe<{ srid: number }[]>(`SELECT Find_SRID(current_schema()::text, $1, '${GEOM}') AS srid`, table),
    ]);
    const columns = new Map<string, CqlColumn>();
    for (const c of cols) {
      if (c.column_name === GEOM) continue;
      columns.set(c.column_name, { type: c.data_type });
    }
    const info = { columns, srid: srid[0]?.srid || 4326, at: Date.now() };
    this.tableCache.set(table, info);
    return info;
  }

  /** A user-fixable database error (bad value for a column type, query too
   *  slow) as a plain message; null for anything else. */
  private pgMessage(e: unknown): string | null {
    const err = e as { code?: string; meta?: { code?: string; message?: string }; message?: string };
    const code = err.meta?.code ?? err.code ?? '';
    const text = err.meta?.message ?? err.message ?? '';
    if (code === '57014' || /statement timeout/i.test(text)) return 'The query took too long — narrow the filter.';
    if (['22P02', '22007', '22008', '22003', '42883', '22023', 'XX000'].includes(code) || /invalid input|out of range|parse error|geometry/i.test(text)) {
      return `The filter has a value that doesn't fit its column: ${text.split('\n')[0].replace(/^.*ERROR:\s*/, '').slice(0, 200)}`;
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2010') return 'The filter could not be run on this layer.';
    return null;
  }
}
