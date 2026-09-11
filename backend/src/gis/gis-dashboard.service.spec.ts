import { GisDashboardService } from './gis-dashboard.service';
import { PrismaService } from '../prisma/prisma.service';
import { GeoServerService } from './geoserver.service';
import { GisAuthorizationService } from './gis-authorization.service';
import type { AppUser } from '../auth/types/app-user.type';

describe('GisDashboardService', () => {
  let service: GisDashboardService;
  let prisma: {
    department: { findMany: jest.Mock };
    gISWorkspace: { findUnique: jest.Mock };
    gISLayer: { findMany: jest.Mock };
  };
  let gisAuth: { filterViewable: jest.Mock };

  const owner: AppUser = {
    id: 'owner-1',
    keycloakUserId: 'kc-owner-1',
    municipalityId: 'muni-1',
    departmentId: null,
    systemRole: 'MUNICIPALITY_OWNER',
    status: 'ACTIVE',
  };

  const head: AppUser = {
    id: 'head-1',
    keycloakUserId: 'kc-head-1',
    municipalityId: 'muni-1',
    departmentId: 'dept-own',
    systemRole: 'DEPARTMENT_HEAD',
    status: 'ACTIVE',
  };

  beforeEach(() => {
    prisma = {
      department: { findMany: jest.fn() },
      gISWorkspace: { findUnique: jest.fn() },
      gISLayer: { findMany: jest.fn() },
    };
    gisAuth = { filterViewable: jest.fn().mockResolvedValue([]) };
    service = new GisDashboardService(
      prisma as unknown as PrismaService,
      {} as GeoServerService,
      gisAuth as unknown as GisAuthorizationService,
    );
  });

  describe('getDepartmentSummary (department-scoped access)', () => {
    it('queries every active department for a MUNICIPALITY_OWNER', async () => {
      prisma.department.findMany.mockResolvedValue([]);
      prisma.gISWorkspace.findUnique.mockResolvedValue(null);

      await service.getDepartmentSummary(owner);

      expect(prisma.department.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { municipalityId: 'muni-1', status: 'ACTIVE' },
        }),
      );
    });

    it('scopes the query to only the caller own department for a DEPARTMENT_HEAD', async () => {
      prisma.department.findMany.mockResolvedValue([
        { id: 'dept-own', name: 'Roads' },
      ]);
      prisma.gISWorkspace.findUnique.mockResolvedValue(null);

      const result = await service.getDepartmentSummary(head);

      expect(prisma.department.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            municipalityId: 'muni-1',
            status: 'ACTIVE',
            id: 'dept-own',
          },
        }),
      );
      expect(result).toEqual([
        { departmentId: 'dept-own', departmentName: 'Roads', layerCount: 0 },
      ]);
    });

    it('returns an empty array without querying when the caller has no department', async () => {
      const result = await service.getDepartmentSummary({
        ...head,
        departmentId: null,
      });

      expect(result).toEqual([]);
      expect(prisma.department.findMany).not.toHaveBeenCalled();
    });
  });
});
