import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import { GisLayersService } from '../gis/gis-layers.service';
import { GisUploadsService } from '../gis/gis-uploads.service';
import { GeoServerService } from '../gis/geoserver.service';
import { StorageService } from '../gis/storage.service';
import type { AppUser } from '../auth/types/app-user.type';
import { AuditService } from '../audit/audit.service';
import { isPlatformAdmin } from '../admin/platform-admin';
import { UpdateMeDto } from './dto/update-me.dto';

/** The signed-in account (GET/PATCH /api/me). Departments and roles were
 *  removed: every account owns its own workspace, so the role is always
 *  reported as MUNICIPALITY_OWNER (kept for the frontend's existing shape). */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloakAdmin: KeycloakAdminService,
    private readonly gisLayers: GisLayersService,
    private readonly gisUploads: GisUploadsService,
    private readonly geoServer: GeoServerService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async getMe(keycloakUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { keycloakUserId },
      include: { municipality: true },
    });
    if (!user) {
      throw new NotFoundException(
        'No account is linked to this sign-in. Create an account first.',
      );
    }
    return {
      id: user.id,
      keycloakUserId: user.keycloakUserId,
      name: user.fullName,
      email: user.email,
      mobileNumber: user.mobileNumber,
      systemRole: 'MUNICIPALITY_OWNER' as const,
      status: user.status,
      isPlatformAdmin: isPlatformAdmin(user),
      municipality: {
        id: user.municipality.id,
        name: user.municipality.name,
        type: user.municipality.type,
        state: user.municipality.state,
        district: user.municipality.district,
        city: user.municipality.city,
      },
    };
  }

  /** Own profile edit — name / mobile only. */
  async updateMe(keycloakUserId: string, dto: UpdateMeDto) {
    const user = await this.prisma.user.findUnique({ where: { keycloakUserId } });
    if (!user) {
      throw new NotFoundException('No account is linked to this sign-in.');
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        ...(dto.fullName !== undefined && { fullName: dto.fullName.trim() }),
        ...(dto.mobileNumber !== undefined && { mobileNumber: dto.mobileNumber }),
      },
    });
    return this.getMe(keycloakUserId);
  }

  /**
   * Changes the sign-in email, confirmed by the current password. The new
   * address must be verified at the next sign-in (Keycloak emails a link),
   * so all sessions are signed out. Returns the new email.
   */
  async changeEmail(keycloakUserId: string, newEmail: string, password: string, ip?: string): Promise<{ email: string }> {
    const user = await this.prisma.user.findUnique({ where: { keycloakUserId } });
    if (!user) {
      throw new NotFoundException('No account is linked to this sign-in.');
    }
    const email = newEmail.trim().toLowerCase();
    if (email === user.email.toLowerCase()) {
      throw new BadRequestException('That is already your email.');
    }
    if (!(await this.keycloakAdmin.verifyPassword(user.email, password))) {
      throw new ForbiddenException('That password is not correct.');
    }
    const [userTaken, tenantTaken] = await Promise.all([
      this.prisma.user.findUnique({ where: { email } }),
      this.prisma.municipality.findFirst({
        where: { officialEmail: email, id: { not: user.municipalityId } },
      }),
    ]);
    if (userTaken || tenantTaken) {
      throw new ConflictException('An account with this email already exists.');
    }

    await this.keycloakAdmin.updateEmail(keycloakUserId, email);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { email } });
      // Self sign-up workspaces are keyed by the owner's email.
      await tx.municipality.updateMany({
        where: { id: user.municipalityId, officialEmail: user.email },
        data: { officialEmail: email },
      });
    });
    await this.keycloakAdmin.logoutUserSessions(keycloakUserId);
    this.audit.record({
      action: 'account.email_changed',
      actorUserId: user.id,
      actorEmail: email,
      accountId: user.municipalityId,
      targetType: 'user',
      targetId: user.id,
      details: { from: user.email, to: email },
      ip,
    });
    return { email };
  }

  /**
   * Permanently deletes the signed-in account, confirmed by its password.
   * If the account is the only one in its workspace (always true for
   * self sign-up), the whole workspace goes too: every layer and upload
   * (GeoServer, PostGIS tables, files), the GeoServer workspace, stored
   * files and every database row of the tenant. In an older shared
   * workspace only this user's own login and profile are removed.
   */
  async deleteMe(keycloakUserId: string, password: string, ip?: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { keycloakUserId } });
    if (!user) {
      throw new NotFoundException('No account is linked to this sign-in.');
    }
    if (!(await this.keycloakAdmin.verifyPassword(user.email, password))) {
      throw new ForbiddenException('That password is not correct.');
    }

    await this.removeAccount(user, { by: 'self', actorUserId: user.id, actorEmail: user.email, ip });
  }

  /**
   * Removes an account — used by self-deletion and by platform admins.
   * Single-user workspace → everything goes; shared → only this user.
   */
  async removeAccount(
    user: { id: string; keycloakUserId: string; email: string; municipalityId: string; status: AppUser['status'] },
    actor: { by: 'self' | 'admin'; actorUserId: string; actorEmail: string; ip?: string },
  ): Promise<void> {
    const others = await this.prisma.user.count({
      where: { municipalityId: user.municipalityId, id: { not: user.id } },
    });
    if (others === 0) {
      await this.deleteWorkspaceData({
        id: user.id,
        keycloakUserId: user.keycloakUserId,
        municipalityId: user.municipalityId,
        systemRole: 'MUNICIPALITY_OWNER',
        status: user.status,
      });
    } else {
      await this.prisma.user.delete({ where: { id: user.id } });
    }

    await this.keycloakAdmin.deleteUser(user.keycloakUserId);
    this.logger.log(`Account ${user.id} deleted by ${actor.by} (workspace removed: ${others === 0}).`);
    this.audit.record({
      action: 'account.deleted',
      actorUserId: actor.actorUserId,
      actorEmail: actor.actorEmail,
      accountId: user.municipalityId,
      targetType: 'user',
      targetId: user.id,
      details: { email: user.email, workspaceRemoved: others === 0, by: actor.by },
      ip: actor.ip,
    });
  }

  private async deleteWorkspaceData(owner: AppUser): Promise<void> {
    const municipalityId = owner.municipalityId;
    const workspace = await this.prisma.gISWorkspace.findUnique({ where: { municipalityId } });

    // 1. Layers and uploads through their own services — they know how to
    //    unpublish from GeoServer and drop their PostGIS tables and files.
    if (workspace) {
      const layers = await this.prisma.gISLayer.findMany({
        where: { gisWorkspaceId: workspace.id },
        select: { id: true },
      });
      for (const layer of layers) {
        await this.gisLayers
          .deleteLayer(owner, layer.id)
          .catch((e: Error) => this.logger.warn(`Delete layer ${layer.id}: ${e.message}`));
      }
    }
    const uploads = await this.prisma.gISLayerUpload.findMany({
      where: { municipalityId },
      select: { id: true },
    });
    for (const upload of uploads) {
      await this.gisUploads
        .discard(upload.id, owner)
        .catch((e: Error) => this.logger.warn(`Discard upload ${upload.id}: ${e.message}`));
    }

    // 2. Whatever is left on GeoServer and disk.
    if (workspace) {
      await this.geoServer
        .deleteWorkspace(workspace.geoserverWorkspace)
        .catch((e: Error) => this.logger.warn(`Delete GeoServer workspace: ${e.message}`));
    }
    await this.storage
      .deleteTenantFiles(municipalityId)
      .catch((e: Error) => this.logger.warn(`Delete tenant files: ${e.message}`));

    // 3. Every remaining database row of the tenant. Tables are found from
    //    the schema (any `municipality_id` column) so new features are
    //    covered automatically; a few passes resolve foreign-key order.
    const tables = await this.prisma.$queryRaw<{ table_name: string }[]>`
      SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'municipality_id'
        AND table_name <> 'municipalities'`;
    let pending = tables.map((t) => t.table_name);
    for (let pass = 0; pass < 6 && pending.length; pass++) {
      const failed: string[] = [];
      for (const table of pending) {
        try {
          await this.prisma.$executeRawUnsafe(
            `DELETE FROM "${table.replace(/"/g, '')}" WHERE municipality_id = $1`,
            municipalityId,
          );
        } catch {
          failed.push(table);
        }
      }
      pending = failed;
    }
    if (pending.length) {
      throw new InternalServerErrorException(
        `Could not remove all account data (${pending.join(', ')}). Please contact support.`,
      );
    }
    await this.prisma.municipality.delete({ where: { id: municipalityId } });
  }
}
