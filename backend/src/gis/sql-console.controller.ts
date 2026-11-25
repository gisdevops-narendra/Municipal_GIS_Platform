import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Res } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { SqlConsoleService, type SqlExportFormat } from './sql-console.service';

export class SqlConsoleRunDto {
  @IsString()
  @MaxLength(20_000)
  sql!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5000)
  limit?: number;

  /** Values for :name placeholders. */
  @IsOptional()
  @IsObject()
  params?: Record<string, string>;
}

export class SqlConsoleSaveLayerDto extends SqlConsoleRunDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class SqlConsoleExportDto extends SqlConsoleRunDto {
  @IsIn(['csv', 'xlsx', 'geojson', 'kml', 'shapefile'])
  format!: SqlExportFormat;
}

export class SqlSavedQueryDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsString()
  @MaxLength(20_000)
  sql!: string;

  @IsOptional()
  @IsBoolean()
  shared?: boolean;
}

/** SQL Console: read-only SELECTs over the caller's viewable layers. */
@Controller('gis/sql')
export class SqlConsoleController {
  constructor(private readonly console: SqlConsoleService) {}

  @RequireMunicipalityMember()
  @Get('tables')
  tables(@CurrentAppUser() appUser: AppUser) {
    return this.console.tables(appUser);
  }

  @RequireMunicipalityMember()
  @Post('run')
  @HttpCode(200)
  run(@CurrentAppUser() appUser: AppUser, @Body() dto: SqlConsoleRunDto) {
    return this.console.run(appUser, dto.sql, dto.limit, dto.params);
  }

  @RequireMunicipalityMember()
  @Post('explain')
  @HttpCode(200)
  explain(@CurrentAppUser() appUser: AppUser, @Body() dto: SqlConsoleRunDto) {
    return this.console.explain(appUser, dto.sql, dto.params);
  }

  @RequireMunicipalityMember()
  @Post('save-layer')
  saveLayer(@CurrentAppUser() appUser: AppUser, @Body() dto: SqlConsoleSaveLayerDto) {
    return this.console.saveAsLayer(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Post('export')
  @HttpCode(200)
  async export(@CurrentAppUser() appUser: AppUser, @Body() dto: SqlConsoleExportDto, @Res() res: Response) {
    const file = await this.console.export(appUser, dto);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.body);
  }

  @RequireMunicipalityMember()
  @Get('saved')
  listSaved(@CurrentAppUser() appUser: AppUser) {
    return this.console.listSaved(appUser);
  }

  @RequireMunicipalityMember()
  @Post('saved')
  createSaved(@CurrentAppUser() appUser: AppUser, @Body() dto: SqlSavedQueryDto) {
    return this.console.saveQuery(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Put('saved/:id')
  updateSaved(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SqlSavedQueryDto) {
    return this.console.saveQuery(appUser, dto, id);
  }

  @RequireMunicipalityMember()
  @Delete('saved/:id')
  deleteSaved(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.console.deleteSaved(appUser, id);
  }
}
