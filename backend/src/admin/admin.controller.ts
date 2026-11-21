import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { AuditService } from '../audit/audit.service';
import { clientIp } from '../common/client-ip';
import { AdminService } from './admin.service';
import { RequirePlatformAdmin } from './platform-admin';
import { AuditQuery, ListAccountsQuery, SetAccountQuotaDto, SetAccountStatusDto } from './dto/admin.dto';

/** /api/admin/* — platform administrators only. */
@Controller('admin')
@RequirePlatformAdmin()
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly audit: AuditService,
  ) {}

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
