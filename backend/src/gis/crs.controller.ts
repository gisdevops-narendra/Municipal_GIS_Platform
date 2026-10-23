import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CrsService } from './crs.service';
import { GdalService } from './gdal.service';

class IdentifyCrsDto {
  /** A .prj file's WKT. */
  @IsString()
  @MaxLength(20000)
  wkt!: string;
}

/** The coordinate systems the platform supports (any EPSG 2D CRS). */
@Controller('gis/crs')
export class CrsController {
  constructor(
    private readonly crs: CrsService,
    private readonly gdal: GdalService,
  ) {}

  /** The upload form shows a Shapefile's projection before uploading: the
   *  closest EPSG CRS to its .prj, plus the name the .prj itself gives. */
  @RequireMunicipalityMember()
  @Post('identify')
  @HttpCode(200)
  async identify(@Body() dto: IdentifyCrsDto) {
    const name = /^[A-Z_0-9]+\["([^"]+)"/.exec(dto.wkt.trim())?.[1] ?? null;
    const srid = await this.gdal.identifyEpsg(dto.wkt.trim());
    return { name, crs: srid ? await this.crs.get(srid) : null };
  }

  /** ?q=utm 43 | 32643 | EPSG:7755 — empty lists the recommended ones. */
  @RequireMunicipalityMember()
  @Get()
  search(@Query('q') q?: string, @Query('limit') limit?: string) {
    return this.crs.search(q, Number(limit) || undefined);
  }

  @RequireMunicipalityMember()
  @Get(':code')
  async get(@Param('code') code: string) {
    const crs = await this.crs.get(code);
    if (!crs) throw new NotFoundException(`"${code}" is not a supported EPSG coordinate system.`);
    return crs;
  }
}
