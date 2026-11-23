import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { KeycloakModule } from './keycloak/keycloak.module';
import { MunicipalitiesModule } from './municipalities/municipalities.module';
import { AccountModule } from './account/account.module';
import { AuditModule } from './audit/audit.module';
import { PlatformModule } from './platform/platform.module';
import { AdminModule } from './admin/admin.module';
import { GisModule } from './gis/gis.module';
import { GisAiModule } from './gis-ai/gis-ai.module';
import { SettingsModule } from './settings/settings.module';
import { SystemModule } from './system/system.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuditModule,
    PlatformModule,
    AuthModule,
    KeycloakModule,
    MunicipalitiesModule,
    AccountModule,
    AdminModule,
    GisModule,
    GisAiModule,
    SettingsModule,
    SystemModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
