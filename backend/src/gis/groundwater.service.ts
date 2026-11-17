import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AppUser } from '../auth/types/app-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { GisLayersService } from './gis-layers.service';
import type { WellImportDto, WellReadingDto } from './dto/platform-extras.dto';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const MAX_WELLS = 5000;
/** Trend window: the last three years of readings. */
const TREND_YEARS = 3;

export type WellStatus = 'falling-fast' | 'falling' | 'stable' | 'rising' | 'no-data';

/**
 * Groundwater monitoring: any point layer can hold borewells / wells; each
 * feature gets dated water-level readings (depth below ground). The trend
 * is a least-squares slope over the last three years — positive = the
 * water table is going down.
 */
@Injectable()
export class GroundwaterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gisLayers: GisLayersService,
  ) {}

  async summary(appUser: AppUser, layerId: string, labelField?: string) {
    const { layer, from } = await this.gisLayers.vectorSource(appUser, layerId, 'view');
    if (layer.geometryType !== 'POINT') throw new BadRequestException(`"${layer.name}" is not a point layer.`);
    if (labelField && !FIELD.test(labelField)) throw new BadRequestException('Invalid label field.');
    const wells = await this.prisma.$queryRawUnsafe<{ id: number; lon: number; lat: number; props: Record<string, unknown> }[]>(
      `SELECT t.ogc_fid AS id, ST_X(p) AS lon, ST_Y(p) AS lat, to_jsonb(t) - 'geom' - 'gis_workspace_id' AS props
         FROM (SELECT t.*, ST_Transform(ST_PointOnSurface(t.geom), 4326) AS p FROM ${from} t WHERE t.geom IS NOT NULL) t
        ORDER BY t.ogc_fid LIMIT ${MAX_WELLS}`,
    );
    const readings = await this.prisma.gISWellReading.findMany({
      where: { layerId },
      select: { featureId: true, readingDate: true, depthM: true },
      orderBy: { readingDate: 'asc' },
    });
    const byWell = new Map<number, { t: number; d: number }[]>();
    for (const r of readings) {
      const list = byWell.get(r.featureId) ?? [];
      list.push({ t: r.readingDate.getTime(), d: r.depthM });
      byWell.set(r.featureId, list);
    }
    const out = wells.map((w) => {
      const list = byWell.get(w.id) ?? [];
      const last = list[list.length - 1];
      const trend = this.trend(list);
      return {
        id: w.id,
        label: this.label(w.props, labelField, w.id),
        point: [Number(w.lon), Number(w.lat)] as [number, number],
        readings: list.length,
        latestDepthM: last ? last.d : null,
        latestDate: last ? new Date(last.t).toISOString().slice(0, 10) : null,
        trendMPerYear: trend,
        status: this.status(trend, list.length),
      };
    });
    const withData = out.filter((w) => w.readings > 0);
    const count = (s: WellStatus) => out.filter((w) => w.status === s).length;
    return {
      layerName: layer.name,
      wells: out,
      stats: {
        wells: out.length,
        withReadings: withData.length,
        fallingFast: count('falling-fast'),
        falling: count('falling'),
        stable: count('stable'),
        rising: count('rising'),
        averageDepthM: withData.length
          ? Math.round((withData.reduce((s, w) => s + (w.latestDepthM ?? 0), 0) / withData.length) * 100) / 100
          : null,
      },
      truncated: wells.length >= MAX_WELLS,
    };
  }

  async readings(appUser: AppUser, layerId: string, featureId: number) {
    await this.gisLayers.vectorSource(appUser, layerId, 'view');
    const rows = await this.prisma.gISWellReading.findMany({
      where: { layerId, featureId },
      orderBy: { readingDate: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      date: r.readingDate.toISOString().slice(0, 10),
      depthM: r.depthM,
      note: r.note,
    }));
  }

  async addReading(appUser: AppUser, layerId: string, featureId: number, dto: WellReadingDto) {
    const { from } = await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    if (!DATE.test(dto.date) || Number.isNaN(Date.parse(dto.date))) throw new BadRequestException('Use a date like 2026-11-17.');
    if (Date.parse(dto.date) > Date.now() + 86_400_000) throw new BadRequestException('The reading date is in the future.');
    const [exists] = await this.prisma.$queryRawUnsafe<{ ok: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM ${from} t WHERE t.ogc_fid = $1) AS ok`,
      featureId,
    );
    if (!exists?.ok) throw new NotFoundException('Well not found.');
    await this.prisma.gISWellReading.create({
      data: {
        layerId,
        featureId,
        readingDate: new Date(`${dto.date}T00:00:00Z`),
        depthM: dto.depthM,
        note: dto.note?.trim() || null,
        createdById: appUser.id,
      },
    });
    return this.readings(appUser, layerId, featureId);
  }

  async deleteReading(appUser: AppUser, layerId: string, readingId: string) {
    await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    const { count } = await this.prisma.gISWellReading.deleteMany({ where: { id: readingId, layerId } });
    if (!count) throw new NotFoundException('Reading not found.');
  }

  /** Bulk readings from a spreadsheet: rows matched to wells by `keyField`. */
  async import(appUser: AppUser, layerId: string, dto: WellImportDto) {
    const { from, table } = await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    if (!FIELD.test(dto.keyField)) throw new BadRequestException('Invalid key field.');
    const [has] = await this.prisma.$queryRawUnsafe<{ ok: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND table_name = $2 AND column_name = $1) AS ok`,
      dto.keyField,
      table,
    );
    if (!has?.ok && dto.keyField !== 'ogc_fid') throw new BadRequestException(`"${dto.keyField}" is not a field of this layer.`);
    const keys = await this.prisma.$queryRawUnsafe<{ id: number; key: string }[]>(
      `SELECT t.ogc_fid AS id, t."${dto.keyField}"::text AS key FROM ${from} t`,
    );
    const idOf = new Map(keys.map((k) => [String(k.key).trim().toLowerCase(), k.id]));
    const data: { layerId: string; featureId: number; readingDate: Date; depthM: number; createdById: string }[] = [];
    const skipped: string[] = [];
    for (const [i, row] of dto.rows.entries()) {
      const id = idOf.get(String(row.key ?? '').trim().toLowerCase());
      const depth = Number(row.depthM);
      const date = String(row.date ?? '').trim();
      if (id === undefined || !Number.isFinite(depth) || !DATE.test(date) || Number.isNaN(Date.parse(date))) {
        if (skipped.length < 20) skipped.push(`row ${i + 2}: ${id === undefined ? `no well "${row.key}"` : 'bad date or depth'}`);
        continue;
      }
      data.push({ layerId, featureId: id, readingDate: new Date(`${date}T00:00:00Z`), depthM: depth, createdById: appUser.id });
    }
    if (data.length) await this.prisma.gISWellReading.createMany({ data });
    return { imported: data.length, skipped: dto.rows.length - data.length, problems: skipped };
  }

  /** Metres per year (least squares) over the recent window; null if
   *  under 3 readings or under ~3 months of record. */
  private trend(list: { t: number; d: number }[]): number | null {
    if (list.length < 3) return null;
    const cutoff = list[list.length - 1].t - TREND_YEARS * 365.25 * 86_400_000;
    const pts = list.filter((p) => p.t >= cutoff);
    if (pts.length < 3 || pts[pts.length - 1].t - pts[0].t < 90 * 86_400_000) return null;
    const year = 365.25 * 86_400_000;
    const xs = pts.map((p) => (p.t - pts[0].t) / year);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = pts.reduce((a, p) => a + p.d, 0) / pts.length;
    let num = 0;
    let den = 0;
    xs.forEach((x, i) => {
      num += (x - mx) * (pts[i].d - my);
      den += (x - mx) ** 2;
    });
    return den > 0 ? Math.round((num / den) * 100) / 100 : null;
  }

  private status(trend: number | null, n: number): WellStatus {
    if (!n) return 'no-data';
    if (trend === null) return 'stable';
    if (trend > 0.5) return 'falling-fast';
    if (trend > 0.1) return 'falling';
    if (trend < -0.1) return 'rising';
    return 'stable';
  }

  private label(props: Record<string, unknown>, field: string | undefined, id: number): string {
    if (field && props[field] !== null && props[field] !== undefined && props[field] !== '') return String(props[field]);
    const key = Object.keys(props).find((k) => /^(well_?id|bore_?well|name|well_?name|code|id_no|site)/i.test(k) && props[k]);
    return key ? String(props[key]) : `Well ${id}`;
  }
}
