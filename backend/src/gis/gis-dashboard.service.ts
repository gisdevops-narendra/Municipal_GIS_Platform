import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GeoServerService } from './geoserver.service';
import { GisAuthorizationService } from './gis-authorization.service';
import { AiClientService } from '../gis-ai/ai-client.service';
import type { AppUser } from '../auth/types/app-user.type';

export interface DashboardSummary {
  totalLayers: number;
  publishedLayers: number;
  draftLayers: number;
  departments: number;
  dataSources: number;
}

export interface DepartmentSummaryEntry {
  departmentId: string;
  departmentName: string;
  layerCount: number;
}

export interface SearchLayerMatch {
  id: string;
  name: string;
  code: string;
  ownershipType: string;
  departmentName: string | null;
  /** `name`: the query is in the layer name/code. `semantic`: the layer is
   *  about the query by meaning ("drainage" → storm_water_lines), found
   *  through the AI service's embedding index. */
  match: 'name' | 'semantic';
  /** For a semantic hit through one attribute field, that field. */
  matchedField?: string | null;
}

export interface SearchFeatureMatch {
  layerId: string;
  layerName: string;
  layerCode: string;
  attributes: Record<string, unknown>;
  bbox: [number, number, number, number] | null;
}

/** Layers actually searched for feature-level matches, per request — kept
 *  small on purpose (Task 9 §15: "do not request huge datasets
 *  unnecessarily", "keep the map responsive"). Layer-name matching itself
 *  is unbounded (cheap, in-memory over metadata only). */
const MAX_LAYERS_SEARCHED_FOR_FEATURES = 12;
const MAX_FEATURES_FETCHED_PER_LAYER = 50;
const MAX_FEATURE_MATCHES_RETURNED = 25;
const SEARCH_TIMEOUT_MS = 5000;
/** Shorter queries embed to noise ("ro", "wa"). */
const MIN_SEMANTIC_QUERY = 3;
const MAX_LAYER_MATCHES = 15;

/**
 * Task 9: view/analysis endpoints only — dashboard summary counts,
 * per-department layer counts, and a lightweight cross-layer search.
 * Every number and every row here is scoped through the same
 * GisAuthorizationService used everywhere else (Task 9 §13: "Dashboard
 * must only show authorized information"), and every query is scoped by
 * `appUser.municipalityId` resolved server-side from the JWT — never
 * accepted from the client (§14).
 */
@Injectable()
export class GisDashboardService {
  private readonly logger = new Logger(GisDashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geoServer: GeoServerService,
    private readonly gisAuth: GisAuthorizationService,
    private readonly ai: AiClientService,
  ) {}

