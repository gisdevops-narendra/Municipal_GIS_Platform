import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
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
import { AuditQuery, ListAccountsQuery, RestoreBackupDto, RetentionDto, SetAccountQuotaDto, SetAccountStatusDto } from './dto/admin.dto';

/** /api/admin/* — platform administrators only. */
@Controller('admin')
@RequirePlatformAdmin()
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly audit: AuditService,
    private readonly sessions: AdminSessionsService,
    private readonly maintenance: AdminMaintenanceService,
  ) {}

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
