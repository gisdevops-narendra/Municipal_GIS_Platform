import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, rename, rm, stat, writeFile } from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { PrismaService } from '../prisma/prisma.service';
import { rasterFilePath } from './raster-paths.util';

const run = promisify(execFile);

/** What to tile: a vector layer's SQL source, or a raster layer's COG. */
export type ArchiveSource =
  | { kind: 'vector'; from: string; layerName: string }
  | { kind: 'raster'; workspace: string; layer: string };

interface QueueItem {
  layerId: string;
  municipalityId: string;
  source: ArchiveSource;
}

/**
 * PMTiles archives: a layer pre-tiled into ONE static file (vector: MVT
 * tiles from PostGIS; raster: PNG tiles from its COG), built with GDAL and
 * served by the backend with HTTP range requests. The browser reads only
 * the tiles it needs — no GeoServer rendering at view time, the fastest way
 * to draw large layers.
 *
 * Builds run one at a time at the lowest CPU priority (a big layer can take
 * minutes), so they never compete with interactive work. A data change
 * schedules a rebuild; until it is READY the map falls back to live tiles.
 */
@Injectable()
export class TileArchiveService implements OnModuleInit {
  private readonly logger = new Logger(TileArchiveService.name);
  private readonly storageRoot: string;
  private readonly queue: QueueItem[] = [];
  private running = false;
  private readonly rebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.storageRoot = path.resolve(this.config.get<string>('GIS_UPLOAD_STORAGE_DIR', './storage/uploads'));
  }

  /** Builds interrupted by a restart: READY if a (possibly older) archive
   *  is on disk, otherwise NONE — the admin can trigger a new build. */
  async onModuleInit(): Promise<void> {
    const stuck = await this.prisma.gISLayer
      .findMany({ where: { pmtilesStatus: 'BUILDING' }, select: { id: true, gisWorkspaceId: true, pmtilesBuiltAt: true } })
      .catch(() => []);
    for (const layer of stuck) {
      const ws = await this.prisma.gISWorkspace.findUnique({ where: { id: layer.gisWorkspaceId }, select: { municipalityId: true } });
      const ready = !!ws && existsSync(this.filePath(ws.municipalityId, layer.id)) && !!layer.pmtilesBuiltAt;
      await this.prisma.gISLayer.update({ where: { id: layer.id }, data: { pmtilesStatus: ready ? 'READY' : 'NONE' } });
    }
  }

  filePath(municipalityId: string, layerId: string): string {
    return path.join(this.storageRoot, municipalityId, 'tiles', `${layerId}.pmtiles`);
  }

  /** Queues a (re)build of the layer's archive. */
  async request(layerId: string, municipalityId: string, source: ArchiveSource): Promise<void> {
    await this.prisma.gISLayer.update({ where: { id: layerId }, data: { pmtilesStatus: 'BUILDING', pmtilesError: null } });
    const queued = this.queue.find((q) => q.layerId === layerId);
    if (queued) queued.source = source;
    else this.queue.push({ layerId, municipalityId, source });
    void this.drain();
  }

  /** The layer's data changed: rebuild its archive (if it has one) after a
   *  quiet period, so a burst of edits costs one build. */
  scheduleRebuild(layerId: string, municipalityId: string, source: () => Promise<ArchiveSource | null>): void {
    clearTimeout(this.rebuildTimers.get(layerId));
    this.rebuildTimers.set(
      layerId,
      setTimeout(() => {
        this.rebuildTimers.delete(layerId);
        void (async () => {
          const layer = await this.prisma.gISLayer.findUnique({ where: { id: layerId }, select: { pmtilesStatus: true } });
          if (!layer || layer.pmtilesStatus === 'NONE') return;
          const src = await source();
          if (src) await this.request(layerId, municipalityId, src);
        })().catch((e) => this.logger.warn(`PMTiles rebuild of ${layerId} not scheduled: ${(e as Error).message}`));
      }, 30_000),
    );
  }

  async remove(municipalityId: string, layerId: string): Promise<void> {
    clearTimeout(this.rebuildTimers.get(layerId));
    const i = this.queue.findIndex((q) => q.layerId === layerId);
    if (i >= 0) this.queue.splice(i, 1);
    await rm(this.filePath(municipalityId, layerId), { force: true }).catch(() => undefined);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let item = this.queue.shift(); item; item = this.queue.shift()) {
        await this.build(item);
      }
    } finally {
      this.running = false;
    }
  }

  private async build(item: QueueItem): Promise<void> {
    const out = this.filePath(item.municipalityId, item.layerId);
    const tmp = `${out}.${Date.now()}.tmp.pmtiles`;
    const started = Date.now();
    try {
      await mkdir(path.dirname(out), { recursive: true });
      if (item.source.kind === 'vector') await this.buildVector(item.source, tmp);
      else await this.buildRaster(rasterFilePath(this.storageRoot, item.municipalityId, item.layerId), item.source, tmp);
      await rename(tmp, out);
      const size = (await stat(out)).size;
      await this.prisma.gISLayer.update({
        where: { id: item.layerId },
        data: { pmtilesStatus: 'READY', pmtilesBuiltAt: new Date(), pmtilesError: null },
      });
      this.logger.log(`PMTiles for ${item.layerId}: ${(size / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      const message = this.summarize(error);
      this.logger.warn(`PMTiles build of ${item.layerId} failed: ${message}`);
      await this.prisma.gISLayer
        .update({ where: { id: item.layerId }, data: { pmtilesStatus: 'FAILED', pmtilesError: message } })
        .catch(() => undefined);
    }
  }

  /** Vector: PostGIS -> MVT tiles. The max zoom keeps the tile count (set
   *  by the layer's EXTENT, not its feature count: one country-wide polygon
   *  covers millions of z14 tiles) and the per-tile load bounded; the
   *  browser over-zooms the last level. */
  private async buildVector(source: Extract<ArchiveSource, { kind: 'vector' }>, out: string): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<{ n: bigint; w: number | null; h: number | null }[]>(
      `SELECT n, ST_XMax(e) - ST_XMin(e) AS w, ST_YMax(e) - ST_YMin(e) AS h
         FROM (SELECT count(*) AS n, ST_Extent(ST_Transform(t.geom, 3857)) AS e FROM ${source.from} t) x`,
    );
    const count = Number(rows[0]?.n ?? 0);
    const w = Math.max(rows[0]?.w ?? 0, 1);
    const h = Math.max(rows[0]?.h ?? 0, 1);
    const world = 40_075_016.686;
    const tilesAt = (z: number) => Math.ceil(w / (world / 2 ** z)) * Math.ceil(h / (world / 2 ** z));
    let maxZoom = 14;
    while (maxZoom > 6 && tilesAt(maxZoom) > 40_000) maxZoom--;
    if (count > 500_000) maxZoom = Math.min(maxZoom, 11);
    else if (count > 100_000) maxZoom = Math.min(maxZoom, 12);
    this.logger.log(`PMTiles: ${count} features, ${tilesAt(maxZoom)} tiles at max zoom ${maxZoom}`);
    await run(
      'nice',
      [
        '-n', '19',
        'ogr2ogr', '-f', 'PMTiles', out, this.pgConnection(),
        '-sql', `SELECT * FROM ${source.from} t`,
        '-nln', source.layerName,
        '-dsco', `NAME=${source.layerName}`,
        '-dsco', 'MINZOOM=0',
        '-dsco', `MAXZOOM=${maxZoom}`,
        '-dsco', 'MAX_SIZE=1000000',
        '-dsco', 'MAX_FEATURES=500000',
      ],
      { timeout: 90 * 60_000, maxBuffer: 16 * 1024 * 1024 },
    );
  }

  /** Raster: PNG tiles in web mercator at the raster's native resolution.
   *  8-bit RGB(A) imagery is tiled as-is; data rasters (DEM, LST, indices,
   *  multi-band 16-bit) are tiled from GeoServer's STYLED rendering of the
   *  layer, so the archive looks exactly like the map. */
  private async buildRaster(
    cog: string,
    source: Extract<ArchiveSource, { kind: 'raster' }>,
    out: string,
  ): Promise<void> {
    const vrt = `${out}.3857.vrt`;
    const wms = `${out}.wms.xml`;
    try {
      const { stdout } = await run('gdalinfo', ['-json', cog], { maxBuffer: 64 * 1024 * 1024 });
      const bands = ((JSON.parse(stdout) as { bands?: { type?: string }[] }).bands ?? []);
      const imagery = (bands.length === 3 || bands.length === 4) && bands.every((b) => b.type === 'Byte');
      // Web-mercator footprint and native size of the raster.
      await run('gdalwarp', ['-q', '-of', 'VRT', '-t_srs', 'EPSG:3857', cog, vrt], { timeout: 5 * 60_000 });
      if (imagery) {
        await run('nice', ['-n', '19', 'gdal_translate', '-q', '-of', 'PMTiles', '-co', 'TILE_FORMAT=PNG', vrt, out], {
          timeout: 90 * 60_000,
        });
        return;
      }
      const info = JSON.parse((await run('gdalinfo', ['-json', vrt], { maxBuffer: 64 * 1024 * 1024 })).stdout) as {
        size: [number, number];
        geoTransform: number[];
      };
      const [w, h] = info.size;
      const [x0, dx, , y0, , dy] = info.geoTransform;
      const base = this.config.getOrThrow<string>('GEOSERVER_URL').replace(/\/+$/, '');
      const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const xml =
        `<GDAL_WMS><Service name="WMS"><Version>1.1.1</Version>` +
        `<ServerUrl>${esc(`${base}/${encodeURIComponent(source.workspace)}/wms?`)}</ServerUrl>` +
        `<SRS>EPSG:3857</SRS><ImageFormat>image/png</ImageFormat>` +
        `<Layers>${esc(`${source.workspace}:${source.layer}`)}</Layers><Styles></Styles><Transparent>TRUE</Transparent>` +
        `</Service><DataWindow><UpperLeftX>${x0}</UpperLeftX><UpperLeftY>${y0}</UpperLeftY>` +
        `<LowerRightX>${x0 + dx * w}</LowerRightX><LowerRightY>${y0 + dy * h}</LowerRightY>` +
        `<SizeX>${w}</SizeX><SizeY>${h}</SizeY></DataWindow>` +
        `<BandsCount>4</BandsCount><BlockSizeX>1024</BlockSizeX><BlockSizeY>1024</BlockSizeY>` +
        `<ZeroBlockHttpCodes>204,404</ZeroBlockHttpCodes></GDAL_WMS>`;
      await writeFile(wms, xml);
      await run('nice', ['-n', '19', 'gdal_translate', '-q', '-of', 'PMTiles', '-co', 'TILE_FORMAT=PNG', wms, out], {
        timeout: 90 * 60_000,
      });
    } finally {
      await rm(vrt, { force: true }).catch(() => undefined);
      await rm(wms, { force: true }).catch(() => undefined);
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

  /** One readable line, never the connection string. */
  private summarize(error: unknown): string {
    const e = error as { stderr?: string; message?: string };
    const line = (e.stderr || e.message || 'Build failed.')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('Warning'));
    return (line ?? 'Build failed.').replace(/PG:[^\s]*(\s+\w+='[^']*')*/g, 'PG:…').slice(0, 300);
  }
}
