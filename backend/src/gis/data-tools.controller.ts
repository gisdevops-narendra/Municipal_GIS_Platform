import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { DataToolsService } from './data-tools.service';
import {
  CreateSnapshotDto,
  FieldCalcDto,
  FieldRulesDto,
  FixLayerDto,
  GeocodeDto,
  TableJoinDto,
  ValidateLayerDto,
} from './dto/data-tools.dto';

const CSV_LIMIT = { limits: { fileSize: 20 * 1024 * 1024 } };

/** GIS Data Tools. Layer permissions and Module Access are enforced in
 *  DataToolsService. */
@Controller('gis')
export class DataToolsController {
  constructor(private readonly dataTools: DataToolsService) {}

  @RequireMunicipalityMember()
  @Post('layers/:id/field-calculator')
  @HttpCode(200)
  fieldCalculate(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Body() dto: FieldCalcDto) {
    return this.dataTools.fieldCalculate(appUser, id, dto);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/join-table')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', CSV_LIMIT))
  joinTable(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Body() dto: TableJoinDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('A CSV file is required.');
    return this.dataTools.joinTable(appUser, id, file.buffer, dto);
  }

  @RequireMunicipalityMember()
  @Post('geocode')
  @UseInterceptors(FileInterceptor('file', CSV_LIMIT))
  geocode(
    @CurrentAppUser() appUser: AppUser,
    @Body() dto: GeocodeDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('A CSV file is required.');
    return this.dataTools.geocode(appUser, file.buffer, dto);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/validate')
  @HttpCode(200)
  validate(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Body() dto: ValidateLayerDto) {
    return this.dataTools.validate(appUser, id, dto);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/validate/fix')
  @HttpCode(200)
  fix(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Body() dto: FixLayerDto) {
    return this.dataTools.fix(appUser, id, dto.kind);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/field-rules')
  getFieldRules(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.dataTools.getFieldRules(appUser, id);
  }

  @RequireMunicipalityMember()
  @Put('layers/:id/field-rules')
  setFieldRules(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Body() dto: FieldRulesDto) {
    return this.dataTools.setFieldRules(appUser, id, dto);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/snapshots')
  listSnapshots(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.dataTools.listSnapshots(appUser, id);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/snapshots')
  createSnapshot(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Body() dto: CreateSnapshotDto) {
    return this.dataTools.createSnapshot(appUser, id, dto.name);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/snapshots/:snapshotId/compare')
  compare(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Param('snapshotId') snapshotId: string,
    @Query('key') key?: string,
  ) {
    return this.dataTools.compareSnapshot(appUser, id, snapshotId, key);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/snapshots/:snapshotId/restore')
  @HttpCode(200)
  restore(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Param('snapshotId') snapshotId: string) {
    return this.dataTools.restoreSnapshot(appUser, id, snapshotId);
  }

  @RequireMunicipalityMember()
  @Delete('layers/:id/snapshots/:snapshotId')
  deleteSnapshot(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Param('snapshotId') snapshotId: string) {
    return this.dataTools.deleteSnapshot(appUser, id, snapshotId);
  }
}
