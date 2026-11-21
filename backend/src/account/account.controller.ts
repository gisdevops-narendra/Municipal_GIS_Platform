import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { KeycloakJwtGuard } from '../auth/guards/keycloak-jwt.guard';
import { AppUserGuard } from '../auth/guards/app-user.guard';
import { CurrentKeycloakUser } from '../auth/decorators/current-keycloak-user.decorator';
import type { KeycloakJwtPayload } from '../auth/strategies/keycloak-jwt.strategy';
import { AccountService } from './account.service';
import { UpdateMeDto } from './dto/update-me.dto';

@Controller('me')
@UseGuards(KeycloakJwtGuard, AppUserGuard)
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get()
  getMe(@CurrentKeycloakUser() user: KeycloakJwtPayload) {
    return this.account.getMe(user.sub);
  }

  @Patch()
  updateMe(@CurrentKeycloakUser() user: KeycloakJwtPayload, @Body() dto: UpdateMeDto) {
    return this.account.updateMe(user.sub, dto);
  }
}
