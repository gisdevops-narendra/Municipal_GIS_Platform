import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { RequireMunicipalityOwner } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { CreateApiKeyDto, CreateWebhookDto, UpdateWebhookDto, WEBHOOK_EVENTS } from './dto/platform-extras.dto';
import { IntegrationsService } from './integrations.service';

/** API keys + webhooks — Municipality Owner only. */
@Controller('gis/integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @RequireMunicipalityOwner()
  @Get('api-keys')
  listKeys(@CurrentAppUser() appUser: AppUser) {
    return this.integrations.listKeys(appUser);
  }

  @RequireMunicipalityOwner()
  @Post('api-keys')
  createKey(@CurrentAppUser() appUser: AppUser, @Body() dto: CreateApiKeyDto) {
    return this.integrations.createKey(appUser, dto);
  }

  @RequireMunicipalityOwner()
  @Delete('api-keys/:id')
  @HttpCode(204)
  async revokeKey(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    await this.integrations.revokeKey(appUser, id);
  }

  @RequireMunicipalityOwner()
  @Get('webhooks/events')
  events() {
    return WEBHOOK_EVENTS;
  }

  @RequireMunicipalityOwner()
  @Get('webhooks')
  listWebhooks(@CurrentAppUser() appUser: AppUser) {
    return this.integrations.listWebhooks(appUser);
  }

  @RequireMunicipalityOwner()
  @Post('webhooks')
  createWebhook(@CurrentAppUser() appUser: AppUser, @Body() dto: CreateWebhookDto) {
    return this.integrations.createWebhook(appUser, dto);
  }

  @RequireMunicipalityOwner()
  @Patch('webhooks/:id')
  updateWebhook(@CurrentAppUser() appUser: AppUser, @Param('id') id: string, @Body() dto: UpdateWebhookDto) {
    return this.integrations.updateWebhook(appUser, id, dto);
  }

  @RequireMunicipalityOwner()
  @Delete('webhooks/:id')
  @HttpCode(204)
  async deleteWebhook(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    await this.integrations.deleteWebhook(appUser, id);
  }

  @RequireMunicipalityOwner()
  @Post('webhooks/:id/test')
  testWebhook(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.integrations.testWebhook(appUser, id);
  }
}
