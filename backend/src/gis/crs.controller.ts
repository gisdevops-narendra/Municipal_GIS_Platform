import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CrsService } from './crs.service';

/** The coordinate systems the platform supports (any EPSG 2D CRS). */
@Controller('gis/crs')
export class CrsController {
  constructor(private readonly crs: CrsService) {}

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
