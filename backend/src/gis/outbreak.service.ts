import { BadRequestException, Injectable } from '@nestjs/common';
import type { AppUser } from '../auth/types/app-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { GisLayersService } from './gis-layers.service';
import { RasterService } from './raster.service';
import type { OutbreakDto } from './dto/platform-extras.dto';

const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_POINTS = 20_000;
/** A cluster is "active" with a case in the last 14 days of the period
 *  (about two dengue incubation + reporting cycles). */
const ACTIVE_DAYS = 14;

/**
 * Disease outbreak mapping on any point layer of cases with a date field:
 * weekly trend, space clusters (DBSCAN on cases within `clusterDistanceM`),
 * a control zone (fogging / spraying ring) around each cluster, and
 * optionally case counts and rates per area (ward) layer.
 */
@Injectable()
export class OutbreakService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gisLayers: GisLayersService,
    private readonly raster: RasterService,
  ) {}

  async analyze(appUser: AppUser, dto: OutbreakDto) {
    const { layer, table, from } = await this.gisLayers.vectorSource(appUser, dto.layerId, 'view');
    const columns = await this.columns(table);
    for (const f of [dto.dateField, dto.diseaseField]) {
      if (f && (!FIELD.test(f) || !columns.has(f))) throw new BadRequestException(`"${f}" is not a field of "${layer.name}".`);
    }
    const q = (c: string) => `"${c}"`;
    const dateExpr = `(t.${q(dto.dateField)})::date`;
    const filters: string[] = ['t.geom IS NOT NULL', `t.${q(dto.dateField)} IS NOT NULL`];
    const params: unknown[] = [];
    if (dto.diseaseField && dto.diseaseValues?.length) {
      params.push(dto.diseaseValues);
      filters.push(`t.${q(dto.diseaseField)}::text = ANY($${params.length}::text[])`);
    }
    const where = filters.join(' AND ');

    // Period: as given, or the 90 days up to the latest case.
    let to = dto.to;
    let fromDate = dto.from;
    if (to && !DATE.test(to)) throw new BadRequestException('Dates must be YYYY-MM-DD.');
    if (fromDate && !DATE.test(fromDate)) throw new BadRequestException('Dates must be YYYY-MM-DD.');
    try {
      if (!to) {
        const [row] = await this.prisma.$queryRawUnsafe<{ d: Date | null }[]>(`SELECT max(${dateExpr}) AS d FROM ${from} t WHERE ${where}`, ...params);
        if (!row?.d) throw new BadRequestException('No cases with a date were found.');
        to = row.d.toISOString().slice(0, 10);
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(`"${dto.dateField}" does not hold dates PostgreSQL can read (use YYYY-MM-DD).`);
    }
    if (!fromDate) fromDate = new Date(Date.parse(to) - 89 * 86_400_000).toISOString().slice(0, 10);
    if (fromDate > to) throw new BadRequestException('The start date is after the end date.');
    params.push(fromDate, to);
    const pFrom = `$${params.length - 1}::date`;
    const pTo = `$${params.length}::date`;

    // Web Mercator stretches distances by 1/cos(lat): scale the metres.
    const lat = layer.bboxMinY !== null && layer.bboxMaxY !== null ? (layer.bboxMinY + layer.bboxMaxY) / 2 : 0;
    const k = 1 / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const eps = (dto.clusterDistanceM ?? 200) * k;
    const buffer = (dto.zoneBufferM ?? 400) * k;
    const minCases = dto.minCases ?? 3;

    const cases = `cases AS (
        SELECT t.ogc_fid AS id, ${dateExpr} AS d, ST_Transform(ST_PointOnSurface(t.geom), 3857) AS g
          FROM ${from} t
         WHERE ${where} AND ${dateExpr} BETWEEN ${pFrom} AND ${pTo})`;

    const [weekly, clusters, points, breakdown] = await Promise.all([
      this.prisma.$queryRawUnsafe<{ week: Date; n: number }[]>(
        `WITH ${cases} SELECT date_trunc('week', d)::date AS week, count(*)::int AS n FROM cases GROUP BY 1 ORDER BY 1`,
        ...params,
      ),
      this.prisma.$queryRawUnsafe<
        { n: number; recent: number; first: Date; last: Date; center: { coordinates: [number, number] }; hull: unknown; zone: unknown }[]
      >(
        `WITH ${cases},
              k AS (SELECT d, g, ST_ClusterDBSCAN(g, eps := ${eps}, minpoints := ${minCases}) OVER () AS cid FROM cases)
         SELECT count(*)::int AS n,
                sum(CASE WHEN d > ${pTo} - ${ACTIVE_DAYS} THEN 1 ELSE 0 END)::int AS recent,
                min(d) AS first, max(d) AS last,
                ST_AsGeoJSON(ST_Transform(ST_Centroid(ST_Collect(g)), 4326), 6)::json AS center,
                ST_AsGeoJSON(ST_Transform(ST_ConvexHull(ST_Collect(g)), 4326), 6)::json AS hull,
                ST_AsGeoJSON(ST_Transform(ST_Buffer(ST_ConvexHull(ST_Collect(g)), ${buffer}, 'quad_segs=8'), 4326), 6)::json AS zone
           FROM k WHERE cid IS NOT NULL
          GROUP BY cid
          ORDER BY recent DESC, n DESC
          LIMIT 200`,
        ...params,
      ),
      this.prisma.$queryRawUnsafe<{ x: number; y: number; d: Date }[]>(
        `WITH ${cases} SELECT ST_X(ST_Transform(g, 4326)) AS x, ST_Y(ST_Transform(g, 4326)) AS y, d FROM cases ORDER BY d DESC LIMIT ${MAX_POINTS}`,
        ...params,
      ),
      dto.diseaseField
        ? this.prisma.$queryRawUnsafe<{ value: string | null; n: number }[]>(
            `SELECT t.${q(dto.diseaseField)}::text AS value, count(*)::int AS n FROM ${from} t
              WHERE t.geom IS NOT NULL AND ${dateExpr} BETWEEN $1::date AND $2::date
              GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
            fromDate,
            to,
          )
        : Promise.resolve([]),
    ]);

    const total = weekly.reduce((s, w) => s + w.n, 0);
    if (!total) throw new BadRequestException(`No cases between ${fromDate} and ${to}.`);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    const areas = dto.areaLayerId ? await this.byArea(appUser, dto, from, where, dateExpr, params, pFrom, pTo) : null;

    const result = {
      period: { from: fromDate, to },
      totalCases: total,
      weekly: weekly.map((w) => ({ week: iso(w.week), cases: w.n })),
      clusters: clusters.map((c, i) => ({
        rank: i + 1,
        cases: c.n,
        recentCases: c.recent,
        active: c.recent > 0,
        firstCase: iso(c.first),
        lastCase: iso(c.last),
        center: c.center.coordinates,
        hull: c.hull,
        zone: c.zone,
      })),
      casesInClusters: clusters.reduce((s, c) => s + c.n, 0),
      points: points.map((p) => [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6, iso(p.d)] as [number, number, string]),
      breakdown: breakdown.map((b) => ({ value: b.value ?? '(blank)', cases: b.n })),
      areas,
      savedLayer: null as unknown,
      settings: { clusterDistanceM: dto.clusterDistanceM ?? 200, minCases, zoneBufferM: dto.zoneBufferM ?? 400 },
    };

    if (dto.saveZonesAs?.trim() && result.clusters.length) {
      result.savedLayer = await this.saveZones(appUser, dto.saveZonesAs.trim(), result.clusters, layer.name, fromDate, to);
    }
    return result;
  }

  private async byArea(
    appUser: AppUser,
    dto: OutbreakDto,
    from: string,
    where: string,
    dateExpr: string,
    params: unknown[],
    pFrom: string,
    pTo: string,
  ) {
    const area = await this.gisLayers.vectorSource(appUser, dto.areaLayerId!, 'view');
    if (area.layer.geometryType !== 'POLYGON') throw new BadRequestException(`"${area.layer.name}" is not a polygon layer.`);
    const cols = await this.columns(area.table);
    const pop = dto.areaPopulationField;
    if (pop && (!FIELD.test(pop) || !cols.has(pop))) throw new BadRequestException(`"${pop}" is not a field of "${area.layer.name}".`);
    const label =
      [...cols].find((c) => /^(ward_?name|ward_?no|ward|name|name_en|label)$/i.test(c)) ?? [...cols].find((c) => /name/i.test(c)) ?? null;
    const rows = await this.prisma.$queryRawUnsafe<{ id: number; label: string | null; pop: number | null; n: number; geometry: unknown }[]>(
      `WITH c AS (SELECT ST_Transform(ST_PointOnSurface(t.geom), 4326) AS p FROM ${from} t
                   WHERE ${where} AND ${dateExpr} BETWEEN ${pFrom} AND ${pTo})
       SELECT a.ogc_fid AS id, ${label ? `a."${label}"::text` : 'NULL'} AS label,
              ${pop ? `NULLIF(a."${pop}"::text, '')::float8` : 'NULL'} AS pop,
              (SELECT count(*)::int FROM c WHERE ST_Intersects(ST_Transform(a.geom, 4326), c.p)) AS n,
              ST_AsGeoJSON(ST_SimplifyPreserveTopology(ST_Transform(a.geom, 4326), 0.0002), 6)::json AS geometry
         FROM ${area.from} a WHERE a.geom IS NOT NULL
        LIMIT 1000`,
      ...params,
    );
    return {
      layerName: area.layer.name,
      rows: rows
        .map((r) => ({
          label: r.label ?? `Area ${r.id}`,
          cases: r.n,
          population: r.pop,
          per10k: r.pop && r.pop > 0 ? Math.round((r.n / r.pop) * 100_000) / 10 : null,
          geometry: r.geometry,
        }))
        .sort((a, b) => (b.per10k ?? b.cases) - (a.per10k ?? a.cases)),
    };
  }

  private async saveZones(
    appUser: AppUser,
    name: string,
    clusters: { cases: number; recentCases: number; firstCase: string; lastCase: string; zone: unknown }[],
    sourceName: string,
    fromDate: string,
    to: string,
  ) {
    const output = await this.raster.prepareVectorOutput(appUser, name);
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE "${output.table}" (
         ogc_fid SERIAL PRIMARY KEY, cluster int, cases int, recent_cases int, active boolean,
         first_case date, last_case date, geom geometry(MultiPolygon, 4326))`,
    );
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "${output.table}" (cluster, cases, recent_cases, active, first_case, last_case, geom)
         SELECT r.rank, r.cases, r.recent, r.recent > 0, r.first::date, r.last::date,
                ST_Multi(ST_CollectionExtract(ST_SetSRID(ST_GeomFromGeoJSON(r.zone), 4326), 3))
           FROM jsonb_to_recordset($1::jsonb) AS r(rank int, cases int, recent int, first text, last text, zone text)`,
        JSON.stringify(
          clusters.map((c, i) => ({ rank: i + 1, cases: c.cases, recent: c.recentCases, first: c.firstCase, last: c.lastCase, zone: JSON.stringify(c.zone) })),
        ),
      );
      return await this.raster.publishVectorTable(appUser, output, {
        name,
        geometryType: 'POLYGON',
        description: `Outbreak control zones from "${sourceName}", ${fromDate} to ${to}.`,
        rasterAnalysis: false,
        srs: 'EPSG:4326',
      });
    } catch (error) {
      await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${output.table}"`).catch(() => undefined);
      throw error;
    }
  }

  private async columns(table: string): Promise<Set<string>> {
    const rows = await this.prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      table,
    );
    return new Set(rows.map((r) => r.name));
  }
}
