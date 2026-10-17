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
import { StyleService } from './style.service';
import { deriveLayerCode, generateLayerTableName } from './layer-naming.util';
import { rasterFilePath } from './raster-paths.util';
import { rasterYsld, type RasterStyleSpec } from './raster-style';
import { rasterJobContext } from './raster-job-context';

const execFileAsync = promisify(execFile);
const RASTER_EXTENSIONS = /\.(tif|tiff|geotiff|gtiff|jp2|j2k|img|zip)$/i;
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

/** Stage shown in the panel while a background job runs each operation. */
const OP_STAGES: Record<string, string> = {
  online_dem: 'Downloading Copernicus DEM tiles',
  online_landcover: 'Downloading ESA WorldCover tiles',
  stac_fetch: 'Downloading Sentinel-2 bands',
  mosaic: 'Merging rasters',
  resample: 'Resampling',
  classify: 'Clustering pixels (k-means)',
  watershed: 'Routing flow across the DEM',
  fill_sinks: 'Filling depressions',
  zonal: 'Summarising zones',
  idw: 'Interpolating',
  heatmap: 'Computing density',
  proximity: 'Computing distances',
  s2_composite: 'Downloading scenes and building the median composite',
  index_series: 'Reading every clear Sentinel-2 date',
  lst: 'Downloading Landsat thermal bands',
  supervised: 'Training and classifying',
  change_matrix: 'Cross-tabulating classes',
  streams: 'Tracing the stream network',
  online_population: 'Downloading population data',
  online_water: 'Downloading surface-water data',
  suitability: 'Combining the criteria',
  extract_values: 'Sampling the rasters at every feature',
  least_cost: 'Searching the cheapest route',
  hotspot: 'Computing Getis-Ord Gi* statistics',
  no2: 'Downloading Sentinel-5P orbits and averaging NO₂',
  fill_nodata: 'Filling gaps',
  heights: 'Subtracting ground from surface',
  encroachment: 'Building before / after composites and comparing built-up land',
  green_cover: 'Building Sentinel-2 composites and measuring green cover',
  hand: 'Computing height above nearest drainage',
  exposure: 'Overlaying population and hazard',
  area_report: 'Summarising each raster inside the area',
  viewshed_multi: 'Computing each observer\'s viewshed',
};

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
    private readonly styles: StyleService,
  ) {
    this.storageRoot = path.resolve(
      this.config.get<string>('GIS_UPLOAD_STORAGE_DIR', './storage/uploads'),
    );
  }

  // ----- Raster Upload & Publish -----

  /** `file.path`: multer wrote the upload straight to disk (it is never
   *  held in memory); this method always removes it. */
  async upload(
    appUser: AppUser,
    file: { path: string; size: number; originalname: string } | undefined,
    dto: { name: string; description?: string; departmentId?: string },
  ) {
    if (!file?.path || !file.size) {
      if (file?.path) await fsp.rm(file.path, { force: true });
      throw new BadRequestException('Choose a GeoTIFF file to upload.');
    }
    const source = file.path;
    try {
      if (!RASTER_EXTENSIONS.test(file.originalname)) {
        throw new BadRequestException('Only GeoTIFF rasters (.tif / .tiff) are supported.');
      }
      const input = /\.zip$/i.test(file.originalname) ? await this.rasterInZip(source) : source;
      const { stdout } = await execFileAsync('gdalinfo', ['-json', input], {
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
        sourcePath: input,
      });
    } finally {
      await fsp.rm(source, { force: true });
    }
  }

  /** The first raster inside an uploaded .zip, as a GDAL /vsizip/ path
   *  (so an .img with its .ige, or a .tif with .tfw/.prj, works). */
  private async rasterInZip(zipPath: string): Promise<string> {
    const { path: inner } = await this.runOp<{ path: string | null }>({ op: 'find_raster', path: zipPath });
    if (!inner) throw new BadRequestException('The .zip contains no GeoTIFF, JPEG 2000 or .img raster.');
    return inner;
  }

  // ----- Raster Styling / Pixel Identify / info -----

  /** Raster metadata plus its current style and description, so the
   *  panel can edit classes and show where the layer came from. */
  async info(appUser: AppUser, layerId: string) {
    const { file, layer } = await this.resolveRaster(appUser, layerId);
    const info = await this.runOp<RasterInfo>({ op: 'info', path: file });
    return { ...info, styleSpec: layer.styleSpec ?? null, description: layer.description };
  }

  /** 3D Terrain View: a ≤ `size`² elevation grid of the DEM + its bbox. */
  async mesh(appUser: AppUser, layerId: string, band: number, size: number) {
    const { file } = await this.resolveRaster(appUser, layerId);
    return this.runOp({ op: 'mesh', path: file, band, size });
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
  /** VIEW check for any layer type (raster or vector analysis output). */
  async assertCanView(appUser: AppUser, layerId: string): Promise<void> {
    await this.gisLayers.getById(appUser, layerId);
  }

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
    rasterJobContext.getStore()?.sources.push(layer.name);
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
    rasterJobContext.getStore()?.sources.push(layer.name);
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
    const job = rasterJobContext.getStore();
    if (job?.signal.aborted) throw new BadRequestException('Cancelled.');
    job?.setStage(OP_STAGES[String(request.op)] ?? 'Processing');
    return new Promise<T>((resolve, reject) => {
      const child = spawn('python3', [this.script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HDF5_DISABLE_VERSION_CHECK: '1' },
      });
      const onAbort = () => child.kill('SIGKILL');
      job?.signal.addEventListener('abort', onAbort, { once: true });
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
        job?.signal.removeEventListener('abort', onAbort);
        if (job?.signal.aborted) return reject(new BadRequestException('Cancelled.'));
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
    const job = rasterJobContext.getStore();
    const owner = this.outputOwnership(appUser, params.departmentId ?? job?.outputDepartmentId);
    const { workspace, code } = await this.newLayerCode(appUser, params.name);
    job?.setStage('Optimising and publishing the layer', false);
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
        file,
      );
      const layer = await this.prisma.gISLayer.create({
        data: {
          id,
          gisWorkspaceId: workspace.id,
          name: params.name,
          code,
          description: params.description ?? job?.describe(),
          layerType: 'RASTER',
          rasterAnalysis: true,
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

  /** The layer as the API returns it (after a style was applied). */
  layerResponse(appUser: AppUser, layerId: string) {
    return this.gisLayers.getById(appUser, layerId);
  }

  /** Styles a layer this service just created (e.g. the Zonal Statistics
   *  choropleth) — best effort, the layer stays usable unstyled. */
  async applyVectorStyle(layerId: string, spec: Record<string, unknown>): Promise<void> {
    const layer = await this.prisma.gISLayer.findUnique({ where: { id: layerId } });
    if (!layer) return;
    try {
      const { styleName } = await this.styles.applyStyle(
        { workspace: layer.geoserverWorkspace, geoserverLayer: layer.geoserverLayer },
        spec as never,
      );
      await this.prisma.gISLayer.update({ where: { id: layer.id }, data: { styleName, styleSpec: spec as object } });
    } catch (error) {
      this.logger.warn(`Layer ${layer.id} published without its style: ${(error as Error).message}`);
    }
  }

  /** Imports a GeoPackage (layer "result") as a new vector layer. */
  async createVectorLayer(
    appUser: AppUser,
    params: { name: string; sourcePath: string; geometryType: GisGeometryType; description?: string },
  ) {
    const job = rasterJobContext.getStore();
    const output = await this.prepareVectorOutput(appUser, params.name, job?.outputDepartmentId);
    job?.setStage('Importing and publishing the layer', false);
    await this.gdal.importToPostgis({
      sourcePath: params.sourcePath,
      tableName: output.table,
      targetCrs: output.workspace.defaultCrs,
      connection: {
        host: this.config.getOrThrow<string>('POSTGIS_HOST'),
        port: this.config.getOrThrow<string>('POSTGIS_PORT'),
        database: this.config.getOrThrow<string>('POSTGIS_DATABASE'),
        user: this.config.getOrThrow<string>('POSTGIS_USER'),
        password: this.config.getOrThrow<string>('POSTGIS_PASSWORD'),
      },
    });
    return this.publishVectorTable(appUser, output, {
      name: params.name,
      geometryType: params.geometryType,
      description: params.description ?? job?.describe(),
      rasterAnalysis: true,
    });
  }

  /** Ownership check + a free layer code + a fresh table name for a new
   *  vector layer — call before writing the table (Geoprocessing too). */
  async prepareVectorOutput(appUser: AppUser, name: string, departmentId?: string) {
    const owner = this.outputOwnership(appUser, departmentId);
    const { workspace, code } = await this.newLayerCode(appUser, name);
    return { owner, workspace, code, table: generateLayerTableName() };
  }

  /** Publishes a PostGIS table (with a `geom` column) written for
   *  `prepareVectorOutput` as a new layer; drops the table on failure. */
  async publishVectorTable(
    appUser: AppUser,
    output: Awaited<ReturnType<RasterService['prepareVectorOutput']>>,
    params: { name: string; geometryType: GisGeometryType; description?: string; rasterAnalysis: boolean },
  ) {
    const { owner, workspace, code, table } = output;
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
          rasterAnalysis: params.rasterAnalysis,
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
