import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GisAuthorizationService } from './gis-authorization.service';
import { AiClientService } from '../gis-ai/ai-client.service';
import { FuzzySearchService } from './fuzzy-search.service';
import type { AppUser } from '../auth/types/app-user.type';

export interface SearchLayerMatch {
  id: string;
  name: string;
  code: string;
  ownershipType: string;
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
  /** GeoJSON shape (EPSG:4326) and an inside point, for the map highlight. */
  geometry?: Record<string, unknown> | null;
  anchor?: [number, number] | null;
  /** The field / value that matched (fuzzy search) — the result's title. */
  matchedField?: string;
  label?: string;
}

/** Layers actually searched for feature-level matches, per request — kept
 *  small on purpose (Task 9 §15: "do not request huge datasets
 *  unnecessarily", "keep the map responsive"). Layer-name matching itself
 *  is unbounded (cheap, in-memory over metadata only). */
const MAX_LAYERS_SEARCHED_FOR_FEATURES = 40;
const MAX_FEATURE_MATCHES_RETURNED = 25;
/** Shorter queries embed to noise ("ro", "wa"). */
const MIN_SEMANTIC_QUERY = 3;
const MAX_LAYER_MATCHES = 15;

/**
 * Task 9: view/analysis endpoints only — dashboard summary counts,
 * a lightweight cross-layer search for the map.
 * Every number and every row here is scoped through the same
 * GisAuthorizationService used everywhere else (Task 9 §13: "Dashboard
 * must only show authorized information"), and every query is scoped by
 * `appUser.municipalityId` resolved server-side from the JWT — never
 * accepted from the client (§14).
 */
@Injectable()
export class GisDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gisAuth: GisAuthorizationService,
    private readonly ai: AiClientService,
    private readonly fuzzySearch: FuzzySearchService,
  ) {}



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

    // Feature values: fuzzy, ranked search straight in PostGIS (pg_trgm).
    // Every vector layer has its own table (uploads, external databases and
    // analysis outputs are all stored there) — GeoServer is never asked.
    const tableLayers = searchableLayers.filter(
      (l): l is typeof l & { postgisTable: string } => !!l.postgisTable,
    );

    // Semantic hits run alongside the feature search; the AI service being
    // down just means name matches only (searchLayers never throws).
    const [fuzzyResults, semanticHits] = await Promise.all([
      this.fuzzySearch.search(tableLayers, query, MAX_FEATURE_MATCHES_RETURNED),
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

    const features: SearchFeatureMatch[] = fuzzyResults
      .map(({ score: _score, ...hit }) => hit)
      .slice(0, MAX_FEATURE_MATCHES_RETURNED);
    return { layers: layerMatches, features };
  }
}
