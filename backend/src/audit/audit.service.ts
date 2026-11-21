import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEvent {
  action: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  /** The account (tenant / municipality id) the action concerns. */
  accountId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown> | null;
  ip?: string | null;
}

/**
 * Platform audit trail. `record` is fire-and-forget and never throws — an
 * audit failure must never break the action being audited.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  record(event: AuditEvent): void {
    this.prisma.auditLog
      .create({
        data: {
          action: event.action,
          actorUserId: event.actorUserId ?? null,
          actorEmail: event.actorEmail ?? null,
          accountId: event.accountId ?? null,
          targetType: event.targetType ?? null,
          targetId: event.targetId ?? null,
          details: (event.details ?? undefined) as Prisma.InputJsonValue | undefined,
          ip: event.ip ?? null,
        },
      })
      .catch((e: Error) => this.logger.warn(`Audit "${event.action}" not recorded: ${e.message}`));
  }

  /** Newest first, optionally filtered. For the platform admin screen. */
  async list(query: { accountId?: string; action?: string; q?: string; page?: number; pageSize?: number }) {
    const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 200);
    const page = Math.max(query.page ?? 1, 1);
    const where: Prisma.AuditLogWhereInput = {
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.q
        ? {
            OR: [
              { actorEmail: { contains: query.q, mode: 'insensitive' } },
              { action: { contains: query.q, mode: 'insensitive' } },
              { targetId: { contains: query.q } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }
}
