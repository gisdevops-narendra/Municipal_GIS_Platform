import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GISLayer, GISWorkspace, GisPermission } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GeoServerService } from './geoserver.service';
import { GisAuthorizationService } from './gis-authorization.service';
import type { AppUser } from '../auth/types/app-user.type';

type LayerWithDepartment = GISLayer & {
  department?: { id: string; name: string } | null;
};

interface DemoLayerDefinition {
  code: string;
  name: string;
  description: string;
  geometryType: 'POINT' | 'LINE' | 'POLYGON';
  /** Underlying shared PostGIS table (see the Task 6 migration). */
  nativeTable: string;
  /** Published GeoServer layer name within each municipality's own workspace. */
  geoserverLayer: string;
  visibleByDefault: boolean;
  displayOrder: number;
}

/**
 * The three demonstration layers every municipality gets automatically —
 * see Task 6 §7/§31. "Demo" is not a euphemism: the underlying geometry is
 * hand-authored sample data (see backend/prisma/seed-demo-gis-data.ts), not
 * real municipal GIS data.
 */
const DEMO_LAYER_DEFINITIONS: DemoLayerDefinition[] = [
  {
    code: 'MUNICIPAL_BOUNDARY',
    name: 'Municipality Boundary',
    description: 'Development/demo data — outline of the municipality.',
    geometryType: 'POLYGON',
    nativeTable: 'gis_demo_municipal_boundary',
    geoserverLayer: 'municipal_boundary',
    visibleByDefault: true,
    displayOrder: 1,
  },
  {
    code: 'WARDS',
    name: 'Wards',
    description: 'Development/demo data — ward subdivisions.',
    geometryType: 'POLYGON',
    nativeTable: 'gis_demo_wards',
    geoserverLayer: 'wards',
    visibleByDefault: true,
    displayOrder: 2,
  },
  {
    code: 'ROADS',
    name: 'Roads',
    description: 'Development/demo data — road network.',
    geometryType: 'LINE',
    nativeTable: 'gis_demo_roads',
    geoserverLayer: 'roads',
    visibleByDefault: false,
    displayOrder: 3,
  },
];

@Injectable()
export class GisLayersService {
  private readonly logger = new Logger(GisLayersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geoServer: GeoServerService,
    private readonly gisAuth: GisAuthorizationService,
  ) {}

  /**
   * Idempotently creates the GISLayer metadata rows + publishes the
   * matching GeoServer feature types for a workspace, so a newly
   * provisioned (or backfilled) municipality gets a working map with zero
   * manual steps — same philosophy as GisWorkspaceService.provisionWorkspace,
   * which calls this right after marking the workspace ACTIVE.
   *
   * Each feature type is published with a CQL filter scoping it to this
   * workspace's own rows in the shared demo tables — GeoServer itself
   * enforces the tenant boundary for WMS/WFS requests, not just this app's
   * own listForMunicipality query. Never throws: a demo-layer publish
   * failure is logged and skipped, it must not affect the workspace's own
   * PROVISIONING/ACTIVE status (the workspace and datastore are genuinely
   * working even if one layer publish had a hiccup).
   */
  async ensureDemoLayers(workspace: GISWorkspace): Promise<void> {
    const datastore = `${workspace.geoserverWorkspace}_postgis`;
    const cqlFilter = `gis_workspace_id = '${workspace.id}'`;

    for (const definition of DEMO_LAYER_DEFINITIONS) {
      try {
        const bbox = await this.geoServer.ensureFeatureType(
          workspace.geoserverWorkspace,
          datastore,
          {
            name: definition.geoserverLayer,
            nativeName: definition.nativeTable,
            title: definition.name,
            srs: workspace.defaultCrs,
            cqlFilter,
          },
        );

        await this.prisma.gISLayer.upsert({
          where: {
            gisWorkspaceId_code: {
              gisWorkspaceId: workspace.id,
              code: definition.code,
            },
          },
          create: {
            gisWorkspaceId: workspace.id,
            name: definition.name,
            code: definition.code,
            description: definition.description,
            layerType: 'VECTOR',
            geoserverWorkspace: workspace.geoserverWorkspace,
            geoserverLayer: definition.geoserverLayer,
            geometryType: definition.geometryType,
            visibleByDefault: definition.visibleByDefault,
            displayOrder: definition.displayOrder,
            status: 'ACTIVE',
            bboxMinX: bbox?.minX,
            bboxMinY: bbox?.minY,
            bboxMaxX: bbox?.maxX,
            bboxMaxY: bbox?.maxY,
          },
          update: {
            bboxMinX: bbox?.minX,
            bboxMinY: bbox?.minY,
            bboxMaxX: bbox?.maxX,
            bboxMaxY: bbox?.maxY,
          },
        });
      } catch (error) {
        this.logger.error(
          `Failed to provision demo layer "${definition.code}" for workspace "${workspace.geoserverWorkspace}"`,
          error as Error,
        );
      }
    }
  }

