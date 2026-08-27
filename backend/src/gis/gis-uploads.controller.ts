import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { GisUploadsService } from './gis-uploads.service';
import { CreateUploadDto } from './dto/create-upload.dto';
import { RejectUploadDto } from './dto/reject-upload.dto';

// Multer decorators are evaluated once, at class-load time, before Nest's
// DI is available — so the size limit is read directly from process.env
// here rather than via ConfigService. Kept in sync with
// StorageService.maxUploadBytes, which is the value actually documented
// and configurable (GIS_UPLOAD_MAX_FILE_SIZE_MB) — this is just Multer's
// own first line of defense so an oversized upload is rejected before
// even being buffered in memory.
const MAX_UPLOAD_BYTES =
  Number(process.env.GIS_UPLOAD_MAX_FILE_SIZE_MB ?? '500') * 1024 * 1024;

@Controller('gis')
export class GisUploadsController {
  constructor(private readonly uploadsService: GisUploadsService) {}

  /** Any municipality member may upload, subject to the department/
   *  ownership rules enforced in GisUploadsService (Task 7 §12/§26).
   *  Multipart: `file` field + CreateUploadDto fields. municipalityId is
   *  never accepted here — derived from the JWT (Task 7 §17). */
  @RequireMunicipalityMember()
  @Post('uploads')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  async create(
    @CurrentAppUser() appUser: AppUser,
    @Body() dto: CreateUploadDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('A file is required.');
    }
    return this.uploadsService.create(appUser, dto, file);
  }

  @RequireMunicipalityMember()
  @Get('uploads')
  list(
    @CurrentAppUser() appUser: AppUser,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSize?: number,
  ) {
    return this.uploadsService.list(
      appUser,
      Math.max(page ?? 1, 1),
      Math.min(Math.max(pageSize ?? 20, 1), 100),
    );
  }

  @RequireMunicipalityMember()
  @Get('uploads/:id')
  getById(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.uploadsService.getById(id, appUser);
  }

  @RequireMunicipalityMember()
  @Post('uploads/:id/validate')
  validate(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.uploadsService.validate(id, appUser);
  }

  @RequireMunicipalityMember()
  @Get('uploads/:id/preview')
  preview(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.uploadsService.preview(id, appUser);
  }

  @RequireMunicipalityMember()
  @Post('uploads/:id/submit-review')
  submitForReview(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.uploadsService.submitForReview(id, appUser);
  }

  /** Task 8: no longer Owner-only at the route level — a Department Head
   *  has APPROVE by default (§4), and it's the GISLayerPermission grants
   *  (or, for a brand-new layer, the §4 defaults) that actually decide,
   *  enforced inside GisUploadsService.resolvePermissions(). Any other
   *  municipality member reaching this without APPROVE gets a 403 from
   *  the service. */
  @RequireMunicipalityMember()
  @Post('uploads/:id/approve')
  approve(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.uploadsService.approve(id, appUser);
  }

  @RequireMunicipalityMember()
  @Post('uploads/:id/reject')
  reject(
    @CurrentAppUser() appUser: AppUser,
    @Param('id') id: string,
    @Body() dto: RejectUploadDto,
  ) {
    return this.uploadsService.reject(id, appUser, dto.rejectionReason);
  }

  /** Task 8: no longer Owner-only at the route level — PUBLISH is a
   *  configurable grant (§4 defaults give it to neither Head nor User;
   *  the Owner must explicitly grant it), enforced the same way as
   *  approve() above. */
  @RequireMunicipalityMember()
  @Post('uploads/:id/publish')
  publish(@CurrentAppUser() appUser: AppUser, @Param('id') id: string) {
    return this.uploadsService.publish(id, appUser);
  }
}
