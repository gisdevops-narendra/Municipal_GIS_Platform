import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { diskStorage } from 'multer';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { extname } from 'path';
import { RasterService } from './raster.service';
import { RasterJobsService } from './raster-jobs.service';
import { RasterMonitorService } from './raster-monitor.service';
import { RasterWorkspaceService } from './raster-workspace.service';
import { RequireRasterModule } from './raster-module.guard';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { ANY_RASTER_MODULE, RASTER_MODULES, terrainModules } from './raster-tool-registry';
import { RasterToolsService } from './raster-tools.service';
import {
  ChangeDetectionDto,
  CreateMonitorDto,
  CreatePinDto,
  CreateWorkflowDto,
  RunWorkflowDto,
  MonitorActiveDto,
  ClassifyDto,
  ClipDto,
  FillSinksDto,
  HeatmapDto,
  IdwDto,
  MosaicDto,
  OnlineRasterDto,
  SentinelPreviewDto,
  SentinelSearchDto,
  ImageryCoverageDto,
  ProximityDto,
  RasterizeDto,
  RasterStatisticsDto,
  ResampleDto,
  SpectralIndexDto,
  ZonalStatisticsDto,
  ContourDto,
  CutFillDto,
  FloodDto,
  LineOfSightDto,
  NdviDto,
  PointDto,
  PolygonizeDto,
  ProfileDto,
  RasterCalculatorDto,
  RasterStyleDto,
  RasterUploadDto,
  ReclassifyDto,
  TerrainDto,
  ViewshedDto,
  WatershedDto,
} from './dto/raster.dto';

const UPLOAD_TMP_DIR = `${process.env.GIS_UPLOAD_STORAGE_DIR ?? './storage/uploads'}/tmp-uploads`;
/** Rasters get their own, larger cap: drone / SVAMITVA orthophotos run to
 *  several GB (written straight to disk, never held in memory). */
const MAX_RASTER_BYTES =
  Number(process.env.GIS_RASTER_MAX_FILE_SIZE_MB ?? process.env.GIS_UPLOAD_MAX_FILE_SIZE_MB ?? '8192') * 1024 * 1024;

/** Raster Analysis. Every call VIEW-checks the rasters it reads; tools
 *  that create a layer need the caller's UPLOAD permission. */
@Controller('gis/raster')
export class RasterController {
  constructor(
    private readonly rasters: RasterService,
    private readonly tools: RasterToolsService,
    private readonly jobs: RasterJobsService,
    private readonly monitors: RasterMonitorService,
    private readonly workspace: RasterWorkspaceService,
  ) {}

  // ----- Saved analysis report of an output layer -----

  /** Save the results-screen report (any raster tool user; the service
   *  only allows the job's own user or the Owner). */
  @RequireRasterModule(Object.values(RASTER_MODULES))
  @Put('layers/:layerId/report')
  saveReport(
    @CurrentAppUser() appUser: AppUser,
    @Param('layerId') layerId: string,
    @Body() body: { report: Record<string, unknown> },
  ) {
    if (!body?.report || typeof body.report !== 'object' || JSON.stringify(body.report).length > 200_000) {
      throw new BadRequestException('A report object (under 200 KB) is required.');
    }
    return this.jobs.saveReport(appUser, layerId, body.report);
  }

  /** Reopen it later — anyone who may view the layer. */
  @RequireMunicipalityMember()
  @Get('layers/:layerId/report')
  async getReport(@CurrentAppUser() appUser: AppUser, @Param('layerId') layerId: string) {
    await this.rasters.assertCanView(appUser, layerId); // raster or vector output
    return this.jobs.getReport(appUser, layerId);
  }

  // ----- Workspace: workflows, history, storage, pins -----

  @RequireRasterModule([RASTER_MODULES.workflows])
  @Get('workflows')
  listWorkflows(@CurrentAppUser() appUser: AppUser) {
    return this.workspace.listWorkflows(appUser);
  }

  @RequireRasterModule([RASTER_MODULES.workflows])
  @Post('workflows')
  createWorkflow(@CurrentAppUser() appUser: AppUser, @Body() dto: CreateWorkflowDto) {
    return this.workspace.createWorkflow(appUser, dto.name, dto.steps);
  }

  @RequireRasterModule([RASTER_MODULES.workflows])
  @Delete('workflows/:id')
  @HttpCode(204)
  async deleteWorkflow(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.workspace.deleteWorkflow(appUser, id);
  }

  @RequireRasterModule([RASTER_MODULES.workflows])
  @Post('workflows/:id/run')
  runWorkflow(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RunWorkflowDto) {
    return this.workspace.runWorkflow(appUser, id, dto.inputLayerId);
  }

