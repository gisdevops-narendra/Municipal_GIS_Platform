import { UseGuards } from '@nestjs/common';
import { KeycloakJwtGuard } from '../auth/guards/keycloak-jwt.guard';
import { AppUserGuard } from '../auth/guards/app-user.guard';

/** AI Assistant endpoint gate: any signed-in account. */
export function RequireAiAssistant() {
  return UseGuards(KeycloakJwtGuard, AppUserGuard);
}
