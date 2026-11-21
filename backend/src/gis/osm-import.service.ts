import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GisGeometryType } from '@prisma/client';
import type { AppUser } from '../auth/types/app-user.type';
import { safeFetch } from '../common/safe-fetch';
import { PrismaService } from '../prisma/prisma.service';
import { RasterService } from './raster.service';
import type { OsmImportDto } from './dto/platform-extras.dto';

interface Preset {
  label: string;
  /** Overpass selectors, `{{bbox}}` filled in. */
  selectors: string[];
  /** Tags kept as their own columns (all tags also go to `tags`). */
  columns: string[];
}

const PRESETS: Record<string, Preset> = {
  buildings: {
    label: 'Buildings',
    selectors: ['way["building"]', 'relation["building"]["type"="multipolygon"]'],
    columns: ['building', 'name', 'addr:housenumber', 'addr:street', 'building:levels', 'height', 'amenity'],
  },
  roads: {
    label: 'Roads',
    selectors: [
      'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]',
    ],
    columns: ['highway', 'name', 'ref', 'oneway', 'surface', 'lanes', 'maxspeed'],
  },
  schools: {
    label: 'Schools & colleges',
    selectors: ['nwr["amenity"~"^(school|college|university|kindergarten)$"]'],
    columns: ['amenity', 'name', 'operator', 'isced:level', 'addr:street', 'addr:city'],
  },
  health: {
    label: 'Hospitals & clinics',
    selectors: ['nwr["amenity"~"^(hospital|clinic|doctors|pharmacy|dentist)$"]', 'nwr["healthcare"]'],
    columns: ['amenity', 'healthcare', 'name', 'operator', 'emergency', 'beds', 'addr:street'],
  },
  water: {
    label: 'Water bodies',
    selectors: ['way["natural"="water"]', 'relation["natural"="water"]["type"="multipolygon"]', 'way["waterway"="riverbank"]'],
    columns: ['natural', 'water', 'name'],
  },
  waterways: {
    label: 'Rivers, canals & drains',
    selectors: ['way["waterway"~"^(river|stream|canal|drain|ditch)$"]'],
    columns: ['waterway', 'name', 'width', 'intermittent'],
  },
  worship: {
    label: 'Places of worship',
    selectors: ['nwr["amenity"="place_of_worship"]'],
    columns: ['religion', 'name', 'denomination'],
  },
  parks: {
    label: 'Parks & playgrounds',
    selectors: ['nwr["leisure"~"^(park|garden|playground|pitch|sports_centre)$"]'],
    columns: ['leisure', 'name', 'sport', 'access'],
  },
  landuse: {
    label: 'Land use',
    selectors: ['way["landuse"]', 'relation["landuse"]["type"="multipolygon"]'],
    columns: ['landuse', 'name'],
  },
  shops: {
    label: 'Shops & markets',
    selectors: ['nwr["shop"]', 'nwr["amenity"="marketplace"]'],
    columns: ['shop', 'amenity', 'name', 'opening_hours', 'addr:street'],
  },
};

const MAX_AREA_DEG2 = 0.6; // ~ 80 km × 80 km at the equator
const MAX_FEATURES = 100_000;
const BATCH = 2000;
const TAG_KEY = /^[A-Za-z0-9_:.\-]{1,60}$/;

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
  tags?: Record<string, string>;
}

/** Column name for an OSM tag ("addr:street" → addr_street). */
const columnOf = (tag: string) => tag.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 50);

/**
 * OSM Download: OpenStreetMap features inside a box (from a preset or a
 * custom tag) fetched from Overpass and published as a new vector layer in
 * WGS84. Areas are rebuilt in PostGIS (closed ways and multipolygon
 * relations); points can come from any element (a point on its surface).
 */
@Injectable()
export class OsmImportService {
  private readonly logger = new Logger(OsmImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly raster: RasterService,
    private readonly config: ConfigService,
  ) {}