  @RequireRasterModule([RASTER_MODULES.history])
  @Get('history')
  history(@CurrentAppUser() appUser: AppUser) {
    return this.jobs.history(appUser);
  }

  @RequireRasterModule([RASTER_MODULES.storage])
  @Get('storage')
  storage(@CurrentAppUser() appUser: AppUser) {
    return this.workspace.storage(appUser);
  }

  @RequireRasterModule([RASTER_MODULES.storage])
  @Post('storage/cleanup')
  @HttpCode(200)
  cleanupStorage(@CurrentAppUser() appUser: AppUser) {
    return this.workspace.cleanup(appUser);
  }

  /** Dashboard pins are read by every member (the Dashboard shows them). */
  @RequireRasterModule(ANY_RASTER_MODULE)
  @Get('pins')
  listPins(@CurrentAppUser() appUser: AppUser) {
    return this.workspace.listPins(appUser);
  }

  @RequireRasterModule([RASTER_MODULES.dashboardPins])
  @Post('pins')
  createPin(@CurrentAppUser() appUser: AppUser, @Body() dto: CreatePinDto) {
    return this.workspace.createPin(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.dashboardPins])
  @Delete('pins/:id')
  @HttpCode(204)
  async deletePin(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.workspace.deletePin(appUser, id);
  }

  // ----- Automatic Monitoring -----

  @RequireRasterModule([RASTER_MODULES.monitoring])
  @Get('monitors')
  listMonitors(@CurrentAppUser() appUser: AppUser) {
    return this.monitors.list(appUser);
  }

  @RequireRasterModule([RASTER_MODULES.monitoring])
  @Post('monitors')
  createMonitor(@CurrentAppUser() appUser: AppUser, @Body() dto: CreateMonitorDto) {
    return this.monitors.create(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.monitoring])
  @Delete('monitors/:id')
  @HttpCode(204)
  async deleteMonitor(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.monitors.remove(appUser, id);
  }

  @RequireRasterModule([RASTER_MODULES.monitoring])
  @Put('monitors/:id/active')
  setMonitorActive(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MonitorActiveDto) {
    return this.monitors.setActive(appUser, id, dto.active);
  }

  @RequireRasterModule([RASTER_MODULES.monitoring])
  @Post('monitors/:id/run')
  @HttpCode(200)
  runMonitor(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.monitors.runNow(appUser, id);
  }

  @RequireRasterModule([RASTER_MODULES.monitoring])
  @Post('monitors/:id/acknowledge')
  @HttpCode(200)
  acknowledgeMonitor(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.monitors.acknowledge(appUser, id);
  }

  // ----- Background jobs (tools that publish a layer) -----

  /** Starts `:tool` (an endpoint name below, e.g. "terrain", "online") in
   *  the background; poll GET jobs/:id for its stage and result. */
  @RequireRasterModule('job')
  @Post('jobs/:tool')
  startJob(
    @CurrentAppUser() appUser: AppUser,
    @Param('tool') tool: string,
    @Body() body: Record<string, unknown>,
    @Query('departmentId', new ParseUUIDPipe({ optional: true })) departmentId?: string,
    /** The panel tool that started it, for reattaching after a reload. */
    @Query('ui') clientTool?: string,
  ) {
    const ui = clientTool && /^[a-z0-9-]{1,40}$/.test(clientTool) ? clientTool : 'panel';
    return this.jobs.start(appUser, tool, body, departmentId, undefined, undefined, ui);
  }

  @RequireRasterModule(ANY_RASTER_MODULE)
  @Get('jobs')
  listJobs(@CurrentAppUser() appUser: AppUser) {
    return this.jobs.list(appUser);
  }

  /** A reloaded panel reattaches to these (running, or finished unseen). */
  @RequireRasterModule(ANY_RASTER_MODULE)
  @Get('jobs/pending')
  pendingJobs(@CurrentAppUser() appUser: AppUser) {
    return this.jobs.pending(appUser);
  }

  @RequireRasterModule(ANY_RASTER_MODULE)
  @Post('jobs/:id/seen')
  @HttpCode(200)
  markJobSeen(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.markSeen(appUser, id);
  }

  @RequireRasterModule(ANY_RASTER_MODULE)
  @Get('jobs/:id')
  getJob(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.getOrRecord(appUser, id);
  }

  @RequireRasterModule(ANY_RASTER_MODULE)
  @Post('jobs/:id/cancel')
  @HttpCode(200)
  cancelJob(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.cancel(appUser, id);
  }

  // ----- Raster Data -----

