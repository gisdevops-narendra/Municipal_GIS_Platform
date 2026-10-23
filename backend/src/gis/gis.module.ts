import { Module } from '@nestjs/common';
import { ModuleAccessModule } from '../module-access/module-access.module';
import { AuthModule } from '../auth/auth.module';
import { AiClientModule } from '../gis-ai/ai-client.module';
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
import { RasterJobsService } from './raster-jobs.service';
import { RasterMonitorService } from './raster-monitor.service';
import { RasterMailService } from './raster-mail.service';
import { RasterWorkspaceService } from './raster-workspace.service';
import { RasterModuleGuard } from './raster-module.guard';
import { VectorToolsController } from './vector-tools.controller';
import { VectorToolsService } from './vector-tools.service';
import { DataToolsController } from './data-tools.controller';
import { DataToolsService } from './data-tools.service';
import { CrsController } from './crs.controller';
import { CrsService } from './crs.service';
import { UploadReviewService } from './upload-review.service';
import { UploadSchemaService } from './upload-schema.service';

@Module({
  imports: [AuthModule, ModuleAccessModule, AiClientModule],
  controllers: [
    GisWorkspaceController,
    GisLayersController,
    GisUploadsController,
    GisDashboardController,
    PrintController,
    NetworkController,
    RasterController,
    VectorToolsController,
    DataToolsController,
    CrsController,
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
    RasterJobsService,
    RasterMonitorService,
    RasterMailService,
    RasterWorkspaceService,
    RasterModuleGuard,
    VectorToolsService,
    DataToolsService,
    CrsService,
    UploadReviewService,
    UploadSchemaService,
  ],
  exports: [
    GisWorkspaceService,
    GisLayersService,
    GisAuthorizationService,
    GeoServerService,
    NetworkService,
    RasterService,
    CrsService,
  ],
})
export class GisModule {}
