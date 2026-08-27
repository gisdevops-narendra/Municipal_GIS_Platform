import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GISWorkspace, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GeoServerService, PostgisConnectionParams } from './geoserver.service';
import { GisLayersService } from './gis-layers.service';
import {
  deriveWorkspaceCode,
  slugifyWorkspaceName,
} from './workspace-naming.util';
import { UpdateGisWorkspaceDto } from './dto/update-gis-workspace.dto';

/** Default storage CRS for newly provisioned workspaces. Suitable for the
 *  initial Gujarat/Somnath development environment (UTM zone 43N) — NOT a
 *  universal default. Configurable per municipality after creation (see
 *  UpdateGisWorkspaceDto); automatic per-state/region CRS selection is
 *  deferred to a future task, as is CRS auto-detection during data
 *  ingestion. */
const DEFAULT_STORAGE_CRS = 'EPSG:32643';
const DEFAULT_DISPLAY_CRS = 'EPSG:4326';

type PrismaOrTx = PrismaService | Prisma.TransactionClient;

/**
 * Owns the Municipality -> GISWorkspace relationship (exactly one
 * permanent workspace per municipality) and orchestrates GeoServer
 * provisioning. See docs/backend.md "GIS Workspace" for the full design
 * (transaction boundary, retry-safe provisioning, tenant isolation).
 */
@Injectable()
export class GisWorkspaceService {
  private readonly logger = new Logger(GisWorkspaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geoServer: GeoServerService,
    private readonly config: ConfigService,
    private readonly gisLayers: GisLayersService,
  ) {}

  /**
   * Creates the GISWorkspace database row. Called from within
   * MunicipalitiesService's registration `$transaction` — Municipality +
   * Owner + GISWorkspace all commit together or not at all. Does NOT touch
   * GeoServer (an external service cannot participate in a DB
   * transaction) — call `provisionWorkspace` afterward, once the
   * transaction has committed.
   */
  async createWorkspaceRecord(
    tx: Prisma.TransactionClient,
    municipalityId: string,
    municipalityName: string,
    createdById: string | null,
  ): Promise<GISWorkspace> {
    const geoserverWorkspace = await this.generateUniqueGeoserverWorkspaceName(
      municipalityName,
      tx,
    );
    return tx.gISWorkspace.create({
      data: {
        municipalityId,
        name: `${municipalityName} GIS`,
        code: deriveWorkspaceCode(municipalityName),
        geoserverWorkspace,
        defaultCrs: DEFAULT_STORAGE_CRS,
        displayCrs: DEFAULT_DISPLAY_CRS,
        status: 'PROVISIONING',
        createdById,
      },
    });
  }

  /**
   * Provisions (or re-provisions) the GeoServer side for an existing
   * GISWorkspace row: ensures the workspace and its PostGIS datastore
   * exist, then confirms the datastore can actually reach PostGIS. Every
   * step is idempotent (ensureWorkspace/ensurePostgisDatastore check
   * existence first) — safe to call repeatedly, e.g. via the retry
   * endpoint, without creating duplicates. Never throws: failure is
   * recorded as PROVISIONING_FAILED rather than propagated, so a
   * GeoServer outage never fails municipality registration itself.
   */
  async provisionWorkspace(workspaceId: string): Promise<GISWorkspace> {
    const workspace = await this.prisma.gISWorkspace.findUniqueOrThrow({
      where: { id: workspaceId },
    });
    const datastoreName = this.datastoreName(workspace.geoserverWorkspace);

    try {
      await this.geoServer.ensureWorkspace(workspace.geoserverWorkspace);
      await this.geoServer.ensurePostgisDatastore(
        workspace.geoserverWorkspace,
        datastoreName,
        this.datastoreConnection(),
      );

      const connected = await this.geoServer.checkDatastoreConnection(
        workspace.geoserverWorkspace,
        datastoreName,
      );
      if (!connected) {
        throw new Error(
          'PostGIS datastore was created but the connection check failed.',
        );
      }

      const active = await this.prisma.gISWorkspace.update({
        where: { id: workspace.id },
        data: { status: 'ACTIVE' },
      });

      // Task 6: publish the demo layers once the workspace itself is
      // confirmed ACTIVE. Never lets a demo-layer hiccup flip a genuinely
      // working workspace back to PROVISIONING_FAILED — see
      // GisLayersService.ensureDemoLayers, which never throws.
      await this.gisLayers.ensureDemoLayers(active);

      return active;
    } catch (error) {
      this.logger.error(
        `GIS workspace provisioning failed for "${workspace.geoserverWorkspace}"`,
        error as Error,
      );
      return this.prisma.gISWorkspace.update({
        where: { id: workspace.id },
        data: { status: 'PROVISIONING_FAILED' },
      });
    }
  }

