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
  CalcGeometryDto,
  FieldManageDto,
  FindReplaceDto,
  SplitLayerDto,
  AppendDto,
  AutoNumberDto,
  ChangeTypeDto,
  DuplicatesDto,
  StandardiseDto,
} from './dto/data-tools.dto';

const CSV_LIMIT = { limits: { fileSize: 20 * 1024 * 1024 } };

/** GIS Data Tools. Layer permissions and Module Access are enforced in
 *  DataToolsService. */
@Controller('gis')
export class DataToolsController {
  constructor(private readonly dataTools: DataToolsService) {}

  @RequireMunicipalityMember()
  @Post('layers/:id/auto-number')
  @HttpCode(200)
  autoNumber(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Body() dto: AutoNumberDto) {
    return this.dataTools.autoNumber(appUser, id, dto);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/change-type')
  @HttpCode(200)
  changeType(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Body() dto: ChangeTypeDto) {
    return this.dataTools.changeType(appUser, id, dto);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/duplicates')
  @HttpCode(200)
  duplicates(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Body() dto: DuplicatesDto) {
    return this.dataTools.duplicates(appUser, id, dto);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/standardise')
  @HttpCode(200)
  standardise(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Body() dto: StandardiseDto) {
    return this.dataTools.standardise(appUser, id, dto);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/append')
  @HttpCode(200)
  append(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Body() dto: AppendDto) {
    return this.dataTools.append(appUser, id, dto);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/change-log')
  changeLog(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.dataTools.changeLog(appUser, id);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/fields')
  @HttpCode(200)
  manageField(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Body() dto: FieldManageDto) {
    return this.dataTools.manageField(appUser, id, dto);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/calculate-geometry')
  @HttpCode(200)
  calculateGeometry(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Body() dto: CalcGeometryDto) {
    return this.dataTools.calculateGeometry(appUser, id, dto);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/find-replace')
  @HttpCode(200)
  findReplace(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Body() dto: FindReplaceDto) {
    return this.dataTools.findReplace(appUser, id, dto);
  }

  @RequireMunicipalityMember()
  @Get('layers/:id/completeness')
  completeness(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.dataTools.completeness(appUser, id);
  }

  @RequireMunicipalityMember()
  @Post('layers/:id/split')
  @HttpCode(200)
  split(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Body() dto: SplitLayerDto) {
    return this.dataTools.splitByAttribute(appUser, id, dto);
  }

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
