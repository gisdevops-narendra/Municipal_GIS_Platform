import { Body, Controller, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { extname } from 'path';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { RequireRasterModule } from './raster-module.guard';
import { RASTER_MODULES } from './raster-tool-registry';
import { GeoreferenceService } from './georeference.service';
import { CreateGeorefSessionDto, GeorefPreviewDto, SaveGeorefSessionDto } from './dto/georeference.dto';

const UPLOAD_TMP_DIR = `${process.env.GIS_UPLOAD_STORAGE_DIR ?? './storage/uploads'}/tmp-uploads`;
const MAX_SCAN_BYTES = Number(process.env.GIS_RASTER_MAX_FILE_SIZE_MB ?? '8192') * 1024 * 1024;

/** Georeferencer — scanned maps / toposheets placed with GCPs. The final
 *  warp runs as the background raster job "georeference". Gated by the
 *  Raster Upload & Publish module (it publishes a raster layer). */
@Controller('gis/raster/georef')
export class GeoreferenceController {
  constructor(private readonly georef: GeoreferenceService) {}

  @RequireRasterModule([RASTER_MODULES.upload])
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_SCAN_BYTES },
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
          cb(null, UPLOAD_TMP_DIR);
        },
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase().slice(0, 6)}`),
      }),
    }),
  )
  create(
    @CurrentAppUser() appUser: AppUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: CreateGeorefSessionDto,
  ) {
    return this.georef.create(appUser, file, dto.dpi);
  }

  @RequireRasterModule([RASTER_MODULES.upload])
  @Get()
  list(@CurrentAppUser() appUser: AppUser) {
    return this.georef.list(appUser);
  }

  @RequireRasterModule([RASTER_MODULES.upload])
  @Get(':id')
  get(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.georef.get(appUser, id);
  }

  @RequireRasterModule([RASTER_MODULES.upload])
  @Put(':id')
  save(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveGeorefSessionDto) {
    return this.georef.save(appUser, id, dto.gcps, dto.settings);
  }

  @RequireRasterModule([RASTER_MODULES.upload])
  @Delete(':id')
  remove(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.georef.remove(appUser, id);
  }

  @RequireRasterModule([RASTER_MODULES.upload])
  @Post(':id/preview')
  preview(@CurrentAppUser() appUser: AppUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GeorefPreviewDto) {
    return this.georef.preview(appUser, id, dto.gcps, dto.settings);
  }

  /** Viewer tile of the scanned image (pixel space, XYZ numbering). */
  @RequireRasterModule([RASTER_MODULES.upload])
  @Get(':id/tiles/:z/:x/:y')
  async tile(
    @CurrentAppUser() appUser: AppUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('z', ParseIntPipe) z: number,
    @Param('x', ParseIntPipe) x: number,
    @Param('y', ParseIntPipe) y: number,
    @Res() res: Response,
  ) {
    const file = await this.georef.tilePath(appUser, id, z, x, y);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(file);
  }
}
