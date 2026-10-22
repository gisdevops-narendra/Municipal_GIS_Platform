import {
  BadRequestException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { GISLayer } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';
import { GisLayersService } from './gis-layers.service';
import { isSafeGeneratedTableName } from './layer-naming.util';
import type { NearestFacilityDto, RouteDto, ServiceAreaDto, TraceDto } from './dto/network.dto';

/**
 * `road`: lines are split where they cross, so street intersections connect.
 * `pipe`: lines connect only where their end points meet (crossing pipes at
 * different depths are not joined).
 */
type NetworkKind = 'road' | 'pipe';

type LonLat = [number, number];

interface Edge {
  a: number;
  b: number;
  /** Geodesic length in metres. */
  len: number;
  /** EPSG:4326 vertices, for drawing the result. */
  coords: LonLat[];
  /** Road name (for directions), when the layer has a name column. */
  name: string | null;
}

interface Graph {
  /** Working SRID (metric) the node coordinates are in. */
  srid: number;
  nodeX: number[];
  nodeY: number[];
  adj: { to: number; edge: number }[][];
  edges: Edge[];
  grid: Map<string, number[]>;
  builtAt: number;
  /** Table write counter when built (see writeStamp) — a change rebuilds. */
  stamp: string;
}

/** One stretch of a route: (part of) an edge, in travel order. */
interface RoutePiece {
  edge: number;
  coords: LonLat[];
  len: number;
}

/** A route found by bestRoute(): true length, its pieces in travel order
 *  and the edge ids it uses (for alternatives). */
interface FoundRoute {
  lengthM: number;
  edges: number[];
  pieces: RoutePiece[];
}

/** One turn-by-turn instruction; `distanceM` is how far to follow it. */
export interface RouteStep {
  text: string;
  distanceM: number;
  at: LonLat;
  kind: 'depart' | 'turn' | 'waypoint' | 'arrive';
}

/** A click snapped onto an edge: segment `segment` at fraction `t`. */
interface EdgeSnap {
  edge: number;
  segment: number;
  t: number;
  point: LonLat;
  /** Metres along the edge from node a. */
  fromA: number;
}

interface SearchResult {
  dist: Float64Array;
  prevEdge: Int32Array;
}

/** End points closer than this (metres) are one junction. */
const SNAP_TOLERANCE_M: Record<NetworkKind, number> = { road: 0.5, pipe: 1 };
/** A click further than this from every network node is rejected. */
const MAX_SNAP_M = 2000;
/** Road-name columns, best first (shapefiles cut names to 10 chars). */
const ROAD_NAME_COLUMNS = [
  /^(road_?name|street_?name|st_?name|rd_?name|roadnam|streetnam)$/i,
  /^(name|name_en|name_eng|label)$/i,
  /(road|street|rd|st).*name|name.*(road|street)/i,
  /name/i,
];
/** Routing returns up to this many routes (shortest + alternatives). */
const ALTERNATIVE_ROUTES = 3;
/** Cost multiplier on roads an earlier route used. */
const ROUTE_PENALTY = 3;
/** An alternative may share at most this share of its length with another. */
const MAX_ROUTE_OVERLAP = 0.7;
const GRID_CELL_M = 200;
/** Safety net only: a graph is rebuilt as soon as its table is written to. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHED_GRAPHS = 6;
/** Line layers kept warm (fewer than the cache holds, so the networks
 *  people are actually routing on are not pushed out). */
const WARMUP_LAYERS = 4;
const WARMUP_DELAY_MS = 15_000;
/** How often layers are checked for changes (a cheap stats query each). */
const WARMUP_INTERVAL_MS = 60_000;
const MAX_FACILITIES = 5000;
const DEMO_TABLES = new Set(['gis_demo_roads']);

/**
 * GIS Advanced Tools — Basic Routing, Nearest Facility and Network Tracing
 * over an uploaded LINE layer. PostGIS prepares the segments (`ST_Node`
 * splits roads at crossings); the graph is built and searched (Dijkstra) in
 * memory and cached per layer for a few minutes, so repeated clicks on the
 * same network are instant. No pgRouting needed.
 */
@Injectable()
export class NetworkService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NetworkService.name);
  private readonly cache = new Map<string, Graph>();
  /** Builds in progress, keyed by graph key + table stamp. */
  private readonly building = new Map<string, Promise<Graph>>();
  private warming = false;
  private warmTimer?: NodeJS.Timeout;
  private warmInterval?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gisLayers: GisLayersService,
  ) {}

  /**
   * Route through 2–25 stops along a routing layer. Each stop snaps onto
   * the nearest usable road (not just a junction).
   * - `optimize`: reorders the middle stops for the shortest trip (the
   *   first stop stays the start; the last stays the end unless
   *   `roundTrip`).
   * - `roundTrip`: returns to the first stop.
   * - `avoidAreas` (rings) / `avoidPoints` (a click on a road blocks that
   *   stretch): those roads are never used.
   * - With exactly two stops, up to ALTERNATIVE_ROUTES - 1 alternatives.
   * `lengthM` / `path` are the first (shortest) route — the original
   * from/to request shape still works.
   */
  async route(appUser: AppUser, dto: RouteDto) {
    const stops = dto.stops?.length ? dto.stops : dto.from && dto.to ? [dto.from, dto.to] : [];
    if (stops.length < 2) {
      throw new BadRequestException('Pick a start and a destination.');
    }
    const areas = dto.avoidAreas ?? [];
    for (const ring of areas) {
      if (ring.length < 4 || !ring.every(isLonLat)) {
        throw new BadRequestException('Each avoid area must be a closed ring of [lon, lat] points.');
      }
    }
    const graph = await this.graphFor(appUser, dto.layerId, 'road');
    const blocked = this.blockedEdges(graph, areas, dto.avoidPoints ?? []);
    const base = (edge: number) => (blocked.has(edge) ? Infinity : 1);
    const snaps = stops.map((point, i) =>
      this.snapToEdge(graph, point, (edge) => !blocked.has(edge), `stop ${stopLabel(i)}`),
    );

    // Visit order: as given, or optimised over road distances.
    let order = stops.map((_, i) => i);
    const canReorder = stops.length - (dto.roundTrip ? 1 : 2) >= 2;
    if (dto.optimize && canReorder) {
      const matrix = snaps.map((snap) => this.costsFrom(graph, snap, snaps, base));
      const unreachable = matrix.findIndex((row) => row.some((cost) => !Number.isFinite(cost)));
      if (unreachable >= 0) {
        throw new BadRequestException(
          `Stop ${stopLabel(unreachable)} cannot be reached from every other stop on this network.`,
        );
      }
      order = this.optimizeOrder(matrix, !!dto.roundTrip);
    }
    const sequence = dto.roundTrip ? [...order, order[0]] : order;

    const legs = (factor: (edge: number) => number) => {
      const found: FoundRoute[] = [];
      for (let i = 0; i < sequence.length - 1; i++) {
        const leg = this.bestRoute(graph, snaps[sequence[i]], snaps[sequence[i + 1]], factor);
        if (!leg) return null;
        found.push(leg);
      }
      return found;
    };
    const best = legs(base);
    if (!best) {
      throw new BadRequestException(
        blocked.size
          ? 'The stops are not connected on this network without the avoided roads.'
          : 'The stops are not connected on this network.',
      );
    }

    // Alternatives (penalty method), for a plain A → B route only: make
    // the roads already used dearer and search again; keep a result only
    // if it is really different.
    const routes = [best];
    if (sequence.length === 2) {
      const penalty = new Map<number, number>();
      for (let attempt = 0; attempt < 6 && routes.length < ALTERNATIVE_ROUTES; attempt++) {
        for (const edge of routes[routes.length - 1][0].edges) {
          penalty.set(edge, (penalty.get(edge) ?? 1) * ROUTE_PENALTY);
        }
        const next = legs((edge) => base(edge) * (penalty.get(edge) ?? 1));
        if (!next) break;
        if (routes.every((r) => this.sharedLength(graph, r[0], next[0]) < MAX_ROUTE_OVERLAP * next[0].lengthM)) {
          routes.push(next);
        }
      }
      routes.sort((x, y) => x[0].lengthM - y[0].lengthM);
    }

    const toResponse = (route: FoundRoute[]) => ({
      lengthM: route.reduce((sum, leg) => sum + leg.lengthM, 0),
      path: { type: 'MultiLineString', coordinates: route.flatMap((leg) => leg.pieces.map((p) => p.coords)) },
      legs: route.map((leg, i) => ({
        from: sequence[i],
        to: sequence[i + 1],
        lengthM: leg.lengthM,
        path: { type: 'MultiLineString', coordinates: leg.pieces.map((p) => p.coords) },
      })),
      directions: this.directions(graph, route, sequence),
    });
    return {
      ...toResponse(routes[0]),
      order: sequence,
      snapped: snaps.map((snap) => snap.point),
      blockedRoads: blocked.size,
      routes: routes.map(toResponse),
    };
  }

  /** Cheapest route between two snapped points, edge costs scaled by
   *  `factor` (Infinity = closed); true lengths are reported. */
  private bestRoute(
    graph: Graph,
    from: EdgeSnap,
    to: EdgeSnap,
    factor: (edge: number) => number = () => 1,
  ): FoundRoute | null {
    const fromEdge = graph.edges[from.edge];
    const toEdge = graph.edges[to.edge];

    // Both on the same segment: straight along it may be shortest.
    const alongLen = from.edge === to.edge ? Math.abs(from.fromA - to.fromA) : Infinity;
    const along = alongLen * factor(from.edge);

    const fa = factor(from.edge);
    const ta = factor(to.edge);
    const search = this.dijkstra(
      graph,
      [
        [fromEdge.a, from.fromA * fa],
        [fromEdge.b, (fromEdge.len - from.fromA) * fa],
      ],
      { targets: [toEdge.a, toEdge.b], factor },
    );
    const viaA = search.dist[toEdge.a] + to.fromA * ta;
    const viaB = search.dist[toEdge.b] + (toEdge.len - to.fromA) * ta;
    const cost = Math.min(along, viaA, viaB);
    if (!Number.isFinite(cost)) return null;

    if (cost === along) {
      return {
        lengthM: alongLen,
        edges: [from.edge],
        pieces: [{ edge: from.edge, coords: this.edgeBetween(fromEdge, from, to), len: alongLen }],
      };
    }
    const end = cost === viaA ? toEdge.a : toEdge.b;
    const start = this.searchStart(graph, search, end);
    const edges = this.pathEdges(graph, search, end);
    const middle = this.pathLines(graph, search, end);
    const head = start === fromEdge.a ? from.fromA : fromEdge.len - from.fromA;
    const tail = end === toEdge.a ? to.fromA : toEdge.len - to.fromA;
    const pieces: RoutePiece[] = [
      { edge: from.edge, coords: this.edgePart(fromEdge, from, start === fromEdge.a ? 'a' : 'b', true), len: head },
      ...edges.map((edge, i) => ({ edge, coords: middle[i], len: graph.edges[edge].len })),
      { edge: to.edge, coords: this.edgePart(toEdge, to, end === toEdge.a ? 'a' : 'b', false), len: tail },
    ].filter((piece) => piece.coords.length >= 2);
    return {
      lengthM: head + edges.reduce((sum, e) => sum + graph.edges[e].len, 0) + tail,
      edges: [from.edge, ...edges, to.edge],
      pieces,
    };
  }

  /** Cost from `from` to each of `targets` (one full search). */
  private costsFrom(graph: Graph, from: EdgeSnap, targets: EdgeSnap[], factor: (edge: number) => number): number[] {
    const edge = graph.edges[from.edge];
    const f = factor(from.edge);
    const search = this.dijkstra(
      graph,
      [
        [edge.a, from.fromA * f],
        [edge.b, (edge.len - from.fromA) * f],
      ],
      { factor },
    );
    return targets.map((to) => {
      if (to === from) return 0;
      const toEdge = graph.edges[to.edge];
      const t = factor(to.edge);
      const along = to.edge === from.edge ? Math.abs(to.fromA - from.fromA) * f : Infinity;
      return Math.min(
        along,
        search.dist[toEdge.a] + to.fromA * t,
        search.dist[toEdge.b] + (toEdge.len - to.fromA) * t,
      );
    });
  }

  /** Visit order for the stops (index 0 always first; the last stop stays
   *  last unless `roundTrip`): nearest neighbour, then 2-opt. */
  private optimizeOrder(matrix: number[][], roundTrip: boolean): number[] {
    const n = matrix.length;
    const end = roundTrip ? -1 : n - 1;
    const left = new Set([...Array(n).keys()].filter((i) => i !== 0 && i !== end));
    const tour = [0];
    while (left.size) {
      const last = tour[tour.length - 1];
      let next = -1;
      for (const i of left) if (next < 0 || matrix[last][i] < matrix[last][next]) next = i;
      tour.push(next);
      left.delete(next);
    }
    if (end >= 0) tour.push(end);

    const cost = (t: number[]) => {
      let sum = 0;
      for (let i = 0; i < t.length - 1; i++) sum += matrix[t[i]][t[i + 1]];
      return roundTrip ? sum + matrix[t[t.length - 1]][t[0]] : sum;
    };
    // Reverse stretches between the fixed ends while that shortens the trip.
    const lastMovable = roundTrip ? tour.length - 1 : tour.length - 2;
    let bestCost = cost(tour);
    for (let improved = true, rounds = 0; improved && rounds < 50; rounds++) {
      improved = false;
      for (let i = 1; i < lastMovable; i++) {
        for (let k = i + 1; k <= lastMovable; k++) {
          const candidate = [...tour.slice(0, i), ...tour.slice(i, k + 1).reverse(), ...tour.slice(k + 1)];
          const c = cost(candidate);
          if (c < bestCost - 1e-6) {
            tour.splice(0, tour.length, ...candidate);
            bestCost = c;
            improved = true;
          }
        }
      }
    }
    return tour;
  }

  /** Edges never to be used: any part inside an avoid area, plus the road
   *  stretch nearest each avoid point. */
  private blockedEdges(graph: Graph, areas: LonLat[][], points: LonLat[]): Set<number> {
    const blocked = new Set<number>();
    for (const point of points) {
      blocked.add(this.snapToEdge(graph, point, () => true, 'a blocked road').edge);
    }
    for (const ring of areas) {
      const xs = ring.map((p) => p[0]);
      const ys = ring.map((p) => p[1]);
      const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      graph.edges.forEach((edge, index) => {
        if (blocked.has(index)) return;
        const c = edge.coords;
        if (c.every((p) => p[0] < minX) || c.every((p) => p[0] > maxX) || c.every((p) => p[1] < minY) || c.every((p) => p[1] > maxY)) {
          return;
        }
        if (c.some((p) => pointInRing(p, ring)) || crossesRing(c, ring)) blocked.add(index);
      });
    }
    return blocked;
  }

  /** Turn-by-turn steps for one route (its legs in order). */
  private directions(graph: Graph, legs: FoundRoute[], sequence: number[]): RouteStep[] {
    const steps: RouteStep[] = [];
    let previousEnd: number | null = null;
    legs.forEach((leg, li) => {
      // Consecutive pieces on the same road read as one instruction.
      const runs: { name: string | null; len: number; coords: LonLat[] }[] = [];
      for (const piece of leg.pieces) {
        const name = graph.edges[piece.edge].name;
        const last = runs[runs.length - 1];
        if (last && last.name === name) {
          last.len += piece.len;
          last.coords = [...last.coords, ...piece.coords.slice(1)];
        } else {
          runs.push({ name, len: piece.len, coords: [...piece.coords] });
        }
      }
      runs.forEach((run, k) => {
        const road = run.name ?? 'unnamed road';
        const heading = startBearing(run.coords);
        let text: string;
        if (k === 0) {
          text = li === 0 ? `Head ${compass(heading)} on ${road}` : `Continue ${compass(heading)} on ${road}`;
          if (li > 0 && previousEnd !== null) {
            const turn = turnPhrase(turnAngle(previousEnd, heading));
            if (turn !== 'Continue') text = `${turn} onto ${road}`;
          }
        } else {
          const turn = turnPhrase(turnAngle(endBearing(runs[k - 1].coords), heading));
          text = turn === 'Continue' ? `Continue onto ${road}` : `${turn} onto ${road}`;
        }
        steps.push({ text, distanceM: run.len, at: run.coords[0], kind: k === 0 && li === 0 ? 'depart' : 'turn' });
      });
      const lastRun = runs[runs.length - 1];
      previousEnd = lastRun ? endBearing(lastRun.coords) : previousEnd;
      const finalLeg = li === legs.length - 1;
      const arrivedAt = sequence[li + 1];
      steps.push({
        text: finalLeg
          ? arrivedAt === sequence[0] && legs.length > 1
            ? `Arrive back at the start (${stopLabel(arrivedAt)})`
            : `Arrive at the destination (${stopLabel(arrivedAt)})`
          : `Reach stop ${stopLabel(arrivedAt)}`,
        distanceM: 0,
        at: lastRun ? lastRun.coords[lastRun.coords.length - 1] : leg.pieces[0]?.coords[0] ?? [0, 0],
        kind: finalLeg ? 'arrive' : 'waypoint',
      });
    });
    return steps;
  }

  /** Metres of road two routes have in common (whole edges). */
  private sharedLength(graph: Graph, a: FoundRoute, b: FoundRoute): number {
    const inA = new Set(a.edges);
    return [...new Set(b.edges)].filter((e) => inA.has(e)).reduce((sum, e) => sum + graph.edges[e].len, 0);
  }

  /** Edge ids of the found path ending at `target`, in travel order. */
  private pathEdges(graph: Graph, search: SearchResult, target: number): number[] {
    const edges: number[] = [];
    let node = target;
    while (search.prevEdge[node] >= 0) {
      const edge = search.prevEdge[node];
      edges.push(edge);
      node = graph.edges[edge].a === node ? graph.edges[edge].b : graph.edges[edge].a;
    }
    return edges.reverse();
  }

  async nearest(appUser: AppUser, dto: NearestFacilityDto) {
    const graph = await this.graphFor(appUser, dto.layerId, 'road');
    const facilities = await this.gisLayers.networkSource(
      appUser,
      dto.facilityLayerId,
      'POINT',
    );
    this.assertTable(facilities.table);
    const scope = this.scope(facilities.table, facilities.workspaceId, 2);
    const rows = await this.prisma.$queryRawUnsafe<
      { x: number; y: number; lon: number; lat: number; props: Record<string, unknown> }[]
    >(
      `SELECT ST_X(p) AS x, ST_Y(p) AS y,
              ST_X(ST_Transform(p, 4326)) AS lon, ST_Y(ST_Transform(p, 4326)) AS lat,
              to_jsonb(s) - 'geom' - 'p' AS props
         FROM (SELECT t.*, ST_Transform(ST_PointOnSurface(t.geom), $1::int) AS p
                 FROM "${facilities.table}" t
                WHERE t.geom IS NOT NULL ${scope.clause}
                LIMIT ${MAX_FACILITIES}) s`,
      graph.srid,
      ...scope.params,
    );
    if (rows.length === 0) {
      throw new BadRequestException(`"${facilities.name}" has no facilities.`);
    }

    const [start] = await this.snap(graph, [dto.from]);
    const search = this.dijkstra(graph, start, {});
    const ranked = rows
      .map((row, index) => {
        const node = this.nearestNode(graph, row.x, row.y);
        return { row, index, node: node.id, distM: node.id < 0 ? Infinity : search.dist[node.id] };
      })
      .filter((f) => Number.isFinite(f.distM))
      .sort((a, b) => a.distM - b.distM)
      .slice(0, dto.count ?? 3);
    if (ranked.length === 0) {
      throw new BadRequestException(
        'No facility can be reached from this point on the network.',
      );
    }
    return {
      facilities: ranked.map((f) => ({
        label: this.facilityLabel(f.row.props, f.index),
        lengthM: f.distM,
        location: [f.row.lon, f.row.lat] as LonLat,
        properties: f.row.props,
        path: this.pathGeometry(graph, search, f.node),
      })),
    };
  }

  async trace(appUser: AppUser, dto: TraceDto) {
    const graph = await this.graphFor(appUser, dto.layerId, 'pipe');
    const [start] = await this.snap(graph, [dto.at]);
    const limit = dto.maxDistanceM ?? Infinity;
    const search = this.dijkstra(graph, start, { maxDist: limit });

    const lines: LonLat[][] = [];
    let lengthM = 0;
    const endPoints: LonLat[] = [];
    graph.edges.forEach((edge) => {
      if (Math.min(search.dist[edge.a], search.dist[edge.b]) > limit) return;
      lines.push(edge.coords);
      lengthM += edge.len;
    });
    // Dead ends reached by the trace (pipe ends, valves, last houses).
    graph.adj.forEach((links, node) => {
      if (links.length === 1 && search.dist[node] <= limit) {
        endPoints.push(this.nodeLonLat(graph, node));
      }
    });
    return {
      segmentCount: lines.length,
      lengthM,
      path: { type: 'MultiLineString', coordinates: lines },
      endPoints: { type: 'MultiPoint', coordinates: endPoints },
    };
  }

  /** Service Area: roads reachable from a point within each break, and a
   *  polygon around them (the reached roads buffered by 50 m). */
  async serviceArea(appUser: AppUser, dto: ServiceAreaDto) {
    const graph = await this.graphFor(appUser, dto.layerId, 'road');
    const [start] = await this.snap(graph, [dto.at]);
    const toMetres = (b: number) => (dto.speedKmh ? (b / 60) * dto.speedKmh * 1000 : b);
    const breaks = [...new Set(dto.breaks)].sort((a, b) => a - b);
    const limits = breaks.map(toMetres);
    if (limits[limits.length - 1] > 100_000) {
      throw new BadRequestException('Service areas are limited to 100 km.');
    }
    const search = this.dijkstra(graph, start, { maxDist: limits[limits.length - 1] });
    const areas: { break: number; distanceM: number; lengthM: number; roads: unknown; area: unknown }[] = [];
    for (let i = 0; i < breaks.length; i++) {
      const limit = limits[i];
      const lines: LonLat[][] = [];
      let lengthM = 0;
      for (const edge of graph.edges) {
        if (Math.max(search.dist[edge.a], search.dist[edge.b]) > limit) continue;
        lines.push(edge.coords);
        lengthM += edge.len;
      }
      let area: unknown = null;
      if (lines.length) {
        const [row] = await this.prisma.$queryRawUnsafe<{ g: unknown }[]>(
          `SELECT ST_AsGeoJSON(ST_Transform(ST_SimplifyPreserveTopology(
                    ST_Buffer(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), $2::int), 50, 'quad_segs=4'), 5), 4326), 6)::json AS g`,
          JSON.stringify({ type: 'MultiLineString', coordinates: lines }),
          graph.srid,
        );
        area = row?.g ?? null;
      }
      areas.push({
        break: breaks[i],
        distanceM: limit,
        lengthM,
        roads: { type: 'MultiLineString', coordinates: lines },
        area,
      });
    }
    return { unit: dto.speedKmh ? 'min' : 'm', areas };
  }

  // ----- graph -----

  private async graphFor(
    appUser: AppUser,
    layerId: string,
    kind: NetworkKind,
  ): Promise<Graph> {
    const { table, workspaceId } = await this.gisLayers.networkSource(
      appUser,
      layerId,
      'LINE',
      // Pipe tracing works on any line layer; road analysis only on
      // layers marked for routing.
      { routing: kind === 'road' },
    );
    return this.graphForTable(table, workspaceId, kind);
  }

  /** The cached graph if its table is unchanged, else a fresh build. A
   *  build already running for the same table (a background warm-up, or
   *  another request) is shared rather than started twice. */
  private async graphForTable(
    table: string,
    workspaceId: string | null,
    kind: NetworkKind,
  ): Promise<Graph> {
    this.assertTable(table);
    const key = `${table}|${workspaceId ?? ''}|${kind}`;
    const stamp = await this.writeStamp(table);
    const cached = this.cache.get(key);
    if (cached && cached.stamp === stamp && Date.now() - cached.builtAt < CACHE_TTL_MS) {
      // Most recently used last, so eviction drops the least used.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const buildKey = `${key}|${stamp}`;
    let pending = this.building.get(buildKey);
    if (!pending) {
      pending = this.buildGraph(table, workspaceId, kind)
        .then((graph) => {
          graph.stamp = stamp;
          this.cache.delete(key);
          this.cache.set(key, graph);
          while (this.cache.size > MAX_CACHED_GRAPHS) {
            this.cache.delete(this.cache.keys().next().value as string);
          }
          return graph;
        })
        .finally(() => this.building.delete(buildKey));
      this.building.set(buildKey, pending);
    }
    return pending;
  }

  // ----- warm-up: networks built in the background, before anyone routes -----

  onApplicationBootstrap(): void {
    if (process.env.NETWORK_WARMUP === '0' || process.env.NODE_ENV === 'test') return;
    // Let the app finish starting first; then keep checking, so a layer
    // that is uploaded, imported, replaced or edited gets its network
    // (re)built in the background rather than on the next route request.
    this.warmTimer = setTimeout(() => void this.warmAll(), WARMUP_DELAY_MS);
    this.warmInterval = setInterval(() => void this.warmAll(), WARMUP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    clearTimeout(this.warmTimer);
    clearInterval(this.warmInterval);
  }

  /** Builds the road network of one layer now, in the background (e.g.
   *  right after it is published). Never throws. */
  warmLayer(layerId: string): void {
    void this.prisma.gISLayer
      .findUnique({ where: { id: layerId } })
      .then((layer) => (layer ? this.warm(layer) : undefined))
      .catch(() => undefined);
  }

  /** Keeps the most recently changed routing layers' networks current. */
  private async warmAll(): Promise<void> {
    if (this.warming) return;
    this.warming = true;
    try {
      const layers = await this.prisma.gISLayer.findMany({
        where: { layerType: 'VECTOR', geometryType: 'LINE', routingEnabled: true },
        orderBy: { updatedAt: 'desc' },
        take: WARMUP_LAYERS,
      });
      // One at a time: a build is a heavy query.
      for (const layer of layers) await this.warm(layer);
    } catch (error) {
      this.logger.warn(`Network warm-up failed: ${(error as Error).message}`);
    } finally {
      this.warming = false;
    }
  }

  private async warm(layer: GISLayer): Promise<void> {
    if (layer.layerType !== 'VECTOR' || layer.geometryType !== 'LINE' || !layer.routingEnabled) return;
    const { table, workspaceId } = this.gisLayers.styleSource(layer);
    if (!table) return;
    const key = `${table}|${workspaceId ?? ''}|road`;
    const before = this.cache.get(key);
    const started = Date.now();
    try {
      const graph = await this.graphForTable(table, workspaceId, 'road');
      if (graph !== before) {
        this.logger.log(
          `Road network for "${layer.name}" ready: ${graph.edges.length} segments in ${Date.now() - started} ms.`,
        );
      }
    } catch (error) {
      this.logger.warn(`Road network for "${layer.name}" not built: ${(error as Error).message}`);
    }
  }

  private async buildGraph(
    table: string,
    workspaceId: string | null,
    kind: NetworkKind,
  ): Promise<Graph> {
    const [col] = await this.prisma.$queryRawUnsafe<{ srid: number }[]>(
      `SELECT srid FROM geometry_columns
        WHERE f_table_schema = 'public' AND f_table_name = $1 LIMIT 1`,
      table,
    );
    // Geographic data is worked in Web Mercator so snapping is in metres.
    const srid = !col || col.srid === 4326 || col.srid === 0 ? 3857 : col.srid;
    const scope = this.scope(table, workspaceId, 2);
    const nameColumn = kind === 'road' ? await this.roadNameColumn(table) : null;
    const nameExpr = nameColumn ? `NULLIF(trim(t."${nameColumn.replace(/"/g, '""')}"::text), '')` : 'NULL::text';
    type PartRow = { sx: number; sy: number; ex: number; ey: number; len: number; gj: string; nm: string | null };
    // Roads are split where they cross (noded). One ST_Node over the whole
    // layer is quadratic-ish (~40 s for 40k roads), so each line is cut
    // only by the lines its index finds touching it (~4 s, same network).
    const rows = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `CREATE TEMP TABLE net_lines ON COMMIT DROP AS
             SELECT row_number() OVER () AS id, g, nm FROM (
               SELECT (ST_Dump(ST_Force2D(ST_Transform(t.geom, $1::int)))).geom AS g, ${nameExpr} AS nm
                 FROM "${table}" t
                WHERE t.geom IS NOT NULL ${scope.clause}) s
              WHERE GeometryType(g) = 'LINESTRING' AND NOT ST_IsEmpty(g)`,
          srid,
          ...scope.params,
        );
        if (kind === 'road') {
          await tx.$executeRawUnsafe(`CREATE INDEX ON net_lines USING gist (g)`);
          await tx.$executeRawUnsafe(`ANALYZE net_lines`);
        }
        const parts =
          kind === 'road'
            ? `WITH cuts AS (
                 SELECT a.id, ST_UnaryUnion(ST_Collect(ST_CollectionExtract(ST_Intersection(a.g, b.g), 1))) AS pts
                   FROM net_lines a
                   JOIN net_lines b ON a.id <> b.id AND a.g && b.g AND ST_Intersects(a.g, b.g)
                  GROUP BY a.id)
               SELECT (ST_Dump(
                        CASE WHEN c.pts IS NULL OR ST_IsEmpty(c.pts) THEN l.g
                             ELSE ST_Split(ST_Snap(l.g, c.pts, 0.01), c.pts) END)).geom AS g, l.nm
                 FROM net_lines l LEFT JOIN cuts c USING (id)`
            : `SELECT g, nm FROM net_lines`;
        return tx.$queryRawUnsafe<PartRow[]>(
          `WITH parts AS (${parts})
           SELECT ST_X(ST_StartPoint(g)) AS sx, ST_Y(ST_StartPoint(g)) AS sy,
                  ST_X(ST_EndPoint(g)) AS ex, ST_Y(ST_EndPoint(g)) AS ey,
                  ST_Length(ST_Transform(g, 4326)::geography) AS len,
                  ST_AsGeoJSON(ST_Transform(g, 4326), 6) AS gj, nm
             FROM parts
            WHERE GeometryType(g) = 'LINESTRING' AND NOT ST_IsEmpty(g)`,
        );
      },
      { timeout: 120_000 },
    );
    if (rows.length === 0) {
      throw new BadRequestException('This layer has no lines to build a network from.');
    }

    const tol = SNAP_TOLERANCE_M[kind];
    const ids = new Map<string, number>();
    const graph: Graph = {
      srid,
      nodeX: [],
      nodeY: [],
      adj: [],
      edges: [],
      grid: new Map(),
      builtAt: Date.now(),
      stamp: '',
    };
    const nodeId = (x: number, y: number): number => {
      const key = `${Math.round(x / tol)}:${Math.round(y / tol)}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = graph.nodeX.length;
        ids.set(key, id);
        graph.nodeX.push(x);
        graph.nodeY.push(y);
        graph.adj.push([]);
        const cell = this.cellKey(x, y);
        const bucket = graph.grid.get(cell);
        if (bucket) bucket.push(id);
        else graph.grid.set(cell, [id]);
      }
      return id;
    };
    for (const row of rows) {
      const a = nodeId(row.sx, row.sy);
      const b = nodeId(row.ex, row.ey);
      if (a === b && row.len < tol) continue;
      const edge = graph.edges.length;
      graph.edges.push({
        a,
        b,
        len: Number(row.len),
        coords: (JSON.parse(row.gj) as { coordinates: LonLat[] }).coordinates,
        name: row.nm,
      });
      graph.adj[a].push({ to: b, edge });
      if (a !== b) graph.adj[b].push({ to: a, edge });
    }
    return graph;
  }

  /** Clicked lon/lat positions → their nearest network nodes. */
  private async snap(graph: Graph, points: LonLat[]): Promise<number[]> {
    const nodes: number[] = [];
    for (const [lon, lat] of points) {
      const [p] = await this.prisma.$queryRawUnsafe<{ x: number; y: number }[]>(
        `SELECT ST_X(p) AS x, ST_Y(p) AS y
           FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326), $3::int) AS p) s`,
        lon,
        lat,
        graph.srid,
      );
      const node = this.nearestNode(graph, p.x, p.y);
      if (node.id < 0 || node.distance > MAX_SNAP_M) {
        throw new BadRequestException(
          'Click closer to the network — no line found within 2 km.',
        );
      }
      nodes.push(node.id);
    }
    return nodes;
  }

  /** The point on the network nearest `click` (lon/lat): which edge, where
   *  on it (segment index + the point) and how far along it from node a. */
  private snapToEdge(
    graph: Graph,
    click: LonLat,
    usable: (edge: number) => boolean = () => true,
    what = 'the point',
  ): EdgeSnap {
    const [lon0, lat0] = click;
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const ky = 110540;
    let best: (EdgeSnap & { distance: number }) | null = null;
    graph.edges.forEach((edge, index) => {
      if (!usable(index)) return;
      const c = edge.coords;
      for (let i = 0; i < c.length - 1; i++) {
        const ax = (c[i][0] - lon0) * kx;
        const ay = (c[i][1] - lat0) * ky;
        const bx = (c[i + 1][0] - lon0) * kx;
        const by = (c[i + 1][1] - lat0) * ky;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
        const px = ax + t * dx;
        const py = ay + t * dy;
        const distance = Math.hypot(px, py);
        if (!best || distance < best.distance) {
          best = {
            edge: index,
            segment: i,
            t,
            point: [c[i][0] + t * (c[i + 1][0] - c[i][0]), c[i][1] + t * (c[i + 1][1] - c[i][1])],
            fromA: 0,
            distance,
          };
        }
      }
    });
    const found = best as (EdgeSnap & { distance: number }) | null;
    if (!found || found.distance > MAX_SNAP_M) {
      throw new BadRequestException(
        `Move ${what} closer to the network — no usable road within 2 km.`,
      );
    }
    // Distance from node a along the edge, scaled to the edge's true length.
    const edge = graph.edges[found.edge];
    const planar = (from: LonLat, to: LonLat) =>
      Math.hypot((to[0] - from[0]) * kx, (to[1] - from[1]) * ky);
    let total = 0;
    let before = 0;
    for (let i = 0; i < edge.coords.length - 1; i++) {
      const part = planar(edge.coords[i], edge.coords[i + 1]);
      if (i < found.segment) before += part;
      if (i === found.segment) before += part * found.t;
      total += part;
    }
    found.fromA = total > 0 ? (before / total) * edge.len : 0;
    return found;
  }

  /** The part of `edge` between the snapped point and its node `side`,
   *  ordered point → node (`fromPoint`, the route's start) or node → point. */
  private edgePart(edge: Edge, snap: EdgeSnap, side: 'a' | 'b', fromPoint: boolean): LonLat[] {
    const c = edge.coords;
    const nodeToPoint =
      side === 'a'
        ? [...c.slice(0, snap.segment + 1), snap.point]
        : [...c.slice(snap.segment + 1).reverse(), snap.point];
    return fromPoint ? nodeToPoint.reverse() : nodeToPoint;
  }

  /** Both points on one edge: the stretch of it between them. */
  private edgeBetween(edge: Edge, from: EdgeSnap, to: EdgeSnap): LonLat[] {
    const c = edge.coords;
    const forward = from.fromA <= to.fromA;
    const [p, q] = forward ? [from, to] : [to, from];
    const line = [p.point, ...c.slice(p.segment + 1, q.segment + 1), q.point];
    return forward ? line : line.reverse();
  }

  /** Lines of the found path ending at `target`, in travel order. */
  private pathLines(graph: Graph, search: SearchResult, target: number): LonLat[][] {
    const lines: LonLat[][] = [];
    let node = target;
    while (search.prevEdge[node] >= 0) {
      const edge = graph.edges[search.prevEdge[node]];
      const from = edge.a === node ? edge.b : edge.a;
      lines.push(edge.a === from ? edge.coords : [...edge.coords].reverse());
      node = from;
    }
    return lines.reverse();
  }

  /** The source node the path to `target` started from. */
  private searchStart(graph: Graph, search: SearchResult, target: number): number {
    let node = target;
    while (search.prevEdge[node] >= 0) {
      const edge = graph.edges[search.prevEdge[node]];
      node = edge.a === node ? edge.b : edge.a;
    }
    return node;
  }

  private nearestNode(graph: Graph, x: number, y: number) {
    const cx = Math.floor(x / GRID_CELL_M);
    const cy = Math.floor(y / GRID_CELL_M);
    let best = { id: -1, distance: Infinity };
    const maxRing = Math.ceil(MAX_SNAP_M / GRID_CELL_M) + 1;
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let i = cx - ring; i <= cx + ring; i++) {
        for (let j = cy - ring; j <= cy + ring; j++) {
          if (Math.max(Math.abs(i - cx), Math.abs(j - cy)) !== ring) continue;
          for (const id of graph.grid.get(`${i}:${j}`) ?? []) {
            const d = Math.hypot(graph.nodeX[id] - x, graph.nodeY[id] - y);
            if (d < best.distance) best = { id, distance: d };
          }
        }
      }
      // Anything in a further ring is at least `ring * cell` away.
      if (best.id >= 0 && best.distance <= ring * GRID_CELL_M) break;
    }
    return best;
  }

  private cellKey(x: number, y: number): string {
    return `${Math.floor(x / GRID_CELL_M)}:${Math.floor(y / GRID_CELL_M)}`;
  }

  // ----- search -----

  /** `source`: one node, or several [node, starting distance] pairs (a
   *  point part-way along an edge starts from both its ends). Stops early
   *  once every one of `targets` is settled. */
  private dijkstra(
    graph: Graph,
    source: number | [number, number][],
    options: { targets?: number[]; maxDist?: number; factor?: (edge: number) => number },
  ): SearchResult {
    const n = graph.nodeX.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prevEdge = new Int32Array(n).fill(-1);
    const maxDist = options.maxDist ?? Infinity;
    const heap = new MinHeap();
    for (const [node, d] of typeof source === 'number' ? [[source, 0] as [number, number]] : source) {
      if (d < dist[node]) {
        dist[node] = d;
        heap.push(node, d);
      }
    }
    const pending = new Set(options.targets ?? []);
    while (heap.size > 0) {
      const [node, d] = heap.pop();
      if (d > dist[node]) continue;
      if (pending.delete(node) && pending.size === 0) break;
      for (const { to, edge } of graph.adj[node]) {
        const next = d + graph.edges[edge].len * (options.factor ? options.factor(edge) : 1);
        if (next < dist[to] && next <= maxDist) {
          dist[to] = next;
          prevEdge[to] = edge;
          heap.push(to, next);
        }
      }
    }
    return { dist, prevEdge };
  }

  private pathGeometry(graph: Graph, search: SearchResult, target: number) {
    const lines: LonLat[][] = [];
    let node = target;
    while (search.prevEdge[node] >= 0) {
      const edge = graph.edges[search.prevEdge[node]];
      lines.push(edge.coords);
      node = edge.a === node ? edge.b : edge.a;
    }
    return { type: 'MultiLineString', coordinates: lines.reverse() };
  }

  private nodeLonLat(graph: Graph, node: number): LonLat {
    const link = graph.adj[node][0];
    const edge = graph.edges[link.edge];
    return edge.a === node ? edge.coords[0] : edge.coords[edge.coords.length - 1];
  }

  // ----- helpers -----

  private facilityLabel(props: Record<string, unknown>, index: number): string {
    const keys = Object.keys(props);
    const named = keys.find((k) => /name/i.test(k) && typeof props[k] === 'string' && props[k]);
    if (named) return String(props[named]);
    const text = keys.find((k) => typeof props[k] === 'string' && props[k]);
    return text ? String(props[text]) : `Facility ${index + 1}`;
  }

  /** Demo tables are shared by every municipality — scope them by workspace. */
  /** The column holding road names, if any (for turn-by-turn directions). */
  private async roadNameColumn(table: string): Promise<string | null> {
    const columns = await this.prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
          AND data_type IN ('text', 'character varying', 'character')`,
      table,
    );
    const names = columns.map((c) => c.name);
    for (const pattern of ROAD_NAME_COLUMNS) {
      const hit = names.find((n) => pattern.test(n));
      if (hit) return hit;
    }
    return null;
  }

  /** Changes whenever rows of `table` are inserted, updated or deleted
   *  (Postgres statistics counters) — cheap enough to check per request. */
  private async writeStamp(table: string): Promise<string> {
    const [row] = await this.prisma.$queryRawUnsafe<{ stamp: string | null }[]>(
      `SELECT (n_tup_ins + n_tup_upd + n_tup_del)::text AS stamp
         FROM pg_stat_user_tables WHERE schemaname = 'public' AND relname = $1`,
      table,
    );
    return row?.stamp ?? '';
  }

  private scope(table: string, workspaceId: string | null, param: number) {
    return workspaceId && DEMO_TABLES.has(table)
      ? { clause: `AND t.gis_workspace_id = $${param}`, params: [workspaceId] }
      : { clause: '', params: [] as string[] };
  }

  private assertTable(table: string): void {
    if (isSafeGeneratedTableName(table) || DEMO_TABLES.has(table)) return;
    throw new BadRequestException('This layer cannot be used as a network.');
  }
}

