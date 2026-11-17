import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { NetworkService } from './network.service';
import { PlaceSearchService } from './place-search.service';
import {
  FleetRoutesDto,
  NearestFacilityDto,
  OdMatrixDto,
  RouteDto,
  ServiceAreaDto,
  SiteSelectionDto,
  TraceDto,
} from './dto/network.dto';

/** GIS Advanced Tools. Each call VIEW-checks the layers it reads. */
@Controller('gis/network')
export class NetworkController {
  constructor(
    private readonly networkService: NetworkService,
    private readonly placeSearch: PlaceSearchService,
  ) {}

  /** Places by name, for routing stops: GET /gis/network/places?q= */
  @RequireMunicipalityMember()
  @Get('places')
  places(@CurrentAppUser() appUser: AppUser, @Query('q') q?: string) {
    return this.placeSearch.search(appUser, q ?? '');
  }

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

  /** Service Area: reachable roads / area within distance or time breaks. */
  @RequireMunicipalityMember()
  @Post('service-area')
  @HttpCode(200)
  serviceArea(@CurrentAppUser() appUser: AppUser, @Body() dto: ServiceAreaDto) {
    return this.networkService.serviceArea(appUser, dto);
  }

  /** OD Cost Matrix: road distance from every origin to every destination. */
  @RequireMunicipalityMember()
  @Post('od-matrix')
  @HttpCode(200)
  odMatrix(@CurrentAppUser() appUser: AppUser, @Body() dto: OdMatrixDto) {
    return this.networkService.odMatrix(appUser, dto);
  }

  /** Fleet Routes: split stops across vehicles from one depot. */
  @RequireMunicipalityMember()
  @Post('fleet-routes')
  @HttpCode(200)
  fleetRoutes(@CurrentAppUser() appUser: AppUser, @Body() dto: FleetRoutesDto) {
    return this.networkService.fleetRoutes(appUser, dto);
  }

  /** Site Selection: best new facility sites for a demand layer. */
  @RequireMunicipalityMember()
  @Post('site-selection')
  @HttpCode(200)
  siteSelection(@CurrentAppUser() appUser: AppUser, @Body() dto: SiteSelectionDto) {
    return this.networkService.siteSelection(appUser, dto);
  }
}
