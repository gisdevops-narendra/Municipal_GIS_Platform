import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateDepartmentDto,
  UpdateDepartmentDto,
} from './dto/create-department.dto';

/**
 * Every method here takes `municipalityId` as an explicit argument sourced
 * from the authenticated caller's own AppUser (via AppUserGuard) — never
 * from a client-supplied id. This is what makes cross-tenant access
 * impossible: a Department belonging to another municipality simply never
 * matches the `where` clause, so it looks identical to "not found".
 */
@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(municipalityId: string) {
    const departments = await this.prisma.department.findMany({
      where: { municipalityId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { users: true } } },
    });
    return departments.map((department) => this.toResponse(department));
  }

  async getById(municipalityId: string, id: string) {
    const department = await this.prisma.department.findFirst({
      where: { id, municipalityId },
      include: { _count: { select: { users: true } } },
    });
    if (!department) {
      throw new NotFoundException('Department not found.');
    }
    return this.toResponse(department);
  }

  async create(
    municipalityId: string,
    createdById: string,
    dto: CreateDepartmentDto,
  ) {
    try {
      const department = await this.prisma.department.create({
        data: {
          municipalityId,
          name: dto.name.trim(),
          code: dto.code,
          description: dto.description?.trim() || null,
          createdById,
        },
        include: { _count: { select: { users: true } } },
      });
      return this.toResponse(department);
    } catch (error) {
      throw this.mapWriteError(error);
    }
  }

  async update(municipalityId: string, id: string, dto: UpdateDepartmentDto) {
    // Confirms the department belongs to this municipality (404 otherwise)
    // before allowing the update-by-id below to proceed.
    await this.assertBelongsToMunicipality(municipalityId, id);

    try {
      const department = await this.prisma.department.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name.trim() }),
          ...(dto.code !== undefined && { code: dto.code }),
          ...(dto.description !== undefined && {
            description: dto.description?.trim() || null,
          }),
          ...(dto.status !== undefined && { status: dto.status }),
        },
        include: { _count: { select: { users: true } } },
      });
      return this.toResponse(department);
    } catch (error) {
      throw this.mapWriteError(error);
    }
  }

  /** Never hard-deletes a department that still has users assigned — the
   *  caller must deactivate it (PATCH status=INACTIVE) instead. This
   *  avoids ever silently orphaning a user's department reference. */
  async remove(municipalityId: string, id: string): Promise<void> {
    const department = await this.prisma.department.findFirst({
      where: { id, municipalityId },
      include: { _count: { select: { users: true } } },
    });
    if (!department) {
      throw new NotFoundException('Department not found.');
    }
    if (department._count.users > 0) {
      throw new ConflictException(
        `Cannot delete "${department.name}" — it has ${department._count.users} user(s) assigned. Deactivate it instead.`,
      );
    }
    await this.prisma.department.delete({ where: { id } });
  }

  private async assertBelongsToMunicipality(
    municipalityId: string,
    id: string,
  ): Promise<void> {
    const exists = await this.prisma.department.findFirst({
      where: { id, municipalityId },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException('Department not found.');
    }
  }

  private mapWriteError(error: unknown): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(
        'A department with this name or code already exists in this municipality.',
      );
    }
    return error;
  }

  private toResponse(department: {
    id: string;
    municipalityId: string;
    name: string;
    code: string;
    description: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    _count: { users: number };
  }) {
    return {
      id: department.id,
      municipalityId: department.municipalityId,
      name: department.name,
      code: department.code,
      description: department.description,
      status: department.status,
      userCount: department._count.users,
      createdAt: department.createdAt,
      updatedAt: department.updatedAt,
    };
  }
}
