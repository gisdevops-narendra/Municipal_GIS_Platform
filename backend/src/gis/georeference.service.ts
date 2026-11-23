import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type { AppUser } from '../auth/types/app-user.type';
import { RasterService } from './raster.service';
import { rasterJobContext } from './raster-job-context';
import { fitTransform, MIN_GCPS, type GcpPair, type GeorefTransform } from './georef-math';
import type { GeorefGcpDto, GeorefSettingsDto, GeoreferenceRunDto } from './dto/georeference.dto';

const execFileAsync = promisify(execFile);

/** Image formats a scanned map can arrive in (PDF pages are rendered). */
const SOURCE_EXTENSIONS = /\.(png|jpe?g|tiff?|bmp|gif|webp|jp2|pdf)$/i;
/** Long side of the low-resolution copy used for previews. */
const PREVIEW_MAX = 2048;
const TILE_SIZE = 256;
const LONG_OP_MS = 30 * 60_000;

export interface GeorefSession {
  id: string;
  name: string;
  originalName: string;
  createdAt: string;
  updatedAt: string;
  createdById: string;
  status: 'processing' | 'ready' | 'failed';
  stage: string | null;
  error: string | null;
  /** full-resolution image size (pixels) */
  width: number;
  height: number;
  /** deepest tile zoom of the viewer pyramid (1 tile pixel = 1 image pixel) */
  maxZoom: number;
  /** preview copy size ÷ full size */
  previewScale: number;
  dpi: number | null;
  gcps: GeorefGcpDto[];
  settings: GeorefSettingsDto | null;
  /** layers published from this session */
  outputs: { layerId: string; name: string; createdAt: string; rmse: number | null; transform: string }[];
}

interface GdalInfo {
  size: [number, number];
  bands: { colorTable?: unknown }[];
  geoTransform?: number[];
}

/**
 * Georeferencer (QGIS-style): a scanned map / toposheet is uploaded once
 * and kept as a session (its full-resolution image, a tiled pyramid for
 * the browser viewer and a small copy for previews). The user places
 * ground control points; previews and the final warp run through GDAL
 * (gdal_translate -gcp + gdalwarp -order n / -tps). The result is
 * published as an ordinary raster layer, downloadable as GeoTIFF.
 */
@Injectable()
export class GeoreferenceService {
  private readonly logger = new Logger(GeoreferenceService.name);

  constructor(private readonly rasters: RasterService) {}

  // ----- sessions -----

  private dir(municipalityId: string, id?: string): string {
    const root = this.rasters.georefRoot(municipalityId);
    return id ? path.join(root, id) : root;
  }

