import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { Prisma } from '@prisma/client';
import type { AppUser } from '../auth/types/app-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { GisLayersService } from './gis-layers.service';
import type { CreateShareLinkDto } from './dto/platform-extras.dto';

interface ShareConfig {
  layerIds: string[];
  external: Record<string, unknown>[];
  basemap: string;
  center: [number, number];
  zoom: number;
}

const EXTERNAL_KINDS = new Set(['WMS', 'WMTS', 'XYZ', 'ARCGIS', 'WFS']);

/** Keeps only the known, plain fields of an Add Service spec, and only
 *  http(s) URLs — the public viewer builds map sources from these. */
function sanitizeExternal(spec: Record<string, unknown>): Record<string, unknown> | null {
  const kind = String(spec['kind'] ?? '');
  const url = String(spec['url'] ?? '');
  if (!EXTERNAL_KINDS.has(kind) || !/^https?:\/\//i.test(url) || url.length > 2000) return null;
  const out: Record<string, unknown> = { kind, url, title: String(spec['title'] ?? kind).slice(0, 120) };
  for (const key of ['layer', 'format', 'style', 'version', 'attribution', 'outputFormat']) {
    if (typeof spec[key] === 'string') out[key] = (spec[key] as string).slice(0, 500);
  }
  const opacity = Number(spec['opacity']);
  out['opacity'] = Number.isFinite(opacity) ? Math.min(Math.max(opacity, 0), 1) : 1;
  // WMTS tile grid, captured from the service's capabilities.
  if (kind === 'WMTS' && spec['wmts'] && typeof spec['wmts'] === 'object') {
    out['wmts'] = JSON.parse(JSON.stringify(spec['wmts']).slice(0, 200_000)) as unknown;
  }
  return out;
}

@Injectable()
export class ShareLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gisLayers: GisLayersService,
  ) {}

  async create(appUser: AppUser, dto: CreateShareLinkDto) {
    // Only layers the creator may see can be shared (getById enforces VIEW).
    const layerIds: string[] = [];
    for (const id of [...new Set(dto.layerIds)]) {
      await this.gisLayers.getById(appUser, id);
      layerIds.push(id);
    }
    const external = (dto.external ?? []).map(sanitizeExternal).filter((s): s is Record<string, unknown> => !!s);
    const [lon, lat] = dto.center;
    const config: ShareConfig = {
      layerIds,
      external,
      basemap: dto.basemap ?? 'osm',
      center: [Number.isFinite(lon) ? lon : 0, Number.isFinite(lat) ? lat : 0],
      zoom: dto.zoom,
    };
    const row = await this.prisma.gISShareLink.create({
      data: {
        token: randomBytes(18).toString('base64url'),
        municipalityId: appUser.municipalityId,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        config: config as unknown as Prisma.InputJsonValue,
        createdById: appUser.id,
        expiresAt: dto.expiresInDays ? new Date(Date.now() + dto.expiresInDays * 86_400_000) : null,
      },
    });
    return this.toView(row);
  }

  async list(appUser: AppUser) {
    const rows = await this.prisma.gISShareLink.findMany({
      where: { municipalityId: appUser.municipalityId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => this.toView(r));
  }

  /** The creator, or the Municipality Owner, may revoke a link. */
  async revoke(appUser: AppUser, id: string) {
    const row = await this.prisma.gISShareLink.findFirst({ where: { id, municipalityId: appUser.municipalityId } });
    if (!row) throw new NotFoundException('Share link not found.');
    if (row.createdById !== appUser.id && appUser.systemRole !== 'MUNICIPALITY_OWNER') {
      throw new ForbiddenException('Only the person who created this link, or the Owner, can revoke it.');
    }
    await this.prisma.gISShareLink.update({ where: { id }, data: { revokedAt: new Date() } });
  }

  /** Anonymous read of a live link — what the public viewer draws. */
  async open(token: string) {
    const row = await this.prisma.gISShareLink.findUnique({ where: { token } });
    if (!row || row.revokedAt || (row.expiresAt && row.expiresAt < new Date())) {
      throw new NotFoundException('This map link does not exist, has expired or was revoked.');
    }
    const config = row.config as unknown as ShareConfig;
    const workspace = await this.prisma.gISWorkspace.findUnique({ where: { municipalityId: row.municipalityId } });
    const municipality = await this.prisma.municipality.findUnique({
      where: { id: row.municipalityId },
      select: { name: true },
    });
    const layers = workspace
      ? await this.prisma.gISLayer.findMany({
          where: { id: { in: config.layerIds }, gisWorkspaceId: workspace.id, status: 'ACTIVE' },
        })
      : [];
    const order = new Map(config.layerIds.map((id, i) => [id, i]));
    await this.prisma.gISShareLink.update({
      where: { id: row.id },
      data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
    });
    return {
      title: row.title,
      description: row.description,
      municipalityName: municipality?.name ?? null,
      basemap: config.basemap,
      center: config.center,
      zoom: config.zoom,
      expiresAt: row.expiresAt,
      layers: layers
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
        .map((l) => ({
          id: l.id,
          name: l.name,
          layerType: l.layerType,
          geometryType: l.geometryType,
          geoserverWorkspace: l.geoserverWorkspace,
          geoserverLayer: l.geoserverLayer,
          styleName: l.styleName,
        })),
      external: config.external ?? [],
    };
  }

  private toView(row: {
    id: string;
    token: string;
    title: string;
    description: string | null;
    config: Prisma.JsonValue;
    createdById: string;
    expiresAt: Date | null;
    viewCount: number;
    lastViewedAt: Date | null;
    createdAt: Date;
  }) {
    const config = row.config as unknown as ShareConfig;
    return {
      id: row.id,
      token: row.token,
      title: row.title,
      description: row.description,
      layerCount: config.layerIds.length + (config.external?.length ?? 0),
      createdById: row.createdById,
      expiresAt: row.expiresAt,
      expired: !!row.expiresAt && row.expiresAt < new Date(),
      viewCount: row.viewCount,
      lastViewedAt: row.lastViewedAt,
      createdAt: row.createdAt,
    };
  }
}