  /**
   * publishedLayers: layers the caller may VIEW (a layer only ever exists
   * as a GISLayer row once it has actually been published — Task 7).
   * draftLayers: the caller's own visible in-flight uploads (DRAFT/
   * IN_REVIEW/APPROVED — not yet published, not failed/rejected), using
   * the exact same visibility rule as GET /api/gis/uploads (own upload,
   * own department, or Owner sees all). totalLayers is the sum, matching
   * the worked example in Task 9 §1 (24 = 18 + 6). dataSources counts
   * every upload that successfully produced at least a validated draft —
   * i.e. every distinct file that has actually contributed GIS data,
   * published or not.
   */
  async getSummary(appUser: AppUser): Promise<DashboardSummary> {
    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId: appUser.municipalityId },
      select: { id: true },
    });
    if (!workspace) {
      return {
        totalLayers: 0,
        publishedLayers: 0,
        draftLayers: 0,
        departments: 0,
        dataSources: 0,
      };
    }

    const allLayers = await this.prisma.gISLayer.findMany({
      where: { gisWorkspaceId: workspace.id, status: 'ACTIVE' },
      select: { id: true, ownershipType: true, departmentId: true },
    });
    const viewableLayers = await this.gisAuth.filterViewable(
      appUser,
      allLayers,
    );

    const uploadVisibilityWhere =
      appUser.systemRole === 'MUNICIPALITY_OWNER'
        ? { municipalityId: appUser.municipalityId }
        : {
            municipalityId: appUser.municipalityId,
            OR: [
              { uploadedById: appUser.id },
              ...(appUser.departmentId
                ? [{ departmentId: appUser.departmentId }]
                : []),
            ],
          };

    const [draftLayers, dataSources, departments] = await Promise.all([
      this.prisma.gISLayerUpload.count({
        where: {
          ...uploadVisibilityWhere,
          status: { in: ['DRAFT', 'IN_REVIEW', 'APPROVED'] },
        },
      }),
      this.prisma.gISLayerUpload.count({
        where: {
          ...uploadVisibilityWhere,
          status: { notIn: ['UPLOAD_PENDING', 'VALIDATING', 'FAILED'] },
        },
      }),
      this.prisma.department.count({
        where: this.visibleDepartmentsWhere(appUser),
      }),
    ]);

    return {
      totalLayers: viewableLayers.length + draftLayers,
      publishedLayers: viewableLayers.length,
      draftLayers,
      departments,
      dataSources,
    };
  }

  /** Task 9 §2: every active department the caller may see, with a
   *  VIEW-authorized layer count each (0 for a department the caller has
   *  no visible layers in). MUNICIPALITY_OWNER sees every department;
   *  a DEPARTMENT_HEAD/DEPARTMENT_USER only ever sees their own — same
   *  department-scoped visibility as GET /api/departments, since these
   *  rows carry other departments' names, which a non-Owner must never
   *  see (see DepartmentsService.list). */
  async getDepartmentSummary(
    appUser: AppUser,
  ): Promise<DepartmentSummaryEntry[]> {
    if (
      appUser.systemRole !== 'MUNICIPALITY_OWNER' &&
      !appUser.departmentId
    ) {
      return [];
    }

    const departments = await this.prisma.department.findMany({
      where: this.visibleDepartmentsWhere(appUser),
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId: appUser.municipalityId },
      select: { id: true },
    });
    if (!workspace) {
      return departments.map((d) => ({
        departmentId: d.id,
        departmentName: d.name,
        layerCount: 0,
      }));
    }

    const departmentLayers = await this.prisma.gISLayer.findMany({
      where: {
        gisWorkspaceId: workspace.id,
        status: 'ACTIVE',
        ownershipType: 'DEPARTMENT',
        departmentId: { in: departments.map((d) => d.id) },
      },
      select: { id: true, ownershipType: true, departmentId: true },
    });
    const viewable = await this.gisAuth.filterViewable(
      appUser,
      departmentLayers,
    );
    const countsByDepartment = new Map<string, number>();
    for (const layer of viewable) {
      const key = layer.departmentId!;
      countsByDepartment.set(key, (countsByDepartment.get(key) ?? 0) + 1);
    }

    return departments.map((d) => ({
      departmentId: d.id,
      departmentName: d.name,
      layerCount: countsByDepartment.get(d.id) ?? 0,
    }));
  }

  /**
   * Task 9 §5: a deliberately simple search — layer name/code matching is
   * free (in-memory over metadata already scoped to VIEW-authorized
   * layers), and feature-level matching fetches a small, bounded set of
   * features per layer (never the whole dataset) and checks whether any
   * attribute value contains the query text. Not a property/cadastral
   * search system (§5 explicitly rules that out) — just enough to find a
   * road or ward by name.
   */
  async search(
    appUser: AppUser,
    query: string,
  ): Promise<{ layers: SearchLayerMatch[]; features: SearchFeatureMatch[] }> {
    const q = query.trim().toLowerCase();
    if (!q) {
      return { layers: [], features: [] };
    }

    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId: appUser.municipalityId },
    });
    if (!workspace) {
      return { layers: [], features: [] };
    }

    const allLayers = await this.prisma.gISLayer.findMany({
      where: { gisWorkspaceId: workspace.id, status: 'ACTIVE' },
      include: { department: { select: { id: true, name: true } } },
      orderBy: { displayOrder: 'asc' },
    });
    const viewable = await this.gisAuth.filterViewable(appUser, allLayers);

    const toMatch = (
      l: (typeof viewable)[number],
      match: SearchLayerMatch['match'],
      matchedField?: string | null,
    ): SearchLayerMatch => ({
      id: l.id,
      name: l.name,
      code: l.code,
      ownershipType: l.ownershipType,
      departmentName: l.department?.name ?? null,
      match,
      ...(matchedField !== undefined && { matchedField }),
    });
    const layerMatches: SearchLayerMatch[] = viewable
      .filter(
        (l) =>
          l.name.toLowerCase().includes(q) || l.code.toLowerCase().includes(q),
      )
      .map((l) => toMatch(l, 'name'));

    const searchableLayers = viewable
      .filter((l) => l.layerType === 'VECTOR')
      .slice(0, MAX_LAYERS_SEARCHED_FOR_FEATURES);

    // Semantic hits run alongside the feature search; the AI service being
    // down just means name matches only (searchLayers never throws).
    const [featureResults, semanticHits] = await Promise.all([
      Promise.all(
        searchableLayers.map((layer) => this.searchLayerFeatures(layer, q)),
      ),
      q.length >= MIN_SEMANTIC_QUERY
        ? this.ai.searchLayers(appUser.municipalityId, query.trim())
        : Promise.resolve([]),
    ]);
    // Only layers this caller may view — the index covers every layer.
    const byId = new Map(viewable.map((l) => [l.id, l]));
    for (const hit of semanticHits) {
      const layer = byId.get(hit.layer_id);
      if (!layer || layerMatches.some((m) => m.id === layer.id)) continue;
      if (layerMatches.length >= MAX_LAYER_MATCHES) break;
      layerMatches.push(toMatch(layer, 'semantic', hit.field));
    }

    const features = featureResults
      .flat()
      .slice(0, MAX_FEATURE_MATCHES_RETURNED);
    return { layers: layerMatches, features };
  }

  /** Active departments the caller may see — all of them for the Owner,
   *  only their own for anyone else (same rule as DepartmentsService.list);
   *  `in: []` matches nothing for a non-Owner with no department. */
  private visibleDepartmentsWhere(appUser: AppUser) {
    return {
      municipalityId: appUser.municipalityId,
      status: 'ACTIVE' as const,
      ...(appUser.systemRole !== 'MUNICIPALITY_OWNER' && {
        id: appUser.departmentId ?? { in: [] },
      }),
    };
  }

  private async searchLayerFeatures(
    layer: {
      id: string;
      name: string;
      code: string;
      geoserverWorkspace: string;
      geoserverLayer: string;
    },
    query: string,
  ): Promise<SearchFeatureMatch[]> {
    try {
      const geojson = await this.geoServer.getFeaturesAsGeoJson(
        layer.geoserverWorkspace,
        layer.geoserverLayer,
        {
          maxFeatures: MAX_FEATURES_FETCHED_PER_LAYER,
          timeoutMs: SEARCH_TIMEOUT_MS,
          // Bbox must be EPSG:4326 to match GisLayer.bbox's own
          // convention and MapService.zoomToBbox4326 on the frontend —
          // never assume GeoServer's native/storage CRS.
          srsName: 'EPSG:4326',
        },
      );
      const parsed = JSON.parse(geojson) as {
        features?: {
          properties?: Record<string, unknown>;
          bbox?: [number, number, number, number];
        }[];
      };
      const matches: SearchFeatureMatch[] = [];
      for (const feature of parsed.features ?? []) {
        const properties = feature.properties ?? {};
        const matchesQuery = Object.values(properties).some((value) => {
          if (value == null) return false;
          const text =
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
              ? String(value)
              : JSON.stringify(value);
          return text.toLowerCase().includes(query);
        });
        if (matchesQuery) {
          matches.push({
            layerId: layer.id,
            layerName: layer.name,
            layerCode: layer.code,
            attributes: properties,
            bbox: feature.bbox ?? null,
          });
        }
      }
      return matches;
    } catch (error) {
      // A single layer failing to search (GeoServer hiccup, timeout) must
      // never fail the whole search — same tolerance as GetFeatureInfo.
      this.logger.warn(
        `Search failed for layer "${layer.code}": ${(error as Error).message}`,
      );
      return [];
    }
  }
}
