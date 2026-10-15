import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ModuleAccessService } from './module-access.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';

// A small slice of the real seeded hierarchy, enough to exercise
// ancestor-walking via nodePath: 18 (Basic Tools, default) -> 21 (Pan,
// default); 5 (Advanced Tools, not default) -> 11 (Measure, default) and
// -> 187 (MultiBuffer, not default); 226 (Export Data) -> 227 (Export to
// csv).
const MODULES = [
  { id: 18, nodePath: '18', defaultModule: true, isActive: true },
  { id: 21, nodePath: '18.21', defaultModule: true, isActive: true },
  { id: 5, nodePath: '5', defaultModule: null, isActive: true },
  { id: 11, nodePath: '5.11', defaultModule: true, isActive: true },
  { id: 187, nodePath: '5.187', defaultModule: null, isActive: true },
  { id: 226, nodePath: '226', defaultModule: null, isActive: true },
  { id: 227, nodePath: '226.227', defaultModule: null, isActive: true },
];

describe('ModuleAccessService', () => {
  let service: ModuleAccessService;
  let prisma: {
    module: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      deleteMany: jest.Mock;
    };
    departmentModuleGrant: {
      findMany: jest.Mock;
      deleteMany: jest.Mock;
      createMany: jest.Mock;
    };
    userModuleGrant: {
      findMany: jest.Mock;
      deleteMany: jest.Mock;
      createMany: jest.Mock;
    };
    department: { findFirst: jest.Mock };
    user: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };

  const OWNER: AppUser = {
    id: 'owner-1',
    keycloakUserId: 'kc-owner',
    municipalityId: 'muni-a',
    departmentId: null,
    systemRole: 'MUNICIPALITY_OWNER',
    status: 'ACTIVE',
  };

  const ROADS_HEAD: AppUser = {
    id: 'head-1',
    keycloakUserId: 'kc-head',
    municipalityId: 'muni-a',
    departmentId: 'dept-roads',
    systemRole: 'DEPARTMENT_HEAD',
    status: 'ACTIVE',
  };

  const ROADS_USER: AppUser = {
    id: 'user-1',
    keycloakUserId: 'kc-user',
    municipalityId: 'muni-a',
    departmentId: 'dept-roads',
    systemRole: 'DEPARTMENT_USER',
    status: 'ACTIVE',
  };

  beforeEach(() => {
    prisma = {
      module: {
        findMany: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      departmentModuleGrant: {
        findMany: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      userModuleGrant: {
        findMany: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      department: { findFirst: jest.fn() },
      user: { findFirst: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    service = new ModuleAccessService(prisma as unknown as PrismaService);
  });

  /** module.findMany is called twice per resolveModuleIds() call: once
   *  for defaults, once for the explicit ids. This wires both from the
   *  same fixed catalog slice. */
  function mockCatalogLookups(): void {
    prisma.module.findMany.mockImplementation(({ where }) => {
      if (where?.defaultModule) {
        return Promise.resolve(
          MODULES.filter((m) => m.defaultModule).map((m) => ({
            id: m.id,
            nodePath: m.nodePath,
          })),
        );
      }
      const ids: number[] = where?.id?.in ?? [];
      return Promise.resolve(
        MODULES.filter((m) => ids.includes(m.id)).map((m) => ({
          id: m.id,
          nodePath: m.nodePath,
        })),
      );
    });
  }

  describe('resolveModuleIds', () => {
    it('expands an explicit grant to include its ancestors via nodePath', async () => {
      mockCatalogLookups();

      const result = await service.resolveModuleIds([227]);

      // 227 itself, plus ancestor 226, plus every default (18, 21, 5? no —
      // 5 is not default) and defaults' own ancestors (18 is its own
      // ancestor; 11's ancestor 5 gets pulled in via the default 11).
      expect(result.has(227)).toBe(true);
      expect(result.has(226)).toBe(true);
      expect(result.has(18)).toBe(true); // default
      expect(result.has(21)).toBe(true); // default
      expect(result.has(11)).toBe(true); // default
      expect(result.has(5)).toBe(true); // ancestor of default 11
      expect(result.has(187)).toBe(false); // never granted, not default
    });
  });

  describe('getEffectiveModuleIdsForAppUser', () => {
    it('gives the Owner every active module, ignoring grants entirely', async () => {
      prisma.module.findMany.mockResolvedValue(
        MODULES.map((m) => ({ id: m.id })),
      );

      const result = await service.getEffectiveModuleIdsForAppUser(OWNER);

      expect(result).toEqual(new Set(MODULES.map((m) => m.id)));
      expect(prisma.departmentModuleGrant.findMany).not.toHaveBeenCalled();
    });

    it("gives a Department Head exactly their department's effective set", async () => {
      mockCatalogLookups();
      prisma.departmentModuleGrant.findMany.mockResolvedValue([
        { moduleId: 187 },
      ]);

      const result = await service.getEffectiveModuleIdsForAppUser(ROADS_HEAD);

      expect(result.has(187)).toBe(true);
      expect(result.has(5)).toBe(true); // ancestor of 187
    });

    it("clamps a Department User's own grants to the department's current set", async () => {
      mockCatalogLookups();
      // Department only has 187 explicitly granted.
      prisma.departmentModuleGrant.findMany.mockResolvedValue([
        { moduleId: 187 },
      ]);
      // But the user was (historically) also granted 227 — no longer
      // covered by the department's current grants.
      prisma.userModuleGrant.findMany.mockResolvedValue([
        { moduleId: 187 },
        { moduleId: 227 },
      ]);

      const result = await service.getEffectiveModuleIdsForAppUser(ROADS_USER);

      expect(result.has(187)).toBe(true);
      expect(result.has(227)).toBe(false);
      expect(result.has(226)).toBe(false);
    });
  });

  describe('setUserGrants — hierarchical enforcement', () => {
    it('lets a Department Head grant a module within their own department set', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        departmentId: 'dept-roads',
        systemRole: 'DEPARTMENT_USER',
      });
      mockCatalogLookups();
      prisma.departmentModuleGrant.findMany.mockResolvedValue([
        { moduleId: 187 },
      ]);
      prisma.userModuleGrant.findMany.mockResolvedValue([{ moduleId: 187 }]);

      await service.setUserGrants(ROADS_HEAD, 'user-1', [187]);

      expect(prisma.userModuleGrant.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(prisma.userModuleGrant.createMany).toHaveBeenCalledWith({
        data: [{ userId: 'user-1', moduleId: 187, grantedById: 'head-1' }],
      });
    });

    it('refuses a Department Head granting a module their own department does not have', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        departmentId: 'dept-roads',
        systemRole: 'DEPARTMENT_USER',
      });
      mockCatalogLookups();
      // Department has nothing beyond the defaults granted.
      prisma.departmentModuleGrant.findMany.mockResolvedValue([]);

      await expect(
        service.setUserGrants(ROADS_HEAD, 'user-1', [227]),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.userModuleGrant.deleteMany).not.toHaveBeenCalled();
    });

    it('refuses a Department Head assigning a user outside their own department', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-2',
        departmentId: 'dept-water',
        systemRole: 'DEPARTMENT_USER',
      });

      await expect(
        service.setUserGrants(ROADS_HEAD, 'user-2', [18]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a Department Head assigning a peer Department Head', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'head-2',
        departmentId: 'dept-roads',
        systemRole: 'DEPARTMENT_HEAD',
      });

      await expect(
        service.setUserGrants(ROADS_HEAD, 'head-2', [18]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses managing the municipality owner', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'owner-1',
        departmentId: null,
        systemRole: 'MUNICIPALITY_OWNER',
      });

      await expect(
        service.setUserGrants(OWNER, 'owner-1', [18]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets the Owner grant any active module without a department-subset check', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-2',
        departmentId: 'dept-water',
        systemRole: 'DEPARTMENT_USER',
      });
      mockCatalogLookups();
      prisma.departmentModuleGrant.findMany.mockResolvedValue([]);
      prisma.userModuleGrant.findMany.mockResolvedValue([{ moduleId: 227 }]);

      await service.setUserGrants(OWNER, 'user-2', [227]);

      expect(prisma.userModuleGrant.createMany).toHaveBeenCalledWith({
        data: [{ userId: 'user-2', moduleId: 227, grantedById: 'owner-1' }],
      });
    });

    it('rejects an unknown/inactive module id before touching any grant', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        departmentId: 'dept-roads',
        systemRole: 'DEPARTMENT_USER',
      });
      prisma.module.findMany.mockResolvedValue([]); // none found -> all "unknown"

      await expect(
        service.setUserGrants(OWNER, 'user-1', [9999]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.userModuleGrant.deleteMany).not.toHaveBeenCalled();
    });

    it('404s for a user outside the caller municipality', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.setUserGrants(OWNER, 'user-in-other-muni', [18]),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('setDepartmentGrants — Owner only (role enforced by the controller decorator)', () => {
    it('full-replaces the department grant set', async () => {
      prisma.department.findFirst.mockResolvedValue({ id: 'dept-roads' });
      mockCatalogLookups();
      prisma.departmentModuleGrant.findMany.mockResolvedValue([
        { moduleId: 187 },
      ]);

      await service.setDepartmentGrants(OWNER, 'dept-roads', [187]);

      expect(prisma.departmentModuleGrant.deleteMany).toHaveBeenCalledWith({
        where: { departmentId: 'dept-roads' },
      });
      expect(prisma.departmentModuleGrant.createMany).toHaveBeenCalledWith({
        data: [{ departmentId: 'dept-roads', moduleId: 187, grantedById: 'owner-1' }],
      });
    });

    it('404s for a department outside the caller municipality', async () => {
      prisma.department.findFirst.mockResolvedValue(null);

      await expect(
        service.setDepartmentGrants(OWNER, 'dept-other-muni', [18]),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getDepartmentGrants — view scoping', () => {
    it('403s a Department User trying to view any department', async () => {
      const user: AppUser = { ...ROADS_USER };
      await expect(
        service.getDepartmentGrants(user, 'dept-roads'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("403s a Department Head viewing another department's grants", async () => {
      prisma.department.findFirst.mockResolvedValue({ id: 'dept-water' });

      await expect(
        service.getDepartmentGrants(ROADS_HEAD, 'dept-water'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets a Department Head view their own department', async () => {
      prisma.department.findFirst.mockResolvedValue({ id: 'dept-roads' });
      mockCatalogLookups();
      prisma.departmentModuleGrant.findMany.mockResolvedValue([]);

      const result = await service.getDepartmentGrants(ROADS_HEAD, 'dept-roads');

      expect(result.departmentId).toBe('dept-roads');
    });
  });

  describe('createModule — Owner only (role enforced by the controller decorator)', () => {
    it('derives nodePath from the parent for a nested module', async () => {
      prisma.module.findFirst.mockResolvedValue({ nodePath: '226' });
      prisma.module.create.mockResolvedValue({ id: 300 });
      prisma.module.update.mockResolvedValue({
        id: 300,
        name: 'Export to PDF',
        parentId: 226,
        nodePath: '226.300',
        defaultModule: false,
        displayPriority: null,
        type: 'other',
      });

      const result = await service.createModule({
        name: 'Export to PDF',
        parentId: 226,
        type: 'other',
      });

      expect(prisma.module.findFirst).toHaveBeenCalledWith({
        where: { id: 226, isActive: true },
        select: { nodePath: true },
      });
      expect(prisma.module.update).toHaveBeenCalledWith({
        where: { id: 300 },
        data: { nodePath: '226.300' },
      });
      expect(result.nodePath).toBe('226.300');
    });

    it('gives a top-level module (no parentId) its own id as the nodePath', async () => {
      prisma.module.create.mockResolvedValue({ id: 301 });
      prisma.module.update.mockResolvedValue({
        id: 301,
        name: 'New Top-Level Tool',
        parentId: null,
        nodePath: '301',
        defaultModule: false,
        displayPriority: null,
        type: null,
      });

      const result = await service.createModule({ name: 'New Top-Level Tool' });

      expect(prisma.module.findFirst).not.toHaveBeenCalled();
      expect(prisma.module.update).toHaveBeenCalledWith({
        where: { id: 301 },
        data: { nodePath: '301' },
      });
      expect(result.nodePath).toBe('301');
    });

    it('rejects an unknown or inactive parent before creating anything', async () => {
      prisma.module.findFirst.mockResolvedValue(null);

      await expect(
        service.createModule({ name: 'Orphan', parentId: 9999 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.module.create).not.toHaveBeenCalled();
    });
  });

  describe('deleteModule — removes the module and its whole branch', () => {
    const CATALOG = [
      { id: 5, parentId: null },
      { id: 11, parentId: 5 },
      { id: 70, parentId: 5 },
      { id: 71, parentId: 70 },
      { id: 72, parentId: 70 },
      { id: 17, parentId: null },
    ];

    it('deletes the target and every descendant, nothing else', async () => {
      prisma.module.findMany.mockResolvedValue(CATALOG);

      const result = await service.deleteModule(70);

      expect(result.deletedIds).toEqual([70, 71, 72]);
      expect(prisma.module.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [70, 71, 72] } },
      });
    });

    it('404s for an unknown module without deleting anything', async () => {
      prisma.module.findMany.mockResolvedValue(CATALOG);

      await expect(service.deleteModule(999)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.module.deleteMany).not.toHaveBeenCalled();
    });

    it('terminates on a cyclic parentId chain', async () => {
      prisma.module.findMany.mockResolvedValue([
        { id: 1, parentId: 2 },
        { id: 2, parentId: 1 },
      ]);

      const result = await service.deleteModule(1);

      expect(result.deletedIds.sort()).toEqual([1, 2]);
    });
  });
});
