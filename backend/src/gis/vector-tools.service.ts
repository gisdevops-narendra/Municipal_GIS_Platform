import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GisGeometryType, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';
import { ModuleAccessService } from '../module-access/module-access.service';
import { GisLayersService } from './gis-layers.service';
import { RasterService } from './raster.service';
import { GisAuthorizationService } from './gis-authorization.service';
import type { CreateBlankLayerDto, GeoprocessDto } from './dto/vector-tools.dto';

/** Module Access catalog ids (seed-modules.ts). */
export const EDIT_PANEL_MODULE_ID = 55;
export const DRAW_MODULE_ID = 32;
export const EDIT_HISTORY_MODULE_ID = 1001;
export const GEOPROCESSING_MODULE_ID = 1002;
/** Sub-modules of Geoprocessing for the tools added later (seed-modules.ts). */
const GEOPROCESS_GROUP_MODULE: Record<string, [number, string]> = {
  symdifference: [1031, 'Advanced Overlay'], merge: [1031, 'Advanced Overlay'],
  nearest: [1032, 'Proximity Analysis'], selectbylocation: [1032, 'Proximity Analysis'], voronoi: [1032, 'Proximity Analysis'],
  centroids: [1033, 'Geometry Tools'], convexhull: [1033, 'Geometry Tools'], envelope: [1033, 'Geometry Tools'], simplify: [1033, 'Geometry Tools'],
  explode: [1033, 'Geometry Tools'], polygonstolines: [1033, 'Geometry Tools'], linestopolygons: [1033, 'Geometry Tools'], pointsalonglines: [1033, 'Geometry Tools'],
  squaregrid: [1034, 'Grid Analysis'], hexgrid: [1034, 'Grid Analysis'],
};
export const IMPACT_REPORT_MODULE_ID = 1003;
export const ATTACHMENTS_MODULE_ID = 1005;
export const PARCEL_TOOLS_MODULE_ID = 1006;

/** Per-field attribute domain / validation (GISLayer.fieldRules). */
export interface FieldRule {
  required?: boolean;
  values?: string[];
  min?: number;
  max?: number;
}
export type FieldRules = Record<string, FieldRule>;

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_TYPES = /^(image\/(jpeg|png|webp|gif|heic)|application\/pdf|text\/plain|application\/(msword|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.ms-excel))$/;

const MAX_BUFFER_METRES = 50_000;
const MAX_IMPACT_ROWS = 20_000;
const HISTORY_LIMIT = 200;

/** Columns never shown as / written to feature attributes. */
const INTERNAL_COLUMNS = new Set(['geom', 'ogc_fid', 'gis_workspace_id']);

const DIMENSION: Record<GisGeometryType, number> = { POINT: 1, LINE: 2, POLYGON: 3 };
const BY_DIMENSION: GisGeometryType[] = ['POINT', 'POINT', 'LINE', 'POLYGON'];
const MULTI_TYPE: Record<GisGeometryType, string> = {
  POINT: 'MultiPoint',
  LINE: 'MultiLineString',
  POLYGON: 'MultiPolygon',
};

/** Field types offered when creating a layer → PostgreSQL column types
 *  (the Edit panel already maps these back to number / date / boolean
 *  inputs). */
const BLANK_COLUMN_TYPE: Record<string, string> = {
  text: 'text',
  integer: 'integer',
  decimal: 'double precision',
  date: 'date',
  boolean: 'boolean',
};
/** Columns the platform manages itself. */
const RESERVED_FIELDS = new Set(['geom', 'ogc_fid', 'fid', 'gis_workspace_id']);

export interface Column {
  name: string;
  dataType: string;
}

export interface EditableFeature {
  id: number;
  geometry: Record<string, unknown> | null;
  properties: Record<string, unknown>;
}

type Source = Awaited<ReturnType<GisLayersService['vectorSource']>>;

/** Double-quotes a column name taken from information_schema. */
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/**
 * Vector Feature Editing (+ its audit trail), Geoprocessing that publishes
 * new layers, and the buffer Impact Report — all straight in PostGIS.
 *
 * Table names only ever come from `GisLayersService.vectorSource` (an
 * application-generated `layer_<uuid>` or a fixed demo table); column
 * names only from `information_schema`; every user value is a bind
 * parameter.
 */
