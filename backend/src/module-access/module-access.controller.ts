import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  RequireMunicipalityMember,
  RequireMunicipalityOwner,
} from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { ModuleAccessService } from './module-access.service';
import { SetModuleGrantsDto } from './dto/set-module-grants.dto';
import { CreateModuleDto } from './dto/create-module.dto';

/**
 * Hierarchical Module Access (Owner -> Department -> Department User).
 * Every handler is reachable by any municipality member
 * (@RequireMunicipalityMember) — the real, role- and
 * subset-of-what-you-have-yourself gate lives entirely in
 * ModuleAccessService, never here and never only in the frontend. See
 * ModuleAccessService's class doc for the full rule.
 */
@Controller('module-access')
export class ModuleAccessController {
  constructor(private readonly moduleAccessService: ModuleAccessService) {}

  @RequireMunicipalityMember()
  @Get('catalog')
  getCatalog() {
    return this.moduleAccessService.getCatalog();
  }

  /** Owner-only — adds one new module to the global catalog. See
   *  ModuleAccessService.createModule for how nodePath is derived. */
  @RequireMunicipalityOwner()
  @Post('catalog')
  createModule(@Body() dto: CreateModuleDto) {
    return this.moduleAccessService.createModule(dto);
  }

  /** Owner-only — permanently deletes a module and its descendants from
   *  the global catalog (shared by every municipality), with their grants.
   *  See ModuleAccessService.deleteModule. */
  @RequireMunicipalityOwner()
  @Delete('catalog/:id')
  deleteModule(@Param('id', ParseIntPipe) id: number) {
    return this.moduleAccessService.deleteModule(id);
  }

  /** The caller's own resolved module set — what the live /gis workspace
   *  gates its tool rail on. */
  @RequireMunicipalityMember()
  @Get('me')
  async getMyModules(@CurrentAppUser() appUser: AppUser) {
    const ids =
      await this.moduleAccessService.getEffectiveModuleIdsForAppUser(appUser);
    return { moduleIds: [...ids] };
  }

  @RequireMunicipalityMember()
  @Get('departments/:departmentId')
  getDepartmentGrants(
    @CurrentAppUser() appUser: AppUser,
    @Param('departmentId') departmentId: string,
  ) {
    return this.moduleAccessService.getDepartmentGrants(appUser, departmentId);
  }

  @RequireMunicipalityOwner()
  @Put('departments/:departmentId')
  setDepartmentGrants(
    @CurrentAppUser() appUser: AppUser,
    @Param('departmentId') departmentId: string,
    @Body() dto: SetModuleGrantsDto,
  ) {
    return this.moduleAccessService.setDepartmentGrants(
      appUser,
      departmentId,
      dto.moduleIds,
    );
  }

  @RequireMunicipalityMember()
  @Get('users/:userId')
  getUserGrants(
    @CurrentAppUser() appUser: AppUser,
    @Param('userId') userId: string,
  ) {
    return this.moduleAccessService.getUserGrants(appUser, userId);
  }

  /** Not Owner-only — a Department Head must be able to call this too.
   *  The real gate (Owner may grant anyone; a Head only a Department
   *  User in their own department, only modules the Head themselves
   *  has) is enforced inside ModuleAccessService.setUserGrants. */
  @RequireMunicipalityMember()
  @Put('users/:userId')
  setUserGrants(
    @CurrentAppUser() appUser: AppUser,
    @Param('userId') userId: string,
    @Body() dto: SetModuleGrantsDto,
  ) {
    return this.moduleAccessService.setUserGrants(
      appUser,
      userId,
      dto.moduleIds,
    );
  }
}