  private async readMeta(appUser: AppUser, id: string): Promise<GeorefSession> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFoundException('Georeferencing session not found.');
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(this.dir(appUser.municipalityId, id), 'session.json'), 'utf8')) as GeorefSession;
      if (meta.createdById !== appUser.id) throw new Error('not yours');
      return meta;
    } catch {
      throw new NotFoundException('Georeferencing session not found.');
    }
  }

  private async writeMeta(municipalityId: string, meta: GeorefSession): Promise<void> {
    const file = path.join(this.dir(municipalityId, meta.id), 'session.json');
    await fsp.writeFile(`${file}.tmp`, JSON.stringify(meta));
    await fsp.rename(`${file}.tmp`, file);
  }

  private async update(municipalityId: string, id: string, patch: Partial<GeorefSession>): Promise<GeorefSession> {
    const file = path.join(this.dir(municipalityId, id), 'session.json');
    const meta = { ...(JSON.parse(await fsp.readFile(file, 'utf8')) as GeorefSession), ...patch, updatedAt: new Date().toISOString() };
    await this.writeMeta(municipalityId, meta);
    return meta;
  }

  async list(appUser: AppUser): Promise<GeorefSession[]> {
    const root = this.dir(appUser.municipalityId);
    const ids = await fsp.readdir(root).catch(() => [] as string[]);
    const sessions = await Promise.all(ids.map((id) => this.readMeta(appUser, id).catch(() => null)));
    return sessions.filter((s): s is GeorefSession => !!s).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(appUser: AppUser, id: string): Promise<GeorefSession> {
    return this.readMeta(appUser, id);
  }

  async save(appUser: AppUser, id: string, gcps: GeorefGcpDto[], settings?: GeorefSettingsDto): Promise<GeorefSession> {
    const meta = await this.readMeta(appUser, id);
    return this.update(appUser.municipalityId, id, { gcps, settings: settings ?? meta.settings });
  }

  async remove(appUser: AppUser, id: string): Promise<{ success: true }> {
    await this.readMeta(appUser, id);
    await fsp.rm(this.dir(appUser.municipalityId, id), { recursive: true, force: true });
    return { success: true };
  }

  /** One viewer tile (WEBP) — z/x/y as written by gdal2tiles --xyz. */
  async tilePath(appUser: AppUser, id: string, z: number, x: number, y: number): Promise<string> {
    const meta = await this.readMeta(appUser, id);
    if (![z, x, y].every((n) => Number.isInteger(n) && n >= 0) || z > meta.maxZoom) throw new NotFoundException();
    const file = path.join(this.dir(appUser.municipalityId, id), 'tiles', String(z), String(x), `${y}.webp`);
    await fsp.access(file).catch(() => {
      throw new NotFoundException();
    });
    return file;
  }

  /** Stores the upload and prepares it in the background (PDF rendering,
   *  palette expansion, tile pyramid, preview copy). Poll `get` until
   *  status is "ready". `file.path` is always moved or removed. */
  async create(
    appUser: AppUser,
    file: { path: string; size: number; originalname: string } | undefined,
    dpi = 300,
  ): Promise<GeorefSession> {
    if (!file?.path || !file.size) throw new BadRequestException('Choose a scanned map image or PDF.');
    if (!SOURCE_EXTENSIONS.test(file.originalname)) {
      await fsp.rm(file.path, { force: true });
      throw new BadRequestException('Upload a PNG, JPEG, TIFF, BMP, GIF, WEBP, JPEG 2000 image or a PDF.');
    }
    const id = randomUUID();
    const dir = this.dir(appUser.municipalityId, id);
    await fsp.mkdir(dir, { recursive: true });
    const ext = path.extname(file.originalname).toLowerCase();
    const original = path.join(dir, `original${ext}`);
    await fsp.rename(file.path, original).catch(async () => {
      await fsp.copyFile(file.path, original);
      await fsp.rm(file.path, { force: true });
    });
    const now = new Date().toISOString();
    const meta: GeorefSession = {
      id,
      name: path.basename(file.originalname, ext).slice(0, 80) || 'Scanned map',
      originalName: file.originalname,
      createdAt: now,
      updatedAt: now,
      createdById: appUser.id,
      status: 'processing',
      stage: 'Reading the image',
      error: null,
      width: 0,
      height: 0,
      maxZoom: 0,
      previewScale: 1,
      dpi: ext === '.pdf' ? dpi : null,
      gcps: [],
      settings: null,
      outputs: [],
    };
    await this.writeMeta(appUser.municipalityId, meta);
    void this.prepare(appUser.municipalityId, meta, original).catch(async (error: Error) => {
      this.logger.warn(`Georef session ${id} failed: ${error.message}`);
      await this.update(appUser.municipalityId, id, { status: 'failed', stage: null, error: error.message }).catch(() => undefined);
    });
    return meta;
  }

  private async run(cmd: string, args: string[], timeout = LONG_OP_MS): Promise<string> {
    try {
      const { stdout } = await execFileAsync(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const e = error as { stderr?: string; message: string };
      const detail = (e.stderr || e.message).split('\n').filter(Boolean).slice(-2).join(' ');
      this.logger.warn(`${cmd} failed: ${detail}`);
      throw new BadRequestException(`${cmd} failed: ${detail.slice(0, 300)}`);
    }
  }

  private async info(file: string): Promise<GdalInfo> {
    return JSON.parse(await this.run('gdalinfo', ['-json', file], 120_000)) as GdalInfo;
  }

  private async prepare(municipalityId: string, meta: GeorefSession, original: string): Promise<void> {
    const dir = this.dir(municipalityId, meta.id);
    const source = path.join(dir, 'source.tif');
    const tiff = ['-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES', '-co', 'BIGTIFF=IF_SAFER'];

    // 1. A plain (non-georeferenced) RGB(A) GeoTIFF of the full image.
    const isPdf = /\.pdf$/i.test(original);
    if (isPdf) await this.update(municipalityId, meta.id, { stage: `Rendering the PDF at ${meta.dpi} DPI` });
    const first = await this.info(original);
    const palette = !isPdf && !!first.bands[0]?.colorTable;
    await this.run('gdal_translate', [
      '-q',
      ...(isPdf ? ['--config', 'GDAL_PDF_DPI', String(meta.dpi ?? 300)] : []),
      ...(palette ? ['-expand', 'rgba'] : []),
      '-of', 'GTiff', ...tiff, original, source,
    ]);
    // Any existing geotransform is dropped: the GCPs define the placement
    // (the GCP VRT replaces GCPs / CRS itself).
    await this.run('gdal_edit', ['-unsetgt', '-unsetrpc', source], 120_000).catch(() => undefined);
    await fsp.rm(original, { force: true });
    const full = await this.info(source);
    const [width, height] = full.size;

    // 2. Small copy for previews.
    await this.update(municipalityId, meta.id, { stage: 'Making the preview copy', width, height });
    const scale = Math.min(1, PREVIEW_MAX / Math.max(width, height));
    await this.run('gdal_translate', [
      '-q', '-r', 'average', '-outsize', String(Math.max(1, Math.round(width * scale))), String(Math.max(1, Math.round(height * scale))),
      '-of', 'GTiff', ...tiff, source, path.join(dir, 'preview.tif'),
    ]);

    // 3. Tile pyramid for the viewer (pixel coordinates, XYZ numbering).
    const maxZoom = Math.max(0, Math.ceil(Math.log2(Math.max(width, height) / TILE_SIZE)));
    await this.update(municipalityId, meta.id, { stage: 'Building the zoomable image', maxZoom, previewScale: scale });
    await this.run('gdal2tiles', [
      '-q', '-p', 'raster', '--xyz', '-w', 'none', '-r', 'average', '-z', `0-${maxZoom}`,
      '--tiledriver=WEBP', '--webp-quality=85', '--processes=2', source, path.join(dir, 'tiles'),
    ]);

    await this.update(municipalityId, meta.id, { status: 'ready', stage: null });
  }

  // ----- transformation -----

  /** WGS84 lon/lat → target CRS (exact PROJ maths via gdaltransform). */
  private async toTarget(points: { lon: number; lat: number }[], targetCrs: string): Promise<[number, number][]> {
    if (/^EPSG:4326$/i.test(targetCrs)) return points.map((p) => [p.lon, p.lat]);
    const out = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'gdaltransform',
        ['-s_srs', '+proj=longlat +datum=WGS84 +no_defs', '-t_srs', targetCrs, '-output_xy'],
        { timeout: 60_000 },
        (error, stdout, stderr) => (error ? reject(new BadRequestException(`Unknown target CRS ${targetCrs}: ${stderr}`)) : resolve(stdout)),
      );
      child.stdin?.end(points.map((p) => `${p.lon} ${p.lat}`).join('\n') + '\n');
    });
    const rows = out.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    if (rows.length !== points.length || rows.some((r) => r.length < 2 || !r.every(Number.isFinite))) {
      throw new BadRequestException('Some GCPs fall outside the target coordinate system.');
    }
    return rows.map((r) => [r[0], r[1]]);
  }

  /** gdal_translate GCP args (+ gdalwarp transform args) for the settings,
   *  with pixel positions scaled by `scale` (preview copy). */
  private async gcpArgs(gcps: GeorefGcpDto[], settings: GeorefSettingsDto, scale: number, width: number, height: number) {
    const enabled = gcps.filter((g) => g.enabled);
    const transform = settings.transform as GeorefTransform;
    if (enabled.length < MIN_GCPS[transform]) {
      throw new BadRequestException(`${transform === 'tps' ? 'Thin plate spline' : transform} needs at least ${MIN_GCPS[transform]} enabled GCPs (you have ${enabled.length}).`);
    }
    const xy = await this.toTarget(enabled, settings.targetCrs);
    const pairs: GcpPair[] = enabled.map((g, i) => ({ px: g.px, py: g.py, x: xy[i][0], y: xy[i][1] }));
    const fit = fitTransform(transform, pairs);
    if (!fit) throw new BadRequestException('The GCPs cannot define this transform — they may lie on one line. Spread them across the map.');

    let used = pairs;
    let warp: string[];
    if (transform === 'helmert') {
      // Similarity transform = exact first-order fit through the four
      // image corners as predicted by the Helmert fit.
      used = ([[0, 0], [width, 0], [0, height], [width, height]] as const).map(([px, py]) => {
        const [x, y] = fit.forward(px, py);
        return { px, py, x, y };
      });
      warp = ['-order', '1'];
    } else if (transform === 'tps') {
      warp = ['-tps'];
    } else {
      warp = ['-order', transform.slice(-1)];
    }
    const gcp = used.flatMap((p) => ['-gcp', String(p.px * scale), String(p.py * scale), String(p.x), String(p.y)]);
    return { gcp, warp, fit, count: enabled.length };
  }

  /** Low-resolution warp shown on the reference map: a PNG (data URL)
   *  and its WGS84 bounds, plus the fit's RMSE. */
  async preview(appUser: AppUser, id: string, gcps: GeorefGcpDto[], settings: GeorefSettingsDto) {
    const meta = await this.readMeta(appUser, id);
    if (meta.status !== 'ready') throw new BadRequestException('The image is still being prepared.');
    const dir = this.dir(appUser.municipalityId, id);
    const { gcp, warp, fit } = await this.gcpArgs(gcps, settings, meta.previewScale, meta.width, meta.height);
    const work = path.join(dir, `preview-${randomUUID()}`);
    try {
      await this.run('gdal_translate', ['-q', '-of', 'VRT', '-a_srs', settings.targetCrs, ...gcp, path.join(dir, 'preview.tif'), `${work}.vrt`], 120_000);
      await this.run('gdalwarp', [
        '-q', '-overwrite', '-t_srs', 'EPSG:4326', ...warp, '-r', 'bilinear', '-dstalpha',
        '-ts', '1600', '0', '-of', 'GTiff', `${work}.vrt`, `${work}.tif`,
      ], 180_000);
      const info = await this.info(`${work}.tif`);
      // WEBP keeps the preview ~10× smaller than PNG (needs RGB / RGBA).
      const webp = info.bands.length === 3 || info.bands.length === 4;
      const ext = webp ? 'webp' : 'png';
      await this.run('gdal_translate', ['-q', '-of', webp ? 'WEBP' : 'PNG', ...(webp ? ['-co', 'QUALITY=80'] : []), `${work}.tif`, `${work}.${ext}`], 120_000);
      const gt = info.geoTransform!;
      const [w, h] = info.size;
      const bounds = [gt[0], gt[3] + gt[5] * h, gt[0] + gt[1] * w, gt[3]];
      const bytes = await fsp.readFile(`${work}.${ext}`);
      return { bounds, image: `data:image/${ext};base64,${bytes.toString('base64')}`, rmse: fit.rmse, pixelSize: fit.pixelSize };
    } finally {
      await Promise.all(['.vrt', '.tif', '.png', '.webp', '.png.aux.xml', '.webp.aux.xml', '.tif.aux.xml'].map((e) => fsp.rm(`${work}${e}`, { force: true })));
    }
  }

  /** Full-resolution warp → published raster layer (background job). */
  async georeference(appUser: AppUser, dto: GeoreferenceRunDto) {
    const meta = await this.readMeta(appUser, dto.sessionId);
    if (meta.status !== 'ready') throw new BadRequestException('The image is still being prepared.');
    const job = rasterJobContext.getStore();
    const dir = this.dir(appUser.municipalityId, meta.id);
    job?.setStage('Checking the GCPs', true);
    const { gcp, warp, fit, count } = await this.gcpArgs(dto.gcps, dto.settings, 1, meta.width, meta.height);
    await this.save(appUser, meta.id, dto.gcps, dto.settings);

    const work = path.join(dir, `run-${randomUUID()}`);
    try {
      await this.run('gdal_translate', ['-q', '-of', 'VRT', '-a_srs', dto.settings.targetCrs, ...gcp, path.join(dir, 'source.tif'), `${work}.vrt`], 300_000);
      job?.setStage(`Warping the image (${dto.settings.transform}, ${dto.settings.resampling})`, true);
      const bands = (await this.info(path.join(dir, 'source.tif'))).bands.length;
      await this.run('gdalwarp', [
        '-q', '-overwrite', '-t_srs', dto.settings.targetCrs, ...warp, '-r', dto.settings.resampling,
        ...(bands === 2 || bands === 4 ? [] : ['-dstalpha']),
        '-multi', '-wm', '512', '-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES', '-co', 'BIGTIFF=IF_SAFER',
        `${work}.vrt`, `${work}.tif`,
      ]);
      const unit = /^EPSG:4326$/i.test(dto.settings.targetCrs) ? '°' : ' m';
      const label: Record<string, string> = { helmert: 'Helmert', poly1: 'Polynomial 1', poly2: 'Polynomial 2', poly3: 'Polynomial 3', tps: 'Thin plate spline' };
      const description =
        `Georeferenced from ${meta.originalName}: ${count} GCPs, ${label[dto.settings.transform]}, ` +
        `${dto.settings.resampling} resampling, ${dto.settings.targetCrs}` +
        (dto.settings.transform === 'tps' ? '.' : `, RMSE ${fit.rmse.toFixed(unit === '°' ? 6 : 2)}${unit}.`);
      const layer = await this.rasters.createRasterLayer(appUser, { name: dto.outputName, sourcePath: `${work}.tif`, description });
      const outputs = [
        ...meta.outputs,
        { layerId: (layer as { id: string }).id, name: dto.outputName, createdAt: new Date().toISOString(), rmse: dto.settings.transform === 'tps' ? null : fit.rmse, transform: dto.settings.transform },
      ];
      await this.update(appUser.municipalityId, meta.id, { outputs });
      return { layer, result: { rmse: fit.rmse, pixelSize: fit.pixelSize, gcps: count } };
    } finally {
      await Promise.all(['.vrt', '.tif', '.tif.aux.xml'].map((e) => fsp.rm(`${work}${e}`, { force: true })));
    }
  }
}