  /** Tenant-scoped AND permission-filtered: only ever returns ACTIVE
   *  layers belonging to the caller's own municipality's workspace that
   *  they have VIEW permission for — never accepts a workspace/
   *  municipality id from the caller (see GisLayersController). Task 8
   *  §8: filtering happens here, server-side, not by the frontend hiding
   *  layers it was handed anyway — a layer the caller cannot view is
   *  never present in the response at all, so OpenLayers/GetFeatureInfo
   *  never even attempts to query it. */
  async listForMunicipality(appUser: AppUser) {
    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId: appUser.municipalityId },
    });
    if (!workspace) {
      throw new NotFoundException('GIS workspace not found.');
    }

    // Lazy backfill: a workspace that was provisioned before this feature
    // existed (or whose earlier ensureDemoLayers call fully failed) has an
    // ACTIVE workspace but zero GISLayer rows. Self-heal it here — cheap in
    // the common case (a single count query that short-circuits once
    // layers exist) and avoids requiring every pre-existing municipality's
    // owner to manually hit "Retry Provisioning".
    if (workspace.status === 'ACTIVE') {
      const existingCount = await this.prisma.gISLayer.count({
        where: { gisWorkspaceId: workspace.id },
      });
      if (existingCount === 0) {
        await this.ensureDemoLayers(workspace);
      }
    }

    const layers = await this.prisma.gISLayer.findMany({
      where: { gisWorkspaceId: workspace.id, status: 'ACTIVE' },
      orderBy: { displayOrder: 'asc' },
      include: { department: { select: { id: true, name: true } } },
    });

    const viewable = await this.gisAuth.filterViewable(appUser, layers);
    return viewable.map((layer) => this.toResponse(layer));
  }

  /** Tenant-scoped AND permission-checked single-layer lookup — used by
   *  GET /api/gis/layers/:id. A layer belonging to another municipality's
   *  workspace, or one the caller lacks VIEW permission for, both look
   *  identical to "not found" — same as every other tenant-scoped lookup
   *  in this codebase, and consistent with never leaking whether a
   *  layer exists to someone not allowed to see it. */
  async getById(appUser: AppUser, layerId: string) {
    const layer = await this.findLayerInMunicipality(
      appUser.municipalityId,
      layerId,
    );
    if (!(await this.gisAuth.canView(appUser, layer))) {
      throw new NotFoundException('Layer not found.');
    }
    return this.toResponse(layer);
  }

  /** Task 8 §3/§9: server-side export, gated by EXPORT permission — the
   *  backend fetches the GeoJSON from GeoServer's WFS itself and streams
   *  it back, rather than handing the client a GeoServer URL to fetch
   *  directly (which would bypass our own authorization check entirely,
   *  since GeoServer's OGC endpoints are public/anonymous by this
   *  platform's architecture — see docs/backend.md §23's "Known
   *  limitation"). */
  async exportLayer(
    appUser: AppUser,
    layerId: string,
  ): Promise<{ filename: string; geojson: string }> {
    const layer = await this.findLayerInMunicipality(
      appUser.municipalityId,
      layerId,
    );
    if (!(await this.gisAuth.canExport(appUser, layer))) {
      throw new ForbiddenException(
        'You do not have permission to export this layer.',
      );
    }
    const geojson = await this.geoServer.getFeaturesAsGeoJson(
      layer.geoserverWorkspace,
      layer.geoserverLayer,
    );
    return { filename: `${layer.code.toLowerCase()}.geojson`, geojson };
  }

  /** Task 8 §7: every department that currently has at least one grant on
   *  this layer, plus the full department list (for granting a
   *  department that has none yet) — gated by MANAGE ("Layer
   *  administration"), same as setPermission. */
  async getPermissionMatrix(appUser: AppUser, layerId: string) {
    const layer = await this.findLayerInMunicipality(
      appUser.municipalityId,
      layerId,
    );
    if (!(await this.gisAuth.canManage(appUser, layer))) {
      throw new ForbiddenException(
        'You do not have permission to manage this layer.',
      );
    }

    const [grants, departments] = await Promise.all([
      this.gisAuth.listGrants(layer.id),
      this.prisma.department.findMany({
        where: { municipalityId: appUser.municipalityId, status: 'ACTIVE' },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const byDepartment = new Map<
      string,
      {
        departmentId: string;
        departmentName: string;
        grants: Record<string, GisPermission[]>;
      }
    >();
    for (const grant of grants) {
      const entry = byDepartment.get(grant.departmentId) ?? {
        departmentId: grant.departmentId,
        departmentName: grant.department.name,
        grants: { DEPARTMENT_HEAD: [], DEPARTMENT_USER: [] },
      };
      entry.grants[grant.role] = [
        ...(entry.grants[grant.role] ?? []),
        grant.permission,
      ];
      byDepartment.set(grant.departmentId, entry);
    }

    return {
      layer: this.toResponse(layer),
      departments,
      grants: [...byDepartment.values()],
    };
  }

  /** Owner-only in practice (default permissions never give MANAGE to
   *  anyone else — see GisAuthorizationService), enforced by canManage
   *  here, with GisAuthorizationService.setGrant additionally refusing to
   *  let an actor change the row governing their own (role, department)
   *  pair (§7: "never allow a user to grant themselves permissions"). */
  async setPermission(
    appUser: AppUser,
    layerId: string,
    departmentId: string,
    role: 'DEPARTMENT_HEAD' | 'DEPARTMENT_USER',
    permission: GisPermission,
    granted: boolean,
  ) {
    const layer = await this.findLayerInMunicipality(
      appUser.municipalityId,
      layerId,
    );
    if (!(await this.gisAuth.canManage(appUser, layer))) {
      throw new ForbiddenException(
        'You do not have permission to manage this layer.',
      );
    }
    const department = await this.prisma.department.findFirst({
      where: { id: departmentId, municipalityId: appUser.municipalityId },
      select: { id: true },
    });
    if (!department) {
      throw new NotFoundException('Department not found.');
    }
    await this.gisAuth.setGrant(
      appUser,
      layer.id,
      departmentId,
      role,
      permission,
      granted,
    );
    return this.getPermissionMatrix(appUser, layerId);
  }

  private async findLayerInMunicipality(
    municipalityId: string,
    layerId: string,
  ) {
    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId },
      select: { id: true },
    });
    if (!workspace) {
      throw new NotFoundException('GIS workspace not found.');
    }
    const layer = await this.prisma.gISLayer.findFirst({
      where: { id: layerId, gisWorkspaceId: workspace.id, status: 'ACTIVE' },
      include: { department: { select: { id: true, name: true } } },
    });
    if (!layer) {
      throw new NotFoundException('Layer not found.');
    }
    return layer;
  }

  private toResponse(layer: LayerWithDepartment) {
    return {
      id: layer.id,
      name: layer.name,
      code: layer.code,
      description: layer.description,
      layerType: layer.layerType,
      geoserverWorkspace: layer.geoserverWorkspace,
      geoserverLayer: layer.geoserverLayer,
      geometryType: layer.geometryType,
      visibleByDefault: layer.visibleByDefault,
      displayOrder: layer.displayOrder,
      ownershipType: layer.ownershipType,
      departmentId: layer.departmentId,
      departmentName: layer.department?.name ?? null,
      version: layer.version,
      bbox:
        layer.bboxMinX !== null &&
        layer.bboxMinY !== null &&
        layer.bboxMaxX !== null &&
        layer.bboxMaxY !== null
          ? {
              minX: layer.bboxMinX,
              minY: layer.bboxMinY,
              maxX: layer.bboxMaxX,
              maxY: layer.bboxMaxY,
            }
          : null,
    };
  }
}
