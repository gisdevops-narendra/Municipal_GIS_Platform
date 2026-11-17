import { BadRequestException, ForbiddenException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { stat } from 'fs/promises';
import * as path from 'path';
import type { AppUser } from '../auth/types/app-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { rasterFilePath } from './raster-paths.util';
import { isSafeGeneratedTableName } from './layer-naming.util';

const MB = 1024 * 1024;
const CACHE_MS = 60_000;

export interface LayerUsage {
  id: string;
  name: string;
  departmentId: string | null;
  layerType: string;
  tableBytes: number;
  fileBytes: number;
  tileBytes: number;
  attachmentBytes: number;
  totalBytes: number;
}

interface Usage {
  at: number;
  layers: LayerUsage[];
}

/**
 * Storage usage and limits. Usage per layer = its PostGIS table (with
 * indexes) + raster file + PMTiles archive + feature attachments; summed
 * per department ("shared" = municipality-owned layers). Limits (MB) are
 * optional, per department and for the whole municipality, and are checked
 * before new data is stored (uploads, new layers).
 */
@Injectable()
export class StorageUsageService {
  private readonly storageRoot: string;
  private readonly cache = new Map<string, Usage>();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.storageRoot = path.resolve(config.get<string>('GIS_UPLOAD_STORAGE_DIR', './storage/uploads'));
  }

  /** Overview for the Storage panel. A Department Head sees only their own
   *  department; the Owner sees everything. */
  async overview(appUser: AppUser) {
    const usage = await this.layerUsage(appUser.municipalityId, true);
    const [municipality, departments] = await Promise.all([
      this.prisma.municipality.findUnique({ where: { id: appUser.municipalityId }, select: { storageQuotaMb: true } }),
      this.prisma.department.findMany({
        where: { municipalityId: appUser.municipalityId },
        select: { id: true, name: true, storageQuotaMb: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    const owner = appUser.systemRole === 'MUNICIPALITY_OWNER';
    const sum = (list: LayerUsage[]) => list.reduce((s, l) => s + l.totalBytes, 0);
    const byDept = departments
      .filter((d) => owner || d.id === appUser.departmentId)
      .map((d) => {
        const layers = usage.layers.filter((l) => l.departmentId === d.id);
        return { id: d.id, name: d.name, quotaMb: d.storageQuotaMb, bytes: sum(layers), layerCount: layers.length };
      });
    const shared = usage.layers.filter((l) => !l.departmentId);
    const visible = owner ? usage.layers : usage.layers.filter((l) => l.departmentId === appUser.departmentId);
    return {
      canEditLimits: owner,
      municipalityQuotaMb: municipality?.storageQuotaMb ?? null,
      totalBytes: sum(usage.layers),
      breakdown: {
        tableBytes: visible.reduce((s, l) => s + l.tableBytes, 0),
        fileBytes: visible.reduce((s, l) => s + l.fileBytes, 0),
        tileBytes: visible.reduce((s, l) => s + l.tileBytes, 0),
        attachmentBytes: visible.reduce((s, l) => s + l.attachmentBytes, 0),
      },
      shared: owner ? { bytes: sum(shared), layerCount: shared.length } : null,
      departments: byDept,
      largestLayers: [...visible].sort((a, b) => b.totalBytes - a.totalBytes).slice(0, 25),
      measuredAt: new Date(usage.at).toISOString(),
    };
  }

  async setLimits(
    appUser: AppUser,
    body: { municipalityQuotaMb?: number | null; departments?: { id: string; quotaMb: number | null }[] },
  ) {
    if (appUser.systemRole !== 'MUNICIPALITY_OWNER') throw new ForbiddenException('Only the Owner can set storage limits.');
    const valid = (v: unknown) => v === null || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10_000_000);
    if (body.municipalityQuotaMb !== undefined) {
      if (!valid(body.municipalityQuotaMb)) throw new BadRequestException('Limits are whole MB from 1, or empty for none.');
      await this.prisma.municipality.update({
        where: { id: appUser.municipalityId },
        data: { storageQuotaMb: body.municipalityQuotaMb },
      });
    }
    for (const d of body.departments ?? []) {
      if (!valid(d.quotaMb)) throw new BadRequestException('Limits are whole MB from 1, or empty for none.');
      const { count } = await this.prisma.department.updateMany({
        where: { id: d.id, municipalityId: appUser.municipalityId },
        data: { storageQuotaMb: d.quotaMb },
      });
      if (!count) throw new BadRequestException('Unknown department.');
    }
    return this.overview(appUser);
  }

  /**
   * Refuses to store `incomingBytes` more for `departmentId` (null =
   * municipality-owned) when that would pass the department's or the
   * municipality's limit. Call before saving uploads / creating layers.
   */
  async assertCanStore(municipalityId: string, departmentId: string | null | undefined, incomingBytes = 0): Promise<void> {
    const [municipality, department] = await Promise.all([
      this.prisma.municipality.findUnique({ where: { id: municipalityId }, select: { storageQuotaMb: true } }),
      departmentId
        ? this.prisma.department.findFirst({ where: { id: departmentId, municipalityId }, select: { name: true, storageQuotaMb: true } })
        : Promise.resolve(null),
    ]);
    const muniQuota = municipality?.storageQuotaMb ?? null;
    const deptQuota = department?.storageQuotaMb ?? null;
    if (muniQuota === null && deptQuota === null) return;
    const usage = await this.layerUsage(municipalityId, false);
    const total = usage.layers.reduce((s, l) => s + l.totalBytes, 0);
    const mb = (b: number) => `${Math.round(b / MB).toLocaleString()} MB`;
    if (deptQuota !== null) {
      const used = usage.layers.filter((l) => l.departmentId === departmentId).reduce((s, l) => s + l.totalBytes, 0);
      if (used + incomingBytes > deptQuota * MB) {
        throw new PayloadTooLargeException(
          `${department?.name ?? 'This department'} has reached its storage limit (${mb(used)} of ${deptQuota.toLocaleString()} MB used). Delete unused layers or ask the Owner to raise the limit.`,
        );
      }
    }
    if (muniQuota !== null && total + incomingBytes > muniQuota * MB) {
      throw new PayloadTooLargeException(
        `The municipality has reached its storage limit (${mb(total)} of ${muniQuota.toLocaleString()} MB used). Delete unused layers or raise the limit.`,
      );
    }
  }

  /** Per-layer usage, cached for a minute (`fresh` re-measures). */
  private async layerUsage(municipalityId: string, fresh: boolean): Promise<Usage> {
    const hit = this.cache.get(municipalityId);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit;
    const workspace = await this.prisma.gISWorkspace.findUnique({ where: { municipalityId } });
    if (!workspace) return { at: Date.now(), layers: [] };
    const layers = await this.prisma.gISLayer.findMany({
      where: { gisWorkspaceId: workspace.id },
      select: { id: true, name: true, departmentId: true, layerType: true, postgisTable: true },
    });
    // Shared demo tables are not this municipality's data.
    const tables = layers.map((l) => l.postgisTable).filter((t): t is string => !!t && isSafeGeneratedTableName(t));
    const sizes = tables.length
      ? await this.prisma.$queryRawUnsafe<{ name: string; bytes: bigint }[]>(
          `SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes
             FROM pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
          tables,
        )
      : [];
    const tableBytes = new Map(sizes.map((s) => [s.name, Number(s.bytes)]));
    const attachments = await this.prisma.gISFeatureAttachment.groupBy({
      by: ['layerId'],
      where: { layerId: { in: layers.map((l) => l.id) } },
      _sum: { size: true },
    });
    const attachmentBytes = new Map(attachments.map((a) => [a.layerId, a._sum.size ?? 0]));
    const fileSize = (file: string) => stat(file).then((s) => s.size, () => 0);
    const result: LayerUsage[] = await Promise.all(
      layers.map(async (l) => {
        const fileBytes = l.layerType === 'RASTER' ? await fileSize(rasterFilePath(this.storageRoot, municipalityId, l.id)) : 0;
        const tileBytes = await fileSize(path.join(this.storageRoot, municipalityId, 'tiles', `${l.id}.pmtiles`));
        const t = l.postgisTable ? tableBytes.get(l.postgisTable) ?? 0 : 0;
        const a = attachmentBytes.get(l.id) ?? 0;
        return {
          id: l.id,
          name: l.name,
          departmentId: l.departmentId,
          layerType: l.layerType,
          tableBytes: t,
          fileBytes,
          tileBytes,
          attachmentBytes: a,
          totalBytes: t + fileBytes + tileBytes + a,
        };
      }),
    );
    const usage = { at: Date.now(), layers: result };
    this.cache.set(municipalityId, usage);
    return usage;
  }
}
