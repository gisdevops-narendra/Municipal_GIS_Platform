import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { KeycloakJwtGuard } from '../auth/guards/keycloak-jwt.guard';
import { AppUserGuard } from '../auth/guards/app-user.guard';
import { CurrentKeycloakUser } from '../auth/decorators/current-keycloak-user.decorator';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import {
  RequireMunicipalityMember,
  RequireMunicipalityOwner,
} from '../auth/decorators/authorization.decorators';
import type { KeycloakJwtPayload } from '../auth/strategies/keycloak-jwt.strategy';
import type { AppUser } from '../auth/types/app-user.type';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto, UpdateUserStatusDto } from './dto/update-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';

@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /** GET /api/me — the authenticated application user, derived entirely
   *  from the validated JWT's `sub` claim. AppUserGuard additionally
   *  rejects a deactivated user here, even with an otherwise-valid token. */
  @UseGuards(KeycloakJwtGuard, AppUserGuard)
  @Get('me')
  getMe(@CurrentKeycloakUser() user: KeycloakJwtPayload) {
    return this.usersService.getAuthenticatedUser(user.sub);
  }

  /** Any authenticated member of the municipality may view the user list —
   *  only creating/editing/deactivating is Owner-only. */
  @RequireMunicipalityMember()
  @Get('users')
  list(@CurrentAppUser() appUser: AppUser, @Query() query: QueryUsersDto) {
    return this.usersService.list(appUser.municipalityId, query);
  }

  @RequireMunicipalityMember()
  @Get('users/:id')
  getOne(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.usersService.getById(appUser.municipalityId, id);
  }

  @RequireMunicipalityOwner()
  @Post('users')
  create(@CurrentAppUser() appUser: AppUser, @Body() dto: CreateUserDto) {
    return this.usersService.createUser(appUser, dto);
  }

  @RequireMunicipalityOwner()
  @Patch('users/:id')
  update(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.updateUser(appUser.municipalityId, id, dto);
  }

  @RequireMunicipalityOwner()
  @Patch('users/:id/status')
  updateStatus(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.usersService.updateUserStatus(appUser.municipalityId, id, dto);
  }
}
