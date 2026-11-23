import { NotFoundException } from '@nestjs/common';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors, DefaultValuePipe } from '@nestjs/common';
import type { Response } from 'express';
import { AdminMaintenanceService } from './admin-maintenance.service';
import { AdminSessionsService } from './admin-sessions.service';
import type { KeycloakJwtPayload } from '../auth/strategies/keycloak-jwt.strategy';
import type { Request } from 'express';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { AuditService } from '../audit/audit.service';
import { clientIp } from '../common/client-ip';
import { AdminService } from './admin.service';
import { RequirePlatformAdmin } from './platform-admin';
import {
  AnnouncementDto,
  AuditQuery,
  BrandingDto,
  EmailDto,
  IntegrityFixDto,
  InviteUserDto,
  ListAccountsQuery,
  MaintenanceDto,
  ModulesDto,
  RestoreBackupDto,
  RetentionDto,
  SecurityDto,
  SetAccountQuotaDto,
  SetAccountStatusDto,
  TestEmailDto,
  UpdateUserDto,
} from './dto/admin.dto';
import { AdminPlatformService } from './admin-platform.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { extname } from 'path';

/** /api/admin/* — platform administrators only. */
@Controller('admin')
@RequirePlatformAdmin()
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly audit: AuditService,
    private readonly sessions: AdminSessionsService,
    private readonly maintenance: AdminMaintenanceService,
    private readonly platform: AdminPlatformService,
  ) {}

  // ----- users -----
  @Get('users')
  users(@Query('q') q = '', @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number) {
    return this.platform.listUsers(q.trim(), Math.max(1, page), 25);
  }

  @Post('users/invite')
  invite(@CurrentAppUser() me: AppUser, @Body() dto: InviteUserDto, @Req() req: Request) {
    return this.platform.invite(me, dto.email, dto.fullName, clientIp(req));
  }

  @Patch('users/:id')
  updateUser(@CurrentAppUser() me: AppUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @Req() req: Request) {
    return this.platform.updateUser(me, id, dto, clientIp(req));
  }

  @Post('users/:id/reset-password')
  @HttpCode(200)
  resetPassword(@CurrentAppUser() me: AppUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.platform.sendPasswordReset(me, id, clientIp(req));
  }

  @Post('users/:id/verify-email')
  @HttpCode(200)
  verifyEmail(@CurrentAppUser() me: AppUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.platform.sendVerification(me, id, clientIp(req));
  }

  @Put('users/:id/platform-admin')
  setPlatformAdmin(@CurrentAppUser() me: AppUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: { value?: boolean }, @Req() req: Request) {
    return this.platform.setPlatformAdmin(me, id, body.value === true, clientIp(req));
  }

  // ----- health -----
  @Get('health')
  health() {
    return this.platform.health();
  }

  @Post('geoserver/:action')
  @HttpCode(200)
  geoserver(@CurrentAppUser() me: AppUser, @Param('action') action: string, @Req() req: Request) {
    if (!['reload', 'clear-cache', 'restart'].includes(action)) throw new NotFoundException();
    return this.platform.geoserverAction(me, action as 'reload' | 'clear-cache' | 'restart', clientIp(req));
  }

  // ----- jobs -----
  @Get('jobs')
  jobs() {
    return this.platform.jobsOverview();
  }

  @Post('jobs/:id/cancel')
  @HttpCode(200)
  cancelJob(@CurrentAppUser() me: AppUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.platform.cancelJob(me, id, clientIp(req));
  }

  // ----- logs -----
  @Get('logs')
  logs(@Query('source') source = 'backend', @Query('level') level = '', @Query('q') q = '') {
    return this.platform.logs(source === 'geoserver' ? 'geoserver' : 'backend', level, q, 300);
  }

  // ----- security -----
  @Get('security')
  security() {
    return this.platform.security();
  }

  @Put('security')
  setSecurity(@CurrentAppUser() me: AppUser, @Body() dto: SecurityDto, @Req() req: Request) {
    return this.platform.setSecurity(me, dto, clientIp(req));
  }

  @Post('api-keys/:id/revoke')
  @HttpCode(200)
  revokeKey(@CurrentAppUser() me: AppUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.platform.revokeApiKey(me, id, clientIp(req));
  }

  @Post('share-links/:id/revoke')
  @HttpCode(200)
  revokeLink(@CurrentAppUser() me: AppUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.platform.revokeShareLink(me, id, clientIp(req));
  }

  // ----- email -----
  @Get('email')
  email() {
    return this.platform.email();
  }

  @Put('email')
  setEmail(@CurrentAppUser() me: AppUser, @Body() dto: EmailDto, @Req() req: Request) {
    return this.platform.setEmail(me, dto, clientIp(req));
  }

  @Post('email/test')
  @HttpCode(200)
  testEmail(@CurrentAppUser() me: AppUser, @Body() dto: TestEmailDto) {
    return this.platform.testEmail(me, dto.to);
  }

  // ----- branding -----
  @Get('branding')
  branding() {
    return this.platform.branding();
  }

  @Put('branding')
  setBranding(@CurrentAppUser() me: AppUser, @Body() dto: BrandingDto, @Req() req: Request) {
    return this.platform.setBranding(me, dto, clientIp(req));
  }

  @Post('branding/logo')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 2 * 1024 * 1024 },
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = `${process.env.GIS_UPLOAD_STORAGE_DIR ?? './storage/uploads'}/tmp-uploads`;
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase().slice(0, 6)}`),
      }),
    }),
  )
  setLogo(@CurrentAppUser() me: AppUser, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.platform.setLogo(me, file);
  }

  @Delete('branding/logo')
  removeLogo() {
    return this.platform.removeLogo();
  }

  // ----- announcements & maintenance -----
  @Get('notices')
  notices() {
    return this.platform.notices();
  }

  @Put('announcement')
  setAnnouncement(@CurrentAppUser() me: AppUser, @Body() dto: AnnouncementDto, @Req() req: Request) {
    return this.platform.setAnnouncement(me, dto, clientIp(req));
  }

  @Put('maintenance')
  setMaintenance(@CurrentAppUser() me: AppUser, @Body() dto: MaintenanceDto, @Req() req: Request) {
    return this.platform.setMaintenance(me, dto, clientIp(req));
  }

  // ----- modules -----
  @Get('modules')
  modules() {
    return this.platform.modules();
  }

  @Put('modules')
  setModules(@CurrentAppUser() me: AppUser, @Body() dto: ModulesDto, @Req() req: Request) {
    return this.platform.setModules(me, dto, clientIp(req));
  }

  // ----- analytics -----
  @Get('analytics')
  analytics(@Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number) {
    return this.platform.analytics(Math.min(365, Math.max(7, days)));
  }

  // ----- data check -----
  @Get('integrity')
  integrity() {
    return this.platform.integrity();
  }

  @Post('integrity/fix')
  @HttpCode(200)
  fixIntegrity(@CurrentAppUser() me: AppUser, @Body() dto: IntegrityFixDto, @Req() req: Request) {
    return this.platform.fixIntegrity(me, dto.kind, dto.id, clientIp(req));
  }

  // ----- backups -----

  @Get('backups')
  backups() {
    return this.maintenance.listBackups();
  }

  @Post('backups')
  @HttpCode(202)
  backupNow(@CurrentAppUser() me: AppUser, @Req() req: Request) {
    return this.maintenance.backupNow(me, clientIp(req));
  }

  @Post('backups/:stamp/verify')
  @HttpCode(200)
  verifyBackup(@Param('stamp') stamp: string) {
    return this.maintenance.verify(stamp);
  }

  @Post('backups/:stamp/restore')
  @HttpCode(202)
  restore(@CurrentAppUser() me: AppUser, @Param('stamp') stamp: string, @Body() dto: RestoreBackupDto, @Req() req: Request) {
    return this.maintenance.restore(me, stamp, dto.parts, dto.dryRun === true, dto.confirm ?? '', clientIp(req));
  }

  @Get('backups/:stamp/files/:file')
  async backupFile(@Param('stamp') stamp: string, @Param('file') file: string, @Res() res: Response) {
    const f = await this.maintenance.backupFile(stamp, file);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(f.bytes));
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
    f.stream.pipe(res);
  }

  // ----- storage & retention -----

  @Get('storage')
  storage() {
    return this.maintenance.storage();
  }

  @Put('storage/retention')
  setRetention(@CurrentAppUser() me: AppUser, @Body() dto: RetentionDto, @Req() req: Request) {
    return this.maintenance.setRetention(me, dto, clientIp(req));
  }

  @Post('storage/cleanup')
  @HttpCode(200)
  cleanup(@CurrentAppUser() me: AppUser) {
    return this.maintenance.cleanup(me);
  }

  // ----- active sessions -----

  @Get('sessions')
  listSessions(@Req() req: Request & { user?: KeycloakJwtPayload }) {
    return this.sessions.list(req.user?.sid);
  }

  @Delete('sessions/:sessionId')
  endSession(@CurrentAppUser() me: AppUser, @Param('sessionId') sessionId: string, @Req() req: Request) {
    return this.sessions.endSession(me, sessionId, clientIp(req));
  }

  @Post('users/:id/sign-out')
  @HttpCode(200)
  signOutUser(@CurrentAppUser() me: AppUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.sessions.signOutUser(me, id, clientIp(req));
  }

  @Get('stats')
  stats() {
    return this.admin.stats();
  }

  @Get('accounts')
  accounts(@Query() query: ListAccountsQuery) {
    return this.admin.listAccounts(query);
  }

  @Put('users/:id/status')
  setStatus(@CurrentAppUser() me: AppUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetAccountStatusDto, @Req() req: Request) {
    return this.admin.setUserStatus(me, id, dto.status, clientIp(req));
  }

  @Put('accounts/:id/quota')
  setQuota(@CurrentAppUser() me: AppUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetAccountQuotaDto, @Req() req: Request) {
    return this.admin.setQuota(me, id, dto.quotaMb, clientIp(req));
  }

  @Delete('users/:id')
  @HttpCode(204)
  async deleteUser(@CurrentAppUser() me: AppUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    await this.admin.deleteUser(me, id, clientIp(req));
  }

  @Get('audit')
  auditLog(@Query() query: AuditQuery) {
    return this.audit.list(query);
  }
}
