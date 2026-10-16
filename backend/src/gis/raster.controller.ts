import { Body, Controller, Get, HttpCode, Param, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { RasterService } from './raster.service';
import { RasterToolsService } from './raster-tools.service';
import {
  ChangeDetectionDto,
  ClipDto,
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

  // ----- Raster Analytics -----

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
  @Post('change-detection')
  changeDetection(@CurrentAppUser() appUser: AppUser, @Body() dto: ChangeDetectionDto) {
    return this.tools.changeDetection(appUser, dto);
  }
}
