import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsBoolean, IsObject, IsOptional, IsString, Length } from 'class-validator';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { PrismaService } from '../prisma/prisma.service';

/** Body of POST / PUT /gis/saved-maps. `state` is the map state the
 *  workspace captures (view, basemap, visible layers, order, opacity). */
export class SaveMapDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @IsObject()
  state!: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  shared?: boolean;
}

const MAX_STATE_BYTES = 64 * 1024;

@Injectable()
export class SavedMapsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The user's own maps plus maps others shared with the municipality. */
  async list(appUser: AppUser) {
    const rows = await this.prisma.gISSavedMap.findMany({
      where: { municipalityId: appUser.municipalityId, OR: [{ createdById: appUser.id }, { shared: true }] },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => ({ ...r, mine: r.createdById === appUser.id }));
  }

  private checkState(state: Record<string, unknown>) {
    if (JSON.stringify(state).length > MAX_STATE_BYTES) throw new BadRequestException('The map state is too large.');
    return state as Prisma.InputJsonValue;
  }

  async create(appUser: AppUser, dto: SaveMapDto) {
    const row = await this.prisma.gISSavedMap.create({
      data: {
        municipalityId: appUser.municipalityId,
        createdById: appUser.id,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        state: this.checkState(dto.state),
        shared: dto.shared === true,
      },
    });
    return { ...row, mine: true };
  }

  private async own(appUser: AppUser, id: string) {
    const row = await this.prisma.gISSavedMap.findFirst({ where: { id, municipalityId: appUser.municipalityId } });
    if (!row) throw new NotFoundException('Saved map not found.');
    if (row.createdById !== appUser.id) throw new ForbiddenException('Only the person who saved this map can change it.');
    return row;
  }

  async update(appUser: AppUser, id: string, dto: SaveMapDto) {
    await this.own(appUser, id);
    const row = await this.prisma.gISSavedMap.update({
      where: { id },
      data: {
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        state: this.checkState(dto.state),
        shared: dto.shared === true,
      },
    });
    return { ...row, mine: true };
  }

  async remove(appUser: AppUser, id: string) {
    await this.own(appUser, id);
    await this.prisma.gISSavedMap.delete({ where: { id } });
    return { success: true };
  }
}

/** Saved maps — named, reopenable map states (optionally shared). */
@Controller('gis/saved-maps')
export class SavedMapsController {
  constructor(private readonly maps: SavedMapsService) {}

  @RequireMunicipalityMember()
  @Get()
  list(@CurrentAppUser() appUser: AppUser) {
    return this.maps.list(appUser);
  }

  @RequireMunicipalityMember()
  @Post()
  create(@CurrentAppUser() appUser: AppUser, @Body() dto: SaveMapDto) {
    return this.maps.create(appUser, dto);
  }

  @RequireMunicipalityMember()
  @Put(':id')
  update(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveMapDto) {
    return this.maps.update(appUser, id, dto);
  }

  @RequireMunicipalityMember()
  @Delete(':id')
  remove(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.maps.remove(appUser, id);
  }
}
