import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  ALL_PERMISSIONS,
  GisAuthorizationService,
} from './gis-authorization.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';

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

const WATER_USER: AppUser = {
  id: 'user-2',
  keycloakUserId: 'kc-user-2',
  municipalityId: 'muni-a',
  departmentId: 'dept-water',
  systemRole: 'DEPARTMENT_USER',
  status: 'ACTIVE',
};

const CANONICAL_LAYER = {
  id: 'layer-boundary',
  ownershipType: 'CANONICAL' as const,
  departmentId: null,
};
const ROADS_LAYER = {
  id: 'layer-roads',
  ownershipType: 'DEPARTMENT' as const,
  departmentId: 'dept-roads',
};
const WATER_LAYER = {
  id: 'layer-water',
  ownershipType: 'DEPARTMENT' as const,
  departmentId: 'dept-water',
};

function buildService() {
  const prisma = {
    gISLayerPermission: {
      findMany: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const service = new GisAuthorizationService(
    prisma as unknown as PrismaService,
  );
  return { service, prisma };
}

describe('GisAuthorizationService', () => {
  describe('getPermissions — real grants for an existing layer', () => {
    it('gives the Owner every permission on every layer, unconditionally, without a DB lookup', async () => {
      const { service, prisma } = buildService();
      const permissions = await service.getPermissions(OWNER, ROADS_LAYER);
      expect(permissions).toEqual(new Set(ALL_PERMISSIONS));
      expect(prisma.gISLayerPermission.findMany).not.toHaveBeenCalled();
    });

    it('gives any municipality member VIEW-only on a CANONICAL layer, without a DB lookup', async () => {
      const { service, prisma } = buildService();
      const permissions = await service.getPermissions(
        ROADS_USER,
        CANONICAL_LAYER,
      );
      expect(permissions).toEqual(new Set(['VIEW']));
      expect(prisma.gISLayerPermission.findMany).not.toHaveBeenCalled();
    });

    it('gives VIEW-only on a DEPARTMENT layer to a Head with no department, without a DB lookup', async () => {
      const { service, prisma } = buildService();
      const noDept: AppUser = { ...ROADS_HEAD, departmentId: null };
      const permissions = await service.getPermissions(noDept, ROADS_LAYER);
      expect(permissions).toEqual(new Set(['VIEW']));
      expect(prisma.gISLayerPermission.findMany).not.toHaveBeenCalled();
    });

    it("reflects exactly the grant rows for the caller's own (role, department)", async () => {
      const { service, prisma } = buildService();
      prisma.gISLayerPermission.findMany.mockResolvedValue([
        { permission: 'VIEW' },
        { permission: 'UPLOAD' },
        { permission: 'APPROVE' },
      ]);

      const permissions = await service.getPermissions(ROADS_HEAD, ROADS_LAYER);

      expect(prisma.gISLayerPermission.findMany).toHaveBeenCalledWith({
        where: {
          gisLayerId: 'layer-roads',
          departmentId: 'dept-roads',
          role: 'DEPARTMENT_HEAD',
        },
        select: { permission: true },
      });
      expect(permissions).toEqual(new Set(['VIEW', 'UPLOAD', 'APPROVE']));
    });

    it('gives a Department User VIEW-only on every layer — own or other department — ignoring grant rows', async () => {
      const { service, prisma } = buildService();
      prisma.gISLayerPermission.findMany.mockResolvedValue([
        { permission: 'UPLOAD' },
        { permission: 'MANAGE' },
      ]);

      for (const layer of [ROADS_LAYER, WATER_LAYER]) {
        expect(await service.getPermissions(ROADS_USER, layer)).toEqual(
          new Set(['VIEW']),
        );
      }
      expect(prisma.gISLayerPermission.findMany).not.toHaveBeenCalled();
    });

    it("gives a Department Head VIEW on another department's layer even with no grant rows", async () => {
      const { service, prisma } = buildService();
      prisma.gISLayerPermission.findMany.mockResolvedValue([]);

      const permissions = await service.getPermissions(ROADS_HEAD, WATER_LAYER);

      expect(permissions).toEqual(new Set(['VIEW']));
    });

    it('adds a cross-department grant on top of VIEW — Roads Head granted EXPORT on the Water layer', async () => {
      const { service, prisma } = buildService();
      prisma.gISLayerPermission.findMany.mockResolvedValue([
        { permission: 'EXPORT' },
      ]);

      const permissions = await service.getPermissions(ROADS_HEAD, WATER_LAYER);

      expect(prisma.gISLayerPermission.findMany).toHaveBeenCalledWith({
        where: {
          gisLayerId: 'layer-water',
          departmentId: 'dept-roads',
          role: 'DEPARTMENT_HEAD',
        },
        select: { permission: true },
      });
      expect(permissions).toEqual(new Set(['VIEW', 'EXPORT']));
    });

    it('canView/canUpload/... each reduce to a single has() check on the same permission set', async () => {
      const { service, prisma } = buildService();
      prisma.gISLayerPermission.findMany.mockResolvedValue([
        { permission: 'VIEW' },
      ]);

      expect(await service.canView(WATER_USER, WATER_LAYER)).toBe(true);
      expect(await service.canUpload(WATER_USER, WATER_LAYER)).toBe(false);
      expect(await service.canApprove(WATER_USER, WATER_LAYER)).toBe(false);
      expect(await service.canPublish(WATER_USER, WATER_LAYER)).toBe(false);
      expect(await service.canExport(WATER_USER, WATER_LAYER)).toBe(false);
      expect(await service.canManage(WATER_USER, WATER_LAYER)).toBe(false);
    });
  });

  describe('getDefaultPermissions — virtual defaults for a layer that does not exist yet', () => {
    it('gives the Owner every permission', () => {
      const { service } = buildService();
      expect(
        service.getDefaultPermissions(OWNER, 'DEPARTMENT', 'dept-roads'),
      ).toEqual(new Set(ALL_PERMISSIONS));
    });

    it('gives a Department Head every permission for their own department — upload, approve, publish, export, manage', () => {
      const { service } = buildService();
      expect(
        service.getDefaultPermissions(ROADS_HEAD, 'DEPARTMENT', 'dept-roads'),
      ).toEqual(
        new Set(['VIEW', 'UPLOAD', 'APPROVE', 'PUBLISH', 'EXPORT', 'MANAGE']),
      );
    });

    it('gives a Department User VIEW only (never UPLOAD) for their own department', () => {
      const { service } = buildService();
      expect(
        service.getDefaultPermissions(ROADS_USER, 'DEPARTMENT', 'dept-roads'),
      ).toEqual(new Set(['VIEW']));
    });

    it('gives nothing for a different department — no default cross-department access', () => {
      const { service } = buildService();
      expect(
        service.getDefaultPermissions(ROADS_USER, 'DEPARTMENT', 'dept-water')
          .size,
      ).toBe(0);
    });

    it('gives nothing for a CANONICAL layer to a non-owner', () => {
      const { service } = buildService();
      expect(
        service.getDefaultPermissions(ROADS_HEAD, 'CANONICAL', null).size,
      ).toBe(0);
    });
  });

  describe('filterViewable — bulk VIEW filter (Task 8 §8)', () => {
    it('returns every layer unfiltered for the Owner, without a DB lookup', async () => {
      const { service, prisma } = buildService();
      const layers = [CANONICAL_LAYER, ROADS_LAYER, WATER_LAYER];
      const result = await service.filterViewable(OWNER, layers);
      expect(result).toBe(layers);
      expect(prisma.gISLayerPermission.findMany).not.toHaveBeenCalled();
    });

    it('returns every municipal layer to a Department User or Head — all departments plus canonical — without a DB lookup', async () => {
      const { service, prisma } = buildService();
      const layers = [CANONICAL_LAYER, ROADS_LAYER, WATER_LAYER];

      for (const appUser of [ROADS_USER, ROADS_HEAD]) {
        expect(await service.filterViewable(appUser, layers)).toEqual(layers);
      }
      expect(prisma.gISLayerPermission.findMany).not.toHaveBeenCalled();
    });
  });

  describe('ensureDefaultPermissions', () => {
    it('upserts exactly the 7 default rows (6 for Head, VIEW for User)', async () => {
      const { service, prisma } = buildService();
      prisma.gISLayerPermission.upsert.mockResolvedValue({});

      await service.ensureDefaultPermissions('layer-roads', 'dept-roads');

      expect(prisma.gISLayerPermission.upsert).toHaveBeenCalledTimes(7);
      const calledWith = prisma.gISLayerPermission.upsert.mock.calls.map(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access -- jest.Mock's default typing is `any`
        (call) => call[0].create,
      );
      expect(calledWith).toEqual(
        expect.arrayContaining([
          {
            gisLayerId: 'layer-roads',
            departmentId: 'dept-roads',
            role: 'DEPARTMENT_HEAD',
            permission: 'PUBLISH',
          },
          {
            gisLayerId: 'layer-roads',
            departmentId: 'dept-roads',
            role: 'DEPARTMENT_USER',
            permission: 'VIEW',
          },
        ]),
      );
      expect(calledWith).not.toContainEqual(
        expect.objectContaining({
          role: 'DEPARTMENT_USER',
          permission: 'UPLOAD',
        }),
      );
    });

    it('never overwrites an existing row (upsert update is a no-op)', async () => {
      const { service, prisma } = buildService();
      prisma.gISLayerPermission.upsert.mockResolvedValue({});

      await service.ensureDefaultPermissions('layer-roads', 'dept-roads');

      for (const call of prisma.gISLayerPermission.upsert.mock.calls) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- jest.Mock's default typing is `any`
        const arg = call[0];
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- jest.Mock's default typing is `any`
        expect(arg.update).toEqual({});
      }
    });
  });

  describe('setGrant — Owner-configurable permissions (Task 8 §7)', () => {
    it('refuses to let an actor change the row governing their own (role, department) pair', async () => {
      const { service, prisma } = buildService();

      await expect(
        service.setGrant(
          ROADS_HEAD,
          'layer-roads',
          'dept-roads',
          'DEPARTMENT_HEAD',
          'PUBLISH',
          true,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.gISLayerPermission.upsert).not.toHaveBeenCalled();
      expect(prisma.gISLayerPermission.deleteMany).not.toHaveBeenCalled();
    });

    it('allows the Owner (a different role entirely) to grant a Department Head PUBLISH', async () => {
      const { service, prisma } = buildService();
      prisma.gISLayerPermission.upsert.mockResolvedValue({});

      await service.setGrant(
        OWNER,
        'layer-roads',
        'dept-roads',
        'DEPARTMENT_HEAD',
        'PUBLISH',
        true,
      );

      expect(prisma.gISLayerPermission.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            gisLayerId_departmentId_role_permission: {
              gisLayerId: 'layer-roads',
              departmentId: 'dept-roads',
              role: 'DEPARTMENT_HEAD',
              permission: 'PUBLISH',
            },
          },
        }),
      );
    });

    it('revokes a permission by deleting the row when granted=false', async () => {
      const { service, prisma } = buildService();
      prisma.gISLayerPermission.deleteMany.mockResolvedValue({ count: 1 });

      await service.setGrant(
        OWNER,
        'layer-roads',
        'dept-roads',
        'DEPARTMENT_USER',
        'UPLOAD',
        false,
      );

      expect(prisma.gISLayerPermission.deleteMany).toHaveBeenCalledWith({
        where: {
          gisLayerId: 'layer-roads',
          departmentId: 'dept-roads',
          role: 'DEPARTMENT_USER',
          permission: 'UPLOAD',
        },
      });
      expect(prisma.gISLayerPermission.upsert).not.toHaveBeenCalled();
    });

    it('refuses to grant a Department User anything beyond VIEW', async () => {
      const { service, prisma } = buildService();

      await expect(
        service.setGrant(
          OWNER,
          'layer-roads',
          'dept-roads',
          'DEPARTMENT_USER',
          'UPLOAD',
          true,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.gISLayerPermission.upsert).not.toHaveBeenCalled();
    });

    it('the self-grant guard only blocks the exact (role, department) pair — a Head may still grant a DIFFERENT role in their own department', async () => {
      const { service, prisma } = buildService();
      prisma.gISLayerPermission.upsert.mockResolvedValue({});

      // ROADS_HEAD is DEPARTMENT_HEAD in dept-roads; this grants
      // DEPARTMENT_USER (a different role) in that same department, which
      // is not "granting themselves" anything.
      await expect(
        service.setGrant(
          ROADS_HEAD,
          'layer-water',
          'dept-roads',
          'DEPARTMENT_USER',
          'VIEW',
          true,
        ),
      ).resolves.toBeUndefined();
      expect(prisma.gISLayerPermission.upsert).toHaveBeenCalled();
    });
  });
});
