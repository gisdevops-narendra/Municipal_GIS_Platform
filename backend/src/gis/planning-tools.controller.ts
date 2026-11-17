import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { EvCoverageDto, HazardExposureDto, OutbreakDto, WellImportDto, WellReadingDto } from './dto/platform-extras.dto';
import { EvPlanningService } from './ev-planning.service';
import { GroundwaterService } from './groundwater.service';
import { HazardsService } from './hazards.service';
import { OutbreakService } from './outbreak.service';

/** Groundwater monitoring, disease outbreak mapping and EV charging
 *  planning. Layer VIEW / EDIT permissions are checked in the services. */
@Controller('gis')
export class PlanningToolsController {
  constructor(
    private readonly groundwater: GroundwaterService,
    private readonly outbreak: OutbreakService,
    private readonly ev: EvPlanningService,
    private readonly hazards: HazardsService,
  ) {}

  @RequireMunicipalityMember()
  @Get('groundwater/:layerId')
  wells(@CurrentAppUser() appUser: AppUser, @Param('layerId') layerId: string, @Query('labelField') labelField?: string) {
    return this.groundwater.summary(appUser, layerId, labelField || undefined);
  }

  @RequireMunicipalityMember()
  @Get('groundwater/:layerId/wells/:fid/readings')
  readings(@CurrentAppUser() appUser: AppUser, @Param('layerId') layerId: string, @Param('fid', ParseIntPipe) fid: number) {
    return this.groundwater.readings(appUser, layerId, fid);
  }

  @RequireMunicipalityMember()
  @Post('groundwater/:layerId/wells/:fid/readings')
  addReading(
    @CurrentAppUser() appUser: AppUser,
    @Param('layerId') layerId: string,
    @Param('fid', ParseIntPipe) fid: number,
    @Body() dto: WellReadingDto,
  ) {
    return this.groundwater.addReading(appUser, layerId, fid, dto);
  }

  @RequireMunicipalityMember()
  @Delete('groundwater/:layerId/readings/:readingId')
  @HttpCode(204)
  async deleteReading(@CurrentAppUser() appUser: AppUser, @Param('layerId') layerId: string, @Param('readingId') readingId: string) {
    await this.groundwater.deleteReading(appUser, layerId, readingId);
  }

  @RequireMunicipalityMember()
  @Post('groundwater/:layerId/import')
  importReadings(@CurrentAppUser() appUser: AppUser, @Param('layerId') layerId: string, @Body() dto: WellImportDto) {
    return this.groundwater.import(appUser, layerId, dto);
  }

  @RequireMunicipalityMember()
  @Post('outbreak/analyze')
  @HttpCode(200)
  analyzeOutbreak(@CurrentAppUser() appUser: AppUser, @Body() dto: OutbreakDto) {
    return this.outbreak.analyze(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('ev/coverage')
  @HttpCode(200)
  evCoverage(@CurrentAppUser() appUser: AppUser, @Body() dto: EvCoverageDto) {
    return this.ev.coverage(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('hazards/exposure')
  @HttpCode(200)
  hazardExposure(@CurrentAppUser() appUser: AppUser, @Body() dto: HazardExposureDto) {
    return this.hazards.exposure(appUser, dto);
  }
}
