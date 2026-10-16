import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import type { GisGeometryType, GISLayer } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';
import { GeoServerService } from './geoserver.service';
import { GdalService } from './gdal.service';
import { GisAuthorizationService } from './gis-authorization.service';
import { GisLayersService } from './gis-layers.service';
import { deriveLayerCode, generateLayerTableName } from './layer-naming.util';
import { rasterFilePath } from './raster-paths.util';
import { rasterYsld, type RasterStyleSpec } from './raster-style';

const execFileAsync = promisify(execFile);
const RASTER_EXTENSIONS = /\.(tif|tiff|geotiff|gtiff)$/i;
const OP_TIMEOUT_MS = 15 * 60 * 1000;

export interface RasterBandInfo {
  band: number;
  type: string;
  nodata: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  color: string;
  description: string | null;
}

export interface RasterInfo {
  width: number;
  height: number;
  bandCount: number;
  crs: string;
  geographic: boolean;
  pixelSize: [number, number];
  pixelSizeM: number;
  bands: RasterBandInfo[];
}

export interface VectorField {
  name: string;
  type: string;
  numeric: boolean;
}

const NUMERIC_TYPES = new Set([
  'smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision', 'decimal',
]);

export interface RasterStats {
  min: number | null;
  max: number | null;
  mean: number | null;
  p2: number | null;
  p98: number | null;
}

/**
 * Raster Analysis — raster layers. A raster is stored once as a
 * Cloud-Optimized GeoTIFF under the municipality's storage folder (where
 * GDAL analysis reads it) and uploaded to GeoServer as its own GeoTIFF
 * coverage store (which serves it over WMS). The layer row has no
 * `postgisTable`; its file path is derived from its id (raster-paths.util).
 *
 * Analysis outputs go through `createRasterLayer` / `createVectorLayer`, so
 * every result is an ordinary, permissioned layer in the Layers panel.
 */
