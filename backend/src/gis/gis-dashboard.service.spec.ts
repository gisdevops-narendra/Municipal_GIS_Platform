import { GisDashboardService } from './gis-dashboard.service';
import { PrismaService } from '../prisma/prisma.service';
import { GeoServerService } from './geoserver.service';
import { GisAuthorizationService } from './gis-authorization.service';
import { AiClientService } from '../gis-ai/ai-client.service';
import type { AppUser } from '../auth/types/app-user.type';

describe('GisDashboardService', () => {
  let service: GisDashboardService;
  let prisma: {
    department: { findMany: jest.Mock };
    gISWorkspace: { findUnique: jest.Mock };
    gISLayer: { findMany: jest.Mock };
  };
  let gisAuth: { filterViewable: jest.Mock };
  let ai: { searchLayers: jest.Mock };

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
    ai = { searchLayers: jest.fn().mockResolvedValue([]) };
    service = new GisDashboardService(
      prisma as unknown as PrismaService,
      {} as GeoServerService,
      gisAuth as unknown as GisAuthorizationService,
      ai as unknown as AiClientService,
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

  describe('search (semantic layer matches)', () => {
    const layer = (id: string, name: string) => ({
      id,
      name,
      code: name.toUpperCase().replace(/ /g, '_'),
      layerType: 'VECTOR',
      ownershipType: 'DEPARTMENT',
      department: { id: 'dept-own', name: 'Roads' },
      geoserverWorkspace: 'ws',
      geoserverLayer: id,
    });
    const storm = layer('l-storm', 'Storm Water Lines');
    const drains = layer('l-drain', 'Drainage Points');
    const hidden = layer('l-hidden', 'Sewer Mains');

    beforeEach(() => {
      prisma.gISWorkspace.findUnique.mockResolvedValue({ id: 'ws-1' });
      prisma.gISLayer.findMany.mockResolvedValue([storm, drains, hidden]);
      gisAuth.filterViewable.mockResolvedValue([storm, drains]);
      service = new GisDashboardService(
        prisma as unknown as PrismaService,
        {
          getFeaturesAsGeoJson: jest.fn().mockResolvedValue('{"features":[]}'),
        } as unknown as GeoServerService,
        gisAuth as unknown as GisAuthorizationService,
        ai as unknown as AiClientService,
      );
    });

    it('adds viewable semantic hits after name matches, never a layer the caller cannot view', async () => {
      ai.searchLayers.mockResolvedValue([
        { layer_id: 'l-hidden', field: null, title: 'Layer · Sewer Mains', score: 0.9 },
        { layer_id: 'l-storm', field: 'pipe_dia', title: 'Field · Storm Water Lines.pipe_dia', score: 0.8 },
        { layer_id: 'l-drain', field: null, title: 'Layer · Drainage Points', score: 0.75 },
      ]);

      const result = await service.search(head, 'drainage');

      expect(ai.searchLayers).toHaveBeenCalledWith('muni-1', 'drainage');
      expect(result.layers.map((l) => [l.id, l.match])).toEqual([
        ['l-drain', 'name'],
        ['l-storm', 'semantic'],
      ]);
      expect(result.layers[1].matchedField).toBe('pipe_dia');
    });

    it('skips the semantic lookup for very short queries', async () => {
      await service.search(head, 'dr');
      expect(ai.searchLayers).not.toHaveBeenCalled();
    });
  });
});
