import { BadRequestException, Injectable } from '@nestjs/common';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { GisGeometryType } from '@prisma/client';
import type { AppUser } from '../auth/types/app-user.type';
import { RasterService, type RasterStats } from './raster.service';
import type { RasterStyleSpec } from './raster-style';
import type {
  ChangeDetectionDto,
  ClipDto,
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
      const style: RasterStyleSpec =
        dto.kind === 'hillshade'
          ? { mode: 'ramp', ramp: 'grayscale', min: 0, max: 255 }
          : dto.kind === 'aspect'
            ? { mode: 'ramp', ramp: 'aspect', min: 0, max: 360 }
            : { mode: 'ramp', ramp: 'heat', min: 0, max: span(r.stats, [0, 45])[1] };
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

  // ----- Raster Analytics -----

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
    const letters = 'ABCD'.slice(0, inputCount);
    for (const word of expression.match(/[A-Za-z_]\w*/g) ?? []) {
      if (word.length === 1 && letters.includes(word)) continue;
      if (CALC_FUNCTIONS.has(word)) continue;
      throw new BadRequestException(
        `"${word}" is not allowed — use ${letters.split('').join(', ')} and ${[...CALC_FUNCTIONS].join(', ')}.`,
      );
    }
  }
}
