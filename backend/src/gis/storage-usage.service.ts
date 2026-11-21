import { Injectable, PayloadTooLargeException } from '@nestjs/common';
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
 * indexes) + raster file + PMTiles archive + feature attachments, summed
 * per account. The account limit (MB, set by platform admins; null = none)
 * is checked before new data is stored (uploads, new layers).
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

  /** Overview for the Storage panel: the account's usage against its
   *  limit (limits are set by platform admins). */
  async overview(appUser: AppUser) {
    const usage = await this.layerUsage(appUser.municipalityId, true);
    const account = await this.prisma.municipality.findUnique({
      where: { id: appUser.municipalityId },
      select: { storageQuotaMb: true },
    });
    const layers = usage.layers;
    return {
      municipalityQuotaMb: account?.storageQuotaMb ?? null,
      totalBytes: layers.reduce((s, l) => s + l.totalBytes, 0),
      breakdown: {
        tableBytes: layers.reduce((s, l) => s + l.tableBytes, 0),
        fileBytes: layers.reduce((s, l) => s + l.fileBytes, 0),
        tileBytes: layers.reduce((s, l) => s + l.tileBytes, 0),
        attachmentBytes: layers.reduce((s, l) => s + l.attachmentBytes, 0),
      },
      largestLayers: [...layers].sort((a, b) => b.totalBytes - a.totalBytes).slice(0, 25),
      measuredAt: new Date(usage.at).toISOString(),
    };
  }

  /**
   * Refuses to store `incomingBytes` more when that would pass the
   * account's storage limit. Call before saving uploads / creating layers.
   */
  async assertCanStore(municipalityId: string, incomingBytes = 0): Promise<void> {
    const account = await this.prisma.municipality.findUnique({
      where: { id: municipalityId },
      select: { storageQuotaMb: true },
    });
    const quota = account?.storageQuotaMb ?? null;
    if (quota === null) return;
    const usage = await this.layerUsage(municipalityId, false);
    const total = usage.layers.reduce((s, l) => s + l.totalBytes, 0);
    const mb = (b: number) => `${Math.round(b / MB).toLocaleString()} MB`;
    if (total + incomingBytes > quota * MB) {
      throw new PayloadTooLargeException(
        `Your account has reached its storage limit (${mb(total)} of ${quota.toLocaleString()} MB used). Delete layers you no longer need to free up space.`,
      );
    }
  }

  /** Total bytes used by one account (cached a minute). Admin listing. */
  async accountBytes(municipalityId: string): Promise<{ bytes: number; layerCount: number }> {
    const usage = await this.layerUsage(municipalityId, false);
    return { bytes: usage.layers.reduce((s, l) => s + l.totalBytes, 0), layerCount: usage.layers.length };
  }

  /** Per-layer usage, cached for a minute (`fresh` re-measures). */
  private async layerUsage(municipalityId: string, fresh: boolean): Promise<Usage> {
    const hit = this.cache.get(municipalityId);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit;
    const workspace = await this.prisma.gISWorkspace.findUnique({ where: { municipalityId } });
    if (!workspace) return { at: Date.now(), layers: [] };
    const layers = await this.prisma.gISLayer.findMany({
      where: { gisWorkspaceId: workspace.id },
      select: { id: true, name: true, layerType: true, postgisTable: true },
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
