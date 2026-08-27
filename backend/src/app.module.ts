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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
