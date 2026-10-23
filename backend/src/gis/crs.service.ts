import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CrsInfo {
  /** "EPSG:32643" */
  code: string;
  srid: number;
  name: string;
  kind: 'projected' | 'geographic';
  /** Linear unit of a projected CRS ("metre", "US survey foot"…), or "degree". */
  unit: string;
  /** proj4 definition, so the browser can transform coordinates too. */
  proj4: string;
}

/** Coordinate systems usually needed by Indian municipalities — offered
 *  before the user searches. */
const RECOMMENDED_SRIDS = [
  4326, 3857, 7755, 32642, 32643, 32644, 32645, 32646, 32647, 24378, 24379, 24380, 24381, 24382, 24383, 4240,
];

const MAX_RESULTS = 50;

/**
 * Coordinate reference systems the platform supports — every EPSG
 * projected or geographic 2D CRS in PostGIS's spatial_ref_sys (the same
 * EPSG registry GDAL and GeoServer use), so any of them can be chosen for
 * uploads, reprojection, Define Projection and exports.
 */
@Injectable()
export class CrsService {
  private readonly cache = new Map<number, CrsInfo | null>();

  constructor(private readonly prisma: PrismaService) {}

  /** Matches on code ("32643", "EPSG:32643") or name words ("utm 43",
   *  "kalianpur"); an empty query lists the recommended systems. */
  async search(query: string | undefined, limit = MAX_RESULTS): Promise<CrsInfo[]> {
    const text = (query ?? '').trim();
    if (!text) return this.many(RECOMMENDED_SRIDS);
    const code = /^(?:epsg:)?(\d{3,6})$/i.exec(text);
    const words = text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    const rows = await this.prisma.$queryRawUnsafe<RawCrs[]>(
      `${SELECT}
         AND (${code ? 's.srid::text LIKE $1 || \'%\'' : 'true'})
         AND (${code ? 'true' : words.map((_, i) => `${NAME} ILIKE '%' || $${i + 1} || '%'`).join(' AND ')})
       ORDER BY ${code ? 'length(s.srid::text), s.srid' : `length(${NAME}), s.srid`}
       LIMIT ${Math.min(Math.max(limit, 1), MAX_RESULTS)}`,
      ...(code ? [code[1]] : words.map((w) => w.replace(/[%_\\]/g, '\\$&'))),
    );
    return rows.map(toInfo);
  }

  /** Details of one CRS, or null when it is not a supported EPSG CRS. */
  async get(code: string | number): Promise<CrsInfo | null> {
    const srid = typeof code === 'number' ? code : parseSrid(code);
    if (srid === null) return null;
    if (!this.cache.has(srid)) {
      const [row] = await this.prisma.$queryRawUnsafe<RawCrs[]>(`${SELECT} AND s.srid = $1`, srid);
      this.cache.set(srid, row ? toInfo(row) : null);
    }
    return this.cache.get(srid) ?? null;
  }

  /** The CRS, or a 400 naming what was wrong. */
  async require(code: string, what = 'CRS'): Promise<CrsInfo> {
    const crs = await this.get(code);
    if (!crs) throw new BadRequestException(`${what} "${code}" is not a supported EPSG coordinate system.`);
    return crs;
  }

  /** The SRID a table's geom column is stored in (0 when undeclared). */
  async tableSrid(table: string): Promise<number> {
    const [row] = await this.prisma.$queryRawUnsafe<{ srid: number | null }[]>(
      `SELECT Find_SRID('public', $1, 'geom') AS srid`,
      table,
    );
    return Number(row?.srid ?? 0);
  }

  /** Suggested systems for data at this lon/lat: its WGS 84 UTM zone (the
   *  usual metric choice), India NSF LCC inside India, WGS 84, Web Mercator. */
  async suggestFor(lon: number, lat: number): Promise<CrsInfo[]> {
    const zone = Math.min(Math.max(Math.floor((lon + 180) / 6) + 1, 1), 60);
    const utm = (lat >= 0 ? 32600 : 32700) + zone;
    const india = lon >= 68 && lon <= 98 && lat >= 6 && lat <= 38;
    return this.many([utm, ...(india ? [7755] : []), 4326, 3857]);
  }

  private async many(srids: number[]): Promise<CrsInfo[]> {
    const found = await Promise.all(srids.map((s) => this.get(s)));
    return found.filter((c): c is CrsInfo => !!c);
  }
}

interface RawCrs {
  srid: number;
  name: string | null;
  kind: string;
  unit: string | null;
  proj4text: string | null;
}

/** EPSG 2D projected / geographic systems only (no geocentric, no
 *  compound/vertical) — the ones a 2D layer can be stored or shown in. */
const NAME = `substring(s.srtext from '^[A-Z_0-9]+\\["([^"]+)"')`;
const SELECT = `
  SELECT s.srid,
         ${NAME} AS name,
         split_part(s.srtext, '[', 1) AS kind,
         substring(s.srtext from 'UNIT\\["([^"]+)"[^\\]]*\\](?!.*UNIT\\[)') AS unit,
         s.proj4text
    FROM spatial_ref_sys s
   WHERE s.auth_name = 'EPSG' AND split_part(s.srtext, '[', 1) IN ('PROJCS', 'GEOGCS')`;

function toInfo(row: RawCrs): CrsInfo {
  const kind = row.kind === 'GEOGCS' ? 'geographic' : 'projected';
  return {
    code: `EPSG:${row.srid}`,
    srid: Number(row.srid),
    name: row.name ?? `EPSG:${row.srid}`,
    kind,
    unit: kind === 'geographic' ? 'degree' : (row.unit ?? 'metre'),
    proj4: (row.proj4text ?? '').trim(),
  };
}

export function parseSrid(code: string): number | null {
  const match = /^(?:EPSG:)?(\d{4,6})$/i.exec(code.trim());
  return match ? Number(match[1]) : null;
}
