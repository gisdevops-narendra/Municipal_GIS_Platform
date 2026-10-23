import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Patch,
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
import { RenameLayerDto } from './dto/rename-layer.dto';
import type { Response } from 'express';
import {
  RequireMunicipalityMember,
  RequireMunicipalityOwner,
} from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import {
  GisLayersService,
  LAYER_EXPORT_FORMATS,
  type LayerExportFormat,
} from './gis-layers.service';
import { StyleService } from './style.service';
import { LayerReportService } from './layer-report.service';
import { LayerReportDto } from './dto/layer-report.dto';
import { ExportSelectionDto } from './dto/selection.dto';
import { SetLayerPermissionDto } from './dto/set-layer-permission.dto';
import { LayerStyleSpecDto } from './dto/layer-style.dto';
import type { ClassificationMethod } from './dto/layer-style.dto';
import type { GroupMeasure } from './field-stats.service';

/** Uploaded marker icons are inlined per feature at render time — keep
 *  them small (matches StyleService.MAX_ICON_BYTES). */
const MAX_ICON_BYTES = 512 * 1024;

@Controller('gis')
export class GisLayersController {
  constructor(
    private readonly gisLayersService: GisLayersService,
    private readonly styleService: StyleService,
    private readonly layerReportService: LayerReportService,
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
    @Query('format') format: string | undefined,
    @Res() res: Response,
    @Query('field') field?: string,
    @Query('op') op?: string,
    @Query('value') value?: string,
  ) {
    const requested = format ?? 'geojson';
    if (!Object.hasOwn(LAYER_EXPORT_FORMATS, requested)) {
      throw new BadRequestException(
        `format must be one of: ${Object.keys(LAYER_EXPORT_FORMATS).join(', ')}.`,
      );
    }
    const { filename, body, contentType } =
      await this.gisLayersService.exportLayer(
        appUser,
        id,
        requested as LayerExportFormat,
        field && op ? { field, op, value: value ?? '' } : undefined,
      );
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  }

  /** Export selected: only the given features, same checks as above —
   *  POSTed because a selection's id list can be long. */
  @RequireMunicipalityMember()
  @Post('layers/:id/export')
  async exportSelection(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Body() dto: ExportSelectionDto,
    @Res() res: Response,
  ) {
    const { filename, body, contentType } =
      await this.gisLayersService.exportLayer(
        appUser,
        id,
        dto.format,
        undefined,
        dto.featureIds,
      );
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  }

  /** Task 8 §7. Gated by MANAGE, enforced in the service. */
  @RequireMunicipalityMember()
  @Get('layers/:id/permissions')
  getPermissions(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.gisLayersService.getPermissionMatrix(appUser, id);
  }

  /** Renames a layer (display name only). Owner-only, re-checked in the service. */
  @RequireMunicipalityOwner()
  @Patch('layers/:id')
  renameLayer(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Body() dto: RenameLayerDto,
  ) {
    return this.gisLayersService.renameLayer(appUser, id, dto.name);
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

  // ---- Report Generation. Gated by VIEW in the service. ----

  @RequireMunicipalityMember()
  @Post('layers/:id/report')
  async layerReport(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Body() dto: LayerReportDto,
    @Res() res: Response,
  ) {
    const { filename, body } = await this.layerReportService.buildReport(
      appUser,
      id,
      dto,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', body.length);
    res.send(body);
  }

  // ---- Analytics / Data Visualisation. Gated by VIEW in the service. ----

  @RequireMunicipalityMember()
  @Get('layers/:id/analytics/fields')
  analyticsFields(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.gisLayersService.layerAnalyticsFields(appUser, id);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/analytics/profile')
  analyticsProfile(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
  ) {
    return this.gisLayersService.layerProfile(appUser, id);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/analytics/group')
  analyticsGroup(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Query('by') by: string | undefined,
    @Query('areaLayer') areaLayerId: string | undefined,
    @Query('areaField') areaField: string | undefined,
    @Query('measure') measure: string | undefined,
    @Query('measureField') measureField: string | undefined,
    @Query('shapes') shapes: string | undefined,
  ) {
    const m = (measure ?? 'count') as GroupMeasure;
    if (!['count', 'sum', 'avg', 'length', 'area'].includes(m)) {
      throw new BadRequestException('Unknown measure.');
    }
    if (!by && !areaLayerId) {
      throw new BadRequestException('by or areaLayer is required.');
    }
    return this.gisLayersService.layerGroupBy(appUser, id, {
      by,
      areaLayerId,
      areaField,
      measure: m,
      measureField,
      shapes: shapes === 'true',
    });
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/analytics/area-shape')
  analyticsAreaShape(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Query('field') field: string | undefined,
    @Query('value') value: string | undefined,
  ) {
    if (!field) {
      throw new BadRequestException('field is required.');
    }
    return this.gisLayersService.layerAreaShape(
      appUser,
      id,
      field,
      value ?? null,
    );
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/analytics/summary')
  analyticsSummary(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Query('field') field: string | undefined,
  ) {
    if (!field) {
      throw new BadRequestException('field is required.');
    }
    return this.gisLayersService.layerFieldSummary(appUser, id, field);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/analytics/points')
  analyticsPoints(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Query('weight') weight: string | undefined,
  ) {
    return this.gisLayersService.layerDensityPoints(
      appUser,
      id,
      weight || undefined,
    );
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
