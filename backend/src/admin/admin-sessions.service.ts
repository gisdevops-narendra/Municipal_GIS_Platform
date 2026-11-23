import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import { AuditService } from '../audit/audit.service';
import type { AppUser } from '../auth/types/app-user.type';

export interface ActiveSession {
  id: string;
  userId: string;
  name: string;
  email: string;
  account: string | null;
  ip: string;
  startedAt: string;
  lastAccessAt: string;
  apps: string[];
  /** the admin's own current sign-in */
  current: boolean;
}

/** Active sign-ins across the platform (Keycloak sessions of every app
 *  user), and signing a session or a user out. */
@Injectable()
export class AdminSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloak: KeycloakAdminService,
    private readonly audit: AuditService,
  ) {}

  async list(currentSid: string | undefined): Promise<ActiveSession[]> {
    const users = await this.prisma.user.findMany({
      select: { id: true, keycloakUserId: true, fullName: true, email: true, municipality: { select: { name: true } } },
    });
    const out: ActiveSession[] = [];
    // A few users at a time — one Keycloak call per user.
    for (let i = 0; i < users.length; i += 8) {
      const batch = users.slice(i, i + 8);
      const lists = await Promise.all(batch.map((u) => this.keycloak.listUserSessions(u.keycloakUserId).catch(() => [])));
      batch.forEach((u, k) => {
        for (const s of lists[k]) {
          out.push({
            id: s.id,
            userId: u.id,
            name: u.fullName,
            email: u.email,
            account: u.municipality?.name ?? null,
            ip: s.ipAddress,
            startedAt: new Date(s.start).toISOString(),
            lastAccessAt: new Date(s.lastAccess).toISOString(),
            apps: [...new Set(Object.values(s.clients ?? {}))],
            current: !!currentSid && s.id === currentSid,
          });
        }
      });
    }
    return out.sort((a, b) => b.lastAccessAt.localeCompare(a.lastAccessAt));
  }

  async endSession(me: AppUser, sessionId: string, ip: string | null): Promise<{ success: true }> {
    await this.keycloak.deleteSession(sessionId);
    this.audit.record({ action: 'session.ended', actorUserId: me.id, details: { sessionId }, ip });
    return { success: true };
  }

  async signOutUser(me: AppUser, userId: string, ip: string | null): Promise<{ success: true }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { keycloakUserId: true, email: true, municipalityId: true } });
    if (!user) throw new NotFoundException('User not found.');
    await this.keycloak.logoutUserSessions(user.keycloakUserId);
    this.audit.record({ action: 'session.user_signed_out', actorUserId: me.id, accountId: user.municipalityId, details: { email: user.email }, ip });
    return { success: true };
  }
}