@Injectable()
export class RasterService {
  private readonly logger = new Logger(RasterService.name);
  private readonly storageRoot: string;
  private readonly script = path.resolve(process.cwd(), 'scripts/raster_ops.py');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly geoServer: GeoServerService,
    private readonly gdal: GdalService,
    private readonly gisAuth: GisAuthorizationService,
    private readonly gisLayers: GisLayersService,
  ) {
    this.storageRoot = path.resolve(
      this.config.get<string>('GIS_UPLOAD_STORAGE_DIR', './storage/uploads'),
    );
  }

  // ----- Raster Upload & Publish -----

  async upload(
    appUser: AppUser,
    file: { buffer: Buffer; originalname: string } | undefined,
    dto: { name: string; description?: string; departmentId?: string },
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Choose a GeoTIFF file to upload.');
    }
    if (!RASTER_EXTENSIONS.test(file.originalname)) {
      throw new BadRequestException('Only GeoTIFF rasters (.tif / .tiff) are supported.');
    }
    const source = this.tempPath(appUser.municipalityId, '.tif');
    await fsp.mkdir(path.dirname(source), { recursive: true });
    await fsp.writeFile(source, file.buffer);
    try {
      const { stdout } = await execFileAsync('gdalinfo', ['-json', source], {
        maxBuffer: 64 * 1024 * 1024,
      }).catch(() => {
        throw new BadRequestException('The file is not a readable GeoTIFF.');
      });
      const info = JSON.parse(stdout) as { coordinateSystem?: { wkt?: string } };
      if (!info.coordinateSystem?.wkt) {
        throw new BadRequestException(
          'The raster has no coordinate system — georeference it before uploading.',
        );
      }
      return await this.createRasterLayer(appUser, {
        name: dto.name,
        description: dto.description,
        departmentId: dto.departmentId,
        sourcePath: source,
      });
    } finally {
      await fsp.rm(source, { force: true });
    }
  }

  // ----- Raster Styling / Pixel Identify / info -----

  async info(appUser: AppUser, layerId: string): Promise<RasterInfo> {
    const { file } = await this.resolveRaster(appUser, layerId);
    return this.runOp<RasterInfo>({ op: 'info', path: file });
  }

  async identify(appUser: AppUser, layerId: string, point: [number, number]) {
    const { file } = await this.resolveRaster(appUser, layerId);
    return this.runOp({ op: 'identify', path: file, point });
  }

  async applyStyle(appUser: AppUser, layerId: string, spec: RasterStyleSpec) {
    const { layer } = await this.resolveRaster(appUser, layerId);
    if (!(await this.gisAuth.canManage(appUser, layer))) {
      throw new ForbiddenException('You do not have permission to style this layer.');
    }
    await this.writeStyle(layer, spec);
    return { styleName: `${layer.geoserverLayer}_style`, styleSpec: spec };
  }

  // ----- shared by the analysis tools -----

  /** The VIEW-checked raster layer and its GeoTIFF path. */
  async resolveRaster(appUser: AppUser, layerId: string) {
    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId: appUser.municipalityId },
      select: { id: true },
    });
    const layer = workspace
      ? await this.prisma.gISLayer.findFirst({
          where: { id: layerId, gisWorkspaceId: workspace.id, status: 'ACTIVE' },
        })
      : null;
    if (!layer || !(await this.gisAuth.canView(appUser, layer))) {
      throw new NotFoundException('Layer not found.');
    }
    if (layer.layerType !== 'RASTER') {
      throw new BadRequestException(`"${layer.name}" is not a raster layer.`);
    }
    const file = rasterFilePath(this.storageRoot, appUser.municipalityId, layer.id);
    await fsp.access(file).catch(() => {
      throw new BadRequestException(`The raster file of "${layer.name}" is missing.`);
    });
    return { layer, file };
  }

  /** The VIEW-checked vector layer, as the `{conn, table}` source
   *  raster_ops.py reads with OGR (PostGIS). */
  async resolveVector(appUser: AppUser, layerId: string) {
    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId: appUser.municipalityId },
      select: { id: true },
    });
    const layer = workspace
      ? await this.prisma.gISLayer.findFirst({
          where: { id: layerId, gisWorkspaceId: workspace.id, status: 'ACTIVE' },
        })
      : null;
    if (!layer || !(await this.gisAuth.canView(appUser, layer))) {
      throw new NotFoundException('Layer not found.');
    }
    if (layer.layerType !== 'VECTOR' || !layer.postgisTable) {
      throw new BadRequestException(`"${layer.name}" is not a vector layer.`);
    }
    return { layer, source: { conn: this.pgConnection(), table: layer.postgisTable } };
  }

  /** Attribute fields of a vector layer (for the field pickers). */
  async vectorFields(appUser: AppUser, layerId: string): Promise<VectorField[]> {
    const { source } = await this.resolveVector(appUser, layerId);
    const rows = await this.prisma.$queryRaw<{ name: string; type: string }[]>`
      SELECT column_name AS name, data_type AS type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${source.table}
      ORDER BY ordinal_position`;
    return rows
      .filter((r) => r.type !== 'USER-DEFINED' && r.name !== 'ogc_fid')
      .map((r) => ({ name: r.name, type: r.type, numeric: NUMERIC_TYPES.has(r.type) }));
  }

  /** Rejects a field that is not on the layer (or not numeric when it must be). */
  async assertField(appUser: AppUser, layerId: string, field: string | undefined, numeric: boolean): Promise<void> {
    if (!field) return;
    const match = (await this.vectorFields(appUser, layerId)).find((f) => f.name === field);
    if (!match) throw new BadRequestException(`The layer has no field "${field}".`);
    if (numeric && !match.numeric) throw new BadRequestException(`"${field}" is not a numeric field.`);
  }

  /** Download Raster: the GeoTIFF, optionally cut to an EPSG:4326 bbox.
   *  Gated by the layer's EXPORT permission. */
  async download(appUser: AppUser, layerId: string, bbox?: [number, number, number, number]) {
    const { layer, file } = await this.resolveRaster(appUser, layerId);
    if (!(await this.gisAuth.canExport(appUser, layer))) {
      throw new ForbiddenException('You do not have permission to export this layer.');
    }
    const filename = `${layer.code.toLowerCase()}.tif`;
    if (!bbox) return { filename, body: await fsp.readFile(file) };
    const clipped = this.tempPath(appUser.municipalityId, '.tif');
    await fsp.mkdir(path.dirname(clipped), { recursive: true });
    try {
      const [minX, minY, maxX, maxY] = bbox;
      await execFileAsync(
        'gdal_translate',
        ['-q', '-projwin_srs', 'EPSG:4326', '-projwin', `${minX}`, `${maxY}`, `${maxX}`, `${minY}`,
          '-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES', file, clipped],
        { timeout: OP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      ).catch(() => {
        throw new BadRequestException('The current map view does not overlap this raster.');
      });
      return { filename: filename.replace(/\.tif$/, '_view.tif'), body: await fsp.readFile(clipped) };
    } finally {
      await fsp.rm(clipped, { force: true });
    }
  }

  private pgConnection(): string {
    const q = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    return (
      `PG:host=${q(this.config.getOrThrow<string>('POSTGIS_HOST'))}` +
      ` port=${q(String(this.config.getOrThrow<string>('POSTGIS_PORT')))}` +
      ` dbname=${q(this.config.getOrThrow<string>('POSTGIS_DATABASE'))}` +
      ` user=${q(this.config.getOrThrow<string>('POSTGIS_USER'))}` +
      ` password=${q(this.config.getOrThrow<string>('POSTGIS_PASSWORD'))}`
    );
  }

  /** Runs one raster_ops.py operation (JSON in, JSON out). */
  async runOp<T = Record<string, unknown>>(request: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const child = spawn('python3', [this.script], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), OP_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', () => {
        clearTimeout(timer);
        let body: (T & { error?: string }) | null = null;
        try {
          body = JSON.parse(stdout.trim().split('\n').pop() ?? '') as T & { error?: string };
        } catch {
          body = null;
        }
        if (body && !body.error) return resolve(body);
        if (!body) this.logger.error(`raster_ops ${String(request.op)} failed: ${stderr.slice(-2000)}`);
        reject(new BadRequestException(body?.error ?? 'Raster processing failed.'));
      });
      child.stdin.end(JSON.stringify(request));
    });
  }

  tempPath(municipalityId: string, extension: string): string {
    return path.join(this.storageRoot, municipalityId, 'rasters', 'tmp', `${randomUUID()}${extension}`);
  }

  async removeTemp(...files: string[]): Promise<void> {
    await Promise.all(files.map((f) => fsp.rm(f, { force: true })));
  }

  /** Publishes a GeoTIFF as a new raster layer (converted to COG). */
  async createRasterLayer(
    appUser: AppUser,
    params: {
      name: string;
      sourcePath: string;
      description?: string;
      departmentId?: string;
      style?: RasterStyleSpec;
    },
  ) {
    const owner = this.outputOwnership(appUser, params.departmentId);
    const { workspace, code } = await this.newLayerCode(appUser, params.name);
    const id = randomUUID();
    const file = rasterFilePath(this.storageRoot, appUser.municipalityId, id);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await execFileAsync(
      'gdal_translate',
      ['-q', '-of', 'COG', '-co', 'COMPRESS=DEFLATE', '-co', 'BIGTIFF=IF_SAFER', params.sourcePath, file],
      { timeout: OP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    ).catch((error: { stderr?: string }) => {
      this.logger.warn(`gdal_translate failed: ${error.stderr ?? ''}`);
      throw new BadRequestException('The raster could not be converted.');
    });

    const geoserverLayer = code.toLowerCase();
    try {
      const bbox = await this.geoServer.publishGeoTiff(
        workspace.geoserverWorkspace,
        geoserverLayer,
        geoserverLayer,
        await fsp.readFile(file),
      );
      const layer = await this.prisma.gISLayer.create({
        data: {
          id,
          gisWorkspaceId: workspace.id,
          name: params.name,
          code,
          description: params.description,
          layerType: 'RASTER',
          geoserverWorkspace: workspace.geoserverWorkspace,
          geoserverLayer,
          departmentId: owner.departmentId,
          ownershipType: owner.ownershipType,
          version: 1,
          visibleByDefault: true,
          displayOrder: await this.nextDisplayOrder(workspace.id),
          bboxMinX: bbox?.minX,
          bboxMinY: bbox?.minY,
          bboxMaxX: bbox?.maxX,
          bboxMaxY: bbox?.maxY,
          createdById: appUser.id,
        },
      });
      if (owner.ownershipType === 'DEPARTMENT' && owner.departmentId) {
        await this.gisAuth.ensureDefaultPermissions(layer.id, owner.departmentId);
      }
      const style = params.style ?? (await this.defaultStyle(file));
      await this.writeStyle(layer, style).catch((error: Error) =>
        this.logger.warn(`Raster ${layer.id} published without its style: ${error.message}`),
      );
      return this.gisLayers.getById(appUser, layer.id);
    } catch (error) {
      await fsp.rm(file, { force: true });
      await this.geoServer
        .deleteCoverageStore(workspace.geoserverWorkspace, geoserverLayer)
        .catch(() => undefined);
      throw error;
    }
  }

  /** Imports a GeoPackage (layer "result") as a new vector layer. */
  async createVectorLayer(
    appUser: AppUser,
    params: { name: string; sourcePath: string; geometryType: GisGeometryType; description?: string },
  ) {
    const owner = this.outputOwnership(appUser);
    const { workspace, code } = await this.newLayerCode(appUser, params.name);
    const table = generateLayerTableName();
    await this.gdal.importToPostgis({
      sourcePath: params.sourcePath,
      tableName: table,
      targetCrs: workspace.defaultCrs,
      connection: {
        host: this.config.getOrThrow<string>('POSTGIS_HOST'),
        port: this.config.getOrThrow<string>('POSTGIS_PORT'),
        database: this.config.getOrThrow<string>('POSTGIS_DATABASE'),
        user: this.config.getOrThrow<string>('POSTGIS_USER'),
        password: this.config.getOrThrow<string>('POSTGIS_PASSWORD'),
      },
    });
    await this.prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "${table}_geom_idx" ON "${table}" USING GIST (geom)`,
    );
    const geoserverLayer = code.toLowerCase();
    try {
      const bbox = await this.geoServer.ensureFeatureType(
        workspace.geoserverWorkspace,
        `${workspace.geoserverWorkspace}_postgis`,
        { name: geoserverLayer, nativeName: table, title: params.name, srs: workspace.defaultCrs },
      );
      const layer = await this.prisma.gISLayer.create({
        data: {
          gisWorkspaceId: workspace.id,
          name: params.name,
          code,
          description: params.description,
          layerType: 'VECTOR',
          geoserverWorkspace: workspace.geoserverWorkspace,
          geoserverLayer,
          geometryType: params.geometryType,
          departmentId: owner.departmentId,
          ownershipType: owner.ownershipType,
          postgisTable: table,
          version: 1,
          visibleByDefault: true,
          displayOrder: await this.nextDisplayOrder(workspace.id),
          bboxMinX: bbox?.minX,
          bboxMinY: bbox?.minY,
          bboxMaxX: bbox?.maxX,
          bboxMaxY: bbox?.maxY,
          createdById: appUser.id,
        },
      });
      if (owner.ownershipType === 'DEPARTMENT' && owner.departmentId) {
        await this.gisAuth.ensureDefaultPermissions(layer.id, owner.departmentId);
      }
      return this.gisLayers.getById(appUser, layer.id);
    } catch (error) {
      await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}"`).catch(() => undefined);
      throw error;
    }
  }

  // ----- internals -----

  private async writeStyle(layer: GISLayer, spec: RasterStyleSpec): Promise<void> {
    const styleName = `${layer.geoserverLayer}_style`;
    await this.geoServer.putYsldStyle(layer.geoserverWorkspace, styleName, rasterYsld(styleName, spec));
    await this.geoServer.setLayerDefaultStyle(
      layer.geoserverWorkspace,
      layer.geoserverLayer,
      styleName,
      layer.geoserverWorkspace,
    );
    await this.prisma.gISLayer.update({
      where: { id: layer.id },
      data: { styleName, styleSpec: spec as object },
    });
  }

  private async defaultStyle(file: string): Promise<RasterStyleSpec> {
    const info = await this.runOp<RasterInfo>({ op: 'info', path: file });
    if (info.bandCount >= 3) return { mode: 'rgb', bands: [1, 2, 3] };
    const band = info.bands[0];
    return {
      mode: 'ramp',
      band: 1,
      ramp: band?.type === 'Byte' ? 'grayscale' : 'terrain',
      min: band?.min ?? 0,
      max: band?.max ?? 1,
    };
  }

  /** Who owns a new layer: the owner may pick a department (or none =
   *  municipality-wide); everyone else writes into their own department and
   *  needs its UPLOAD permission. */
  private outputOwnership(appUser: AppUser, departmentId?: string) {
    if (appUser.systemRole === 'MUNICIPALITY_OWNER') {
      return departmentId
        ? { ownershipType: 'DEPARTMENT' as const, departmentId }
        : { ownershipType: 'CANONICAL' as const, departmentId: null };
    }
    const own = appUser.departmentId;
    if (
      !own ||
      (departmentId && departmentId !== own) ||
      !this.gisAuth.getDefaultPermissions(appUser, 'DEPARTMENT', own).has('UPLOAD')
    ) {
      throw new ForbiddenException('You do not have permission to create GIS layers.');
    }
    return { ownershipType: 'DEPARTMENT' as const, departmentId: own };
  }

  private async newLayerCode(appUser: AppUser, name: string) {
    if (!name?.trim()) throw new BadRequestException('Enter a name for the new layer.');
    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId: appUser.municipalityId },
    });
    if (!workspace) throw new NotFoundException('GIS workspace not found.');
    const base = deriveLayerCode(name).slice(0, 56);
    for (let n = 1; n < 1000; n++) {
      const code = n === 1 ? base : `${base}_${n}`;
      const taken = await this.prisma.gISLayer.findUnique({
        where: { gisWorkspaceId_code: { gisWorkspaceId: workspace.id, code } },
        select: { id: true },
      });
      if (!taken) return { workspace, code };
    }
    throw new BadRequestException('Choose a different layer name.');
  }

  private async nextDisplayOrder(gisWorkspaceId: string): Promise<number> {
    const last = await this.prisma.gISLayer.aggregate({
      where: { gisWorkspaceId },
      _max: { displayOrder: true },
    });
    return (last._max.displayOrder ?? 0) + 1;
  }
}
