import type { AppUser } from '../auth/types/app-user.type';
import type { RasterToolsService } from './raster-tools.service';
import {
  ChangeDetectionDto,
  ChangeMatrixDto,
  ClassifyDto,
  ClipDto,
  ContourDto,
  FillSinksDto,
  FloodDto,
  HeatmapDto,
  IdwDto,
  IndexSeriesDto,
  LandSurfaceTempDto,
  MosaicDto,
  NdviDto,
  OnlineRasterDto,
  PolygonizeDto,
  ProximityDto,
  RasterCalculatorDto,
  RasterizeDto,
  ReclassifyDto,
  ResampleDto,
  SpectralIndexDto,
  StreamNetworkDto,
  SupervisedClassifyDto,
  TerrainDto,
  ViewshedDto,
  WatershedDto,
  ZonalStatisticsDto,
} from './dto/raster.dto';

/** Module Access ids (seed-modules.ts, under Raster Analysis 69) a caller
 *  needs — any one of them — to use a raster endpoint. */
export const RASTER_MODULES = {
  upload: 911,
  style: 912,
  identify: 913,
  statistics: 914,
  mosaic: 915,
  resample: 916,
  rasterize: 917,
  download: 918,
  online: 919,
  profile: 921,
  slope: 922,
  aspect: 923,
  hillshade: 924,
  contour: 925,
  cutFill: 926,
  watershed: 927,
  flood: 928,
  lineOfSight: 929,
  viewshed: 930,
  ruggedness: 931,
  fillSinks: 932,
  streams: 933,
  view3d: 934,
  calculator: 942,
  reclassify: 943,
  clip: 944,
  polygonize: 945,
  zonal: 946,
  idw: 947,
  heatmap: 948,
  proximity: 949,
  swipe: 951,
  ndvi: 952,
  change: 953,
  spectralIndex: 954,
  classify: 955,
  indexSeries: 956,
  heatIsland: 957,
  supervised: 958,
  changeMatrix: 959,
} as const;

/** Every raster tool — e.g. reading a raster's info is needed by all. */
export const ANY_RASTER_MODULE: number[] = Object.values(RASTER_MODULES);

const TERRAIN_KIND_MODULES: Record<string, number> = {
  slope: RASTER_MODULES.slope,
  aspect: RASTER_MODULES.aspect,
  hillshade: RASTER_MODULES.hillshade,
  roughness: RASTER_MODULES.ruggedness,
  TRI: RASTER_MODULES.ruggedness,
  TPI: RASTER_MODULES.ruggedness,
};

/** Module ids for the terrain endpoint depend on the requested kind. */
export function terrainModules(body: unknown): number[] {
  const kind = (body as { kind?: unknown } | null)?.kind;
  const id = typeof kind === 'string' ? TERRAIN_KIND_MODULES[kind] : undefined;
  return id ? [id] : [RASTER_MODULES.slope, RASTER_MODULES.aspect, RASTER_MODULES.hillshade, RASTER_MODULES.ruggedness];
}

export interface RasterToolDef {
  /** DTO class the request body is validated against. */
  dto: new () => object;
  modules: number[] | ((body: unknown) => number[]);
  run: (tools: RasterToolsService, appUser: AppUser, dto: never) => Promise<unknown>;
}

/** Tools that publish a new layer — runnable as background jobs
 *  (POST /gis/raster/jobs/:tool); the key is the tool's endpoint name. */
