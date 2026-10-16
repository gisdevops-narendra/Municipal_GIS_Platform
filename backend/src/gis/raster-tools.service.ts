import { BadRequestException, Injectable } from '@nestjs/common';
import { mkdir, readFile } from 'fs/promises';
import { dirname } from 'path';
import type { GisGeometryType } from '@prisma/client';
import type { AppUser } from '../auth/types/app-user.type';
import { RasterService, type RasterStats } from './raster.service';
import type { RasterStyleSpec } from './raster-style';
import type {
  ChangeDetectionDto,
  ChangeMatrixDto,
  ClassifyDto,
  ClipDto,
  FillSinksDto,
  HeatmapDto,
  IndexSeriesDto,
  LandSurfaceTempDto,
  IdwDto,
  MosaicDto,
  OnlineRasterDto,
  SentinelPreviewDto,
  SentinelSearchDto,
  ProximityDto,
  RasterizeDto,
  RasterStatisticsDto,
  ResampleDto,
  SpectralIndexDto,
  StreamNetworkDto,
  SupervisedClassifyDto,
  ZonalStatisticsDto,
  ContourDto,
  CutFillDto,
  FloodDto,
  LineOfSightDto,
  NdviDto,
  PolygonizeDto,
  ProfileDto,
  RasterCalculatorDto,
  ReclassifyDto,
  TerrainDto,
  ViewshedDto,
  WatershedDto,
} from './dto/raster.dto';

/** Functions a Raster Calculator expression may call (raster_ops.py). */
const CALC_FUNCTIONS = new Set([
  'where', 'sqrt', 'log', 'log10', 'exp', 'abs', 'minimum', 'maximum',
  'sin', 'cos', 'tan', 'logical_and', 'logical_or', 'logical_not',
]);

/** Yellow → red, for zonal choropleths (up to 5 classes). */
const CHOROPLETH = ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'];

/** ESA WorldCover legend colours. */
const WORLDCOVER_COLORS: Record<number, string> = {
  10: '#006400', 20: '#ffbb22', 30: '#ffff4c', 40: '#f096ff', 50: '#fa0000', 60: '#b4b4b4',
  70: '#f0f0f0', 80: '#0064c8', 90: '#0096a0', 95: '#00cf75', 100: '#fae6a0',
};

/** Reclassify / class colours, in rule order. */
const CLASS_COLORS = [
  '#1a9850', '#fee08b', '#d73027', '#4575b4', '#984ea3',
  '#ff7f00', '#a65628', '#f781bf', '#66c2a5', '#999999',
];

const span = (s: RasterStats, fallback: [number, number]): [number, number] => {
  const lo = s.p2 ?? s.min ?? fallback[0];
  const hi = s.p98 ?? s.max ?? fallback[1];
  return hi > lo ? [lo, hi] : [lo, lo + 1];
};

/**
 * Raster Analysis tools — Terrain Analysis, Raster Analytics and Imagery
 * Analysis. Each method VIEW-checks its input rasters, runs one
 * raster_ops.py operation, and either returns the numbers directly
 * (profile, volumes, line of sight) or publishes the output as a new
 * raster / vector layer with a style that suits it.
 */
@Injectable()
export class RasterToolsService {
  constructor(private readonly rasters: RasterService) {}

  // ----- Terrain Analysis -----

