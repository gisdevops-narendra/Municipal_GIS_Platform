import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { KeycloakJwtStrategy } from './strategies/keycloak-jwt.strategy';
import { KeycloakJwtGuard } from './guards/keycloak-jwt.guard';
import { AppUserGuard } from './guards/app-user.guard';
import { RolesGuard } from './guards/roles.guard';

@Module({
  imports: [PassportModule],
  providers: [KeycloakJwtStrategy, KeycloakJwtGuard, AppUserGuard, RolesGuard],
  exports: [KeycloakJwtGuard, AppUserGuard, RolesGuard],
})
export class AuthModule {}
