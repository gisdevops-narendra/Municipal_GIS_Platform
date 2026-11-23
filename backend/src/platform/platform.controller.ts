import { Body, Controller, Get, HttpCode, NotFoundException, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ArrayMaxSize, IsArray, IsString, Matches } from 'class-validator';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformSettingsService } from './platform-settings.service';

export class UsageDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Matches(/^[a-z0-9:-]{1,60}$/, { each: true })
  tools!: string[];
}

export const LOGO_DIR = () => path.resolve(process.env.GIS_UPLOAD_STORAGE_DIR ?? './storage/uploads', '..', '_system');

/** Public platform info (branding, announcement, maintenance) for the login
 *  page and header, plus per-user module switches and usage pings. */
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('public')
  async publicInfo() {
    const [branding, announcement, maintenance] = await Promise.all([
      this.settings.get('branding'),
      this.settings.get('announcement'),
      this.settings.get('maintenance'),
    ]);
    const live = announcement.enabled && !!announcement.message && (!announcement.endsAt || new Date(announcement.endsAt) > new Date());
    return { branding, announcement: live ? announcement : null, maintenance: maintenance.enabled ? maintenance : null };
  }

  @Get('logo')
  async logo(@Res() res: Response) {
    const dir = LOGO_DIR();
    const files = await fsp.readdir(dir).catch(() => [] as string[]);
    const logo = files.find((f) => /^logo\.(png|svg|jpg|jpeg|webp)$/i.test(f));
    if (!logo) throw new NotFoundException();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(path.join(dir, logo));
  }

  /** Tools switched off for the caller (everyone + their account). */
  @RequireMunicipalityMember()
  @Get('modules/me')
  async myModules(@CurrentAppUser() me: AppUser) {
    const m = await this.settings.get('modules');
    return { disabled: [...new Set([...(m.global ?? []), ...(m.perAccount?.[me.municipalityId] ?? [])])] };
  }

  /** Tool-open counts for Admin → Analytics (batched by the browser). */
  @RequireMunicipalityMember()
  @Post('usage')
  @HttpCode(204)
  async usage(@Body() dto: UsageDto) {
    const day = new Date(new Date().toISOString().slice(0, 10));
    const counts = new Map<string, number>();
    for (const t of dto.tools) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [tool, n] of counts) {
      await this.prisma.toolUsageDay.upsert({
        where: { day_tool: { day, tool } },
        create: { day, tool, count: n },
        update: { count: { increment: n } },
      });
    }
  }
}
