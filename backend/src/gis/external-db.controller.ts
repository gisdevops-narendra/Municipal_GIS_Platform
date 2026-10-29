import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { RequireMunicipalityManager } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { ExternalDbDatasetDto, ExternalDbImportDto, ExternalDbRequestDto } from './dto/external-db.dto';
import { ExternalDbService } from './external-db.service';

/** Upload GIS data straight from an external database. All POST, so the
 *  connection details travel in the body, never in a URL or access log. */
@Controller('gis/external-db')
export class ExternalDbController {
  constructor(private readonly externalDb: ExternalDbService) {}

  @RequireMunicipalityManager()
  @Post('test')
  @HttpCode(200)
  test(@Body() dto: ExternalDbRequestDto) {
    return this.externalDb.test(dto.connection);
  }

  /** Tables / collections, spatial ones first. */
  @RequireMunicipalityManager()
  @Post('datasets')
  @HttpCode(200)
  datasets(@Body() dto: ExternalDbRequestDto) {
    return this.externalDb.datasets(dto.connection);
  }

  @RequireMunicipalityManager()
  @Post('preview')
  @HttpCode(200)
  preview(@Body() dto: ExternalDbDatasetDto) {
    return this.externalDb.preview(dto.connection, dto.dataset);
  }

  /** Creates an upload from the dataset — the same response (and next
   *  wizard steps) as POST /gis/uploads. */
  @RequireMunicipalityManager()
  @Post('import')
  import(@CurrentAppUser() appUser: AppUser, @Body() dto: ExternalDbImportDto) {
    return this.externalDb.import(appUser, dto);
  }
}
