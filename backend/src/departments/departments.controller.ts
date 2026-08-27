import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  RequireMunicipalityMember,
  RequireMunicipalityOwner,
} from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { DepartmentsService } from './departments.service';
import {
  CreateDepartmentDto,
  UpdateDepartmentDto,
} from './dto/create-department.dto';

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  /** Any authenticated member of the municipality may view departments —
   *  only creating/editing/deleting is Owner-only (see RequireMunicipalityOwner). */
  @RequireMunicipalityMember()
  @Get()
  list(@CurrentAppUser() appUser: AppUser) {
    return this.departmentsService.list(appUser.municipalityId);
  }

  @RequireMunicipalityMember()
  @Get(':id')
  getOne(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.departmentsService.getById(appUser.municipalityId, id);
  }

  @RequireMunicipalityOwner()
  @Post()
  create(@CurrentAppUser() appUser: AppUser, @Body() dto: CreateDepartmentDto) {
    return this.departmentsService.create(
      appUser.municipalityId,
      appUser.id,
      dto,
    );
  }

  @RequireMunicipalityOwner()
  @Patch(':id')
  update(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Body() dto: UpdateDepartmentDto,
  ) {
    return this.departmentsService.update(appUser.municipalityId, id, dto);
  }

  @RequireMunicipalityOwner()
  @Delete(':id')
  async remove(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
  ): Promise<{ success: true }> {
    await this.departmentsService.remove(appUser.municipalityId, id);
    return { success: true };
  }
}
