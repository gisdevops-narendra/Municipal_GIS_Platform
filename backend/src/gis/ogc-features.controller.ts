import { BadRequestException, Controller, Get, Header, NotFoundException, Param, Query } from '@nestjs/common';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { GisLayersService } from './gis-layers.service';

const MAX_LIMIT = 10_000;

/**
 * OGC API – Features (Part 1: Core, GeoJSON) for the caller's vector
 * layers, read straight from PostGIS. GeoServer's own OGC API extension is
 * not installed, and this keeps the same per-layer VIEW permission as the
 * rest of the app. Collections are layer ids; geometries are CRS84.
 */
@Controller('gis/ogc')
export class OgcFeaturesController {
  constructor(
    private readonly gisLayers: GisLayersService,
    private readonly prisma: PrismaService,
  ) {}

  @RequireMunicipalityMember()
  @Get()
  landing() {
    return {
      title: 'Municipal GIS – OGC API Features',
      links: [
        { rel: 'conformance', href: 'conformance', type: 'application/json' },
        { rel: 'data', href: 'collections', type: 'application/json' },
      ],
    };
  }

  @RequireMunicipalityMember()
  @Get('conformance')
  conformance() {
    return {
      conformsTo: [
        'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
        'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson',
      ],
    };
  }

  @RequireMunicipalityMember()
  @Get('collections')
  async collections(@CurrentAppUser() appUser: AppUser) {
    const layers = await this.gisLayers.listForMunicipality(appUser);
    return {
      collections: layers.filter((l) => l.layerType === 'VECTOR').map((l) => this.collection(l)),
      links: [],
    };
  }

  @RequireMunicipalityMember()
  @Get('collections/:id')
  async collectionById(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    const layer = await this.gisLayers.getById(appUser, id);
    if (layer.layerType !== 'VECTOR') throw new NotFoundException('No such collection.');
    return this.collection(layer);
  }

  @RequireMunicipalityMember()
  @Get('collections/:id/items')
  @Header('Content-Type', 'application/geo+json')
  async items(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Query('bbox') bbox?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    const { table, from } = await this.gisLayers.vectorSource(appUser, id, 'view');
    const limit = Math.min(Math.max(Number(limitRaw ?? 1000) || 1000, 1), MAX_LIMIT);
    const offset = Math.max(Number(offsetRaw ?? 0) || 0, 0);
    const srid = await this.srid(table);
    const params: number[] = [];
    let where = '';
    if (bbox) {
      const b = bbox.split(',').map(Number);
      if (b.length !== 4 || b.some((n) => !Number.isFinite(n))) {
        throw new BadRequestException('bbox must be minLon,minLat,maxLon,maxLat.');
      }
      params.push(...b);
      where = `WHERE t.geom && ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, 4326), ${srid})`;
    }
    const n = params.length;
    const [rows, matched] = await Promise.all([
      this.prisma.$queryRawUnsafe<{ id: number; geometry: unknown; properties: Record<string, unknown> }[]>(
        `SELECT t.ogc_fid AS id,
                ST_AsGeoJSON(ST_Transform(t.geom, 4326), 7)::json AS geometry,
                to_jsonb(t) - 'geom' - 'ogc_fid' - 'gis_workspace_id' AS properties
           FROM ${from} t ${where}
          ORDER BY t.ogc_fid
          LIMIT $${n + 1} OFFSET $${n + 2}`,
        ...params,
        limit,
        offset,
      ),
      this.prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${from} t ${where}`, ...params),
    ]);
    const numberMatched = Number(matched[0]?.n ?? 0);
    const query = (o: number) =>
      `items?limit=${limit}&offset=${o}${bbox ? `&bbox=${encodeURIComponent(bbox)}` : ''}`;
    return {
      type: 'FeatureCollection',
      numberMatched,
      numberReturned: rows.length,
      timeStamp: new Date().toISOString(),
      features: rows.map((r) => ({ type: 'Feature', id: r.id, geometry: r.geometry, properties: r.properties })),
      links: [
        { rel: 'self', href: query(offset), type: 'application/geo+json' },
        ...(offset + rows.length < numberMatched
          ? [{ rel: 'next', href: query(offset + limit), type: 'application/geo+json' }]
          : []),
      ],
    };
  }

  @RequireMunicipalityMember()
  @Get('collections/:id/items/:fid')
  @Header('Content-Type', 'application/geo+json')
  async item(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Param('fid') fid: string) {
    const { from } = await this.gisLayers.vectorSource(appUser, id, 'view');
    const fidNum = Number(fid);
    if (!Number.isInteger(fidNum)) throw new NotFoundException('No such feature.');
    const rows = await this.prisma.$queryRawUnsafe<{ id: number; geometry: unknown; properties: Record<string, unknown> }[]>(
      `SELECT t.ogc_fid AS id,
              ST_AsGeoJSON(ST_Transform(t.geom, 4326), 7)::json AS geometry,
              to_jsonb(t) - 'geom' - 'ogc_fid' - 'gis_workspace_id' AS properties
         FROM ${from} t WHERE t.ogc_fid = $1`,
      fidNum,
    );
    if (!rows[0]) throw new NotFoundException('No such feature.');
    return { type: 'Feature', id: rows[0].id, geometry: rows[0].geometry, properties: rows[0].properties };
  }

  private collection(l: { id: string; name: string; description: string | null; bbox: { minX: number; minY: number; maxX: number; maxY: number } | null }) {
    return {
      id: l.id,
      title: l.name,
      description: l.description ?? undefined,
      itemType: 'feature',
      crs: ['http://www.opengis.net/def/crs/OGC/1.3/CRS84'],
      extent: l.bbox ? { spatial: { bbox: [[l.bbox.minX, l.bbox.minY, l.bbox.maxX, l.bbox.maxY]] } } : undefined,
      links: [{ rel: 'items', href: `collections/${l.id}/items`, type: 'application/geo+json' }],
    };
  }

  private async srid(table: string): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<{ srid: number }[]>(
      `SELECT Find_SRID('public', $1, 'geom') AS srid`,
      table,
    );
    return rows[0]?.srid || 4326;
  }
}
