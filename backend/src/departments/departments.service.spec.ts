import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DepartmentsService } from './departments.service';
import { PrismaService } from '../prisma/prisma.service';

describe('DepartmentsService', () => {
  let service: DepartmentsService;
  let prisma: {
    department: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      department: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    service = new DepartmentsService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('normalizes and creates a department scoped to the caller municipality', async () => {
      prisma.department.create.mockResolvedValue({
        id: 'dept-1',
        municipalityId: 'muni-1',
        name: 'Roads',
        code: 'ROADS',
        description: null,
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { users: 0 },
      });

      await service.create('muni-1', 'owner-1', {
        name: 'Roads',
        code: 'ROADS',
      });

      expect(prisma.department.create).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest.Mock's default typing is `any`
          data: expect.objectContaining({
            municipalityId: 'muni-1',
            name: 'Roads',
            code: 'ROADS',
            createdById: 'owner-1',
          }),
        }),
      );
    });

    it('maps a Prisma unique-constraint violation to a clean 409', async () => {
      prisma.department.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.3',
        }),
      );

      await expect(
        service.create('muni-1', 'owner-1', { name: 'Roads', code: 'ROADS' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('tenant isolation', () => {
    it('getById 404s for a department belonging to a different municipality', async () => {
      prisma.department.findFirst.mockResolvedValue(null);

      await expect(
        service.getById('muni-A', 'dept-in-muni-B'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.department.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dept-in-muni-B', municipalityId: 'muni-A' },
        }),
      );
    });

    it('update 404s (never updates) a department belonging to a different municipality', async () => {
      prisma.department.findFirst.mockResolvedValue(null);

      await expect(
        service.update('muni-A', 'dept-in-muni-B', { name: 'Hijacked' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.department.update).not.toHaveBeenCalled();
    });

    it('remove 404s (never deletes) a department belonging to a different municipality', async () => {
      prisma.department.findFirst.mockResolvedValue(null);

      await expect(
        service.remove('muni-A', 'dept-in-muni-B'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.department.delete).not.toHaveBeenCalled();
    });
  });

  describe('remove (delete safety)', () => {
    it('rejects deleting a department that still has assigned users', async () => {
      prisma.department.findFirst.mockResolvedValue({
        id: 'dept-1',
        name: 'Roads',
        _count: { users: 3 },
      });

      await expect(service.remove('muni-1', 'dept-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.department.delete).not.toHaveBeenCalled();
    });

    it('hard-deletes a department with zero assigned users', async () => {
      prisma.department.findFirst.mockResolvedValue({
        id: 'dept-1',
        name: 'Empty Dept',
        _count: { users: 0 },
      });

      await service.remove('muni-1', 'dept-1');

      expect(prisma.department.delete).toHaveBeenCalledWith({
        where: { id: 'dept-1' },
      });
    });
  });
});
