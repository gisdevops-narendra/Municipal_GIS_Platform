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

  /** Tenant-scoped user list, optionally filtered by department/status/search. */
  async list(municipalityId: string, query: QueryUsersDto) {
    const where: Prisma.UserWhereInput = { municipalityId };
    if (query.departmentId) {
      where.departmentId = query.departmentId;
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

  async getById(municipalityId: string, id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, municipalityId },
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

  /** Confirms `id` is a user within `municipalityId` and is not the
   *  MUNICIPALITY_OWNER — the owner can never be edited, deactivated, or
   *  reassigned through these generic management endpoints. */
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
