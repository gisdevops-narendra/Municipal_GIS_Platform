import { Body, Controller, Delete, Get, Patch, Put } from '@nestjs/common';
import { RequireMunicipalityMember, RequireMunicipalityOwner } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { SettingsService } from './settings.service';
import { AppSettingsDto, MunicipalityDefaultsDto } from './dto/app-settings.dto';

/**
 * `/api/me/settings` — the authenticated user's own application settings.
 * Always scoped to `appUser.id` (resolved from the JWT), never a client-
 * supplied id, so a user can only ever read/write their own.
 */
@Controller('me/settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @RequireMunicipalityMember()
  @Get()
  get(@CurrentAppUser() appUser: AppUser) {
    return this.settingsService.get(appUser.id, appUser.municipalityId);
  }

  /** Owner: the setting defaults for everyone in the municipality. */
  @RequireMunicipalityOwner()
  @Put('municipality-defaults')
  async setMunicipalityDefaults(@CurrentAppUser() appUser: AppUser, @Body() dto: MunicipalityDefaultsDto) {
    return { municipalityDefaults: await this.settingsService.setMunicipalityDefaults(appUser.municipalityId, dto) };
  }

  @RequireMunicipalityMember()
  @Patch()
  async patch(@CurrentAppUser() appUser: AppUser, @Body() dto: AppSettingsDto) {
    return { settings: await this.settingsService.patch(appUser.id, dto) };
  }

  @RequireMunicipalityMember()
  @Delete()
  async reset(@CurrentAppUser() appUser: AppUser): Promise<{ success: true }> {
    await this.settingsService.reset(appUser.id);
    return { success: true };
  }
}
