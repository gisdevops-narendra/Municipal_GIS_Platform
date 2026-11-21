import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import { GisWorkspaceService } from '../gis/gis-workspace.service';
import { RegisterAccountDto, TERMS_VERSION } from './dto/register-account.dto';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class MunicipalitiesService {
  private readonly logger = new Logger(MunicipalitiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloakAdmin: KeycloakAdminService,
    private readonly gisWorkspace: GisWorkspaceService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates an account: Keycloak identity + User + its own private
   * workspace (internal Municipality tenant + GISWorkspace) in one DB
   * transaction, then provisions the GeoServer side. If the DB step fails
   * the Keycloak user is rolled back. A GeoServer failure never fails
   * sign-up — the workspace is left PROVISIONING_FAILED and is retried
   * via POST /api/gis/workspace/provision.
   */
  async registerAccount(dto: RegisterAccountDto, ip?: string) {
    if (dto.website) {
      // Honeypot filled → a bot. Same answer as a bad request, no detail.
      this.audit.record({ action: 'signup.blocked', details: { reason: 'honeypot', email: dto.email }, ip });
      throw new BadRequestException('Sign-up could not be completed.');
    }
    const email = dto.email.trim().toLowerCase();
    const fullName = dto.fullName.trim();
    const mobileNumber = dto.mobileNumber?.trim() ?? '';

    const [existingUser, existingTenant] = await Promise.all([
      this.prisma.user.findUnique({ where: { email } }),
      this.prisma.municipality.findUnique({ where: { officialEmail: email } }),
    ]);
    if (existingUser || existingTenant) {
      throw new ConflictException(
        'An account with this email is already registered.',
      );
    }

    const { keycloakUserId } = await this.keycloakAdmin.createUser({
      email,
      fullName,
      mobileNumber,
      password: dto.password,
    });

    let user: Prisma.UserGetPayload<object>;
    let workspace: Prisma.GISWorkspaceGetPayload<object>;
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // Internal tenant row: the GIS stack scopes all data by
        // municipalityId, so every account gets its own.
        const tenant = await tx.municipality.create({
          data: {
            name: fullName,
            type: 'Personal',
            state: '',
            district: '',
            city: '',
            officialEmail: email,
            contactNumber: mobileNumber,
            // Storage limit for a new account (platform admins can change it).
            storageQuotaMb: this.defaultQuotaMb(),
          },
        });
        const user = await tx.user.create({
          data: {
            keycloakUserId,
            fullName,
            email,
            mobileNumber,
            municipalityId: tenant.id,
            systemRole: 'MUNICIPALITY_OWNER',
          },
        });
        const workspace = await this.gisWorkspace.createWorkspaceRecord(
          tx,
          tenant.id,
          fullName,
          user.id,
        );
        return { user, workspace };
      });
      user = result.user;
      workspace = result.workspace;
    } catch (error) {
      await this.keycloakAdmin.deleteUser(keycloakUserId);
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'An account with this email is already registered.',
        );
      }
      this.logger.error('Account registration failed', error as Error);
      throw error;
    }

    const provisioned = await this.gisWorkspace.provisionWorkspace(
      workspace.id,
    );
    this.audit.record({
      action: 'account.created',
      actorUserId: user.id,
      actorEmail: user.email,
      accountId: user.municipalityId,
      targetType: 'user',
      targetId: user.id,
      details: { workspaceStatus: provisioned.status, termsAccepted: TERMS_VERSION },
      ip,
    });

    return {
      user: { id: user.id, fullName: user.fullName, email: user.email },
      gisWorkspace: { id: provisioned.id, status: provisioned.status },
    };
  }

  /** DEFAULT_ACCOUNT_STORAGE_MB (default 2048); 0 or empty = unlimited. */
  private defaultQuotaMb(): number | null {
    const raw = process.env.DEFAULT_ACCOUNT_STORAGE_MB;
    const mb = raw === undefined || raw === '' ? 2048 : Number(raw);
    return Number.isFinite(mb) && mb > 0 ? Math.round(mb) : null;
  }

  /** Returns the municipality belonging to the given Keycloak user. Tenant
   *  scoping always flows from the authenticated identity — never from a
   *  caller-supplied municipality id. */
  async getMunicipalityForKeycloakUser(keycloakUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { keycloakUserId },
      include: { municipality: true },
    });

    if (!user) {
      throw new NotFoundException(
        'No application user is linked to this identity.',
      );
    }

    const { municipality } = user;
    return {
      id: municipality.id,
      name: municipality.name,
      type: municipality.type,
      state: municipality.state,
      district: municipality.district,
      city: municipality.city,
    };
  }
}
