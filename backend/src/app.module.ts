import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { KeycloakModule } from './keycloak/keycloak.module';
import { MunicipalitiesModule } from './municipalities/municipalities.module';
import { UsersModule } from './users/users.module';
import { DepartmentsModule } from './departments/departments.module';
import { GisModule } from './gis/gis.module';
import { GisAiModule } from './gis-ai/gis-ai.module';
import { SettingsModule } from './settings/settings.module';
import { SystemModule } from './system/system.module';
import { ModuleAccessModule } from './module-access/module-access.module';
import { OnboardingModule } from './onboarding/onboarding.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    KeycloakModule,
    MunicipalitiesModule,
    UsersModule,
    DepartmentsModule,
    GisModule,
    GisAiModule,
    SettingsModule,
    SystemModule,
    ModuleAccessModule,
    OnboardingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