@Injectable()
export class VectorToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gisLayers: GisLayersService,
    private readonly gisAuth: GisAuthorizationService,
    private readonly raster: RasterService,
    private readonly moduleAccess: ModuleAccessService,
    private readonly config: ConfigService,
  ) {}

  // ----- New layer (Draw & Mark) -----

  /** Creates an empty, editable vector layer — `ogc_fid` key, the user's
   *  fields, a Multi* `geom` in the chosen CRS — and publishes it. */
  async createBlankLayer(appUser: AppUser, dto: CreateBlankLayerDto) {
    await this.requireModule(appUser, DRAW_MODULE_ID, 'Draw');
    const names = new Set<string>();
    const columns = dto.fields.map((f) => {
      const name = f.name.trim().toLowerCase();
      if (RESERVED_FIELDS.has(name)) {
        throw new BadRequestException(`"${name}" is reserved — choose another field name.`);
      }
      if (names.has(name)) throw new BadRequestException(`The field "${name}" is listed twice.`);
      names.add(name);
      return `${q(name)} ${BLANK_COLUMN_TYPE[f.type]}`;
    });

    const output = await this.raster.prepareVectorOutput(appUser, dto.name.trim());
    const srid = this.workspaceSrid(dto.crs ?? output.workspace.defaultCrs);
    const [known] = await this.prisma.$queryRawUnsafe<{ ok: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM spatial_ref_sys WHERE srid = $1) AS ok`,
      srid,
    );
    if (!known?.ok) throw new BadRequestException(`EPSG:${srid} is not a known coordinate system.`);

    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE "${output.table}" (
         ogc_fid SERIAL PRIMARY KEY,
         ${columns.map((c) => `${c},`).join('\n         ')}
         geom geometry(${MULTI_TYPE[dto.geometryType]}, ${srid})
       )`,
    );
    const layer = await this.raster.publishVectorTable(appUser, output, {
      name: dto.name.trim(),
      geometryType: dto.geometryType,
      description: 'Created with Draw & Mark',
      rasterAnalysis: false,
      srs: `EPSG:${srid}`,
    });
    // GeoServer reports a degenerate extent for an empty table — keep none
    // until the first feature is saved (see createFeature). Flag it as a
    // Draw & Mark layer.
    await this.prisma.gISLayer.update({
      where: { id: layer.id },
      data: { bboxMinX: null, bboxMinY: null, bboxMaxX: null, bboxMaxY: null, drawnLayer: true },
    });
    return { ...layer, bbox: null, drawnLayer: true };
  }

  // ----- Feature Editing -----

  async editSchema(appUser: AppUser, layerId: string) {
    await this.requireModule(appUser, EDIT_PANEL_MODULE_ID, 'Edit Panel');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    const columns = await this.columns(source.table);
    return {
      layerId,
      geometryType: source.layer.geometryType,
      fields: columns.map((c) => ({ name: c.name, type: c.dataType })),
      rules: (source.layer.fieldRules as FieldRules | null) ?? {},
    };
  }

  /** The feature nearest a clicked point, within `toleranceM` metres. */
  async featureAt(
    appUser: AppUser,
    layerId: string,
    lon: number,
    lat: number,
    toleranceM: number,
  ): Promise<EditableFeature | null> {
    await this.requireModule(appUser, EDIT_PANEL_MODULE_ID, 'Edit Panel');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    const srid = await this.srid(source.table);
    const tolerance = Math.min(Math.max(toleranceM, 0.5), 500);
    const rows = await this.prisma.$queryRawUnsafe<EditableFeature[]>(
      `WITH p AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS g),
            z AS (SELECT ST_Transform(ST_Buffer(p.g::geography, $3)::geometry, ${srid}) AS env,
                         ST_Transform(p.g, ${srid}) AS pt FROM p)
       SELECT t.ogc_fid AS id,
              ST_AsGeoJSON(ST_Transform(t.geom, 4326))::json AS geometry,
              to_jsonb(t) - 'geom' - 'ogc_fid' AS properties
         FROM "${source.table}" t, z
        WHERE t.geom && z.env AND ST_Intersects(t.geom, z.env)
        ORDER BY ST_Distance(t.geom, z.pt)
        LIMIT 1`,
      lon,
      lat,
      tolerance,
    );
    return rows[0] ?? null;
  }

  async createFeature(
    appUser: AppUser,
    layerId: string,
    geometry: Record<string, unknown>,
    properties: Record<string, unknown> = {},
  ) {
    await this.requireModule(appUser, EDIT_PANEL_MODULE_ID, 'Edit Panel');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    const columns = await this.columns(source.table);
    this.checkRules(source.layer.fieldRules as FieldRules | null, properties, true);
    const { names, exprs, params } = this.attributeParams(columns, properties, 2);
    const geomExpr = await this.geometryInput(source.table, '$1');
    const userName = await this.userName(appUser);
    return this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRawUnsafe<{ id: number }[]>(
        `INSERT INTO "${source.table}" (geom${names.map((n) => `, ${q(n)}`).join('')})
         VALUES (${geomExpr}${exprs.map((e) => `, ${e}`).join('')})
         RETURNING ogc_fid AS id`,
        JSON.stringify(geometry),
        ...params,
      );
      const feature = await this.readFeature(tx, source.table, row.id);
      await this.recordHistory(tx, appUser, userName, layerId, row.id, 'INSERT', null, feature);
      // A layer created empty has no extent yet — take it from its first feature.
      if (source.layer.bboxMinX === null) {
        await tx.$executeRawUnsafe(
          `UPDATE gis_layers SET bbox_min_x = ST_XMin(e), bbox_min_y = ST_YMin(e),
                  bbox_max_x = ST_XMax(e), bbox_max_y = ST_YMax(e)
             FROM (SELECT ST_Transform(ST_SetSRID(ST_Extent(geom)::geometry,
                                  Find_SRID('public', '${source.table}', 'geom')), 4326) AS e
                     FROM "${source.table}") x
            WHERE id = $1 AND e IS NOT NULL`,
          layerId,
        );
      }
      return feature;
    });
  }

  async updateFeature(
    appUser: AppUser,
    layerId: string,
    featureId: number,
    geometry: Record<string, unknown> | undefined,
    properties: Record<string, unknown> | undefined,
  ) {
    await this.requireModule(appUser, EDIT_PANEL_MODULE_ID, 'Edit Panel');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    const columns = await this.columns(source.table);
    const sets: string[] = [];
    const params: unknown[] = [featureId];
    if (geometry) {
      params.push(JSON.stringify(geometry));
      sets.push(`geom = ${await this.geometryInput(source.table, `$${params.length}`)}`);
    }
    this.checkRules(source.layer.fieldRules as FieldRules | null, properties ?? {}, false);
    const attrs = this.attributeParams(columns, properties ?? {}, params.length + 1);
    attrs.names.forEach((n, i) => sets.push(`${q(n)} = ${attrs.exprs[i]}`));
    params.push(...attrs.params);
    if (!sets.length) throw new BadRequestException('Nothing to update.');
    const userName = await this.userName(appUser);
    return this.prisma.$transaction(async (tx) => {
      const before = await this.readFeature(tx, source.table, featureId);
      await tx.$executeRawUnsafe(
        `UPDATE "${source.table}" SET ${sets.join(', ')} WHERE ogc_fid = $1`,
        ...params,
      );
      const after = await this.readFeature(tx, source.table, featureId);
      await this.recordHistory(tx, appUser, userName, layerId, featureId, 'UPDATE', before, after);
      return after;
    });
  }

  async deleteFeature(appUser: AppUser, layerId: string, featureId: number) {
    await this.requireModule(appUser, EDIT_PANEL_MODULE_ID, 'Edit Panel');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    const userName = await this.userName(appUser);
    await this.prisma.$transaction(async (tx) => {
      const before = await this.readFeature(tx, source.table, featureId);
      await tx.$executeRawUnsafe(`DELETE FROM "${source.table}" WHERE ogc_fid = $1`, featureId);
      await this.recordHistory(tx, appUser, userName, layerId, featureId, 'DELETE', before, null);
    });
    await this.removeAttachments(appUser, layerId, featureId);
    return { success: true as const };
  }

  // ----- Edit history -----

  async history(appUser: AppUser, layerId: string, featureId?: number) {
    await this.requireModule(appUser, EDIT_HISTORY_MODULE_ID, 'Edit History');
    await this.gisLayers.vectorSource(appUser, layerId, 'view');
    return this.prisma.gISFeatureHistory.findMany({
      where: { layerId, ...(featureId !== undefined ? { featureId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
    });
  }

  // ----- Geoprocessing -----

  async geoprocess(appUser: AppUser, dto: GeoprocessDto) {
    await this.requireModule(appUser, GEOPROCESSING_MODULE_ID, 'Geoprocessing');
    const group = GEOPROCESS_GROUP_MODULE[dto.operation];
    if (group) await this.requireModule(appUser, group[0], group[1]);
    const a = await this.gisLayers.vectorSource(appUser, dto.inputLayerId, 'view');
    const needsB = ['intersect', 'clip', 'erase', 'join', 'merge', 'symdifference', 'nearest', 'selectbylocation'].includes(dto.operation);
    const b = needsB
      ? await this.gisLayers.vectorSource(appUser, this.required(dto.overlayLayerId, 'Choose the overlay layer.'), 'view')
      : null;
    if (b && ['clip', 'erase'].includes(dto.operation) && b.layer.geometryType !== 'POLYGON') {
      throw new BadRequestException('The clip / erase layer must be a polygon layer.');
    }

    const output = await this.raster.prepareVectorOutput(appUser, dto.outputName, dto.departmentId);
    const srid = this.workspaceSrid(output.workspace.defaultCrs);
    const { select, geometryType, description } = await this.buildGeoprocessSql(dto, a, b, srid);

    const geomType = `geometry(${MULTI_TYPE[geometryType]}, ${srid})`;
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE "${output.table}" AS
         SELECT r.*, ST_Multi(ST_CollectionExtract(r.g, ${DIMENSION[geometryType]}))::${geomType} AS geom
           FROM (${select}) r
          WHERE r.g IS NOT NULL AND NOT ST_IsEmpty(ST_CollectionExtract(r.g, ${DIMENSION[geometryType]}))`,
    );
    await this.prisma.$executeRawUnsafe(`ALTER TABLE "${output.table}" DROP COLUMN g`);
    await this.prisma.$executeRawUnsafe(
      `ALTER TABLE "${output.table}" ADD COLUMN ogc_fid SERIAL PRIMARY KEY`,
    );
    const [{ n }] = await this.prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "${output.table}"`,
    );
    if (n === 0) {
      await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${output.table}"`);
      throw new BadRequestException('The operation produced no features.');
    }
    return this.raster.publishVectorTable(appUser, output, {
      name: dto.outputName,
      geometryType,
      description,
      rasterAnalysis: false,
    });
  }

  private async buildGeoprocessSql(
    dto: GeoprocessDto,
    a: Source,
    b: Source | null,
    srid: number,
  ): Promise<{ select: string; geometryType: GisGeometryType; description: string }> {
    const aType = this.geometryTypeOf(a);
    const ga = await this.geomIn('a', a.table, srid);
    const used = new Set<string>(['g', 'geom', 'ogc_fid']);
    const aCols = this.outputColumns(await this.columns(a.table), 'a', '', used);

    switch (dto.operation) {
      case 'buffer': {
        const d = dto.distance ?? 0;
        if (!(d > 0 && d <= MAX_BUFFER_METRES)) {
          throw new BadRequestException(`Buffer distance must be between 0 and ${MAX_BUFFER_METRES} m.`);
        }
        const buffered = (await this.isMetric(srid))
          ? `ST_Buffer(${ga}, ${d})`
          : `ST_Transform(ST_Buffer(ST_Transform(${ga}, 4326)::geography, ${d})::geometry, ${srid})`;
        return {
          select: dto.dissolve
            ? `SELECT ST_Union(${buffered}) AS g FROM ${a.from} a`
            : `SELECT ${this.list(aCols)}${buffered} AS g FROM ${a.from} a`,
          geometryType: 'POLYGON',
          description: `${d} m buffer of ${a.layer.name}${dto.dissolve ? ' (dissolved)' : ''}`,
        };
      }
      case 'dissolve': {
        const field = dto.dissolveField
          ? (await this.columns(a.table)).find((c) => c.name === dto.dissolveField)
          : undefined;
        if (dto.dissolveField && !field) throw new BadRequestException('Unknown dissolve field.');
        const key = field ? `a.${q(field.name)}` : null;
        return {
          select:
            `SELECT ${key ? `${key} AS ${q(field!.name)}, ` : ''}count(*)::int AS feature_count, ` +
            `ST_Union(${this.valid(ga, aType)}) AS g FROM ${a.from} a${key ? ` GROUP BY ${key}` : ''}`,
          geometryType: aType,
          description: `${a.layer.name} dissolved${field ? ` by ${field.name}` : ''}`,
        };
      }
      case 'intersect': {
        const bType = this.geometryTypeOf(b!);
        const gb = await this.geomIn('b', b!.table, srid);
        const bCols = this.outputColumns(await this.columns(b!.table), 'b', 'b_', used);
        return {
          select:
            `SELECT ${this.list(aCols)}${this.list(bCols)}` +
            `ST_Intersection(${this.valid(ga, aType)}, ${this.valid(gb, bType)}) AS g ` +
            `FROM ${a.from} a JOIN ${b!.from} b ON ST_Intersects(${ga}, ${gb})`,
          geometryType: BY_DIMENSION[Math.min(DIMENSION[aType], DIMENSION[bType])],
          description: `${a.layer.name} ∩ ${b!.layer.name}`,
        };
      }
      case 'clip':
      case 'erase': {
        const gb = await this.geomIn('b', b!.table, srid);
        const mask = `(SELECT ST_Union(${this.valid(gb, 'POLYGON')}) AS m FROM ${b!.from} b)`;
        const geom =
          dto.operation === 'clip'
            ? `ST_Intersection(${this.valid(ga, aType)}, mk.m)`
            : `CASE WHEN mk.m IS NULL OR NOT ST_Intersects(${ga}, mk.m) THEN ${ga} ` +
              `ELSE ST_Difference(${this.valid(ga, aType)}, mk.m) END`;
        return {
          select:
            `SELECT ${this.list(aCols)}${geom} AS g FROM ${a.from} a CROSS JOIN ${mask} mk` +
            (dto.operation === 'clip' ? ` WHERE ST_Intersects(${ga}, mk.m)` : ''),
          geometryType: aType,
          description: `${a.layer.name} ${dto.operation === 'clip' ? 'clipped to' : 'erased by'} ${b!.layer.name}`,
        };
      }
      case 'join': {
        const gb = await this.geomIn('b', b!.table, srid);
        if (dto.joinMode === 'count') {
          const countCol = this.unique('join_count', used);
          return {
            select:
              `SELECT ${this.list(aCols)}(SELECT count(*)::int FROM ${b!.from} b WHERE ST_Intersects(${ga}, ${gb})) ` +
              `AS ${q(countCol)}, ${ga} AS g FROM ${a.from} a`,
            geometryType: aType,
            description: `${a.layer.name} with count of intersecting ${b!.layer.name}`,
          };
        }
        const bCols = this.outputColumns(await this.columns(b!.table), 'j', 'b_', used);
        const inner = (await this.columns(b!.table)).map((c) => `b.${q(c.name)}`).join(', ');
        return {
          select:
            `SELECT ${this.list(aCols)}${this.list(bCols)}${ga} AS g FROM ${a.from} a ` +
            `LEFT JOIN LATERAL (SELECT ${inner || '1 AS _x'} FROM ${b!.from} b ` +
            `WHERE ST_Intersects(${ga}, ${gb}) LIMIT 1) j ON true`,
          geometryType: aType,
          description: `${a.layer.name} joined with attributes of ${b!.layer.name}`,
        };
      }
      // ----- one layer -----
      case 'centroids':
        return {
          select: `SELECT ${this.list(aCols)}ST_PointOnSurface(${this.valid(ga, aType)}) AS g FROM ${a.from} a`,
          geometryType: 'POINT',
          description: `Points inside the features of ${a.layer.name}`,
        };
      case 'convexhull':
        return {
          select: `SELECT count(*)::int AS feature_count, ST_ConvexHull(ST_Collect(${ga})) AS g FROM ${a.from} a`,
          geometryType: 'POLYGON',
          description: `Convex hull of ${a.layer.name}`,
        };
      case 'envelope':
        return {
          select: `SELECT ${this.list(aCols)}ST_Envelope(${ga}) AS g FROM ${a.from} a`,
          geometryType: 'POLYGON',
          description: `Bounding boxes of ${a.layer.name}`,
        };
      case 'simplify': {
        const tol = this.metres(dto.distance, 'Simplify tolerance');
        const [toM, fromM] = await this.metricWrap(srid);
        return {
          select: `SELECT ${this.list(aCols)}${fromM(`ST_SimplifyPreserveTopology(${toM(ga)}, ${tol})`)} AS g FROM ${a.from} a`,
          geometryType: aType,
          description: `${a.layer.name} simplified (${tol} m)`,
        };
      }
      case 'explode':
        return {
          select: `SELECT ${this.list(aCols)}(ST_Dump(${ga})).geom AS g FROM ${a.from} a`,
          geometryType: aType,
          description: `${a.layer.name} split into single parts`,
        };
      case 'polygonstolines':
        this.requireType(aType, 'POLYGON', 'Polygons → Lines');
        return {
          select: `SELECT ${this.list(aCols)}ST_Boundary(${this.valid(ga, aType)}) AS g FROM ${a.from} a`,
          geometryType: 'LINE',
          description: `Outlines of ${a.layer.name}`,
        };
      case 'linestopolygons':
        this.requireType(aType, 'LINE', 'Lines → Polygons');
        return {
          select: `SELECT ${this.list(aCols)}ST_BuildArea(ST_Node(${ga})) AS g FROM ${a.from} a`,
          geometryType: 'POLYGON',
          description: `Polygons from the closed lines of ${a.layer.name}`,
        };
      case 'pointsalonglines': {
        this.requireType(aType, 'LINE', 'Points Along Lines');
        const step = this.metres(dto.distance, 'Point spacing');
        const [toM, fromM] = await this.metricWrap(srid);
        return {
          select:
            `SELECT ${this.list(aCols)}${fromM('(ST_DumpPoints(ST_Segmentize(' + toM(ga) + `, ${step}))).geom`)} AS g FROM ${a.from} a`,
          geometryType: 'POINT',
          description: `Points every ${step} m along ${a.layer.name}`,
        };
      }
      case 'voronoi': {
        this.requireType(aType, 'POINT', 'Voronoi');
        // Cells clipped to the points' extent (grown 10 %), each carrying the
        // attributes of the point it belongs to.
        return {
          select:
            `WITH pts AS (SELECT ST_Collect(${ga}) AS c FROM ${a.from} a), ` +
            `cells AS (SELECT (ST_Dump(ST_VoronoiPolygons(c, 0, ST_Expand(ST_Envelope(c), GREATEST(ST_XMax(c) - ST_XMin(c), ST_YMax(c) - ST_YMin(c)) * 0.1)))).geom AS cell FROM pts) ` +
            `SELECT ${this.list(aCols)}cells.cell AS g FROM cells JOIN ${a.from} a ON ST_Intersects(cells.cell, ${ga})`,
          geometryType: 'POLYGON',
          description: `Voronoi (Thiessen) polygons of ${a.layer.name}`,
        };
      }
      case 'squaregrid':
      case 'hexgrid': {
        const size = this.metres(dto.distance, 'Cell size');
        const [toM, fromM] = await this.metricWrap(srid);
        const fn = dto.operation === 'squaregrid' ? 'ST_SquareGrid' : 'ST_HexagonGrid';
        const ext = `(SELECT ST_Extent(${toM(ga)})::geometry AS e FROM ${a.from} a)`;
        return {
          select:
            `SELECT cell.i AS col, cell.j AS row, ` +
            `(SELECT count(*)::int FROM ${a.from} a WHERE ST_Intersects(${toM(ga)}, cell.geom)) AS feature_count, ` +
            `${fromM('cell.geom')} AS g FROM ${ext} x, ${fn}(${size}, x.e) cell`,
          geometryType: 'POLYGON',
          description: `${size} m ${dto.operation === 'squaregrid' ? 'square' : 'hexagon'} grid over ${a.layer.name}`,
        };
      }
      // ----- two layers -----
      case 'merge': {
        const bType = this.geometryTypeOf(b!);
        if (bType !== aType) throw new BadRequestException('Merge needs two layers of the same geometry type.');
        const gb = await this.geomIn('b', b!.table, srid);
        const bNames = new Set((await this.columns(b!.table)).map((c) => c.name));
        const shared = (await this.columns(a.table)).filter((c) => bNames.has(c.name) && !['geom', 'ogc_fid'].includes(c.name));
        const cols = shared.map((c) => q(c.name));
        const pick = (alias: string) => shared.map((c) => `${alias}.${q(c.name)}::text AS ${q(c.name)}`).join(', ');
        return {
          select:
            `SELECT ${cols.length ? pick('a') + ', ' : ''}${this.lit(a.layer.name)} AS source_layer, ${ga} AS g FROM ${a.from} a ` +
            `UNION ALL SELECT ${cols.length ? pick('b') + ', ' : ''}${this.lit(b!.layer.name)} AS source_layer, ${gb} AS g FROM ${b!.from} b`,
          geometryType: aType,
          description: `${a.layer.name} + ${b!.layer.name}`,
        };
      }
      case 'symdifference': {
        const bType = this.geometryTypeOf(b!);
        const gb = await this.geomIn('b', b!.table, srid);
        const ua = `(SELECT ST_Union(${this.valid(ga, aType)}) FROM ${a.from} a)`;
        const ub = `(SELECT ST_Union(${this.valid(gb, bType)}) FROM ${b!.from} b)`;
        return {
          select:
            `SELECT ${this.lit(a.layer.name)} AS source_layer, ST_Difference(${ua}, ${ub}) AS g ` +
            `UNION ALL SELECT ${this.lit(b!.layer.name)} AS source_layer, ST_Difference(${ub}, ${ua}) AS g`,
          geometryType: BY_DIMENSION[Math.max(DIMENSION[aType], DIMENSION[bType])],
          description: `Parts of ${a.layer.name} and ${b!.layer.name} that do not overlap`,
        };
      }
      case 'nearest': {
        const gb = await this.geomIn('b', b!.table, srid);
        const bCols = this.outputColumns(await this.columns(b!.table), 'n', 'near_', used);
        const inner = (await this.columns(b!.table)).map((c) => `b.${q(c.name)}`).join(', ');
        const distCol = this.unique('distance_m', used);
        return {
          select:
            `SELECT ${this.list(aCols)}${this.list(bCols)}round(ST_Distance(ST_Transform(${ga}, 4326)::geography, ST_Transform(n._g, 4326)::geography)::numeric, 1)::float8 AS ${q(distCol)}, ${ga} AS g ` +
            `FROM ${a.from} a LEFT JOIN LATERAL (SELECT ${inner ? inner + ', ' : ''}${gb} AS _g FROM ${b!.from} b ORDER BY ${gb} <-> ${ga} LIMIT 1) n ON true`,
          geometryType: aType,
          description: `${a.layer.name} with its nearest ${b!.layer.name}`,
        };
      }
      case 'selectbylocation': {
        const d = dto.distance ?? 0;
        if (!(d >= 0 && d <= MAX_BUFFER_METRES)) throw new BadRequestException(`Distance must be between 0 and ${MAX_BUFFER_METRES} m.`);
        const gb = await this.geomIn('b', b!.table, srid);
        // A cheap planar pre-filter (metres, or ~degrees for a geographic CRS
        // with a safe margin) before the exact geodesic distance.
        const rough = (await this.isMetric(srid)) ? d * 1.05 : d / 80_000;
        const near = d > 0
          ? `ST_DWithin(${ga}, ${gb}, ${rough}) AND ST_DWithin(ST_Transform(${ga}, 4326)::geography, ST_Transform(${gb}, 4326)::geography, ${d})`
          : `ST_Intersects(${ga}, ${gb})`;
        return {
          select: `SELECT ${this.list(aCols)}${ga} AS g FROM ${a.from} a WHERE EXISTS (SELECT 1 FROM ${b!.from} b WHERE ${near})`,
          geometryType: aType,
          description: `${a.layer.name} ${d > 0 ? `within ${d} m of` : 'intersecting'} ${b!.layer.name}`,
        };
      }
    }
  }

  // ----- Impact report -----

  /** Every feature of a layer within `distance` m of a GeoJSON (EPSG:4326)
   *  geometry, as CSV — attributes, distance and a representative point. */
  async impactCsv(
    appUser: AppUser,
    layerId: string,
    geometry: Record<string, unknown>,
    distance = 0,
  ): Promise<{ filename: string; body: string; count: number }> {
    await this.requireModule(appUser, IMPACT_REPORT_MODULE_ID, 'Impact Report');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'view');
    if (!(await this.gisAuth.canExport(appUser, source.layer))) {
      throw new ForbiddenException('You do not have permission to export this layer.');
    }
    if (!(distance >= 0 && distance <= MAX_BUFFER_METRES)) {
      throw new BadRequestException(`Distance must be between 0 and ${MAX_BUFFER_METRES} m.`);
    }
    const srid = await this.srid(source.table);
    const rows = await this.prisma.$queryRawUnsafe<
      { properties: Record<string, unknown>; distance_m: number; lon: number; lat: number }[]
    >(
      `WITH s AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g),
            z AS (SELECT s.g,
                         ST_Transform(CASE WHEN $2::float8 > 0
                                           THEN ST_Buffer(s.g::geography, $2::float8)::geometry
                                           ELSE s.g END, ${srid}) AS zone FROM s)
       SELECT to_jsonb(t) - 'geom' - 'ogc_fid' - 'gis_workspace_id' AS properties,
              round(ST_Distance(ST_Transform(t.geom, 4326)::geography, z.g::geography)::numeric, 2)::float8 AS distance_m,
              ST_X(ST_Transform(ST_PointOnSurface(t.geom), 4326)) AS lon,
              ST_Y(ST_Transform(ST_PointOnSurface(t.geom), 4326)) AS lat
         FROM ${source.from} t, z
        WHERE t.geom && z.zone AND ST_Intersects(t.geom, z.zone)
        ORDER BY distance_m
        LIMIT ${MAX_IMPACT_ROWS}`,
      JSON.stringify(geometry),
      distance,
    );
    const fields = (await this.columns(source.table)).map((c) => c.name);
    const header = [...fields, 'distance_m', 'longitude', 'latitude'];
    const lines = [header.map(this.csvCell).join(',')];
    for (const row of rows) {
      lines.push(
        [...fields.map((f) => row.properties[f]), row.distance_m, row.lon, row.lat]
          .map(this.csvCell)
          .join(','),
      );
    }
    return {
      filename: `${source.layer.code.toLowerCase()}_impact.csv`,
      body: '\uFEFF' + lines.join('\r\n'),
      count: rows.length,
    };
  }

  // ----- Parcel tools: split / merge -----

  /** Cuts a polygon (or line) feature with a drawn line: the first piece
   *  keeps the feature, the others become new features with its attributes. */
  async splitFeature(appUser: AppUser, layerId: string, featureId: number, line: Record<string, unknown>) {
    await this.requireModule(appUser, PARCEL_TOOLS_MODULE_ID, 'Parcel Tools');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    const type = this.geometryTypeOf(source);
    if (type === 'POINT') throw new BadRequestException('Points cannot be split.');
    const srid = await this.srid(source.table);
    const columns = await this.columns(source.table);
    const userName = await this.userName(appUser);
    return this.prisma.$transaction(async (tx) => {
      const before = await this.readFeature(tx, source.table, featureId);
      const parts = await tx.$queryRawUnsafe<{ ewkt: string }[]>(
        `SELECT ST_AsEWKT(p.geom) AS ewkt FROM (
           SELECT (ST_Dump(ST_CollectionExtract(ST_Split(${type === 'POLYGON' ? 'ST_MakeValid(t.geom)' : 't.geom'},
                   ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), ${srid})), ${DIMENSION[type]}))).geom
             FROM "${source.table}" t WHERE t.ogc_fid = $1) p`,
        featureId,
        JSON.stringify(line),
      );
      if (parts.length < 2) {
        throw new BadRequestException('Draw the line right across the feature so it splits into pieces.');
      }
      const geom = await this.geometryEwkt(source.table, '$2');
      await tx.$executeRawUnsafe(`UPDATE "${source.table}" SET geom = ${geom} WHERE ogc_fid = $1`, featureId, parts[0].ewkt);
      const after = await this.readFeature(tx, source.table, featureId);
      await this.recordHistory(tx, appUser, userName, layerId, featureId, 'UPDATE', before, after);
      const cols = columns.map((c) => q(c.name));
      const created: EditableFeature[] = [after];
      for (const part of parts.slice(1)) {
        const [row] = await tx.$queryRawUnsafe<{ id: number }[]>(
          `INSERT INTO "${source.table}" (geom${cols.map((c) => `, ${c}`).join('')})
           SELECT ${geom}${cols.map((c) => `, ${c}`).join('')} FROM "${source.table}" WHERE ogc_fid = $1
           RETURNING ogc_fid AS id`,
          featureId,
          part.ewkt,
        );
        const feature = await this.readFeature(tx, source.table, row.id);
        await this.recordHistory(tx, appUser, userName, layerId, row.id, 'INSERT', null, feature);
        created.push(feature);
      }
      return { features: created };
    });
  }

  /** Unions several features into `keepId` (its attributes win) and
   *  deletes the rest. */
  async mergeFeatures(appUser: AppUser, layerId: string, featureIds: number[], keepId: number) {
    await this.requireModule(appUser, PARCEL_TOOLS_MODULE_ID, 'Parcel Tools');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    const type = this.geometryTypeOf(source);
    const ids = [...new Set([keepId, ...featureIds])];
    if (ids.length < 2) throw new BadRequestException('Select at least two features to merge.');
    const userName = await this.userName(appUser);
    const result = await this.prisma.$transaction(async (tx) => {
      const before = await this.readFeature(tx, source.table, keepId);
      const removed: EditableFeature[] = [];
      for (const id of ids.slice(1)) removed.push(await this.readFeature(tx, source.table, id));
      const [{ ewkt }] = await tx.$queryRawUnsafe<{ ewkt: string }[]>(
        `SELECT ST_AsEWKT(ST_CollectionExtract(ST_Union(${type === 'POLYGON' ? 'ST_MakeValid(geom)' : 'geom'}), ${DIMENSION[type]})) AS ewkt
           FROM "${source.table}" WHERE ogc_fid = ANY($1::int[])`,
        ids,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "${source.table}" SET geom = ${await this.geometryEwkt(source.table, '$2')} WHERE ogc_fid = $1`,
        keepId,
        ewkt,
      );
      await tx.$executeRawUnsafe(`DELETE FROM "${source.table}" WHERE ogc_fid = ANY($1::int[])`, ids.slice(1));
      const after = await this.readFeature(tx, source.table, keepId);
      await this.recordHistory(tx, appUser, userName, layerId, keepId, 'UPDATE', before, after);
      for (const feature of removed) {
        await this.recordHistory(tx, appUser, userName, layerId, feature.id, 'DELETE', feature, null);
      }
      return after;
    });
    for (const id of ids.slice(1)) await this.removeAttachments(appUser, layerId, id);
    return result;
  }

  // ----- Attachments -----

  async listAttachments(appUser: AppUser, layerId: string, featureId: number) {
    await this.requireModule(appUser, ATTACHMENTS_MODULE_ID, 'Attachments');
    await this.gisLayers.vectorSource(appUser, layerId, 'view');
    return this.prisma.gISFeatureAttachment.findMany({
      where: { layerId, featureId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addAttachment(
    appUser: AppUser,
    layerId: string,
    featureId: number,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ) {
    await this.requireModule(appUser, ATTACHMENTS_MODULE_ID, 'Attachments');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    if (file.size > MAX_ATTACHMENT_BYTES) throw new BadRequestException('Attachments are limited to 20 MB.');
    if (!ATTACHMENT_TYPES.test(file.mimetype)) {
      throw new BadRequestException('Attach an image, PDF, text, Word or Excel file.');
    }
    await this.readFeature(this.prisma, source.table, featureId);
    const id = randomUUID();
    const target = this.attachmentPath(appUser.municipalityId, layerId, id);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.buffer);
    return this.prisma.gISFeatureAttachment.create({
      data: {
        id,
        layerId,
        featureId,
        fileName: path.basename(file.originalname).slice(0, 200) || 'file',
        contentType: file.mimetype,
        size: file.size,
        createdById: appUser.id,
      },
    });
  }

  async attachmentFile(appUser: AppUser, layerId: string, attachmentId: string) {
    await this.requireModule(appUser, ATTACHMENTS_MODULE_ID, 'Attachments');
    await this.gisLayers.vectorSource(appUser, layerId, 'view');
    const row = await this.prisma.gISFeatureAttachment.findFirst({ where: { id: attachmentId, layerId } });
    if (!row) throw new NotFoundException('Attachment not found.');
    const body = await readFile(this.attachmentPath(appUser.municipalityId, layerId, row.id)).catch(() => {
      throw new NotFoundException('Attachment file is missing.');
    });
    return { row, body };
  }

  async deleteAttachment(appUser: AppUser, layerId: string, attachmentId: string) {
    await this.requireModule(appUser, ATTACHMENTS_MODULE_ID, 'Attachments');
    await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    const row = await this.prisma.gISFeatureAttachment.findFirst({ where: { id: attachmentId, layerId } });
    if (!row) throw new NotFoundException('Attachment not found.');
    await this.prisma.gISFeatureAttachment.delete({ where: { id: row.id } });
    await rm(this.attachmentPath(appUser.municipalityId, layerId, row.id), { force: true });
    return { success: true as const };
  }

  /** Attachments of a deleted feature — best effort. */
  private async removeAttachments(appUser: AppUser, layerId: string, featureId: number) {
    const rows = await this.prisma.gISFeatureAttachment.findMany({ where: { layerId, featureId } });
    if (!rows.length) return;
    await this.prisma.gISFeatureAttachment.deleteMany({ where: { layerId, featureId } });
    for (const row of rows) {
      await rm(this.attachmentPath(appUser.municipalityId, layerId, row.id), { force: true }).catch(() => undefined);
    }
  }

  /** Directory holding a layer's attachment files (removed with the layer). */
  attachmentDir(municipalityId: string, layerId: string): string {
    const root = path.resolve(this.config.get<string>('GIS_UPLOAD_STORAGE_DIR', './storage/uploads'), '..', 'attachments');
    if (!/^[0-9a-f-]{36}$/.test(municipalityId) || !/^[0-9a-f-]{36}$/.test(layerId)) {
      throw new BadRequestException('Invalid attachment location.');
    }
    return path.join(root, municipalityId, layerId);
  }

  private attachmentPath(municipalityId: string, layerId: string, id: string): string {
    return path.join(this.attachmentDir(municipalityId, layerId), id);
  }

  // ----- Field rules -----

  /** Rejects values outside a field's domain. `full` (a new feature) also
   *  enforces `required` on fields that were not sent at all. */
  checkRules(rules: FieldRules | null, properties: Record<string, unknown>, full: boolean) {
    if (!rules) return;
    const problems: string[] = [];
    for (const [field, rule] of Object.entries(rules)) {
      const sent = Object.hasOwn(properties, field);
      const raw = properties[field];
      const empty = raw === null || raw === undefined || raw === '';
      if (rule.required && empty && (full || sent)) {
        problems.push(`${field} is required.`);
        continue;
      }
      if (empty || !sent) continue;
      const text = String(raw);
      if (rule.values?.length && !rule.values.includes(text)) {
        problems.push(`${field} must be one of: ${rule.values.join(', ')}.`);
      }
      const n = Number(text);
      if (rule.min !== undefined && rule.min !== null && !(n >= rule.min)) problems.push(`${field} must be ≥ ${rule.min}.`);
      if (rule.max !== undefined && rule.max !== null && !(n <= rule.max)) problems.push(`${field} must be ≤ ${rule.max}.`);
    }
    if (problems.length) throw new BadRequestException(problems.join(' '));
  }

  // ----- internals -----

  async requireModule(appUser: AppUser, moduleId: number, label: string) {
    const modules = await this.moduleAccess.getEffectiveModuleIdsForAppUser(appUser);
    if (!modules.has(moduleId)) {
      throw new ForbiddenException(`Your module access does not include ${label}.`);
    }
  }

  private required(value: string | undefined, message: string): string {
    if (!value) throw new BadRequestException(message);
    return value;
  }

  async columns(table: string): Promise<Column[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ column_name: string; data_type: string }[]>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      table,
    );
    return rows
      .filter((r) => !INTERNAL_COLUMNS.has(r.column_name) && r.data_type !== 'USER-DEFINED')
      .map((r) => ({ name: r.column_name, dataType: r.data_type }));
  }

  /** Bind-parameter casts for the given attributes (unknown keys rejected). */
  private attributeParams(columns: Column[], properties: Record<string, unknown>, firstIndex: number) {
    const names: string[] = [];
    const exprs: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(properties)) {
      const column = columns.find((c) => c.name === key);
      if (!column) throw new BadRequestException(`Unknown field "${key}".`);
      names.push(column.name);
      params.push(value === null || value === undefined || value === '' ? null : String(value));
      exprs.push(`CAST($${firstIndex + params.length - 1}::text AS ${column.dataType})`);
    }
    return { names, exprs, params };
  }

  /** SQL turning an EWKT bind parameter (already in the table SRID) into the column's type. */
  private async geometryEwkt(table: string, param: string): Promise<string> {
    const [col] = await this.prisma.$queryRawUnsafe<{ type: string }[]>(
      `SELECT type FROM geometry_columns
        WHERE f_table_schema = 'public' AND f_table_name = $1 AND f_geometry_column = 'geom'`,
      table,
    );
    const g = `ST_GeomFromEWKT(${param})`;
    return col?.type.toUpperCase().startsWith('MULTI') ? `ST_Multi(${g})` : g;
  }

  /** SQL turning a GeoJSON (EPSG:4326) bind parameter into the column's type. */
  async geometryInput(table: string, param: string): Promise<string> {
    const [col] = await this.prisma.$queryRawUnsafe<{ type: string; srid: number }[]>(
      `SELECT type, srid FROM geometry_columns
        WHERE f_table_schema = 'public' AND f_table_name = $1 AND f_geometry_column = 'geom'`,
      table,
    );
    if (!col) throw new BadRequestException('This layer has no editable geometry.');
    const g = `ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(${param}), 4326), ${col.srid})`;
    return col.type.toUpperCase().startsWith('MULTI') ? `ST_Multi(${g})` : g;
  }

  async srid(table: string): Promise<number> {
    const [row] = await this.prisma.$queryRawUnsafe<{ srid: number }[]>(
      `SELECT Find_SRID('public', $1, 'geom') AS srid`,
      table,
    );
    return Number(row.srid);
  }

  /** `alias.geom` in the output SRID (transformed only when it differs). */
  private async geomIn(alias: string, table: string, srid: number): Promise<string> {
    return (await this.srid(table)) === srid ? `${alias}.geom` : `ST_Transform(${alias}.geom, ${srid})`;
  }

  private valid(expr: string, type: GisGeometryType): string {
    return type === 'POLYGON' ? `ST_MakeValid(${expr})` : expr;
  }

  private workspaceSrid(crs: string): number {
    const match = /^EPSG:(\d+)$/i.exec(crs);
    if (!match) throw new BadRequestException(`Unsupported workspace CRS ${crs}.`);
    return Number(match[1]);
  }

  private async isMetric(srid: number): Promise<boolean> {
    const [row] = await this.prisma.$queryRawUnsafe<{ metric: boolean }[]>(
      `SELECT coalesce(proj4text LIKE '%+units=m%', false) AS metric FROM spatial_ref_sys WHERE srid = $1`,
      srid,
    );
    return !!row?.metric;
  }

  private geometryTypeOf(source: Source): GisGeometryType {
    if (!source.layer.geometryType) {
      throw new BadRequestException(`"${source.layer.name}" has no geometry type.`);
    }
    return source.layer.geometryType;
  }

  /** `alias."col" AS "prefix+col"` for each column, de-duplicated. */
  private outputColumns(columns: Column[], alias: string, prefix: string, used: Set<string>): string[] {
    return columns.map((c) => `${alias}.${q(c.name)} AS ${q(this.unique(prefix + c.name, used))}`);
  }

  /** A required distance-like parameter in metres. */
  private metres(value: number | undefined, label: string): number {
    if (!(value !== undefined && value > 0 && value <= MAX_BUFFER_METRES)) {
      throw new BadRequestException(`${label} must be between 0 and ${MAX_BUFFER_METRES} m.`);
    }
    return value;
  }

  /** Wrappers so metre-based ST_ functions work in any CRS: identity in a
   *  metric CRS, otherwise a round trip through Web Mercator. */
  private async metricWrap(srid: number): Promise<[(g: string) => string, (g: string) => string]> {
    if (await this.isMetric(srid)) return [(g) => g, (g) => g];
    return [(g) => `ST_Transform(${g}, 3857)`, (g) => `ST_Transform(${g}, ${srid})`];
  }

  private requireType(actual: GisGeometryType, wanted: GisGeometryType, tool: string): void {
    if (actual !== wanted) throw new BadRequestException(`${tool} needs a ${wanted.toLowerCase()} layer.`);
  }

  /** SQL string literal. */
  private lit(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private unique(name: string, used: Set<string>): string {
    const base = name.slice(0, 60);
    let candidate = base;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base.slice(0, 56)}_${n}`;
    used.add(candidate.toLowerCase());
    return candidate;
  }

  private list(parts: string[]): string {
    return parts.length ? `${parts.join(', ')}, ` : '';
  }

  readFeature(tx: Prisma.TransactionClient, table: string, featureId: number) {
    return tx
      .$queryRawUnsafe<EditableFeature[]>(
        `SELECT t.ogc_fid AS id,
                ST_AsGeoJSON(ST_Transform(t.geom, 4326))::json AS geometry,
                to_jsonb(t) - 'geom' - 'ogc_fid' AS properties
           FROM "${table}" t WHERE t.ogc_fid = $1`,
        featureId,
      )
      .then((rows) => {
        if (!rows[0]) throw new NotFoundException('Feature not found.');
        return rows[0];
      });
  }

  recordHistory(
    tx: Prisma.TransactionClient,
    appUser: AppUser,
    userName: string | null,
    layerId: string,
    featureId: number,
    action: 'INSERT' | 'UPDATE' | 'DELETE',
    before: EditableFeature | null,
    after: EditableFeature | null,
  ) {
    const data = (f: EditableFeature | null) =>
      f ? ({ properties: f.properties, geometry: f.geometry } as Prisma.InputJsonValue) : Prisma.DbNull;
    return tx.gISFeatureHistory.create({
      data: {
        layerId,
        featureId,
        action,
        oldData: data(before),
        newData: data(after),
        userId: appUser.id,
        userName,
      },
    });
  }

  async userName(appUser: AppUser): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: appUser.id },
      select: { fullName: true },
    });
    return user?.fullName ?? null;
  }

  csvCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
}
