import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import { GisWorkspaceService } from '../gis/gis-workspace.service';
import { RegisterMunicipalityDto } from './dto/register-municipality.dto';

@Injectable()
export class MunicipalitiesService {
  private readonly logger = new Logger(MunicipalitiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloakAdmin: KeycloakAdminService,
    private readonly gisWorkspace: GisWorkspaceService,
  ) {}

  /**
   * Registers a new municipality together with its first user, who
   * automatically becomes MUNICIPALITY_OWNER, and its one permanent GIS
   * Workspace. This role is assigned here, server-side, and can never be
   * supplied by the caller.
   *
   * Steps:
   *  1. Fail fast on obvious duplicates (before touching Keycloak).
   *  2. Create the Keycloak user (owns credentials/password).
   *  3. Create Municipality + User + GISWorkspace atomically in one DB
   *     transaction — all three commit together or none do.
   *  4. If the DB transaction fails after step 2, roll back the Keycloak
   *     user so we never leave a Keycloak identity with no application
   *     user attached to it.
   *  5. Once the transaction has committed, provision the GeoServer side
   *     (workspace + PostGIS datastore) for the new GISWorkspace. GeoServer
   *     is an external service that cannot participate in the DB
   *     transaction — if this step fails, the municipality/owner/workspace
   *     row are NOT rolled back; the workspace is left in
   *     PROVISIONING_FAILED and can be retried later (see
   *     GisWorkspaceService.retryProvisioning / POST /api/gis/workspace/provision).
   */
  async registerMunicipality(dto: RegisterMunicipalityDto) {
    const [existingMunicipality, existingUser] = await Promise.all([
      this.prisma.municipality.findUnique({
        where: { officialEmail: dto.municipality.officialEmail },
      }),
      this.prisma.user.findUnique({ where: { email: dto.owner.email } }),
    ]);

    if (existingMunicipality) {
      throw new ConflictException(
        'A municipality with this official email is already registered.',
      );
    }
    if (existingUser) {
      throw new ConflictException(
        'A user with this email is already registered.',
      );
    }

    const { keycloakUserId } = await this.keycloakAdmin.createUser({
      email: dto.owner.email,
      fullName: dto.owner.fullName,
      mobileNumber: dto.owner.mobileNumber,
      password: dto.owner.password,
    });

    let municipality: Prisma.MunicipalityGetPayload<object>;
    let user: Prisma.UserGetPayload<object>;
    let workspace: Prisma.GISWorkspaceGetPayload<object>;

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const municipality = await tx.municipality.create({
          data: {
            name: dto.municipality.name,
            type: dto.municipality.type,
            state: dto.municipality.state,
            district: dto.municipality.district,
            city: dto.municipality.city,
            officialEmail: dto.municipality.officialEmail,
            contactNumber: dto.municipality.contactNumber,
          },
        });

        const user = await tx.user.create({
          data: {
            keycloakUserId,
            fullName: dto.owner.fullName,
            email: dto.owner.email,
            mobileNumber: dto.owner.mobileNumber,
            municipalityId: municipality.id,
            systemRole: 'MUNICIPALITY_OWNER',
          },
        });

        const workspace = await this.gisWorkspace.createWorkspaceRecord(
          tx,
          municipality.id,
          municipality.name,
          user.id,
        );

        return { municipality, user, workspace };
      });
      municipality = result.municipality;
      user = result.user;
      workspace = result.workspace;
    } catch (error) {
      await this.keycloakAdmin.deleteUser(keycloakUserId);

      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'A municipality or user with these details is already registered.',
        );
      }

      this.logger.error(
        'Municipality registration transaction failed',
        error as Error,
      );
      throw error;
    }

    // Non-transactional: GeoServer cannot participate in the DB commit
    // above. Never let a GeoServer outage fail the registration response
    // itself — provisionWorkspace already catches its own errors and
    // records PROVISIONING_FAILED instead of throwing.
    const provisioned = await this.gisWorkspace.provisionWorkspace(
      workspace.id,
    );

    return {
      municipality: {
        id: municipality.id,
        name: municipality.name,
        type: municipality.type,
        state: municipality.state,
        district: municipality.district,
        city: municipality.city,
        officialEmail: municipality.officialEmail,
        contactNumber: municipality.contactNumber,
        status: municipality.status,
      },
      owner: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        systemRole: user.systemRole,
      },
      gisWorkspace: {
        id: provisioned.id,
        name: provisioned.name,
        code: provisioned.code,
        status: provisioned.status,
        geoserverWorkspace: provisioned.geoserverWorkspace,
      },
    };
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
