import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import { StorageUsageService } from '../gis/storage-usage.service';
import { AuditService } from '../audit/audit.service';
import { AccountService } from '../account/account.service';
import type { AppUser } from '../auth/types/app-user.type';
import { isPlatformAdmin } from './platform-admin';

const DAY = 24 * 60 * 60 * 1000;

/** Platform administration: every account, usage, limits, the audit log. */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloakAdmin: KeycloakAdminService,
    private readonly storageUsage: StorageUsageService,
    private readonly audit: AuditService,
    private readonly accounts: AccountService,
  ) {}

  async stats() {
    // Customer accounts only — admin-only accounts are not counted.
    const customer: Prisma.MunicipalityWhereInput = { users: { some: { isPlatformAdmin: false } } };
    const [accounts, users, disabled, layers, newWeek, failedUploads] = await Promise.all([
      this.prisma.municipality.count({ where: customer }),
      this.prisma.user.count({ where: { isPlatformAdmin: false } }),
      this.prisma.user.count({ where: { status: 'DISABLED', isPlatformAdmin: false } }),
      this.prisma.gISLayer.count(),
      this.prisma.municipality.count({ where: { ...customer, createdAt: { gte: new Date(Date.now() - 7 * DAY) } } }),
      this.prisma.auditLog.count({ where: { action: 'upload.failed', createdAt: { gte: new Date(Date.now() - 7 * DAY) } } }),
    ]);
    return { accounts, users, disabledUsers: disabled, layers, newAccountsLast7Days: newWeek, failedUploadsLast7Days: failedUploads };
  }

  async listAccounts(query: { q?: string; page?: number; pageSize?: number }) {
    const pageSize = query.pageSize ?? 25;
    const page = query.page ?? 1;
    const q = query.q?.trim();
    // Admin-only accounts (platform administration) are not customer accounts.
    const where: Prisma.MunicipalityWhereInput = q
      ? {
          users: { some: { isPlatformAdmin: false } },
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { officialEmail: { contains: q, mode: 'insensitive' } },
            { users: { some: { email: { contains: q, mode: 'insensitive' } } } },
          ],
        }
      : { users: { some: { isPlatformAdmin: false } } };
    const [rows, total] = await Promise.all([
      this.prisma.municipality.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          users: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, fullName: true, email: true, status: true, isPlatformAdmin: true, createdAt: true },
          },
          gisWorkspace: { select: { status: true } },
        },
      }),
      this.prisma.municipality.count({ where }),
    ]);
    const items = await Promise.all(
      rows.map(async (m) => {
        const usage = await this.storageUsage.accountBytes(m.id).catch(() => ({ bytes: 0, layerCount: 0 }));
        const owner = m.users[0] ?? null;
        return {
          id: m.id,
          name: m.name,
          createdAt: m.createdAt,
          workspaceStatus: m.gisWorkspace?.status ?? null,
          quotaMb: m.storageQuotaMb,
          usedBytes: usage.bytes,
          layerCount: usage.layerCount,
          users: m.users.map((u) => ({ ...u, isPlatformAdmin: isPlatformAdmin(u) })),
          owner: owner ? { ...owner, isPlatformAdmin: isPlatformAdmin(owner) } : null,
        };
      }),
    );
    return { items, total, page, pageSize };
  }

  async setUserStatus(admin: AppUser, userId: string, status: 'ACTIVE' | 'DISABLED', ip?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');
    if (user.id === admin.id) throw new BadRequestException("You can't disable your own account.");
    await this.keycloakAdmin.setEnabled(user.keycloakUserId, status === 'ACTIVE');
    if (status === 'DISABLED') await this.keycloakAdmin.logoutUserSessions(user.keycloakUserId);
    await this.prisma.user.update({ where: { id: user.id }, data: { status } });
    this.audit.record({
      action: status === 'DISABLED' ? 'admin.user_disabled' : 'admin.user_enabled',
      actorUserId: admin.id,
      actorEmail: await this.emailOf(admin.id),
      accountId: user.municipalityId,
      targetType: 'user',
      targetId: user.id,
      details: { email: user.email },
      ip,
    });
    return { id: user.id, status };
  }

  async setQuota(admin: AppUser, accountId: string, quotaMb: number | null, ip?: string) {
    const account = await this.prisma.municipality.findUnique({ where: { id: accountId } });
    if (!account) throw new NotFoundException('Account not found.');
    await this.prisma.municipality.update({ where: { id: accountId }, data: { storageQuotaMb: quotaMb } });
    this.audit.record({
      action: 'admin.storage_limit_changed',
      actorUserId: admin.id,
      actorEmail: await this.emailOf(admin.id),
      accountId,
      targetType: 'account',
      targetId: accountId,
      details: { from: account.storageQuotaMb, to: quotaMb },
      ip,
    });
    return { id: accountId, quotaMb };
  }

  async deleteUser(admin: AppUser, userId: string, ip?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');
    if (user.id === admin.id) throw new BadRequestException('Delete your own account from Settings.');
    await this.accounts.removeAccount(user, {
      by: 'admin',
      actorUserId: admin.id,
      actorEmail: (await this.emailOf(admin.id)) ?? '',
      ip,
    });
  }

  private async emailOf(userId: string): Promise<string | null> {
    return (await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } }))?.email ?? null;
  }
}
