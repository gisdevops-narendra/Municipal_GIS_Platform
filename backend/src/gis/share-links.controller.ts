import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { RequireMunicipalityManager } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { CreateShareLinkDto } from './dto/platform-extras.dto';
import { ShareLinksService } from './share-links.service';

/**
 * Share Map. Making data public is a management action, so creating /
 * listing links needs Owner or Department Head; opening one needs nothing.
 */
@Controller()
export class ShareLinksController {
  constructor(private readonly shares: ShareLinksService) {}

  @RequireMunicipalityManager()
  @Get('gis/shares')
  list(@CurrentAppUser() appUser: AppUser) {
    return this.shares.list(appUser);
  }

  @RequireMunicipalityManager()
  @Post('gis/shares')
  create(@CurrentAppUser() appUser: AppUser, @Body() dto: CreateShareLinkDto) {
    return this.shares.create(appUser, dto);
  }

  @RequireMunicipalityManager()
  @Delete('gis/shares/:id')
  @HttpCode(204)
  async revoke(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    await this.shares.revoke(appUser, id);
  }

  /** Public, no sign-in: GET /public/shares/:token */
  @Get('public/shares/:token')
  open(@Param('token') token: string) {
    return this.shares.open(token);
  }
}
