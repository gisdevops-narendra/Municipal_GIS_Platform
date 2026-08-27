import { Controller, Get, Query } from '@nestjs/common';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { GisDashboardService } from './gis-dashboard.service';

/**
 * Task 9: read-only dashboard/search endpoints. Every handler resolves
 * tenant scope from `appUser.municipalityId` (JWT-derived, never the
 * client) and defers all layer/feature visibility to
 * GisAuthorizationService via GisDashboardService — no separate
 * authorization logic lives here.
 */
@Controller('gis/dashboard')
export class GisDashboardController {
  constructor(private readonly gisDashboardService: GisDashboardService) {}

  @RequireMunicipalityMember()
  @Get('summary')
  getSummary(@CurrentAppUser() appUser: AppUser) {
    return this.gisDashboardService.getSummary(appUser);
  }

  @RequireMunicipalityMember()
  @Get('departments')
  getDepartmentSummary(@CurrentAppUser() appUser: AppUser) {
    return this.gisDashboardService.getDepartmentSummary(appUser);
  }

  @RequireMunicipalityMember()
  @Get('search')
  search(
    @CurrentAppUser() appUser: AppUser,
    @Query('q') q: string | undefined,
  ) {
    return this.gisDashboardService.search(appUser, q ?? '');
  }
}
