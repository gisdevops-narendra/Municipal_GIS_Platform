import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { PrintService } from './print.service';
import { PrintReportDto } from './dto/print-report.dto';

/**
 * Print Layout endpoints (GIS workspace → left dock). Any municipality
 * member may print — it is a read-only view of layers they can already
 * see, and PrintService re-checks every layer against their
 * permission-filtered list. Angular never talks to MapFish directly.
 */
@Controller('gis')
export class PrintController {
  constructor(private readonly printService: PrintService) {}

  @RequireMunicipalityMember()
  @Get('print/capabilities')
  getCapabilities() {
    return this.printService.getCapabilities();
  }

  @RequireMunicipalityMember()
  @Post('print/report')
  async report(
    @CurrentAppUser() appUser: AppUser,
    @Body() dto: PrintReportDto,
    @Res() res: Response,
  ): Promise<void> {
    const { body, contentType, filename } = await this.printService.buildReport(
      appUser,
      dto,
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', body.length);
    res.send(body);
  }
}
