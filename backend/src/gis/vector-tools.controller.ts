import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseFloatPipe,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { VectorToolsService } from './vector-tools.service';
import {
  CreateBlankLayerDto,
  CreateFeatureDto,
  GeoprocessDto,
  ImpactReportDto,
  MergeFeaturesDto,
  SplitFeatureDto,
  UpdateFeatureDto,
} from './dto/vector-tools.dto';
import { SaveSelectionDto } from './dto/selection.dto';

/** Feature Editing, Edit History, Geoprocessing and Impact Report. Layer
 *  permissions (VIEW / UPLOAD|MANAGE / EXPORT) and Module Access are both
 *  enforced in VectorToolsService. */
@Controller('gis')
export class VectorToolsController {
  constructor(private readonly vectorTools: VectorToolsService) {}

  @RequireMunicipalityMember()
  @Post('layers/blank')
  createBlankLayer(@CurrentAppUser() appUser: AppUser, @Body() dto: CreateBlankLayerDto) {
    return this.vectorTools.createBlankLayer(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/edit-schema')
  editSchema(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.vectorTools.editSchema(appUser, id);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/features/at')
  featureAt(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Query('lon', ParseFloatPipe) lon: number,
    @Query('lat', ParseFloatPipe) lat: number,
    @Query('tolerance', new ParseFloatPipe({ optional: true })) tolerance?: number,
  ) {
    return this.vectorTools
      .featureAt(appUser, id, lon, lat, tolerance ?? 5)
      .then((feature) => ({ feature }));
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/features')
  createFeature(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Body() dto: CreateFeatureDto,
  ) {
    return this.vectorTools.createFeature(appUser, id, dto.geometry, dto.properties);
  }

  @RequireMunicipalityMember()
  @Patch('layers/:id/features/:fid')
  updateFeature(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Param('fid', ParseIntPipe) fid: number,
    @Body() dto: UpdateFeatureDto,
  ) {
    return this.vectorTools.updateFeature(appUser, id, fid, dto.geometry, dto.properties);
  }

  @RequireMunicipalityMember()
  @Delete('layers/:id/features/:fid')
  deleteFeature(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Param('fid', ParseIntPipe) fid: number,
  ) {
    return this.vectorTools.deleteFeature(appUser, id, fid);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/features/merge')
  mergeFeatures(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Body() dto: MergeFeaturesDto,
  ) {
    return this.vectorTools.mergeFeatures(appUser, id, dto.featureIds, dto.keepId);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/features/:fid/split')
  splitFeature(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Param('fid', ParseIntPipe) fid: number,
    @Body() dto: SplitFeatureDto,
  ) {
    return this.vectorTools.splitFeature(appUser, id, fid, dto.line);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/features/:fid/attachments')
  listAttachments(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Param('fid', ParseIntPipe) fid: number,
  ) {
    return this.vectorTools.listAttachments(appUser, id, fid);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/features/:fid/attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  addAttachment(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Param('fid', ParseIntPipe) fid: number,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('A file is required.');
    return this.vectorTools.addAttachment(appUser, id, fid, file);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/attachments/:attachmentId')
  async attachment(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: Response,
  ) {
    const { row, body } = await this.vectorTools.attachmentFile(appUser, id, attachmentId);
    res.setHeader('Content-Type', row.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${row.fileName.replace(/["\\\r\n]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(body);
  }

  @RequireMunicipalityMember()
  @Delete('layers/:id/attachments/:attachmentId')
  deleteAttachment(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.vectorTools.deleteAttachment(appUser, id, attachmentId);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/history')
  layerHistory(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Query('featureId', new ParseIntPipe({ optional: true })) featureId?: number,
  ) {
    return this.vectorTools.history(appUser, id, featureId);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/save-selection')
  saveSelection(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Body() dto: SaveSelectionDto,
  ) {
    return this.vectorTools.saveSelection(appUser, id, dto);
  }

  @RequireMunicipalityMember()
  @Post('geoprocessing')
  geoprocess(@CurrentAppUser() appUser: AppUser, @Body() dto: GeoprocessDto) {
    return this.vectorTools.geoprocess(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/impact')
  async impact(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Body() dto: ImpactReportDto,
    @Res() res: Response,
  ) {
    const { filename, body, count } = await this.vectorTools.impactCsv(
      appUser,
      id,
      dto.geometry,
      dto.distance,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Feature-Count', String(count));
    res.send(body);
  }
}
