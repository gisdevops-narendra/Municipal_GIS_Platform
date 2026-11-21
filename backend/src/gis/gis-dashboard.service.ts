import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GeoServerService } from './geoserver.service';
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
/** Matches per layer — GeoServer filters server-side, so these are hits. */
const MAX_FEATURES_FETCHED_PER_LAYER = 10;
/** Text fields matched per layer (ILIKE OR-chain kept bounded). */
const MAX_SEARCH_ATTRIBUTES = 12;
/** Text fields nobody searches by (ids, codes, flags, measures) — skipped
 *  so the ILIKE scan stays fast on large layers. Name-like fields first. */
const NON_SEARCH_ATTRIBUTE =
  /(^|_)(id|fid|gid|uid|code|cd|status|sta|year|area|length|leng|shape|summer|month)(_|$)|^objectid|code$|_\d+$/i;
/** Text attributes per GeoServer layer; reset when the schema may change. */
const ATTRIBUTE_CACHE_MS = 10 * 60 * 1000;
const MAX_FEATURE_MATCHES_RETURNED = 25;
const SEARCH_TIMEOUT_MS = 8000;
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
  private readonly logger = new Logger(GisDashboardService.name);
  private readonly attributeCache = new Map<
    string,
    { at: number; names: Promise<string[]> }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly geoServer: GeoServerService,
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

    // Uploaded layers: fuzzy, ranked search in PostGIS (pg_trgm). Any layer
    // without its own table falls back to GeoServer's substring filter.
    const tableLayers = searchableLayers.filter(
      (l): l is typeof l & { postgisTable: string } => !!l.postgisTable,
    );
    const otherLayers = searchableLayers.filter((l) => !l.postgisTable);

    // Semantic hits run alongside the feature search; the AI service being
    // down just means name matches only (searchLayers never throws).
    const [fuzzyResults, featureResults, semanticHits] = await Promise.all([
      this.fuzzySearch.search(tableLayers, query, MAX_FEATURE_MATCHES_RETURNED),
      Promise.all(
        otherLayers.map((layer) => this.searchLayerFeatures(layer, q)),
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

    const features: SearchFeatureMatch[] = [
      ...fuzzyResults.map(({ score: _score, ...hit }) => hit),
      ...featureResults.flat(),
    ].slice(0, MAX_FEATURE_MATCHES_RETURNED);
    return { layers: layerMatches, features };
  }

  /** A layer's text attributes (cached briefly; failures are not cached). */
  private searchAttributes(layer: {
    geoserverWorkspace: string;
    geoserverLayer: string;
  }): Promise<string[]> {
    const key = `${layer.geoserverWorkspace}:${layer.geoserverLayer}`;
    const hit = this.attributeCache.get(key);
    if (hit && Date.now() - hit.at < ATTRIBUTE_CACHE_MS) return hit.names;
    const names = this.geoServer
      .stringAttributes(layer.geoserverWorkspace, layer.geoserverLayer, SEARCH_TIMEOUT_MS)
      .then((all) => {
        const useful = all.filter((name) => !NON_SEARCH_ATTRIBUTE.test(name));
        return (useful.length ? useful : all)
          .sort((a, b) => Number(!/name/i.test(a)) - Number(!/name/i.test(b)))
          .slice(0, MAX_SEARCH_ATTRIBUTES);
      });
    names.catch(() => this.attributeCache.delete(key));
    this.attributeCache.set(key, { at: Date.now(), names });
    return names;
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
      // Filter in GeoServer (ILIKE over every text field) so a match
      // anywhere in the layer is found — not just in its first N rows.
      const attributes = await this.searchAttributes(layer);
      if (!attributes.length) return [];
      const pattern = `'%${query.replace(/[%_\\]/g, '').replace(/'/g, "''")}%'`;
      const cqlFilter = attributes
        .map((a) => `"${a.replace(/"/g, '""')}" ILIKE ${pattern}`)
        .join(' OR ');
      const geojson = await this.geoServer.getFeaturesAsGeoJson(
        layer.geoserverWorkspace,
        layer.geoserverLayer,
        {
          maxFeatures: MAX_FEATURES_FETCHED_PER_LAYER,
          timeoutMs: SEARCH_TIMEOUT_MS,
          cqlFilter,
          // Bbox must be EPSG:4326 to match GisLayer.bbox's own
          // convention and MapService.zoomToBbox4326 on the frontend —
          // never assume GeoServer's native/storage CRS.
          srsName: 'EPSG:4326',
        },
      );
      const parsed = JSON.parse(geojson) as {
        features?: {
          properties?: Record<string, unknown>;
          geometry?: Record<string, unknown> | null;
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
            geometry: feature.geometry ?? null,
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
