import { Module } from '@nestjs/common';
import { ModuleAccessModule } from '../module-access/module-access.module';
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
import { StyleService } from './style.service';
import { FieldStatsService } from './field-stats.service';
import { LayerReportService } from './layer-report.service';
import { YsldGenerator } from './ysld-generator';
import { NetworkController } from './network.controller';
import { NetworkService } from './network.service';
import { RasterController } from './raster.controller';
import { RasterService } from './raster.service';
import { RasterToolsService } from './raster-tools.service';

@Module({
  imports: [AuthModule, ModuleAccessModule],
  controllers: [
    GisWorkspaceController,
    GisLayersController,
    GisUploadsController,
    GisDashboardController,
    PrintController,
    NetworkController,
    RasterController,
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
    StyleService,
    FieldStatsService,
    LayerReportService,
    YsldGenerator,
    NetworkService,
    RasterService,
    RasterToolsService,
  ],
  exports: [
    GisWorkspaceService,
    GisLayersService,
    GisAuthorizationService,
    GeoServerService,
  ],
})
export class GisModule {}
