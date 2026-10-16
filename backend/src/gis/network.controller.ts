import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { NetworkService } from './network.service';
import { NearestFacilityDto, RouteDto, TraceDto } from './dto/network.dto';

/** GIS Advanced Tools. Each call VIEW-checks the layers it reads. */
@Controller('gis/network')
export class NetworkController {
  constructor(private readonly networkService: NetworkService) {}

  /** Basic Routing: shortest path between two clicked points. */
  @RequireMunicipalityMember()
  @Post('route')
  @HttpCode(200)
  route(@CurrentAppUser() appUser: AppUser, @Body() dto: RouteDto) {
    return this.networkService.route(appUser, dto);
  }

  /** Nearest Facility: the closest points of a facility layer by road. */
  @RequireMunicipalityMember()
  @Post('nearest')
  @HttpCode(200)
  nearest(@CurrentAppUser() appUser: AppUser, @Body() dto: NearestFacilityDto) {
    return this.networkService.nearest(appUser, dto);
  }

  /** Network Tracing: every line connected to the clicked one. */
  @RequireMunicipalityMember()
  @Post('trace')
  @HttpCode(200)
  trace(@CurrentAppUser() appUser: AppUser, @Body() dto: TraceDto) {
    return this.networkService.trace(appUser, dto);
  }
}
