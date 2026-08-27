import { Module } from '@nestjs/common';
import { KeycloakAdminService } from './keycloak-admin.service';

@Module({
  providers: [KeycloakAdminService],
  exports: [KeycloakAdminService],
})
export class KeycloakModule {}
