import { Body, Controller, Get, HttpCode, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { clientIp } from '../common/client-ip';
import { RateLimit } from '../common/rate-limit.guard';
import { KeycloakJwtGuard } from '../auth/guards/keycloak-jwt.guard';
import { AppUserGuard } from '../auth/guards/app-user.guard';
import { CurrentKeycloakUser } from '../auth/decorators/current-keycloak-user.decorator';
import type { KeycloakJwtPayload } from '../auth/strategies/keycloak-jwt.strategy';
import { AccountService } from './account.service';
import { UpdateMeDto } from './dto/update-me.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { ChangeEmailDto } from './dto/change-email.dto';

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

  /** Changes the sign-in email (confirmed with the password). */
  @Post('email')
  @HttpCode(200)
  @RateLimit({ name: 'password-confirm', perIp: 10, windowMs: 15 * 60 * 1000 })
  changeEmail(@CurrentKeycloakUser() user: KeycloakJwtPayload, @Body() dto: ChangeEmailDto, @Req() req: Request) {
    return this.account.changeEmail(user.sub, dto.email, dto.password, clientIp(req));
  }

  /** Permanently deletes the account (confirmed with its password). */
  @Post('delete')
  @HttpCode(204)
  @RateLimit({ name: 'password-confirm', perIp: 10, windowMs: 15 * 60 * 1000 })
  async deleteMe(@CurrentKeycloakUser() user: KeycloakJwtPayload, @Body() dto: DeleteAccountDto, @Req() req: Request) {
    await this.account.deleteMe(user.sub, dto.password, clientIp(req));
  }
}
