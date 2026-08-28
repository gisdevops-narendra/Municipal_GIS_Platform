import { Body, Controller, Delete, Get, Param, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  RequireMunicipalityMember,
  RequireMunicipalityOwner,
} from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { GisLayersService } from './gis-layers.service';
import { SetLayerPermissionDto } from './dto/set-layer-permission.dto';

@Controller('gis')
export class GisLayersController {
  constructor(private readonly gisLayersService: GisLayersService) {}

  /**
   * Any authenticated member of the municipality may call this — as of
   * Task 8, "sees" is now permission-filtered, not just tenant-filtered:
   * the response only ever contains layers this specific user has VIEW
   * permission for (canonical layers, plus whichever department layers
   * their role/department has been granted — including cross-department
   * grants). Tenant scoping comes entirely from `appUser.municipalityId`,
   * resolved server-side from the JWT — never from anything the client
   * supplies, so a request can never list another municipality's layers
   * by any means.
   */
  @RequireMunicipalityMember()
  @Get('layers')
  listLayers(@CurrentAppUser() appUser: AppUser) {
    return this.gisLayersService.listForMunicipality(appUser);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id')
  getLayer(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.gisLayersService.getById(appUser, id);
  }

  /** Task 8 §3/§9: gated by EXPORT permission, enforced in the service —
   *  the backend fetches the data from GeoServer itself and streams it
   *  back as a download, rather than handing out a GeoServer URL (which
   *  would bypass this check entirely). */
  @RequireMunicipalityMember()
  @Get('layers/:id/export')
  async exportLayer(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { filename, geojson } = await this.gisLayersService.exportLayer(
      appUser,
      id,
    );
    res.setHeader('Content-Type', 'application/geo+json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(geojson);
  }

  /** Task 8 §7. Gated by MANAGE, enforced in the service. */
  @RequireMunicipalityMember()
  @Get('layers/:id/permissions')
  getPermissions(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.gisLayersService.getPermissionMatrix(appUser, id);
  }

  /** Hard-deletes a layer — unpublishes it from GeoServer and drops its
   *  data. Owner-only (also re-checked in the service); the guard here is
   *  defense-in-depth, matching DELETE /api/departments/:id. */
  @RequireMunicipalityOwner()
  @Delete('layers/:id')
  async deleteLayer(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
  ): Promise<{ success: true }> {
    await this.gisLayersService.deleteLayer(appUser, id);
    return { success: true };
  }

  /** Task 8 §7. One checkbox toggle per call. Gated by MANAGE and the
   *  self-grant guard, both enforced in the service. */
  @RequireMunicipalityMember()
  @Put('layers/:id/permissions')
  setPermission(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Body() dto: SetLayerPermissionDto,
  ) {
    return this.gisLayersService.setPermission(
      appUser,
      id,
      dto.departmentId,
      dto.role,
      dto.permission,
      dto.granted,
    );
  }
}
