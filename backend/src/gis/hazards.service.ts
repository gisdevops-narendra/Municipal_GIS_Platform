import { BadRequestException, Injectable } from '@nestjs/common';
import type { AppUser } from '../auth/types/app-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { GisLayersService } from './gis-layers.service';
import type { HazardExposureDto } from './dto/platform-extras.dto';

const SAMPLE = 25;

/** Counts the features of any layer inside each hazard area (earthquake
 *  felt radius, GDACS alert polygon) — "which of our assets are exposed". */
@Injectable()
export class HazardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gisLayers: GisLayersService,
  ) {}

  async exposure(appUser: AppUser, dto: HazardExposureDto) {
    const { layer, from } = await this.gisLayers.vectorSource(appUser, dto.layerId, 'view');
    const out: { id: string; count: number; features: { id: number; label: string; distanceKm: number }[] }[] = [];
    for (const area of dto.areas) {
      let geom: string;
      try {
        geom = JSON.stringify(area.geometry);
      } catch {
        throw new BadRequestException('Invalid area geometry.');
      }
      const meters = (area.bufferKm ?? 0) * 1000;
      const rows = await this.prisma.$queryRawUnsafe<{ id: number; props: Record<string, unknown>; d: number; total: number }[]>(
        `WITH a AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography AS g),
              hit AS (
                SELECT t.ogc_fid AS id, to_jsonb(t) - 'geom' - 'gis_workspace_id' AS props,
                       ST_Distance(ST_Transform(ST_PointOnSurface(t.geom), 4326)::geography, a.g) AS d
                  FROM ${from} t, a
                 WHERE t.geom IS NOT NULL
                   AND ST_DWithin(ST_Transform(t.geom, 4326)::geography, a.g, $2))
         SELECT id, props, d, (SELECT count(*) FROM hit)::int AS total FROM hit ORDER BY d, id LIMIT ${SAMPLE}`,
        geom,
        meters,
      );
      out.push({
        id: area.id,
        count: rows[0]?.total ?? 0,
        features: rows.map((r) => ({ id: r.id, label: this.label(r.props, r.id), distanceKm: Math.round(Number(r.d) / 100) / 10 })),
      });
    }
    return { layerName: layer.name, areas: out };
  }

  private label(props: Record<string, unknown>, id: number): string {
    const key = Object.keys(props).find((k) => /(^|_)(name|title|label|code)($|_)/i.test(k) && props[k]);
    return key ? String(props[key]) : `Feature ${id}`;
  }
}
