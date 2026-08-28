import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  RequireMunicipalityMember,
  RequireMunicipalityOwner,
} from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { GisLayersService } from './gis-layers.service';
import { StyleService } from './style.service';
import { SetLayerPermissionDto } from './dto/set-layer-permission.dto';
import { LayerStyleSpecDto } from './dto/layer-style.dto';
import type { ClassificationMethod } from './dto/layer-style.dto';

/** Uploaded marker icons are inlined per feature at render time — keep
 *  them small (matches StyleService.MAX_ICON_BYTES). */
const MAX_ICON_BYTES = 512 * 1024;

@Controller('gis')
export class GisLayersController {
  constructor(
    private readonly gisLayersService: GisLayersService,
    private readonly styleService: StyleService,
  ) {}

  // ---- Marker-icon gallery (GIS Layer Styling — ExternalGraphic). The
  //      bundled set is workspace-agnostic and CC0 (see
  //      backend/src/gis/marker-icons/LICENSE.txt). ----

  @RequireMunicipalityMember()
  @Get('style/icons')
  listBuiltinIcons() {
    return { icons: this.styleService.builtinIcons() };
  }

  /** Public on purpose — these are static CC0 marker graphics with no
   *  tenant data, and they are loaded as plain `<img src>` in the style
   *  editor (which can't attach the JWT the way HttpClient does). */
  @Get('style/icons/:iconId')
  builtinIcon(@Param('iconId') iconId: string, @Res() res: Response) {
    const bytes = this.styleService.builtinIconBytes(iconId);
    if (!bytes) {
      throw new BadRequestException('Unknown icon.');
    }
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(bytes);
  }

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

  // ---- Styling (GIS Layer Styling — YSLD). Gated by MANAGE in the service. ----

  @RequireMunicipalityMember()
  @Get('layers/:id/style')
  getStyle(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.gisLayersService.getLayerStyle(appUser, id);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/style/attributes')
  styleAttributes(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.gisLayersService.layerStyleAttributes(appUser, id);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/style/field-stats')
  fieldStats(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Query('field') field: string,
    @Query('method') method?: ClassificationMethod,
    @Query('classes', new ParseIntPipe({ optional: true })) classes?: number,
  ) {
    return this.gisLayersService.layerFieldStats(appUser, id, field, {
      method,
      classes,
    });
  }

  @RequireMunicipalityMember()
  @Put('layers/:id/style')
  applyStyle(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Body() spec: LayerStyleSpecDto,
  ) {
    return this.gisLayersService.applyLayerStyle(appUser, id, spec);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/style/icon')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_ICON_BYTES } }),
  )
  async uploadIcon(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('An icon file is required.');
    }
    return this.gisLayersService.uploadLayerIcon(appUser, id, file);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/style/icon/:name')
  async customIcon(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Param('name') name: string,
    @Res() res: Response,
  ) {
    const icon = await this.gisLayersService.layerCustomIcon(appUser, id, name);
    if (!icon) {
      throw new BadRequestException('Icon not found.');
    }
    res.setHeader('Content-Type', icon.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(icon.body);
  }

  @RequireMunicipalityMember()
  @Delete('layers/:id/style')
  async removeStyle(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
  ): Promise<{ success: true }> {
    await this.gisLayersService.removeLayerStyle(appUser, id);
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
