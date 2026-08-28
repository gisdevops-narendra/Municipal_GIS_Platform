import { Controller, Get } from '@nestjs/common';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { SystemService } from './system.service';

/**
 * `/api/system/*` — read-only status + version info for the Settings
 * screen. Authenticated (any municipality member) but not tenant-scoped:
 * connectivity is a platform fact, not per-municipality data.
 */
@Controller('system')
export class SystemController {
  constructor(private readonly systemService: SystemService) {}

  @RequireMunicipalityMember()
  @Get('status')
  status() {
    return this.systemService.status();
  }

  @RequireMunicipalityMember()
  @Get('info')
  info() {
    return this.systemService.info();
  }
}
