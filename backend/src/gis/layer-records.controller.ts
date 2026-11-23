import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
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
