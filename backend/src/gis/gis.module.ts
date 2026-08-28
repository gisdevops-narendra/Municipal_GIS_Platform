import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GisWorkspaceController } from './gis-workspace.controller';
import { GisWorkspaceService } from './gis-workspace.service';
import { GisLayersController } from './gis-layers.controller';
import { GisLayersService } from './gis-layers.service';
import { GeoServerService } from './geoserver.service';
import { GisUploadsController } from './gis-uploads.controller';
import { GisUploadsService } from './gis-uploads.service';
import { GdalService } from './gdal.service';
import { StorageService } from './storage.service';
import { GisAuthorizationService } from './gis-authorization.service';
import { GisDashboardController } from './gis-dashboard.controller';
import { GisDashboardService } from './gis-dashboard.service';
import { PrintController } from './print.controller';
import { PrintService } from './print.service';

@Module({
  imports: [AuthModule],
  controllers: [
    GisWorkspaceController,
    GisLayersController,
    GisUploadsController,
    GisDashboardController,
    PrintController,
  ],
  providers: [
    GisWorkspaceService,
    GisLayersService,
    GeoServerService,
    GisUploadsService,
    GdalService,
    StorageService,
    GisAuthorizationService,
    GisDashboardService,
    PrintService,
  ],
  exports: [GisWorkspaceService, GisLayersService, GisAuthorizationService],
})
export class GisModule {}