  /** Returns the caller's own municipality's workspace. Tenant scoping
   *  flows entirely from `municipalityId`, which callers must derive from
   *  the authenticated AppUser — never from client-supplied input. If no
   *  row exists yet (a municipality registered before Task 5 existed),
   *  backfills one and attempts provisioning once, so onboarding remains
   *  automatic rather than requiring a manual admin step. */
  async getForMunicipality(municipalityId: string) {
    let workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId },
    });

    if (!workspace) {
      const municipality = await this.prisma.municipality.findUniqueOrThrow({
        where: { id: municipalityId },
      });
      const geoserverWorkspace =
        await this.generateUniqueGeoserverWorkspaceName(municipality.name);
      const created = await this.prisma.gISWorkspace.create({
        data: {
          municipalityId,
          name: `${municipality.name} GIS`,
          code: deriveWorkspaceCode(municipality.name),
          geoserverWorkspace,
          defaultCrs: DEFAULT_STORAGE_CRS,
          displayCrs: DEFAULT_DISPLAY_CRS,
          status: 'PROVISIONING',
        },
      });
      workspace = await this.provisionWorkspace(created.id);
    }

    return this.toResponse(workspace);
  }

  /** Owner-only. Allowed fields only — municipalityId, geoserverWorkspace,
   *  and code are system-controlled and never accepted here (enforced by
   *  UpdateGisWorkspaceDto not declaring those fields at all, mirroring the
   *  pattern already used for registration/user-creation DTOs). */
  async update(
    municipalityId: string,
    dto: UpdateGisWorkspaceDto,
    updatedById: string,
  ) {
    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId },
    });
    if (!workspace) {
      throw new NotFoundException('GIS workspace not found.');
    }

    const updated = await this.prisma.gISWorkspace.update({
      where: { id: workspace.id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.description !== undefined && {
          description: dto.description?.trim() || null,
        }),
        ...(dto.defaultCrs !== undefined && { defaultCrs: dto.defaultCrs }),
        ...(dto.displayCrs !== undefined && { displayCrs: dto.displayCrs }),
        updatedById,
      },
    });
    return this.toResponse(updated);
  }

  /** Owner-only. Re-attempts GeoServer provisioning for the caller's own
   *  workspace — the operationally useful "retry" referenced in Task 5 §6,
   *  for recovering a PROVISIONING_FAILED workspace once GeoServer is back. */
  async retryProvisioning(municipalityId: string) {
    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId },
    });
    if (!workspace) {
      throw new NotFoundException('GIS workspace not found.');
    }
    const updated = await this.provisionWorkspace(workspace.id);
    return this.toResponse(updated);
  }

  async getGeoServerHealth(): Promise<{ status: 'UP'; version?: string }> {
    const health = await this.geoServer.checkHealth();
    if (!health.reachable) {
      throw new ServiceUnavailableException(
        health.message ?? 'GeoServer is unavailable.',
      );
    }
    return { status: 'UP', version: health.version };
  }

  /** Deterministic base slug, disambiguated against existing workspaces by
   *  appending _2, _3, ... — GeoServer workspace names live in one flat
   *  namespace shared by every municipality, so this must be globally
   *  unique, not just per-municipality. Bounded loop with a timestamp-based
   *  fallback guards against a pathological run of collisions. */
  private async generateUniqueGeoserverWorkspaceName(
    municipalityName: string,
    client: PrismaOrTx = this.prisma,
  ): Promise<string> {
    const base = slugifyWorkspaceName(municipalityName);
    let candidate = base;
    for (let suffix = 2; suffix <= 50; suffix++) {
      const existing = await client.gISWorkspace.findUnique({
        where: { geoserverWorkspace: candidate },
        select: { id: true },
      });
      if (!existing) {
        return candidate;
      }
      candidate = `${base}_${suffix}`;
    }
    return `${base}_${Date.now()}`;
  }

  private datastoreName(geoserverWorkspace: string): string {
    return `${geoserverWorkspace}_postgis`;
  }

  private datastoreConnection(): PostgisConnectionParams {
    return {
      host: this.config.getOrThrow<string>('POSTGIS_HOST'),
      port: this.config.getOrThrow<string>('POSTGIS_PORT'),
      database: this.config.getOrThrow<string>('POSTGIS_DATABASE'),
      user: this.config.getOrThrow<string>('POSTGIS_USER'),
      password: this.config.getOrThrow<string>('POSTGIS_PASSWORD'),
    };
  }

  private toResponse(workspace: GISWorkspace) {
    return {
      id: workspace.id,
      name: workspace.name,
      code: workspace.code,
      description: workspace.description,
      status: workspace.status,
      defaultCrs: workspace.defaultCrs,
      displayCrs: workspace.displayCrs,
      geoserverWorkspace: workspace.geoserverWorkspace,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
  }
}
