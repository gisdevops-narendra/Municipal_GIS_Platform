import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AppUser } from '../auth/types/app-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { GisAuthorizationService } from './gis-authorization.service';
import type { UpdateLayerMetadataDto } from './dto/platform-extras.dto';

export interface LayerMetadata {
  source?: string;
  licence?: string;
  keywords?: string[];
  contact?: string;
  updateFrequency?: string;
  dataDate?: string;
  notes?: string;
}

/**
 * Data Catalog: every layer the caller may see, with its descriptive
 * record (source, licence, keywords, contact, update frequency, data date)
 * plus facts read from the data (type, size, extent, dates, owner).
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gisAuth: GisAuthorizationService,
  ) {}

  async list(appUser: AppUser) {
    const workspace = await this.prisma.gISWorkspace.findUnique({ where: { municipalityId: appUser.municipalityId } });
    if (!workspace) return [];
    const all = await this.prisma.gISLayer.findMany({
      where: { gisWorkspaceId: workspace.id },
      include: { department: { select: { name: true } } },
      orderBy: { name: 'asc' },
    });
    const layers = await this.gisAuth.filterViewable(appUser, all);
    const tables = layers.map((l) => l.postgisTable).filter((t): t is string => !!t);
    const counts = tables.length
      ? await this.prisma.$queryRawUnsafe<{ name: string; rows: number }[]>(
          `SELECT relname AS name, GREATEST(reltuples, 0)::float8 AS rows FROM pg_class
            WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[])`,
          tables,
        )
      : [];
    const rows = new Map(counts.map((c) => [c.name, Math.round(Number(c.rows))]));
    const creatorIds = [...new Set(layers.map((l) => l.createdById).filter((id): id is string => !!id))];
    const creators = new Map(
      (await this.prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, fullName: true } })).map((u) => [
        u.id,
        u.fullName,
      ]),
    );
    const manageable = await Promise.all(layers.map((l) => this.gisAuth.canManage(appUser, l)));
    return layers.map((l, i) => ({
      id: l.id,
      name: l.name,
      code: l.code,
      description: l.description,
      layerType: l.layerType,
      geometryType: l.geometryType,
      status: l.status,
      department: l.department?.name ?? null,
      ownershipType: l.ownershipType,
      featureCount: l.postgisTable ? rows.get(l.postgisTable) ?? null : null,
      bbox:
        l.bboxMinX !== null && l.bboxMinY !== null && l.bboxMaxX !== null && l.bboxMaxY !== null
          ? [l.bboxMinX, l.bboxMinY, l.bboxMaxX, l.bboxMaxY]
          : null,
      createdBy: l.createdById ? creators.get(l.createdById) ?? null : null,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      aiGenerated: l.aiGenerated,
      drawnLayer: l.drawnLayer,
      metadata: (l.metadata ?? {}) as LayerMetadata,
      canEdit: manageable[i],
    }));
  }

  async update(appUser: AppUser, layerId: string, dto: UpdateLayerMetadataDto) {
    const workspace = await this.prisma.gISWorkspace.findUnique({ where: { municipalityId: appUser.municipalityId } });
    const layer = workspace
      ? await this.prisma.gISLayer.findFirst({ where: { id: layerId, gisWorkspaceId: workspace.id } })
      : null;
    if (!layer) throw new NotFoundException('Layer not found.');
    if (!(await this.gisAuth.canManage(appUser, layer))) {
      throw new ForbiddenException('You need Manage permission on this layer to edit its catalog record.');
    }
    const current = (layer.metadata ?? {}) as LayerMetadata;
    const clean = (v: string | undefined) => (v === undefined ? undefined : v.trim() || undefined);
    const next: LayerMetadata = {
      ...current,
      ...(dto.source !== undefined ? { source: clean(dto.source) } : {}),
      ...(dto.licence !== undefined ? { licence: clean(dto.licence) } : {}),
      ...(dto.keywords !== undefined
        ? { keywords: [...new Set(dto.keywords.map((k) => k.trim()).filter(Boolean))] }
        : {}),
      ...(dto.contact !== undefined ? { contact: clean(dto.contact) } : {}),
      ...(dto.updateFrequency !== undefined ? { updateFrequency: clean(dto.updateFrequency) } : {}),
      ...(dto.dataDate !== undefined ? { dataDate: clean(dto.dataDate) } : {}),
      ...(dto.notes !== undefined ? { notes: clean(dto.notes) } : {}),
    };
    await this.prisma.gISLayer.update({
      where: { id: layerId },
      data: {
        metadata: JSON.parse(JSON.stringify(next)) as Prisma.InputJsonValue,
        ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}),
      },
    });
    return (await this.list(appUser)).find((l) => l.id === layerId);
  }
}