  presets() {
    return Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label }));
  }

  async import(appUser: AppUser, dto: OsmImportDto) {
    const [minX, minY, maxX, maxY] = dto.bbox;
    if (dto.bbox.length !== 4 || !(maxX > minX && maxY > minY) || Math.abs(minY) > 90 || Math.abs(maxY) > 90) {
      throw new BadRequestException('The area is not a valid box.');
    }
    if ((maxX - minX) * (maxY - minY) > MAX_AREA_DEG2) {
      throw new BadRequestException('The area is too large — zoom in (about 80 × 80 km at most).');
    }
    const preset = this.presetFor(dto);
    const box = `${minY},${minX},${maxY},${maxX}`;
    const query =
      `[out:json][timeout:120][maxsize:536870912];(` +
      preset.selectors.map((s) => `${s}(${box});`).join('') +
      `);out tags geom ${MAX_FEATURES + 1};`;

    const url = this.config.get<string>('OVERPASS_URL') ?? 'https://overpass-api.de/api/interpreter';
    const res = await safeFetch(url, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      timeoutMs: 150_000,
      maxBytes: 300 * 1024 * 1024,
      allowPrivate: true,
    });
    if (res.status === 429 || res.status === 504) {
      throw new BadRequestException('OpenStreetMap (Overpass) is busy right now — try again in a minute or with a smaller area.');
    }
    if (res.status !== 200) throw new BadRequestException(`OpenStreetMap (Overpass) answered HTTP ${res.status}.`);
    let elements: OsmElement[];
    try {
      elements = (JSON.parse(res.body.toString('utf8')) as { elements?: OsmElement[] }).elements ?? [];
    } catch {
      throw new BadRequestException('OpenStreetMap returned an unreadable answer.');
    }
    if (elements.length > MAX_FEATURES) {
      throw new BadRequestException(`More than ${MAX_FEATURES.toLocaleString()} features — use a smaller area.`);
    }

    const rows = elements
      .map((el) => ({ el, wkt: this.wkt(el, dto.geometryType) }))
      .filter((r): r is { el: OsmElement; wkt: string } => !!r.wkt);
    if (!rows.length) throw new BadRequestException(`No ${preset.label.toLowerCase()} found in this area on OpenStreetMap.`);

    const tagColumns = [...new Map(preset.columns.filter((t) => TAG_KEY.test(t)).map((t) => [columnOf(t), t])).entries()].filter(
      ([col]) => !['osm_id', 'osm_type', 'tags', 'geom', 'ogc_fid'].includes(col),
    );
    const output = await this.raster.prepareVectorOutput(appUser, dto.name);
    const table = output.table;
    const multi = { POINT: 'MultiPoint', LINE: 'MultiLineString', POLYGON: 'MultiPolygon' }[dto.geometryType];
    const dim = { POINT: 1, LINE: 2, POLYGON: 3 }[dto.geometryType];
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE "${table}" (
         ogc_fid SERIAL PRIMARY KEY,
         osm_type text,
         osm_id bigint,
         ${tagColumns.map(([col]) => `"${col}" text,`).join('\n')}
         tags jsonb,
         geom geometry(${multi}, 4326))`,
    );
    // Build each geometry in PostGIS: areas from closed ways / relation
    // rings, points on the surface of anything for point layers.
    const raw = `ST_GeomFromText(r.wkt, 4326)`;
    // Empty (no ring) → NULL, so point layers fall back to the line itself.
    const area = `(SELECT CASE WHEN a IS NULL OR ST_IsEmpty(a) THEN NULL ELSE a END FROM (SELECT ST_BuildArea(ST_LineMerge(${raw})) AS a) q)`;
    const geom =
      dto.geometryType === 'POLYGON'
        ? `ST_CollectionExtract(ST_MakeValid(${area}), 3)`
        : dto.geometryType === 'LINE'
          ? `ST_CollectionExtract(${raw}, 2)`
          : `ST_PointOnSurface(COALESCE(CASE WHEN GeometryType(${raw}) IN ('LINESTRING','MULTILINESTRING') THEN ${area} END, ${raw}))`;
    try {
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH).map(({ el, wkt }) => ({
          t: el.type,
          id: el.id,
          wkt,
          tags: el.tags ?? {},
        }));
        await this.prisma.$executeRawUnsafe(
          `INSERT INTO "${table}" (osm_type, osm_id, ${tagColumns.map(([c]) => `"${c}", `).join('')}tags, geom)
           SELECT r.t, r.id, ${tagColumns.map(([, tag]) => `r.tags->>'${tag.replace(/'/g, "''")}', `).join('')}r.tags,
                  ST_Multi(g)::geometry(${multi}, 4326)
             FROM jsonb_to_recordset($1::jsonb) AS r(t text, id bigint, wkt text, tags jsonb),
                  LATERAL (SELECT ${geom} AS g) x
            WHERE g IS NOT NULL AND NOT ST_IsEmpty(g) AND ST_Dimension(g) = ${dim - 1}`,
          JSON.stringify(batch),
        );
      }
      const [{ n }] = await this.prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}"`);
      if (n === 0) {
        throw new BadRequestException(
          `No ${dto.geometryType === 'POLYGON' ? 'areas' : dto.geometryType === 'LINE' ? 'lines' : 'points'} could be built from the OpenStreetMap data — try another geometry type.`,
        );
      }
      const layer = await this.raster.publishVectorTable(appUser, output, {
        name: dto.name,
        geometryType: dto.geometryType as GisGeometryType,
        description: `${n.toLocaleString()} ${preset.label.toLowerCase()} from OpenStreetMap (© OpenStreetMap contributors, ODbL), downloaded ${new Date().toISOString().slice(0, 10)}.`,
        rasterAnalysis: false,
        srs: 'EPSG:4326',
      });
      // Data Catalog record: OSM data is ODbL-licensed and must be credited.
      await this.prisma.gISLayer
        .update({
          where: { id: (layer as { id: string }).id },
          data: {
            metadata: {
              source: 'OpenStreetMap (Overpass API)',
              licence: 'ODbL 1.0 — © OpenStreetMap contributors',
              keywords: ['openstreetmap', dto.preset],
              dataDate: new Date().toISOString().slice(0, 10),
            },
          },
        })
        .catch(() => undefined);
      return { layer, featureCount: n, fetched: elements.length };
    } catch (error) {
      await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}"`).catch(() => undefined);
      throw error;
    }
  }

  private presetFor(dto: OsmImportDto): Preset {
    if (dto.preset !== 'custom') return PRESETS[dto.preset];
    const key = (dto.customKey ?? '').trim();
    if (!TAG_KEY.test(key)) throw new BadRequestException('Enter an OpenStreetMap tag key, e.g. "amenity".');
    const value = (dto.customValue ?? '').trim().replace(/["\\]/g, '');
    const filter = value ? `["${key}"="${value}"]` : `["${key}"]`;
    return { label: value ? `${key}=${value}` : key, selectors: [`nwr${filter}`], columns: [key, 'name'] };
  }

  /** WKT in lon/lat: nodes as points, ways as lines (closed rings become
   *  areas in SQL), multipolygon relations as their member lines. */
  private wkt(el: OsmElement, target: 'POINT' | 'LINE' | 'POLYGON'): string | null {
    const line = (g: { lat: number; lon: number }[]) => `(${g.map((p) => `${p.lon} ${p.lat}`).join(',')})`;
    if (el.type === 'node') {
      return target === 'POINT' && el.lon !== undefined && el.lat !== undefined ? `POINT(${el.lon} ${el.lat})` : null;
    }
    if (el.type === 'way') {
      const g = el.geometry?.filter(Boolean) ?? [];
      if (g.length < 2) return null;
      if (target === 'POLYGON') {
        const closed = g.length >= 4 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
        if (!closed) return null;
      }
      return `LINESTRING${line(g)}`;
    }
    if (target === 'LINE') return null;
    const parts = (el.members ?? []).filter((m) => m.type === 'way' && (m.geometry?.length ?? 0) >= 2).map((m) => line(m.geometry!));
    return parts.length ? `MULTILINESTRING(${parts.join(',')})` : null;
  }
}
