import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import {
  RequireMunicipalityMember,
  RequireMunicipalityOwner,
} from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { GisWorkspaceService } from './gis-workspace.service';
import { UpdateGisWorkspaceDto } from './dto/update-gis-workspace.dto';

@Controller('gis')
export class GisWorkspaceController {
  constructor(private readonly gisWorkspaceService: GisWorkspaceService) {}

  /** Any authenticated member of the municipality may view its GIS
   *  workspace. Tenant scoping comes entirely from `appUser.municipalityId`
   *  (resolved server-side from the JWT) — never from anything the client
   *  supplies, so a request can never read another municipality's
   *  workspace by any means. */
  @RequireMunicipalityMember()
  @Get('workspace')
  getWorkspace(@CurrentAppUser() appUser: AppUser) {
    return this.gisWorkspaceService.getForMunicipality(appUser.municipalityId);
  }

  /** Owner-only. name/description/defaultCrs/displayCrs only — see
   *  UpdateGisWorkspaceDto for why municipalityId/geoserverWorkspace/code
   *  are not accepted here. */
  @RequireMunicipalityOwner()
  @Patch('workspace')
  updateWorkspace(
    @CurrentAppUser() appUser: AppUser,
    @Body() dto: UpdateGisWorkspaceDto,
  ) {
    return this.gisWorkspaceService.update(
      appUser.municipalityId,
      dto,
      appUser.id,
    );
  }

  /** Owner-only. Re-attempts GeoServer provisioning for the caller's own
   *  workspace (e.g. after it was created while GeoServer was down). */
  @RequireMunicipalityOwner()
  @Post('workspace/provision')
  retryProvisioning(@CurrentAppUser() appUser: AppUser) {
    return this.gisWorkspaceService.retryProvisioning(appUser.municipalityId);
  }

  /** Member-level (not public): confirms GeoServer reachability without
   *  exposing anything municipality-specific. Returns 503 (via
   *  ServiceUnavailableException, mapped by AllExceptionsFilter) when
   *  GeoServer cannot be reached. */
  @RequireMunicipalityMember()
  @Get('geoserver/health')
  getGeoServerHealth() {
    return this.gisWorkspaceService.getGeoServerHealth();
  }
}
