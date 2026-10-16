import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';
import { GisLayersService } from './gis-layers.service';
import { isSafeGeneratedTableName } from './layer-naming.util';
import type { NearestFacilityDto, RouteDto, TraceDto } from './dto/network.dto';

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
}

interface SearchResult {
  dist: Float64Array;
  prevEdge: Int32Array;
}

/** End points closer than this (metres) are one junction. */
const SNAP_TOLERANCE_M: Record<NetworkKind, number> = { road: 0.5, pipe: 1 };
/** A click further than this from every network node is rejected. */
const MAX_SNAP_M = 2000;
const GRID_CELL_M = 200;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHED_GRAPHS = 6;
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
export class NetworkService {
  private readonly cache = new Map<string, Graph>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly gisLayers: GisLayersService,
  ) {}

  async route(appUser: AppUser, dto: RouteDto) {
    const graph = await this.graphFor(appUser, dto.layerId, 'road');
    const [from, to] = await this.snap(graph, [dto.from, dto.to]);
    const search = this.dijkstra(graph, from, { target: to });
    if (!Number.isFinite(search.dist[to])) {
      throw new BadRequestException(
        'The two points are not connected on this network.',
      );
    }
    return {
      lengthM: search.dist[to],
      path: this.pathGeometry(graph, search, to),
    };
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
    );
    this.assertTable(table);
    const key = `${table}|${workspaceId ?? ''}|${kind}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.builtAt < CACHE_TTL_MS) return cached;

    const graph = await this.buildGraph(table, workspaceId, kind);
    this.cache.delete(key);
    this.cache.set(key, graph);
    while (this.cache.size > MAX_CACHED_GRAPHS) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
    return graph;
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
    const parts =
      kind === 'road'
        ? `SELECT (ST_Dump(ST_Node(ST_Collect(g)))).geom AS g FROM lines`
        : `SELECT g FROM lines`;
    const rows = await this.prisma.$queryRawUnsafe<
      { sx: number; sy: number; ex: number; ey: number; len: number; gj: string }[]
    >(
      `WITH lines AS (
         SELECT (ST_Dump(ST_Force2D(ST_Transform(t.geom, $1::int)))).geom AS g
           FROM "${table}" t
          WHERE t.geom IS NOT NULL ${scope.clause}
       ), parts AS (${parts})
       SELECT ST_X(ST_StartPoint(g)) AS sx, ST_Y(ST_StartPoint(g)) AS sy,
              ST_X(ST_EndPoint(g)) AS ex, ST_Y(ST_EndPoint(g)) AS ey,
              ST_Length(ST_Transform(g, 4326)::geography) AS len,
              ST_AsGeoJSON(ST_Transform(g, 4326), 6) AS gj
         FROM parts
        WHERE GeometryType(g) = 'LINESTRING' AND NOT ST_IsEmpty(g)`,
      srid,
      ...scope.params,
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

  private dijkstra(
    graph: Graph,
    source: number,
    options: { target?: number; maxDist?: number },
  ): SearchResult {
    const n = graph.nodeX.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prevEdge = new Int32Array(n).fill(-1);
    const maxDist = options.maxDist ?? Infinity;
    dist[source] = 0;
    const heap = new MinHeap();
    heap.push(source, 0);
    while (heap.size > 0) {
      const [node, d] = heap.pop();
      if (d > dist[node]) continue;
      if (node === options.target) break;
      for (const { to, edge } of graph.adj[node]) {
        const next = d + graph.edges[edge].len;
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
