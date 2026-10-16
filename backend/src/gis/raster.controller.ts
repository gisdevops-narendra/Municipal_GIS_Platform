import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { RasterService } from './raster.service';
import { RasterToolsService } from './raster-tools.service';
import {
  ChangeDetectionDto,
  ClassifyDto,
  ClipDto,
  FillSinksDto,
  HeatmapDto,
  IdwDto,
  MosaicDto,
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

const MAX_RASTER_BYTES = Number(process.env.GIS_UPLOAD_MAX_FILE_SIZE_MB ?? '500') * 1024 * 1024;

/** Raster Analysis. Every call VIEW-checks the rasters it reads; tools
 *  that create a layer need the caller's UPLOAD permission. */
@Controller('gis/raster')
export class RasterController {
  constructor(
    private readonly rasters: RasterService,
    private readonly tools: RasterToolsService,
  ) {}

  // ----- Raster Data -----

  @RequireMunicipalityMember()
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RASTER_BYTES } }))
  upload(
    @CurrentAppUser() appUser: AppUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: RasterUploadDto,
  ) {
    return this.rasters.upload(appUser, file, dto);
  }

  @RequireMunicipalityMember()
  @Get(':layerId/info')
  info(@CurrentAppUser() appUser: AppUser, @Param('layerId') layerId: string) {
    return this.rasters.info(appUser, layerId);
  }

  @RequireMunicipalityMember()
  @Post(':layerId/identify')
  @HttpCode(200)
  identify(@CurrentAppUser() appUser: AppUser, @Param('layerId') layerId: string, @Body() dto: PointDto) {
    return this.rasters.identify(appUser, layerId, dto.point);
  }

  @RequireMunicipalityMember()
  @Put(':layerId/style')
  style(@CurrentAppUser() appUser: AppUser, @Param('layerId') layerId: string, @Body() dto: RasterStyleDto) {
    return this.rasters.applyStyle(appUser, layerId, dto);
  }

  @RequireMunicipalityMember()
  @Get('vector/:layerId/fields')
  vectorFields(@CurrentAppUser() appUser: AppUser, @Param('layerId') layerId: string) {
    return this.rasters.vectorFields(appUser, layerId);
  }

  /** Download Raster — `?bbox=minX,minY,maxX,maxY` (EPSG:4326) cuts it to
   *  the current map view. */
  @RequireMunicipalityMember()
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

  @RequireMunicipalityMember()
  @Post('statistics')
  @HttpCode(200)
  statistics(@CurrentAppUser() appUser: AppUser, @Body() dto: RasterStatisticsDto) {
    return this.tools.statistics(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('mosaic')
  mosaic(@CurrentAppUser() appUser: AppUser, @Body() dto: MosaicDto) {
    return this.tools.mosaic(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('resample')
  resample(@CurrentAppUser() appUser: AppUser, @Body() dto: ResampleDto) {
    return this.tools.resample(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('rasterize')
  rasterize(@CurrentAppUser() appUser: AppUser, @Body() dto: RasterizeDto) {
    return this.tools.rasterize(appUser, dto);
  }

  // ----- Terrain Analysis -----

  @RequireMunicipalityMember()
  @Post('terrain')
  terrain(@CurrentAppUser() appUser: AppUser, @Body() dto: TerrainDto) {
    return this.tools.terrain(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('contour')
  contour(@CurrentAppUser() appUser: AppUser, @Body() dto: ContourDto) {
    return this.tools.contour(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('profile')
  @HttpCode(200)
  profile(@CurrentAppUser() appUser: AppUser, @Body() dto: ProfileDto) {
    return this.tools.profile(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('cut-fill')
  @HttpCode(200)
  cutFill(@CurrentAppUser() appUser: AppUser, @Body() dto: CutFillDto) {
    return this.tools.cutFill(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('watershed')
  watershed(@CurrentAppUser() appUser: AppUser, @Body() dto: WatershedDto) {
    return this.tools.watershed(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('flood')
  flood(@CurrentAppUser() appUser: AppUser, @Body() dto: FloodDto) {
    return this.tools.flood(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('line-of-sight')
  @HttpCode(200)
  lineOfSight(@CurrentAppUser() appUser: AppUser, @Body() dto: LineOfSightDto) {
    return this.tools.lineOfSight(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('viewshed')
  viewshed(@CurrentAppUser() appUser: AppUser, @Body() dto: ViewshedDto) {
    return this.tools.viewshed(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('fill-sinks')
  fillSinks(@CurrentAppUser() appUser: AppUser, @Body() dto: FillSinksDto) {
    return this.tools.fillSinks(appUser, dto);
  }

  // ----- Raster Analytics -----

  @RequireMunicipalityMember()
  @Post('zonal-statistics')
  zonalStatistics(@CurrentAppUser() appUser: AppUser, @Body() dto: ZonalStatisticsDto) {
    return this.tools.zonalStatistics(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('idw')
  idw(@CurrentAppUser() appUser: AppUser, @Body() dto: IdwDto) {
    return this.tools.idw(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('heatmap')
  heatmap(@CurrentAppUser() appUser: AppUser, @Body() dto: HeatmapDto) {
    return this.tools.heatmap(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('proximity')
  proximity(@CurrentAppUser() appUser: AppUser, @Body() dto: ProximityDto) {
    return this.tools.proximity(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('calculator')
  calculator(@CurrentAppUser() appUser: AppUser, @Body() dto: RasterCalculatorDto) {
    return this.tools.calculator(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('reclassify')
  reclassify(@CurrentAppUser() appUser: AppUser, @Body() dto: ReclassifyDto) {
    return this.tools.reclassify(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('clip')
  clip(@CurrentAppUser() appUser: AppUser, @Body() dto: ClipDto) {
    return this.tools.clip(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('polygonize')
  polygonize(@CurrentAppUser() appUser: AppUser, @Body() dto: PolygonizeDto) {
    return this.tools.polygonize(appUser, dto);
  }

  // ----- Imagery Analysis -----

  @RequireMunicipalityMember()
  @Post('ndvi')
  ndvi(@CurrentAppUser() appUser: AppUser, @Body() dto: NdviDto) {
    return this.tools.ndvi(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('spectral-index')
  spectralIndex(@CurrentAppUser() appUser: AppUser, @Body() dto: SpectralIndexDto) {
    return this.tools.spectralIndex(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('classify')
  classify(@CurrentAppUser() appUser: AppUser, @Body() dto: ClassifyDto) {
    return this.tools.classify(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('change-detection')
  changeDetection(@CurrentAppUser() appUser: AppUser, @Body() dto: ChangeDetectionDto) {
    return this.tools.changeDetection(appUser, dto);
  }
}