  @RequireRasterModule([RASTER_MODULES.upload])
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_RASTER_BYTES },
      // Straight to disk: a large GeoTIFF must never sit in memory.
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
          cb(null, UPLOAD_TMP_DIR);
        },
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase().slice(0, 6)}`),
      }),
    }),
  )
  upload(
    @CurrentAppUser() appUser: AppUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: RasterUploadDto,
  ) {
    return this.rasters.upload(appUser, file, dto);
  }

  @RequireRasterModule(ANY_RASTER_MODULE)
  @Get(':layerId/info')
  info(@CurrentAppUser() appUser: AppUser, @Param('layerId') layerId: string) {
    return this.rasters.info(appUser, layerId);
  }

  @RequireRasterModule([RASTER_MODULES.view3d])
  @Get(':layerId/mesh')
  mesh(
    @CurrentAppUser() appUser: AppUser,
    @Param('layerId', ParseUUIDPipe) layerId: string,
    @Query('band') band?: string,
    @Query('size') size?: string,
  ) {
    const b = Math.max(1, Math.trunc(Number(band) || 1));
    const n = Math.min(Math.max(Math.trunc(Number(size) || 260), 20), 400);
    return this.rasters.mesh(appUser, layerId, b, n);
  }

  @RequireRasterModule([RASTER_MODULES.identify])
  @Post(':layerId/identify')
  @HttpCode(200)
  identify(@CurrentAppUser() appUser: AppUser, @Param('layerId') layerId: string, @Body() dto: PointDto) {
    return this.rasters.identify(appUser, layerId, dto.point);
  }

  @RequireRasterModule([RASTER_MODULES.style])
  @Put(':layerId/style')
  style(@CurrentAppUser() appUser: AppUser, @Param('layerId') layerId: string, @Body() dto: RasterStyleDto) {
    return this.rasters.applyStyle(appUser, layerId, dto);
  }

  @RequireRasterModule([RASTER_MODULES.rasterize, RASTER_MODULES.zonal, RASTER_MODULES.idw, RASTER_MODULES.heatmap, RASTER_MODULES.proximity])
  @Get('vector/:layerId/fields')
  vectorFields(@CurrentAppUser() appUser: AppUser, @Param('layerId') layerId: string) {
    return this.rasters.vectorFields(appUser, layerId);
  }

  /** Download Raster — `?bbox=minX,minY,maxX,maxY` (EPSG:4326) cuts it to
   *  the current map view. */
  @RequireRasterModule([RASTER_MODULES.download])
  @Get(':layerId/download')
  async download(
    @CurrentAppUser() appUser: AppUser,
    @Param('layerId') layerId: string,
    @Query('bbox') bbox: string | undefined,
    @Res() res: Response,
  ) {
    let box: [number, number, number, number] | undefined;
    if (bbox) {
      const parts = bbox.split(',').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        throw new BadRequestException('bbox must be minX,minY,maxX,maxY.');
      }
      box = parts as [number, number, number, number];
    }
    const file = await this.rasters.download(appUser, layerId, box);
    res.setHeader('Content-Type', 'image/tiff');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.body);
  }

  @RequireRasterModule([RASTER_MODULES.online])
  @Post('online/sentinel2/search')
  @HttpCode(200)
  sentinelSearch(@Body() dto: SentinelSearchDto) {
    return this.tools.sentinelSearch(dto);
  }

  @RequireRasterModule([RASTER_MODULES.online])
  @Post('online/coverage')
  imageryCoverage(@Body() dto: ImageryCoverageDto) {
    return this.tools.imageryCoverage(dto);
  }

  @RequireRasterModule([RASTER_MODULES.online])
  @Post('online/sentinel2/preview')
  async sentinelPreview(@CurrentAppUser() appUser: AppUser, @Body() dto: SentinelPreviewDto, @Res() res: Response) {
    const png = await this.tools.sentinelPreview(appUser, dto);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(png);
  }

  @RequireRasterModule([RASTER_MODULES.online])
  @Post('online')
  online(@CurrentAppUser() appUser: AppUser, @Body() dto: OnlineRasterDto) {
    return this.tools.onlineRaster(appUser, dto);
  }

  // Any raster tool: the results screen reads the output's statistics
  // after every analysis (read-only; layer VIEW is still checked).
  @RequireRasterModule(Object.values(RASTER_MODULES))
  @Post('statistics')
  @HttpCode(200)
  statistics(@CurrentAppUser() appUser: AppUser, @Body() dto: RasterStatisticsDto) {
    return this.tools.statistics(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.mosaic])
  @Post('mosaic')
  mosaic(@CurrentAppUser() appUser: AppUser, @Body() dto: MosaicDto) {
    return this.tools.mosaic(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.resample])
  @Post('resample')
  resample(@CurrentAppUser() appUser: AppUser, @Body() dto: ResampleDto) {
    return this.tools.resample(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.rasterize])
  @Post('rasterize')
  rasterize(@CurrentAppUser() appUser: AppUser, @Body() dto: RasterizeDto) {
    return this.tools.rasterize(appUser, dto);
  }

  // ----- Terrain Analysis -----

  @RequireRasterModule(terrainModules)
  @Post('terrain')
  terrain(@CurrentAppUser() appUser: AppUser, @Body() dto: TerrainDto) {
    return this.tools.terrain(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.contour])
  @Post('contour')
  contour(@CurrentAppUser() appUser: AppUser, @Body() dto: ContourDto) {
    return this.tools.contour(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.profile])
  @Post('profile')
  @HttpCode(200)
  profile(@CurrentAppUser() appUser: AppUser, @Body() dto: ProfileDto) {
    return this.tools.profile(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.cutFill])
  @Post('cut-fill')
  @HttpCode(200)
  cutFill(@CurrentAppUser() appUser: AppUser, @Body() dto: CutFillDto) {
    return this.tools.cutFill(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.watershed])
  @Post('watershed')
  watershed(@CurrentAppUser() appUser: AppUser, @Body() dto: WatershedDto) {
    return this.tools.watershed(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.flood])
  @Post('flood')
  flood(@CurrentAppUser() appUser: AppUser, @Body() dto: FloodDto) {
    return this.tools.flood(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.lineOfSight])
  @Post('line-of-sight')
  @HttpCode(200)
  lineOfSight(@CurrentAppUser() appUser: AppUser, @Body() dto: LineOfSightDto) {
    return this.tools.lineOfSight(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.viewshed])
  @Post('viewshed')
  viewshed(@CurrentAppUser() appUser: AppUser, @Body() dto: ViewshedDto) {
    return this.tools.viewshed(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.fillSinks])
  @Post('fill-sinks')
  fillSinks(@CurrentAppUser() appUser: AppUser, @Body() dto: FillSinksDto) {
    return this.tools.fillSinks(appUser, dto);
  }

  // ----- Raster Analytics -----

  @RequireRasterModule([RASTER_MODULES.zonal])
  @Post('zonal-statistics')
  zonalStatistics(@CurrentAppUser() appUser: AppUser, @Body() dto: ZonalStatisticsDto) {
    return this.tools.zonalStatistics(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.idw])
  @Post('idw')
  idw(@CurrentAppUser() appUser: AppUser, @Body() dto: IdwDto) {
    return this.tools.idw(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.heatmap])
  @Post('heatmap')
  heatmap(@CurrentAppUser() appUser: AppUser, @Body() dto: HeatmapDto) {
    return this.tools.heatmap(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.proximity])
  @Post('proximity')
  proximity(@CurrentAppUser() appUser: AppUser, @Body() dto: ProximityDto) {
    return this.tools.proximity(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.calculator])
  @Post('calculator')
  calculator(@CurrentAppUser() appUser: AppUser, @Body() dto: RasterCalculatorDto) {
    return this.tools.calculator(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.reclassify])
  @Post('reclassify')
  reclassify(@CurrentAppUser() appUser: AppUser, @Body() dto: ReclassifyDto) {
    return this.tools.reclassify(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.clip])
  @Post('clip')
  clip(@CurrentAppUser() appUser: AppUser, @Body() dto: ClipDto) {
    return this.tools.clip(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.polygonize])
  @Post('polygonize')
  polygonize(@CurrentAppUser() appUser: AppUser, @Body() dto: PolygonizeDto) {
    return this.tools.polygonize(appUser, dto);
  }

  // ----- Imagery Analysis -----

  @RequireRasterModule([RASTER_MODULES.ndvi])
  @Post('ndvi')
  ndvi(@CurrentAppUser() appUser: AppUser, @Body() dto: NdviDto) {
    return this.tools.ndvi(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.spectralIndex])
  @Post('spectral-index')
  spectralIndex(@CurrentAppUser() appUser: AppUser, @Body() dto: SpectralIndexDto) {
    return this.tools.spectralIndex(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.classify])
  @Post('classify')
  classify(@CurrentAppUser() appUser: AppUser, @Body() dto: ClassifyDto) {
    return this.tools.classify(appUser, dto);
  }

  @RequireRasterModule([RASTER_MODULES.change])
  @Post('change-detection')
  changeDetection(@CurrentAppUser() appUser: AppUser, @Body() dto: ChangeDetectionDto) {
    return this.tools.changeDetection(appUser, dto);
  }
}
