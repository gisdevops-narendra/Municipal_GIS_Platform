import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { KeycloakJwtGuard } from '../auth/guards/keycloak-jwt.guard';
import { AppUserGuard } from '../auth/guards/app-user.guard';
import { CurrentKeycloakUser } from '../auth/decorators/current-keycloak-user.decorator';
import type { KeycloakJwtPayload } from '../auth/strategies/keycloak-jwt.strategy';
import { MunicipalitiesService } from './municipalities.service';
import { RegisterMunicipalityDto } from './dto/register-municipality.dto';

@Controller('municipalities')
export class MunicipalitiesController {
  constructor(private readonly municipalitiesService: MunicipalitiesService) {}

  /** Public: no Keycloak session exists yet at registration time. The
   *  backend creates the Keycloak identity itself and links it to the new
   *  owner — the browser never supplies a keycloak_user_id or a role. */
  @Post('register')
  register(@Body() dto: RegisterMunicipalityDto) {
    return this.municipalitiesService.registerMunicipality(dto);
  }

  /**
   * Tenant-isolation demonstration endpoint (see
   * src/municipalities/tenant-isolation.spec.ts): a `municipalityId` query
   * parameter is accepted here for exactly one reason — to prove it has no
   * effect. The municipality returned is always derived from the
   * authenticated caller's own User record — never from client-supplied
   * input — so User A can never read Municipality B's data by editing this
   * query parameter.
   */
  @UseGuards(KeycloakJwtGuard, AppUserGuard)
  @Get('current')
  getCurrentMunicipality(
    @CurrentKeycloakUser() user: KeycloakJwtPayload,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentionally accepted and ignored, see doc comment above
    @Query('municipalityId') ignoredMunicipalityId?: string,
  ) {
    return this.municipalitiesService.getMunicipalityForKeycloakUser(user.sub);
  }
}
