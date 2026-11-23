import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KeycloakModule } from '../keycloak/keycloak.module';
import { GisModule } from '../gis/gis.module';
import { AccountModule } from '../account/account.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminSessionsService } from './admin-sessions.service';
import { AdminMaintenanceService } from './admin-maintenance.service';
import { PlatformAdminGuard } from './platform-admin';

@Module({
  imports: [AuthModule, KeycloakModule, GisModule, AccountModule],
  controllers: [AdminController],
  providers: [AdminService, AdminSessionsService, AdminMaintenanceService, PlatformAdminGuard],
})
export class AdminModule {}
