import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import type { AppUser } from '../auth/types/app-user.type';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    department: { findFirst: jest.Mock };
  };
  let keycloakAdmin: {
    createUserWithTemporaryPassword: jest.Mock;
    deleteUser: jest.Mock;
    logoutUserSessions: jest.Mock;
  };

  const owner: AppUser = {
    id: 'owner-1',
    keycloakUserId: 'kc-owner-1',
    municipalityId: 'muni-1',
    departmentId: null,
    systemRole: 'MUNICIPALITY_OWNER',
    status: 'ACTIVE',
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      department: { findFirst: jest.fn() },
    };
    keycloakAdmin = {
      createUserWithTemporaryPassword: jest.fn(),
      deleteUser: jest.fn(),
      logoutUserSessions: jest.fn(),
    };
    service = new UsersService(
      prisma as unknown as PrismaService,
      keycloakAdmin as unknown as KeycloakAdminService,
    );
  });

  describe('getAuthenticatedUser (/api/me)', () => {
    it('maps the application user + municipality + department for /api/me from the Keycloak sub claim', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        keycloakUserId: 'kc-1',
        fullName: 'Narendra Owner',
        email: 'owner@somnath.gov.in',
        mobileNumber: '9876543210',
        systemRole: 'MUNICIPALITY_OWNER',
        status: 'ACTIVE',
        department: null,
        municipality: {
          id: 'muni-1',
          name: 'Somnath Municipality',
          type: 'municipality',
          state: 'Gujarat',
          district: 'Gir Somnath',
          city: 'Somnath',
        },
      });

      const result = await service.getAuthenticatedUser('kc-1');

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { keycloakUserId: 'kc-1' },
        include: {
          municipality: true,
          department: { select: { id: true, name: true } },
        },
      });
      expect(result.systemRole).toBe('MUNICIPALITY_OWNER');
      expect(result.municipality.name).toBe('Somnath Municipality');
      expect(result.department).toBeNull();
    });

    it('includes the department for a user who has one assigned', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-2',
        keycloakUserId: 'kc-2',
        fullName: 'Staff User',
        email: 'staff@somnath.gov.in',
        mobileNumber: '9876500001',
        systemRole: 'DEPARTMENT_USER',
        status: 'ACTIVE',
        department: { id: 'dept-electrical', name: 'Electrical Department' },
        municipality: {
          id: 'muni-1',
          name: 'Somnath Municipality',
          type: 'municipality',
          state: 'Gujarat',
          district: 'Gir Somnath',
          city: 'Somnath',
        },
      });

      const result = await service.getAuthenticatedUser('kc-2');

      expect(result.department).toEqual({
        id: 'dept-electrical',
        name: 'Electrical Department',
      });
    });

    it('throws NotFoundException when no application user is linked to the Keycloak identity yet', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.getAuthenticatedUser('unknown-kc-id'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('createUser', () => {
    const dto = {
      fullName: 'Rahul Patel',
      email: 'rahul@somnath.gov.in',
      mobileNumber: '9876500000',
      departmentId: 'dept-roads',
    };

    it('creates a Keycloak user with a temporary password and an app user assigned DEPARTMENT_USER by default', async () => {
      prisma.department.findFirst.mockResolvedValue({ id: 'dept-roads' });
      prisma.user.findUnique.mockResolvedValue(null);
      keycloakAdmin.createUserWithTemporaryPassword.mockResolvedValue({
        keycloakUserId: 'kc-rahul',
        temporaryPassword: 'Temp-Pass-1',
      });
      prisma.user.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            ...data,
            department: { id: 'dept-roads', name: 'Roads' },
          }),
      );

      const result = await service.createUser(owner, dto);

      expect(prisma.department.findFirst).toHaveBeenCalledWith({
        where: { id: 'dept-roads', municipalityId: 'muni-1' },
        select: { id: true },
      });
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest.Mock's default typing is `any`
          data: expect.objectContaining({
            systemRole: 'DEPARTMENT_USER',
            municipalityId: 'muni-1',
            createdById: 'owner-1',
            keycloakUserId: 'kc-rahul',
          }),
        }),
      );
      expect(result.temporaryPassword).toBe('Temp-Pass-1');
      expect(result.user.systemRole).toBe('DEPARTMENT_USER');
    });

    it('rejects a department that does not belong to the caller municipality, without calling Keycloak', async () => {
      prisma.department.findFirst.mockResolvedValue(null);

      await expect(service.createUser(owner, dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(
        keycloakAdmin.createUserWithTemporaryPassword,
      ).not.toHaveBeenCalled();
    });

    it('rejects a duplicate email before calling Keycloak', async () => {
      prisma.department.findFirst.mockResolvedValue({ id: 'dept-roads' });
      prisma.user.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(service.createUser(owner, dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(
        keycloakAdmin.createUserWithTemporaryPassword,
      ).not.toHaveBeenCalled();
    });

    it('rolls back the Keycloak user if the database insert fails', async () => {
      prisma.department.findFirst.mockResolvedValue({ id: 'dept-roads' });
      prisma.user.findUnique.mockResolvedValue(null);
      keycloakAdmin.createUserWithTemporaryPassword.mockResolvedValue({
        keycloakUserId: 'kc-rahul',
        temporaryPassword: 'Temp-Pass-1',
      });
      prisma.user.create.mockRejectedValue(new Error('db exploded'));

      await expect(service.createUser(owner, dto)).rejects.toThrow(
        'db exploded',
      );
      expect(keycloakAdmin.deleteUser).toHaveBeenCalledWith('kc-rahul');
    });
  });

  describe('owner protection', () => {
    it('refuses to update a user whose systemRole is MUNICIPALITY_OWNER', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'owner-1',
        systemRole: 'MUNICIPALITY_OWNER',
      });

      await expect(
        service.updateUser('muni-1', 'owner-1', { fullName: 'New Name' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses to deactivate a user whose systemRole is MUNICIPALITY_OWNER', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'owner-1',
        systemRole: 'MUNICIPALITY_OWNER',
      });

      await expect(
        service.updateUserStatus('muni-1', 'owner-1', { status: 'DISABLED' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('updateUserStatus', () => {
    it('revokes Keycloak sessions when deactivating a user', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-2',
        systemRole: 'DEPARTMENT_USER',
        keycloakUserId: 'kc-user-2',
      });
      prisma.user.update.mockResolvedValue({
        id: 'user-2',
        keycloakUserId: 'kc-user-2',
        fullName: 'Test User',
        email: 't@x.com',
        mobileNumber: '123',
        systemRole: 'DEPARTMENT_USER',
        status: 'DISABLED',
        department: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await service.updateUserStatus('muni-1', 'user-2', {
        status: 'DISABLED',
      });

      expect(keycloakAdmin.logoutUserSessions).toHaveBeenCalledWith(
        'kc-user-2',
      );
    });

    it('does not revoke sessions when reactivating a user', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-2',
        systemRole: 'DEPARTMENT_USER',
        keycloakUserId: 'kc-user-2',
      });
      prisma.user.update.mockResolvedValue({
        id: 'user-2',
        keycloakUserId: 'kc-user-2',
        fullName: 'Test User',
        email: 't@x.com',
        mobileNumber: '123',
        systemRole: 'DEPARTMENT_USER',
        status: 'ACTIVE',
        department: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await service.updateUserStatus('muni-1', 'user-2', { status: 'ACTIVE' });

      expect(keycloakAdmin.logoutUserSessions).not.toHaveBeenCalled();
    });
  });

  describe('tenant isolation', () => {
    it('getById returns null (404) for a user belonging to a different municipality', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.getById('muni-A', 'user-in-muni-B'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-in-muni-B', municipalityId: 'muni-A' },
        }),
      );
    });

    it('list always scopes findMany by the caller municipality, ignoring nothing else supplied', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      await service.list('muni-A', {});

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest.Mock's default typing is `any`
          where: expect.objectContaining({ municipalityId: 'muni-A' }),
        }),
      );
    });
  });
});
