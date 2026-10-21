import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UseGuards } from '@nestjs/common';
import { KeycloakJwtGuard } from '../auth/guards/keycloak-jwt.guard';
import { AppUserGuard, type RequestWithAppUser } from '../auth/guards/app-user.guard';
import { ModuleAccessService } from '../module-access/module-access.service';

/** Module Access id of the AI Assistant (modules table, baseline migration). */
export const AI_ASSISTANT_MODULE_ID = 900;

/**
 * AI Assistant endpoint gate: municipality member AND the AI Assistant
 * module in the caller's effective modules. The map hides the tool the
 * same way, but the API must not rely on that.
 */
export function RequireAiAssistant() {
  return UseGuards(KeycloakJwtGuard, AppUserGuard, AiAssistantGuard);
}

@Injectable()
export class AiAssistantGuard implements CanActivate {
  constructor(private readonly moduleAccess: ModuleAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithAppUser>();
    const granted = await this.moduleAccess.getEffectiveModuleIdsForAppUser(request.appUser);
    if (!granted.has(AI_ASSISTANT_MODULE_ID)) {
      throw new ForbiddenException('Your module access does not include the AI Assistant.');
    }
    return true;
  }
}