export const RASTER_JOB_TOOLS: Record<string, RasterToolDef> = {
  terrain: { dto: TerrainDto, modules: terrainModules, run: (t, u, d: TerrainDto) => t.terrain(u, d) },
  contour: { dto: ContourDto, modules: [RASTER_MODULES.contour], run: (t, u, d: ContourDto) => t.contour(u, d) },
  watershed: { dto: WatershedDto, modules: [RASTER_MODULES.watershed], run: (t, u, d: WatershedDto) => t.watershed(u, d) },
  flood: { dto: FloodDto, modules: [RASTER_MODULES.flood], run: (t, u, d: FloodDto) => t.flood(u, d) },
  viewshed: { dto: ViewshedDto, modules: [RASTER_MODULES.viewshed], run: (t, u, d: ViewshedDto) => t.viewshed(u, d) },
  'fill-sinks': { dto: FillSinksDto, modules: [RASTER_MODULES.fillSinks], run: (t, u, d: FillSinksDto) => t.fillSinks(u, d) },
  calculator: { dto: RasterCalculatorDto, modules: [RASTER_MODULES.calculator], run: (t, u, d: RasterCalculatorDto) => t.calculator(u, d) },
  reclassify: { dto: ReclassifyDto, modules: [RASTER_MODULES.reclassify], run: (t, u, d: ReclassifyDto) => t.reclassify(u, d) },
  clip: { dto: ClipDto, modules: [RASTER_MODULES.clip], run: (t, u, d: ClipDto) => t.clip(u, d) },
  polygonize: { dto: PolygonizeDto, modules: [RASTER_MODULES.polygonize], run: (t, u, d: PolygonizeDto) => t.polygonize(u, d) },
  'zonal-statistics': { dto: ZonalStatisticsDto, modules: [RASTER_MODULES.zonal], run: (t, u, d: ZonalStatisticsDto) => t.zonalStatistics(u, d) },
  idw: { dto: IdwDto, modules: [RASTER_MODULES.idw], run: (t, u, d: IdwDto) => t.idw(u, d) },
  heatmap: { dto: HeatmapDto, modules: [RASTER_MODULES.heatmap], run: (t, u, d: HeatmapDto) => t.heatmap(u, d) },
  proximity: { dto: ProximityDto, modules: [RASTER_MODULES.proximity], run: (t, u, d: ProximityDto) => t.proximity(u, d) },
  mosaic: { dto: MosaicDto, modules: [RASTER_MODULES.mosaic], run: (t, u, d: MosaicDto) => t.mosaic(u, d) },
  resample: { dto: ResampleDto, modules: [RASTER_MODULES.resample], run: (t, u, d: ResampleDto) => t.resample(u, d) },
  rasterize: { dto: RasterizeDto, modules: [RASTER_MODULES.rasterize], run: (t, u, d: RasterizeDto) => t.rasterize(u, d) },
  ndvi: { dto: NdviDto, modules: [RASTER_MODULES.ndvi], run: (t, u, d: NdviDto) => t.ndvi(u, d) },
  'spectral-index': { dto: SpectralIndexDto, modules: [RASTER_MODULES.spectralIndex], run: (t, u, d: SpectralIndexDto) => t.spectralIndex(u, d) },
  classify: { dto: ClassifyDto, modules: [RASTER_MODULES.classify], run: (t, u, d: ClassifyDto) => t.classify(u, d) },
  'change-detection': { dto: ChangeDetectionDto, modules: [RASTER_MODULES.change], run: (t, u, d: ChangeDetectionDto) => t.changeDetection(u, d) },
  online: { dto: OnlineRasterDto, modules: [RASTER_MODULES.online], run: (t, u, d: OnlineRasterDto) => t.onlineRaster(u, d) },
  'index-series': { dto: IndexSeriesDto, modules: [RASTER_MODULES.indexSeries], run: (t, _u, d: IndexSeriesDto) => t.indexSeries(d) },
  'heat-island': { dto: LandSurfaceTempDto, modules: [RASTER_MODULES.heatIsland], run: (t, u, d: LandSurfaceTempDto) => t.landSurfaceTemperature(u, d) },
  'supervised-classify': { dto: SupervisedClassifyDto, modules: [RASTER_MODULES.supervised], run: (t, u, d: SupervisedClassifyDto) => t.supervisedClassify(u, d) },
  'change-matrix': { dto: ChangeMatrixDto, modules: [RASTER_MODULES.changeMatrix], run: (t, u, d: ChangeMatrixDto) => t.changeMatrix(u, d) },
  streams: { dto: StreamNetworkDto, modules: [RASTER_MODULES.streams], run: (t, u, d: StreamNetworkDto) => t.streamNetwork(u, d) },
};