/** Binary min-heap of (node, priority). */
class MinHeap {
  private readonly nodes: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, key: number): void {
    this.nodes.push(node);
    this.keys.push(key);
    let i = this.nodes.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): [number, number] {
    const top: [number, number] = [this.nodes[0], this.keys[0]];
    const lastNode = this.nodes.pop() as number;
    const lastKey = this.keys.pop() as number;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastNode;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.nodes.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.nodes.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(i: number, j: number): void {
    [this.nodes[i], this.nodes[j]] = [this.nodes[j], this.nodes[i]];
    [this.keys[i], this.keys[j]] = [this.keys[j], this.keys[i]];
  }
}

// ----- routing geometry helpers -----

/** "A", "B", … "Z", then "27", "28" … */
function stopLabel(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

function isLonLat(p: unknown): p is LonLat {
  return (
    Array.isArray(p) &&
    p.length === 2 &&
    typeof p[0] === 'number' &&
    typeof p[1] === 'number' &&
    Math.abs(p[0]) <= 180 &&
    Math.abs(p[1]) <= 90
  );
}

function pointInRing([x, y]: LonLat, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function crossesRing(line: LonLat[], ring: LonLat[]): boolean {
  for (let i = 0; i < line.length - 1; i++) {
    for (let j = 0; j < ring.length - 1; j++) {
      if (segmentsCross(line[i], line[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

function segmentsCross(a: LonLat, b: LonLat, c: LonLat, d: LonLat): boolean {
  const orient = (p: LonLat, q: LonLat, r: LonLat) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Compass bearing (0 = north, clockwise) from `p` to `q`. */
function bearing(p: LonLat, q: LonLat): number {
  const kx = Math.cos((p[1] * Math.PI) / 180);
  const deg = (Math.atan2((q[0] - p[0]) * kx, q[1] - p[1]) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Direction a line leaves its first point, looked at over ~15 m so a
 *  tiny kink at the junction doesn't decide the turn. */
function startBearing(coords: LonLat[]): number {
  const p = coords[0];
  let q = coords[1];
  for (const c of coords.slice(1)) {
    q = c;
    if (Math.hypot((c[0] - p[0]) * 111320 * Math.cos((p[1] * Math.PI) / 180), (c[1] - p[1]) * 110540) > 15) break;
  }
  return bearing(p, q);
}

function endBearing(coords: LonLat[]): number {
  return (startBearing([...coords].reverse()) + 180) % 360;
}

/** Signed turn from heading `from` to `to`: positive = right. */
function turnAngle(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

function turnPhrase(angle: number): string {
  const side = angle > 0 ? 'right' : 'left';
  const a = Math.abs(angle);
  if (a < 20) return 'Continue';
  if (a < 50) return `Keep ${side}`;
  if (a < 135) return `Turn ${side}`;
  if (a < 165) return `Make a sharp ${side}`;
  return 'Make a U-turn';
}

function compass(deg: number): string {
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][
    Math.round(deg / 45) % 8
  ];
}
