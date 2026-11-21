import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import {
  RequireMunicipalityManager,
  RequireMunicipalityMember,
  RequireMunicipalityOwner,
} from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { CatalogService } from './catalog.service';
import { OsmImportDto, UpdateLayerMetadataDto } from './dto/platform-extras.dto';
import { OsmImportService } from './osm-import.service';
import { StorageUsageService } from './storage-usage.service';

/** Data Catalog, Storage usage & limits, and OpenStreetMap download. */
@Controller('gis')
export class DataPlatformController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly storage: StorageUsageService,
    private readonly osm: OsmImportService,
  ) {}

  @RequireMunicipalityMember()
  @Get('catalog')
  listCatalog(@CurrentAppUser() appUser: AppUser) {
    return this.catalog.list(appUser);
  }

  /** MANAGE on the layer is checked in the service. */
  @RequireMunicipalityMember()
  @Patch('catalog/:layerId')
  updateCatalog(@CurrentAppUser() appUser: AppUser, @Param('layerId') layerId: string, @Body() dto: UpdateLayerMetadataDto) {
    return this.catalog.update(appUser, layerId, dto);
  }

  @RequireMunicipalityManager()
  @Get('storage')
  storageOverview(@CurrentAppUser() appUser: AppUser) {
    return this.storage.overview(appUser);
  }

  @RequireMunicipalityMember()
  @Get('osm-import/presets')
  osmPresets() {
    return this.osm.presets();
  }

  /** Layer-creation permission is checked by prepareVectorOutput. */
  @RequireMunicipalityMember()
  @Post('osm-import')
  osmImport(@CurrentAppUser() appUser: AppUser, @Body() dto: OsmImportDto) {
    return this.osm.import(appUser, dto);
  }
}
