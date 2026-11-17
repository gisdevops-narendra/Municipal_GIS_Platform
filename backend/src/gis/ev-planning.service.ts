import { BadRequestException, Injectable } from '@nestjs/common';
import type { AppUser } from '../auth/types/app-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { GisLayersService } from './gis-layers.service';
import type { EvCoverageDto } from './dto/platform-extras.dto';

const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const MAX_CELLS = 6000;

type CellStatus = 'served' | 'near' | 'gap' | 'empty';

/**
 * EV charging coverage. A square grid over the area (default 3 × 3 km —
 * India's charging-infrastructure guideline asks for a station in every
 * 3 km × 3 km city grid); each cell is "served" (has a charger), "near"
 * (a charger within the service radius of its centre), a "gap" (demand
 * but no charger in reach) or empty. Demand is any point / polygon layer
 * (buildings, parking, shops…) optionally weighted by a numeric field.
 */
@Injectable()
export class EvPlanningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gisLayers: GisLayersService,
  ) {}

  async coverage(appUser: AppUser, dto: EvCoverageDto) {
    const [minX, minY, maxX, maxY] = dto.bbox;
    if (dto.bbox.length !== 4 || !(maxX > minX && maxY > minY) || Math.abs(minY) > 85 || Math.abs(maxY) > 85) {
      throw new BadRequestException('The area is not a valid box.');
    }
    const cellKm = dto.cellKm ?? 3;
    const radiusKm = dto.serviceRadiusKm ?? cellKm;
    const lat = (minY + maxY) / 2;
    const cos = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const cellCount = (((maxX - minX) * 111.32 * cos) / cellKm) * (((maxY - minY) * 110.54) / cellKm);
    if (cellCount > MAX_CELLS) {
      throw new BadRequestException(`That makes about ${Math.round(cellCount).toLocaleString()} cells — zoom in or use bigger cells (max ${MAX_CELLS.toLocaleString()}).`);
    }

    const chargers = await this.gisLayers.vectorSource(appUser, dto.chargerLayerId, 'view');
    const demand = dto.demandLayerId ? await this.gisLayers.vectorSource(appUser, dto.demandLayerId, 'view') : null;
    let weight = '1';
    if (demand && dto.demandWeightField) {
      const f = dto.demandWeightField;
      const [has] = await this.prisma.$queryRawUnsafe<{ ok: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2) AS ok`,
        demand.table,
        f,
      );
      if (!FIELD.test(f) || !has?.ok) throw new BadRequestException(`"${f}" is not a field of "${demand.layer.name}".`);
      weight = `COALESCE((NULLIF(regexp_replace(t."${f}"::text, '[^0-9.\\-]', '', 'g'), ''))::float8, 0)`;
    }

    // Web Mercator metres, scaled so cells / radius are true ground km.
    const size = (cellKm * 1000) / cos;
    const radius = (radiusKm * 1000) / cos;
    const padDeg = radiusKm / (111.32 * cos);
    const box = `ST_MakeEnvelope($1, $2, $3, $4, 4326)`;
    const padded = `ST_MakeEnvelope($1 - ${padDeg}, $2 - ${padDeg}, $3 + ${padDeg}, $4 + ${padDeg}, 4326)`;
    const pt = `ST_Transform(ST_PointOnSurface(t.geom), 4326)`;
    const sql = `
      WITH env AS (SELECT ST_Transform(${box}, 3857) AS e),
           cells AS (SELECT g.geom, g.i, g.j FROM env, ST_SquareGrid(${size}, env.e) AS g WHERE ST_Intersects(g.geom, env.e)),
           ch AS (SELECT ST_Transform(${pt}, 3857) AS p FROM ${chargers.from} t
                   WHERE t.geom IS NOT NULL AND ${pt} && ${padded}),
           dm AS (${
             demand
               ? `SELECT ST_Transform(${pt}, 3857) AS p, ${weight} AS w FROM ${demand.from} t WHERE t.geom IS NOT NULL AND ${pt} && ${box}`
               : `SELECT NULL::geometry AS p, 0::float8 AS w WHERE false`
           })
      SELECT c.i, c.j,
             ST_AsGeoJSON(ST_Transform(c.geom, 4326), 6)::json AS geometry,
             ST_X(ST_Transform(ST_Centroid(c.geom), 4326)) AS cx,
             ST_Y(ST_Transform(ST_Centroid(c.geom), 4326)) AS cy,
             (SELECT count(*) FROM ch WHERE ST_Intersects(ch.p, c.geom))::int AS chargers,
             (SELECT count(*) FROM ch WHERE ST_DWithin(ch.p, ST_Centroid(c.geom), ${radius}))::int AS near,
             COALESCE((SELECT sum(w) FROM dm WHERE ST_Intersects(dm.p, c.geom)), 0)::float8 AS demand,
             COALESCE((SELECT sum(w) FROM dm WHERE ST_Intersects(dm.p, c.geom)
                         AND EXISTS (SELECT 1 FROM ch WHERE ST_DWithin(ch.p, dm.p, ${radius}))), 0)::float8 AS covered
        FROM cells c`;
    const rows = await this.prisma.$queryRawUnsafe<
      { i: number; j: number; geometry: unknown; cx: number; cy: number; chargers: number; near: number; demand: number; covered: number }[]
    >(sql, minX, minY, maxX, maxY);
    const [{ n: chargerCount }] = await this.prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ${chargers.from} t WHERE t.geom IS NOT NULL AND ${pt} && ${box}`,
      minX,
      minY,
      maxX,
      maxY,
    );

    const hasDemand = !!demand;
    const cells = rows.map((r) => {
      const status: CellStatus =
        r.chargers > 0 ? 'served' : r.near > 0 ? 'near' : hasDemand ? (r.demand > 0 ? 'gap' : 'empty') : 'gap';
      return {
        id: `${r.i}:${r.j}`,
        geometry: r.geometry,
        center: [Number(r.cx), Number(r.cy)] as [number, number],
        chargers: r.chargers,
        demand: Math.round(r.demand * 10) / 10,
        coveredDemand: Math.round(r.covered * 10) / 10,
        status,
      };
    });
    const totalDemand = cells.reduce((s, c) => s + c.demand, 0);
    const coveredDemand = cells.reduce((s, c) => s + c.coveredDemand, 0);
    const count = (s: CellStatus) => cells.filter((c) => c.status === s).length;
    const gaps = cells
      .filter((c) => c.status === 'gap')
      .sort((a, b) => b.demand - a.demand)
      .slice(0, 25)
      .map((c, k) => ({ rank: k + 1, id: c.id, center: c.center, demand: c.demand }));
    return {
      cellKm,
      serviceRadiusKm: radiusKm,
      chargersInArea: chargerCount,
      cells,
      stats: {
        cells: cells.length,
        served: count('served'),
        near: count('near'),
        gaps: count('gap'),
        empty: count('empty'),
        gridCoveragePct: cells.length ? Math.round(((count('served') + count('near')) / cells.length) * 1000) / 10 : 0,
        totalDemand: Math.round(totalDemand * 10) / 10,
        demandCoveredPct: hasDemand && totalDemand > 0 ? Math.round((coveredDemand / totalDemand) * 1000) / 10 : null,
      },
      topGaps: gaps,
    };
  }
}
