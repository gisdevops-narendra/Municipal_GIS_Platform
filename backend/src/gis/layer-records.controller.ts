import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

export class FeatureCountsDto {
  @IsArray()
  @ArrayMaxSize(300)
  @IsUUID('all', { each: true })
  ids!: string[];
}
import { RequireMemberOrApiKey } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { FeatureDistanceDto, LayerRecordsQueryDto } from './dto/layer-records.dto';
import { LayerRecordsService } from './layer-records.service';

/** Layer data for the map tools, read from PostGIS after a login and
 *  view-permission check (replaces the browser's direct GeoServer WFS). */
@Controller('gis/layers')
export class LayerRecordsController {
  constructor(private readonly records: LayerRecordsService) {}

  /** Feature count of each listed vector layer (Layers panel). */
  @RequireMemberOrApiKey()
  @Post('feature-counts')
  @HttpCode(200)
  featureCounts(@CurrentAppUser() appUser: AppUser, @Body() dto: FeatureCountsDto) {
    return this.records.featureCounts(appUser, dto.ids);
  }

  /** Layer properties panel. */
  @RequireMemberOrApiKey()
  @Get(':id/properties')
  properties(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.records.properties(appUser, id);
  }

  @RequireMemberOrApiKey()
  @Post(':id/records')
  @HttpCode(200)
  query(
    @CurrentAppUser() appUser: AppUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LayerRecordsQueryDto,
  ) {
    return this.records.query(appUser, id, dto);
  }

  /** Shortest distance between two features of the layer (by feature id). */
  @RequireMemberOrApiKey()
  @Post(':id/distance')
  @HttpCode(200)
  distance(
    @CurrentAppUser() appUser: AppUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FeatureDistanceDto,
  ) {
    return this.records.distance(appUser, id, dto.a, dto.b);
  }
}