  async terrain(appUser: AppUser, dto: TerrainDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const r = await this.rasters.runOp<{ stats: RasterStats }>({
        op: 'terrain', path: file, output, band: dto.band ?? 1, kind: dto.kind,
        zFactor: dto.zFactor, azimuth: dto.azimuth, altitude: dto.altitude, percent: dto.percent,
      });
      const [lo, hi] = span(r.stats, [0, 45]);
      const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
      const style: RasterStyleSpec =
        dto.kind === 'hillshade'
          ? { mode: 'ramp', ramp: 'grayscale', min: 0, max: 255 }
          : dto.kind === 'aspect'
            ? { mode: 'ramp', ramp: 'aspect', min: 0, max: 360 }
            : dto.kind === 'TPI'
              ? { mode: 'ramp', ramp: 'diverging', min: -m, max: m }
              : { mode: 'ramp', ramp: 'heat', min: 0, max: hi };
      return { style, result: { stats: r.stats } };
    });
  }

  async contour(appUser: AppUser, dto: ContourDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    return this.toVectorLayer(appUser, dto.outputName, 'LINE', (output) =>
      this.rasters.runOp({ op: 'contour', path: file, output, band: dto.band ?? 1, interval: dto.interval, base: dto.base ?? 0 }),
    );
  }

  async profile(appUser: AppUser, dto: ProfileDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    return this.rasters.runOp({ op: 'profile', path: file, band: dto.band ?? 1, line: dto.line, samples: dto.samples ?? 200 });
  }

  async cutFill(appUser: AppUser, dto: CutFillDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    return this.rasters.runOp({ op: 'cut_fill', path: file, band: dto.band ?? 1, polygon: dto.polygon, baseLevel: dto.baseLevel });
  }

  async watershed(appUser: AppUser, dto: WatershedDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    if (dto.mode === 'watershed') {
      if (!dto.point) throw new BadRequestException('Pick the pour point (outlet) on the map.');
      return this.toVectorLayer(appUser, dto.outputName, 'POLYGON', (output) =>
        this.rasters.runOp({ op: 'watershed', mode: 'watershed', path: file, band: dto.band ?? 1, point: dto.point, output }),
      );
    }
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const r = await this.rasters.runOp<{ stats: RasterStats; maxUpstreamKm2: number; resampled: boolean }>({
        op: 'watershed', mode: 'accumulation', path: file, band: dto.band ?? 1, output,
      });
      // stats are of log10(km²): stretch the ramp over the main channels.
      const max = Math.pow(10, r.stats.p98 ?? 0);
      return {
        style: { mode: 'ramp', ramp: 'water', min: max / 100, max },
        result: { maxUpstreamKm2: r.maxUpstreamKm2, resampled: r.resampled },
      };
    });
  }

  async flood(appUser: AppUser, dto: FloodDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const r = await this.rasters.runOp<Record<string, number> & { stats: RasterStats }>({
        op: 'flood', path: file, band: dto.band ?? 1, level: dto.level, seed: dto.seed, output,
      });
      const { stats, ...result } = r;
      return { style: { mode: 'ramp', ramp: 'water', min: 0, max: stats.max ?? 1, opacity: 0.8 }, result };
    });
  }

  async lineOfSight(appUser: AppUser, dto: LineOfSightDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    return this.rasters.runOp({
      op: 'line_of_sight', path: file, band: dto.band ?? 1, from: dto.from, to: dto.to,
      observerHeight: dto.observerHeight ?? 1.7, targetHeight: dto.targetHeight ?? 0,
    });
  }

  async viewshed(appUser: AppUser, dto: ViewshedDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    if ((dto.points?.length ?? 0) > 1) {
      const points = dto.points!.filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
      return this.toRasterLayer(appUser, dto.outputName, async (output) => {
        const r = await this.rasters.runOp<{ maxObservers: number }>({
          op: 'viewshed_multi', path: file, band: dto.band ?? 1, points, output,
          observerHeight: dto.observerHeight ?? 1.7, targetHeight: dto.targetHeight ?? 0, maxDistance: dto.maxDistance,
        });
        return {
          style: { mode: 'ramp', ramp: 'heat', min: 1, max: Math.max(r.maxObservers, 2), opacity: 0.7 },
          result: r,
        };
      });
    }
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const result = await this.rasters.runOp({
        op: 'viewshed', path: file, band: dto.band ?? 1, point: dto.point, output,
        observerHeight: dto.observerHeight ?? 1.7, targetHeight: dto.targetHeight ?? 0, maxDistance: dto.maxDistance,
      });
      const style: RasterStyleSpec = {
        mode: 'values',
        classes: [
          { value: 0, color: '#d7191c', label: 'Not visible', opacity: 0.35 },
          { value: 1, color: '#1a9641', label: 'Visible', opacity: 0.65 },
        ],
      };
      return { style, result };
    });
  }

  async fillSinks(appUser: AppUser, dto: FillSinksDto) {
    const { file, layer } = await this.rasters.resolveRaster(appUser, dto.layerId);
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const { stats, ...result } = await this.rasters.runOp<Record<string, number> & { stats: RasterStats }>({
        op: 'fill_sinks', path: file, band: dto.band ?? 1, output,
      });
      const [min, max] = span(stats, [0, 1]);
      const style = (layer.styleSpec as RasterStyleSpec | null) ?? { mode: 'ramp', ramp: 'terrain', min, max };
      return { style: { ...style, band: 1 } as RasterStyleSpec, result: { ...result, stats } };
    });
  }

  // ----- Raster Data -----

  async statistics(appUser: AppUser, dto: RasterStatisticsDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    return this.rasters.runOp({ op: 'statistics', path: file, band: dto.band ?? 1, bins: dto.bins ?? 32 });
  }

  async mosaic(appUser: AppUser, dto: MosaicDto) {
    const paths: string[] = [];
    let style: RasterStyleSpec | undefined;
    for (const id of new Set(dto.layerIds)) {
      const { file, layer } = await this.rasters.resolveRaster(appUser, id);
      paths.push(file);
      style ??= (layer.styleSpec as RasterStyleSpec | null) ?? undefined;
    }
    if (paths.length < 2) throw new BadRequestException('Choose at least two different rasters.');
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const result = await this.rasters.runOp({ op: 'mosaic', paths, resampling: dto.resampling ?? 'bilinear', output });
      return { style, result };
    });
  }

  async resample(appUser: AppUser, dto: ResampleDto) {
    const { file, layer } = await this.rasters.resolveRaster(appUser, dto.layerId);
    if (!dto.pixelSize && (!dto.targetCrs || dto.targetCrs === 'same')) {
      throw new BadRequestException('Set a new pixel size and/or a different coordinate system.');
    }
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const result = await this.rasters.runOp({
        op: 'resample', path: file, output, pixelSize: dto.pixelSize,
        targetCrs: dto.targetCrs ?? 'same', resampling: dto.resampling ?? 'bilinear',
      });
      return { style: (layer.styleSpec as RasterStyleSpec | null) ?? undefined, result };
    });
  }

  async rasterize(appUser: AppUser, dto: RasterizeDto) {
    const { source } = await this.rasters.resolveVector(appUser, dto.vectorLayerId);
    await this.rasters.assertField(appUser, dto.vectorLayerId, dto.field, true);
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const r = await this.rasters.runOp<{ stats: RasterStats }>({
        op: 'rasterize', vector: source, field: dto.field, pixelSize: dto.pixelSize,
        allTouched: dto.allTouched ?? false, output,
      });
      const [min, max] = span(r.stats, [0, 1]);
      const style: RasterStyleSpec = dto.field
        ? { mode: 'ramp', ramp: 'spectral', min, max }
        : { mode: 'values', classes: [{ value: 1, color: '#2563eb', label: 'Inside', opacity: 0.7 }] };
      return { style, result: r };
    });
  }

  // ----- Raster Analytics -----

  async zonalStatistics(appUser: AppUser, dto: ZonalStatisticsDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    const { source } = await this.rasters.resolveVector(appUser, dto.zonesLayerId);
    await this.rasters.assertField(appUser, dto.zonesLayerId, dto.labelField, false);
    const request = {
      op: 'zonal', path: file, band: dto.band ?? 1, vector: source,
      labelField: dto.labelField, allTouched: dto.allTouched ?? false,
    };
    if (!dto.outputName?.trim()) return { result: await this.rasters.runOp({ ...request }) };
    const published = await this.toVectorLayer(appUser, dto.outputName.trim(), 'POLYGON', (output) =>
      this.rasters.runOp<{ breaks: number[] }>({ ...request, output }),
    );
    // A ready-made choropleth of the zone means.
    const breaks = (published.result as { breaks?: number[] }).breaks ?? [];
    if (breaks.length >= 3) {
      const count = breaks.length - 1;
      await this.rasters.applyVectorStyle(published.layer.id, {
        version: 1,
        geometry: 'polygon',
        mode: 'graduated',
        symbol: { fillColor: '#cccccc', fillOpacity: 0.75, strokeColor: '#555555', strokeWidth: 0.6 },
        graduate: { field: 'z_mean', method: 'quantile', classCount: count, breaks, ramp: CHOROPLETH.slice(-count) },
      });
    }
    return published;
  }

  async idw(appUser: AppUser, dto: IdwDto) {
    const { source } = await this.rasters.resolveVector(appUser, dto.vectorLayerId);
    await this.rasters.assertField(appUser, dto.vectorLayerId, dto.field, true);
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const r = await this.rasters.runOp<{ stats: RasterStats; points: number }>({
        op: 'idw', vector: source, field: dto.field, pixelSize: dto.pixelSize,
        power: dto.power ?? 2, maxPoints: dto.maxPoints ?? 12, output,
      });
      const [min, max] = span(r.stats, [0, 1]);
      return { style: { mode: 'ramp', ramp: 'spectral', min, max, invert: true, opacity: 0.85 }, result: r };
    });
  }

  async heatmap(appUser: AppUser, dto: HeatmapDto) {
    const { source } = await this.rasters.resolveVector(appUser, dto.vectorLayerId);
    await this.rasters.assertField(appUser, dto.vectorLayerId, dto.weightField, true);
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const r = await this.rasters.runOp<{ stats: RasterStats; peakPerKm2: number }>({
        op: 'heatmap', vector: source, weightField: dto.weightField, pixelSize: dto.pixelSize,
        radius: dto.radius, output,
      });
      return { style: { mode: 'ramp', ramp: 'heat', min: 0, max: r.stats.p98 ?? r.peakPerKm2, opacity: 0.8 }, result: r };
    });
  }

  async proximity(appUser: AppUser, dto: ProximityDto) {
    const { source } = await this.rasters.resolveVector(appUser, dto.vectorLayerId);
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const r = await this.rasters.runOp({
        op: 'proximity', vector: source, pixelSize: dto.pixelSize, maxDistance: dto.maxDistance, output,
      });
      return { style: { mode: 'ramp', ramp: 'heat', min: 0, max: dto.maxDistance, invert: true, opacity: 0.75 }, result: r };
    });
  }


  async calculator(appUser: AppUser, dto: RasterCalculatorDto) {
    this.assertExpression(dto.expression, dto.inputs.length);
    const inputs: { path: string; band: number }[] = [];
    for (const input of dto.inputs) {
      const { file } = await this.rasters.resolveRaster(appUser, input.layerId);
      inputs.push({ path: file, band: input.band ?? 1 });
    }
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const r = await this.rasters.runOp<{ stats: RasterStats }>({ op: 'calc', inputs, expression: dto.expression, output });
      const [min, max] = span(r.stats, [0, 1]);
      return { style: { mode: 'ramp', ramp: 'spectral', min, max }, result: { stats: r.stats } };
    });
  }

  async reclassify(appUser: AppUser, dto: ReclassifyDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    for (const rule of dto.rules) {
      if (!(rule.max > rule.min)) throw new BadRequestException('Each range needs "to" greater than "from".');
    }
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const result = await this.rasters.runOp({ op: 'reclassify', path: file, band: dto.band ?? 1, rules: dto.rules, output });
      const values = [...new Map(dto.rules.map((r) => [r.value, r])).values()];
      const style: RasterStyleSpec = {
        mode: 'values',
        classes: values.map((r, i) => ({
          value: r.value,
          color: CLASS_COLORS[i % CLASS_COLORS.length],
          label: r.label || String(r.value),
        })),
      };
      return { style, result };
    });
  }

  async clip(appUser: AppUser, dto: ClipDto) {
    const { file, layer } = await this.rasters.resolveRaster(appUser, dto.layerId);
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const result = await this.rasters.runOp({ op: 'clip', path: file, polygon: dto.polygon, output });
      return { style: (layer.styleSpec as RasterStyleSpec | null) ?? undefined, result };
    });
  }

  async polygonize(appUser: AppUser, dto: PolygonizeDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    return this.toVectorLayer(appUser, dto.outputName, 'POLYGON', (output) =>
      this.rasters.runOp({ op: 'polygonize', path: file, band: dto.band ?? 1, output }),
    );
  }

  // ----- Imagery Analysis -----

  async ndvi(appUser: AppUser, dto: NdviDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const { stats, ...result } = await this.rasters.runOp<Record<string, number> & { stats: RasterStats }>({
        op: 'ndvi', path: file, redBand: dto.redBand, nirBand: dto.nirBand, output,
      });
      return { style: { mode: 'ramp', ramp: 'ndvi', min: -0.2, max: 0.9 }, result: { ...result, stats } };
    });
  }

  async changeDetection(appUser: AppUser, dto: ChangeDetectionDto) {
    const before = await this.rasters.resolveRaster(appUser, dto.beforeLayerId);
    const after = await this.rasters.resolveRaster(appUser, dto.afterLayerId);
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const { stats, ...result } = await this.rasters.runOp<Record<string, number> & { stats: RasterStats }>({
        op: 'change',
        before: { path: before.file, band: dto.beforeBand ?? 1 },
        after: { path: after.file, band: dto.afterBand ?? 1 },
        threshold: dto.threshold ?? 0,
        output,
      });
      const [lo, hi] = span(stats, [-1, 1]);
      const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
      return { style: { mode: 'ramp', ramp: 'diverging', min: -m, max: m }, result: { ...result, stats } };
    });
  }

  async spectralIndex(appUser: AppUser, dto: SpectralIndexDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const { stats, ...result } = await this.rasters.runOp<Record<string, number> & { stats: RasterStats }>({
        op: 'index', path: file, kind: dto.kind, bandA: dto.bandA, bandB: dto.bandB,
        soilFactor: dto.soilFactor ?? 0.5, output,
      });
      const style: RasterStyleSpec =
        dto.kind === 'ndwi'
          ? { mode: 'ramp', ramp: 'water', min: -0.3, max: 0.6 }
          : dto.kind === 'ndbi'
            ? { mode: 'ramp', ramp: 'heat', min: -0.3, max: 0.4 }
            : { mode: 'ramp', ramp: 'ndvi', min: -0.2, max: 0.9 };
      return { style, result: { ...result, stats } };
    });
  }

  async classify(appUser: AppUser, dto: ClassifyDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const result = await this.rasters.runOp<{ classes: { value: number; label: string }[] }>({
        op: 'classify', path: file, classes: dto.classes, bands: dto.bands, output,
      });
      const style: RasterStyleSpec = {
        mode: 'values',
        classes: result.classes.map((c, i) => ({ value: c.value, color: CLASS_COLORS[i % CLASS_COLORS.length], label: c.label })),
      };
      return { style, result };
    });
  }

  // ----- Online Data -----

  /** Sentinel-2 L2A scenes over the area (Earth Search STAC, no key). */
  async sentinelSearch(dto: SentinelSearchDto) {
    this.assertBbox(dto.bbox);
    if (dto.from > dto.to) throw new BadRequestException('"From" must be before "To".');
    return this.rasters.runOp({ op: 'stac_search', bbox: dto.bbox, from: dto.from, to: dto.to, maxCloud: dto.maxCloud ?? 20 });
  }

  /** PNG quick-look of a scene over the area (EPSG:4326 bbox). */
  async sentinelPreview(appUser: AppUser, dto: SentinelPreviewDto): Promise<Buffer> {
    this.assertBbox(dto.bbox);
    const output = this.rasters.tempPath(appUser.municipalityId, '.png');
    await this.ensureDir(output);
    try {
      await this.rasters.runOp({ op: 'stac_preview', sceneId: dto.sceneId, bbox: dto.bbox, output });
      return await readFile(output);
    } finally {
      await this.rasters.removeTemp(output, `${output}.aux.xml`);
    }
  }

  /** Downloads open data (Copernicus DEM, ESA WorldCover, Sentinel-2) for
   *  the area and publishes it as a raster layer. */
  async onlineRaster(appUser: AppUser, dto: OnlineRasterDto) {
    this.assertBbox(dto.bbox);
    if (dto.source === 'sentinel2' && !dto.sceneId) {
      throw new BadRequestException('Search and pick a Sentinel-2 scene first.');
    }
    const request = { bbox: dto.bbox, polygon: dto.polygon, sceneId: dto.sceneId, maskClouds: dto.maskClouds ?? true };
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      if (dto.source === 'dem') {
        const r = await this.rasters.runOp<{ stats: RasterStats }>({ op: 'online_dem', ...request, output });
        const [min, max] = span(r.stats, [0, 100]);
        return { style: { mode: 'ramp', ramp: 'terrain', min, max }, result: r };
      }
      if (dto.source === 'landcover') {
        const r = await this.rasters.runOp<{ classes: { value: number; label: string }[] }>({ op: 'online_landcover', ...request, output });
        const style: RasterStyleSpec = {
          mode: 'values',
          classes: r.classes.map((c) => ({ value: c.value, color: WORLDCOVER_COLORS[c.value] ?? '#999999', label: c.label })),
        };
        return { style, result: r };
      }
      if (dto.source === 'population') {
        const r = await this.rasters.runOp<{ stats: RasterStats }>({ op: 'online_population', ...request, output });
        return { style: { mode: 'ramp', ramp: 'heat', min: 0, max: r.stats.p98 ?? r.stats.max ?? 10, opacity: 0.85 }, result: r };
      }
      if (dto.source === 'water') {
        const r = await this.rasters.runOp({ op: 'online_water', ...request, output });
        return { style: { mode: 'ramp', ramp: 'water', min: 1, max: 100 }, result: r };
      }
      if (dto.source === 'composite') {
        if (!dto.from || !dto.to) throw new BadRequestException('Choose the date range for the composite.');
        const r = await this.rasters.runOp({
          op: 's2_composite', ...request, from: dto.from, to: dto.to,
          maxCloud: dto.maxCloud ?? 60, maxScenes: dto.maxScenes ?? 10, output,
        });
        return { style: { mode: 'rgb', bands: [3, 2, 1], stretch: 'histogram' }, result: r };
      }
      const r = await this.rasters.runOp({ op: 'stac_fetch', ...request, output });
      return { style: { mode: 'rgb', bands: [3, 2, 1], stretch: 'histogram' }, result: r };
    });
  }

  // ----- Imagery (v2) -----

  /** Mean index per clear Sentinel-2 date over a point / area. */
  async indexSeries(dto: IndexSeriesDto) {
    this.assertBbox(dto.bbox);
    if (dto.from > dto.to) throw new BadRequestException('"From" must be before "To".');
    return this.rasters.runOp({
      op: 'index_series', bbox: dto.bbox, polygon: dto.polygon, kind: dto.kind,
      from: dto.from, to: dto.to, maxCloud: dto.maxCloud ?? 60,
    });
  }

  /** Urban heat island: median Landsat 8/9 land surface temperature (°C). */
  async landSurfaceTemperature(appUser: AppUser, dto: LandSurfaceTempDto) {
    this.assertBbox(dto.bbox);
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const { stats, ...result } = await this.rasters.runOp<Record<string, unknown> & { stats: RasterStats }>({
        op: 'lst', bbox: dto.bbox, polygon: dto.polygon, from: dto.from, to: dto.to,
        maxCloud: dto.maxCloud ?? 30, output,
      });
      const [min, max] = span(stats, [20, 50]);
      return { style: { mode: 'ramp', ramp: 'heat', min, max, opacity: 0.8 }, result: { ...result, stats } };
    });
  }

  async supervisedClassify(appUser: AppUser, dto: SupervisedClassifyDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const result = await this.rasters.runOp<{ classes: { value: number; label: string }[] }>({
        op: 'supervised', path: file, method: dto.method ?? 'maxlike',
        classes: dto.classes.map((c) => ({ label: c.label, geometry: c.geometry })), output,
      });
      const style: RasterStyleSpec = {
        mode: 'values',
        classes: result.classes.map((c, i) => ({
          value: c.value,
          color: dto.classes[i]?.color ?? CLASS_COLORS[i % CLASS_COLORS.length],
          label: c.label,
        })),
      };
      return { style, result };
    });
  }

  /** From → to areas between two categorical rasters (e.g. two land-cover
   *  years); publishes the changed pixels coded by transition. */
  async changeMatrix(appUser: AppUser, dto: ChangeMatrixDto) {
    const before = await this.rasters.resolveRaster(appUser, dto.beforeLayerId);
    const after = await this.rasters.resolveRaster(appUser, dto.afterLayerId);
    const labelsOf = (spec: unknown) =>
      new Map(((spec as RasterStyleSpec | null)?.classes ?? []).map((c) => [c.value, c.label ?? String(c.value)]));
    const fromLabels = labelsOf(before.layer.styleSpec);
    const toLabels = labelsOf(after.layer.styleSpec);
    const name = (labels: Map<number, string>, v: number) => labels.get(v) ?? String(v);
    return this.toRasterLayer(appUser, dto.outputName, async (output) => {
      const r = await this.rasters.runOp<{
        transitions: { from: number; to: number; areaM2: number }[];
        codes: { value: number; from: number; to: number }[];
      }>({ op: 'change_matrix', before: before.file, after: after.file, output });
      const style: RasterStyleSpec = {
        mode: 'values',
        classes: r.codes.slice(0, 60).map((c, i) => ({
          value: c.value,
          color: CLASS_COLORS[i % CLASS_COLORS.length],
          label: `${name(fromLabels, c.from)} → ${name(toLabels, c.to)}`,
        })),
      };
      return {
        style,
        result: {
          ...r,
          transitions: r.transitions.map((t) => ({ ...t, fromLabel: name(fromLabels, t.from), toLabel: name(toLabels, t.to) })),
        },
      };
    });
  }

  // ----- Terrain (v2) -----

  async streamNetwork(appUser: AppUser, dto: StreamNetworkDto) {
    const { file } = await this.rasters.resolveRaster(appUser, dto.layerId);
    return this.toVectorLayer(appUser, dto.outputName, 'LINE', (output) =>
      this.rasters.runOp({ op: 'streams', path: file, band: dto.band ?? 1, thresholdKm2: dto.thresholdKm2, output }),
    );
  }

  private assertBbox(bbox: [number, number, number, number]): void {
    const [minX, minY, maxX, maxY] = bbox;
    if (!(minX < maxX && minY < maxY) || minY < -90 || maxY > 90) {
      throw new BadRequestException('The area is not a valid longitude / latitude box.');
    }
  }

  // ----- helpers -----

  private async toRasterLayer(
    appUser: AppUser,
    name: string,
    run: (output: string) => Promise<{ style?: RasterStyleSpec; result: unknown }>,
  ) {
    const output = this.rasters.tempPath(appUser.municipalityId, '.tif');
    await this.ensureDir(output);
    try {
      const { style, result } = await run(output);
      const layer = await this.rasters.createRasterLayer(appUser, { name, sourcePath: output, style });
      return { layer, result };
    } finally {
      await this.rasters.removeTemp(output, `${output}.aux.xml`);
    }
  }

  private async toVectorLayer(
    appUser: AppUser,
    name: string,
    geometryType: GisGeometryType,
    run: (output: string) => Promise<unknown>,
  ) {
    const output = this.rasters.tempPath(appUser.municipalityId, '.gpkg');
    await this.ensureDir(output);
    try {
      const result = await run(output);
      const layer = await this.rasters.createVectorLayer(appUser, { name, sourcePath: output, geometryType });
      return { layer, result };
    } finally {
      await this.rasters.removeTemp(output);
    }
  }

  private async ensureDir(file: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
  }

  /** Only band letters, numbers, operators and whitelisted functions — the
   *  expression is evaluated by numpy with no builtins available. */
  private assertExpression(expression: string, inputCount: number): void {
    if (!/^[\w\s+\-*/%().,<>=!&|~]+$/.test(expression) || expression.includes('__')) {
      throw new BadRequestException('The expression contains characters that are not allowed.');
    }
    const letters = 'ABCDEF'.slice(0, inputCount);
    for (const word of expression.match(/[A-Za-z_]\w*/g) ?? []) {
      if (word.length === 1 && letters.includes(word)) continue;
      if (CALC_FUNCTIONS.has(word)) continue;
      throw new BadRequestException(
        `"${word}" is not allowed — use ${letters.split('').join(', ')} and ${[...CALC_FUNCTIONS].join(', ')}.`,
      );
    }
  }
}
