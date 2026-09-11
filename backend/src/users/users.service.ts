import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import type { AppUser } from '../auth/types/app-user.type';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto, UpdateUserStatusDto } from './dto/update-user.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { QueryUsersDto } from './dto/query-users.dto';

const USER_LIST_INCLUDE = {
  department: { select: { id: true, name: true } },
} as const;
type UserWithDepartment = Prisma.UserGetPayload<{
  include: typeof USER_LIST_INCLUDE;
}>;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloakAdmin: KeycloakAdminService,
  ) {}

  /** GET /api/me. */
  async getAuthenticatedUser(keycloakUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { keycloakUserId },
      include: {
        municipality: true,
        department: { select: { id: true, name: true } },
      },
    });

    if (!user) {
      throw new NotFoundException(
        'No application user is linked to this Keycloak identity. Complete municipality registration first.',
      );
    }

    return {
      id: user.id,
      keycloakUserId: user.keycloakUserId,
      name: user.fullName,
      email: user.email,
      mobileNumber: user.mobileNumber,
      systemRole: user.systemRole,
      status: user.status,
      // Task 7: the GIS upload wizard needs to know the caller's own
      // department to default/restrict department-layer uploads for a
      // DEPARTMENT_HEAD/DEPARTMENT_USER. Null for the Owner (who belongs
      // to no department) and for a user not yet assigned one.
      department: user.department
        ? { id: user.department.id, name: user.department.name }
        : null,
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

  /**
   * Tenant-scoped user list, optionally filtered by department/status/search.
   * A DEPARTMENT_HEAD/DEPARTMENT_USER is additionally locked to their own
   * department — `query.departmentId` is only honored for the Owner; a
   * non-Owner caller always gets their own department's roster, regardless
   * of what (if anything) they pass, and gets nothing back if they somehow
   * have no department assigned.
   */
  async list(appUser: AppUser, query: QueryUsersDto) {
    const where: Prisma.UserWhereInput = {
      municipalityId: appUser.municipalityId,
    };
    if (appUser.systemRole === 'MUNICIPALITY_OWNER') {
      if (query.departmentId) {
        where.departmentId = query.departmentId;
      }
    } else {
      if (!appUser.departmentId) {
        return [];
      }
      where.departmentId = appUser.departmentId;
    }
    if (query.status) {
      where.status = query.status;
    }
    if (query.search) {
      const search = query.search.trim();
      if (search) {
        where.OR = [
          { fullName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ];
      }
    }

    const users = await this.prisma.user.findMany({
      where,
      include: USER_LIST_INCLUDE,
      orderBy: { fullName: 'asc' },
    });
    return users.map((user) => this.toListResponse(user));
  }

  /** A DEPARTMENT_HEAD/DEPARTMENT_USER may only look up a user within their
   *  own department — anyone else's id, including another department's
   *  member, 404s exactly like a user from a different municipality. */
  async getById(appUser: AppUser, id: string) {
    const where: Prisma.UserWhereInput = {
      id,
      municipalityId: appUser.municipalityId,
    };
    if (appUser.systemRole !== 'MUNICIPALITY_OWNER') {
      if (!appUser.departmentId) {
        throw new NotFoundException('User not found.');
      }
      where.departmentId = appUser.departmentId;
    }

    const user = await this.prisma.user.findFirst({
      where,
      include: USER_LIST_INCLUDE,
    });
    if (!user) {
      throw new NotFoundException('User not found.');
    }
    return this.toListResponse(user);
  }

  /**
   * Owner creates a new municipality user. Role is DEPARTMENT_HEAD or
   * DEPARTMENT_USER (Task 8) — defaults to DEPARTMENT_USER, never accepts
   * MUNICIPALITY_OWNER from the client. Follows the same
   * create-Keycloak-user-then-transact-then-compensate pattern as Task 3's
   * municipality registration (see docs/backend.md §Owner-created users).
   */
  async createUser(actor: AppUser, dto: CreateUserDto) {
    if (dto.departmentId) {
      await this.assertDepartmentInMunicipality(
        actor.municipalityId,
        dto.departmentId,
      );
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existingUser) {
      throw new ConflictException(
        'A user with this email is already registered.',
      );
    }

    const { keycloakUserId, temporaryPassword } =
      await this.keycloakAdmin.createUserWithTemporaryPassword({
        email: dto.email,
        fullName: dto.fullName,
        mobileNumber: dto.mobileNumber,
      });

    try {
      const user = await this.prisma.user.create({
        data: {
          keycloakUserId,
          fullName: dto.fullName,
          email: dto.email,
          mobileNumber: dto.mobileNumber,
          municipalityId: actor.municipalityId,
          departmentId: dto.departmentId ?? null,
          systemRole: dto.role ?? 'DEPARTMENT_USER',
          createdById: actor.id,
        },
        include: USER_LIST_INCLUDE,
      });

      return { user: this.toListResponse(user), temporaryPassword };
    } catch (error) {
      await this.keycloakAdmin.deleteUser(keycloakUserId);

      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'A user with these details is already registered.',
        );
      }
      this.logger.error('User creation transaction failed', error as Error);
      throw error;
    }
  }

  /** `PATCH /api/me` — a user editing their own profile. Only `fullName` /
   *  `mobileNumber`; returns the same shape as `GET /api/me`. */
  async updateOwnProfile(keycloakUserId: string, dto: UpdateMeDto) {
    const user = await this.prisma.user.findUnique({
      where: { keycloakUserId },
    });
    if (!user) {
      throw new NotFoundException(
        'No application user is linked to this identity.',
      );
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        ...(dto.fullName !== undefined && { fullName: dto.fullName.trim() }),
        ...(dto.mobileNumber !== undefined && {
          mobileNumber: dto.mobileNumber,
        }),
      },
    });
    return this.getAuthenticatedUser(keycloakUserId);
  }

  async updateUser(municipalityId: string, id: string, dto: UpdateUserDto) {
    const target = await this.assertManageableUser(municipalityId, id);

    if (dto.departmentId) {
      await this.assertDepartmentInMunicipality(
        municipalityId,
        dto.departmentId,
      );
    }

    const user = await this.prisma.user.update({
      where: { id: target.id },
      data: {
        ...(dto.fullName !== undefined && { fullName: dto.fullName.trim() }),
        ...(dto.mobileNumber !== undefined && {
          mobileNumber: dto.mobileNumber,
        }),
        ...(dto.departmentId !== undefined && {
          departmentId: dto.departmentId,
        }),
      },
      include: USER_LIST_INCLUDE,
    });
    return this.toListResponse(user);
  }

  /** Activates/deactivates a user. Deactivation also revokes their active
   *  Keycloak sessions (best-effort) — see KeycloakAdminService.logoutUserSessions
   *  and AppUserGuard, which together enforce that a deactivated user can no
   *  longer use any protected API, regardless of an existing session. */
  async updateUserStatus(
    municipalityId: string,
    id: string,
    dto: UpdateUserStatusDto,
  ) {
    const target = await this.assertManageableUser(municipalityId, id);

    const user = await this.prisma.user.update({
      where: { id: target.id },
      data: { status: dto.status },
      include: USER_LIST_INCLUDE,
    });

    if (dto.status === 'DISABLED') {
      await this.keycloakAdmin.logoutUserSessions(user.keycloakUserId);
    }

    return this.toListResponse(user);
  }

  /**
   * Permanently removes a user. Both the MUNICIPALITY_OWNER and a
   * DEPARTMENT_HEAD may delete — the Owner may delete anyone but the
   * Owner (via `assertManageableUser`); a DEPARTMENT_HEAD may only delete
   * a DEPARTMENT_USER within their own department (never a peer Head, and
   * never anyone outside their department). The DB row is removed first
   * — the source of truth for "does this user still exist" — then the
   * Keycloak identity is deleted best-effort (logged, not fatal): every
   * other record that references this user (`GISLayerUpload.uploadedById`,
   * `Department.createdById`, etc.) is a plain audit string, not a
   * relation, by design (see schema.prisma), so a deleted user never
   * blocks reading data they once created.
   */
  async deleteUser(actor: AppUser, id: string): Promise<void> {
    const target = await this.assertManageableUser(actor.municipalityId, id);

    if (actor.systemRole !== 'MUNICIPALITY_OWNER') {
      const canHeadDelete =
        actor.systemRole === 'DEPARTMENT_HEAD' &&
        !!actor.departmentId &&
        target.departmentId === actor.departmentId &&
        target.systemRole === 'DEPARTMENT_USER';
      if (!canHeadDelete) {
        throw new ForbiddenException(
          'You do not have permission to delete this user.',
        );
      }
    }

    await this.prisma.user.delete({ where: { id: target.id } });

    try {
      await this.keycloakAdmin.deleteUser(target.keycloakUserId);
    } catch (error) {
      this.logger.warn(
        `Failed to delete Keycloak identity for removed user ${target.id}: ${(error as Error).message}`,
      );
    }
  }

  /** Confirms `id` is a user within `municipalityId` and is not the
   *  MUNICIPALITY_OWNER — the owner can never be edited, deactivated,
   *  deleted, or reassigned through these generic management endpoints. */
  private async assertManageableUser(municipalityId: string, id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, municipalityId },
    });
    if (!user) {
      throw new NotFoundException('User not found.');
    }
    if (user.systemRole === 'MUNICIPALITY_OWNER') {
      throw new ForbiddenException(
        'The municipality owner cannot be managed through this endpoint.',
      );
    }
    return user;
  }

  private async assertDepartmentInMunicipality(
    municipalityId: string,
    departmentId: string,
  ): Promise<void> {
    const department = await this.prisma.department.findFirst({
      where: { id: departmentId, municipalityId },
      select: { id: true },
    });
    if (!department) {
      throw new NotFoundException('Department not found in your municipality.');
    }
  }

  private toListResponse(user: UserWithDepartment) {
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      mobileNumber: user.mobileNumber,
      systemRole: user.systemRole,
      status: user.status,
      department: user.department
        ? { id: user.department.id, name: user.department.name }
        : null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
