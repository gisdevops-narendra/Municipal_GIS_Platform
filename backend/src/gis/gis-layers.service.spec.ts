import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GisLayersService } from './gis-layers.service';
import { PrismaService } from '../prisma/prisma.service';
import { GeoServerService } from './geoserver.service';
import { GisAuthorizationService } from './gis-authorization.service';
import type { AppUser } from '../auth/types/app-user.type';

const OWNER: AppUser = {
  id: 'owner-1',
  keycloakUserId: 'kc-owner',
  municipalityId: 'muni-a',
  departmentId: null,
  systemRole: 'MUNICIPALITY_OWNER',
  status: 'ACTIVE',
};

function appUser(municipalityId: string): AppUser {
  return { ...OWNER, municipalityId };
}

describe('GisLayersService', () => {
  let service: GisLayersService;
  let prisma: {
    gISWorkspace: { findUnique: jest.Mock };
    gISLayer: {
      upsert: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      count: jest.Mock;
      delete: jest.Mock;
    };
    department: { findMany: jest.Mock };
    $executeRawUnsafe: jest.Mock;
  };
  let geoServer: {
    ensureFeatureType: jest.Mock;
    getFeaturesAsGeoJson: jest.Mock;
    deleteFeatureType: jest.Mock;
  };
  let gisAuth: {
    filterViewable: jest.Mock;
    canView: jest.Mock;
    canExport: jest.Mock;
    canManage: jest.Mock;
    listGrants: jest.Mock;
    setGrant: jest.Mock;
  };
  let config: { get: jest.Mock };

  const workspace = {
    id: 'ws-somnath',
    municipalityId: 'muni-somnath',
    geoserverWorkspace: 'somnath_municipality',
    defaultCrs: 'EPSG:32643',
    status: 'ACTIVE',
  };

  beforeEach(() => {
    prisma = {
      gISWorkspace: { findUnique: jest.fn() },
      gISLayer: {
        upsert: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
        delete: jest.fn().mockResolvedValue({}),
      },
      department: { findMany: jest.fn().mockResolvedValue([]) },
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    };
    geoServer = {
      ensureFeatureType: jest
        .fn()
        .mockResolvedValue({ minX: 75.0, minY: 20.8, maxX: 75.1, maxY: 20.9 }),
      getFeaturesAsGeoJson: jest.fn(),
      deleteFeatureType: jest.fn().mockResolvedValue(undefined),
    };
    // Owner-bypass by default: filterViewable/canView etc. are only
    // exercised directly in "permission filtering" below — every other
    // describe block here is about workspace-level tenant isolation, not
    // the Task 8 permission system, so it uses an Owner appUser and a
    // pass-through gisAuth mock to keep that focus unchanged.
    gisAuth = {
      filterViewable: jest.fn((_appUser: AppUser, layers: unknown[]) =>
        Promise.resolve(layers),
      ),
      canView: jest.fn().mockResolvedValue(true),
      canExport: jest.fn().mockResolvedValue(true),
      canManage: jest.fn().mockResolvedValue(true),
      listGrants: jest.fn().mockResolvedValue([]),
      setGrant: jest.fn().mockResolvedValue(undefined),
    };

    // Demo-layer seeding is opt-in via GIS_SEED_DEMO_LAYERS; default the
    // mock to "true" so the seeding tests below exercise the real path.
    config = { get: jest.fn().mockReturnValue('true') };

    service = new GisLayersService(
      prisma as unknown as PrismaService,
      geoServer as unknown as GeoServerService,
      gisAuth as unknown as GisAuthorizationService,
      config as unknown as ConfigService,
    );
  });

  describe('ensureDemoLayers', () => {
    it('does nothing when GIS_SEED_DEMO_LAYERS is not "true"', async () => {
      config.get.mockReturnValue('false');

      await service.ensureDemoLayers(workspace as never);

      expect(geoServer.ensureFeatureType).not.toHaveBeenCalled();
      expect(prisma.gISLayer.upsert).not.toHaveBeenCalled();
    });

    it('publishes all three canonical demo layers, each scoped to this workspace via a CQL filter on gis_workspace_id', async () => {
      prisma.gISLayer.upsert.mockResolvedValue({});

      await service.ensureDemoLayers(workspace as never);

      expect(geoServer.ensureFeatureType).toHaveBeenCalledTimes(3);
      const codes = ['municipal_boundary', 'wards', 'roads'];
      codes.forEach((layerName, index) => {
        expect(geoServer.ensureFeatureType).toHaveBeenNthCalledWith(
          index + 1,
          'somnath_municipality',
          'somnath_municipality_postgis',
          expect.objectContaining({
            name: layerName,
            srs: 'EPSG:32643',
            cqlFilter: "gis_workspace_id = 'ws-somnath'",
          }),
        );
      });
    });

    it('never throws when GeoServer rejects one layer publish — logs and continues with the rest', async () => {
      prisma.gISLayer.upsert.mockResolvedValue({});
      geoServer.ensureFeatureType
        .mockResolvedValueOnce({ minX: 1, minY: 1, maxX: 2, maxY: 2 })
        .mockRejectedValueOnce(new Error('GeoServer rejected the request'))
        .mockResolvedValueOnce({ minX: 1, minY: 1, maxX: 2, maxY: 2 });

      await expect(
        service.ensureDemoLayers(workspace as never),
      ).resolves.toBeUndefined();
      expect(prisma.gISLayer.upsert).toHaveBeenCalledTimes(2);
    });

    it('persists the bounding box returned by GeoServer onto the GISLayer row', async () => {
      prisma.gISLayer.upsert.mockResolvedValue({});

      await service.ensureDemoLayers(workspace as never);

      expect(prisma.gISLayer.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest.Mock's default typing is `any`
          create: expect.objectContaining({
            bboxMinX: 75.0,
            bboxMinY: 20.8,
            bboxMaxX: 75.1,
            bboxMaxY: 20.9,
          }),
        }),
      );
    });
  });

  describe('listForMunicipality (tenant isolation)', () => {
    it('scopes strictly by the workspace belonging to the given municipality', async () => {
      prisma.gISWorkspace.findUnique.mockImplementation(
        ({ where }: { where: { municipalityId: string } }) => {
          const byMunicipality: Record<string, { id: string }> = {
            'muni-a': { id: 'ws-a' },
            'muni-b': { id: 'ws-b' },
          };
          return Promise.resolve(byMunicipality[where.municipalityId] ?? null);
        },
      );
      prisma.gISLayer.findMany.mockImplementation(
        ({ where }: { where: { gisWorkspaceId: string; status: string } }) =>
          Promise.resolve([
            {
              id: `layer-in-${where.gisWorkspaceId}`,
              name: 'X',
              code: 'X',
              description: null,
              layerType: 'VECTOR',
              geoserverWorkspace: 'x',
              geoserverLayer: 'x',
              geometryType: 'POLYGON',
              ownershipType: 'CANONICAL',
              departmentId: null,
              version: 1,
              visibleByDefault: true,
              displayOrder: 1,
              bboxMinX: null,
              bboxMinY: null,
              bboxMaxX: null,
              bboxMaxY: null,
            },
          ]),
      );

      const resultA = await service.listForMunicipality(appUser('muni-a'));
      const resultB = await service.listForMunicipality(appUser('muni-b'));

      expect(resultA[0].id).toBe('layer-in-ws-a');
      expect(resultB[0].id).toBe('layer-in-ws-b');
    });

    it('only ever queries ACTIVE layers', async () => {
      prisma.gISWorkspace.findUnique.mockResolvedValue({ id: 'ws-a' });
      prisma.gISLayer.findMany.mockResolvedValue([]);

      await service.listForMunicipality(appUser('muni-a'));

      expect(prisma.gISLayer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { gisWorkspaceId: 'ws-a', status: 'ACTIVE' },
        }),
      );
    });

    it('404s rather than leaking data when the municipality has no workspace', async () => {
      prisma.gISWorkspace.findUnique.mockResolvedValue(null);

      await expect(
        service.listForMunicipality(appUser('muni-unknown')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('never seeds layers on read — a fresh workspace with no layers returns an empty list', async () => {
      prisma.gISWorkspace.findUnique.mockResolvedValue({
        id: 'ws-fresh',
        geoserverWorkspace: 'fresh_municipality',
        defaultCrs: 'EPSG:32643',
        status: 'ACTIVE',
      });
      prisma.gISLayer.findMany.mockResolvedValue([]);

      const result = await service.listForMunicipality(appUser('muni-fresh'));

      expect(result).toEqual([]);
      expect(geoServer.ensureFeatureType).not.toHaveBeenCalled();
      expect(prisma.gISLayer.upsert).not.toHaveBeenCalled();
    });

    it('delegates permission filtering to GisAuthorizationService.filterViewable (Task 8)', async () => {
      const caller = {
        ...OWNER,
        systemRole: 'DEPARTMENT_USER' as const,
        departmentId: 'dept-roads',
      };
      prisma.gISWorkspace.findUnique.mockResolvedValue({
        id: 'ws-a',
        status: 'ACTIVE',
      });
      const layers = [
        { id: 'layer-1', ownershipType: 'CANONICAL', departmentId: null },
      ];
      prisma.gISLayer.findMany.mockResolvedValue(layers);
      gisAuth.filterViewable.mockResolvedValue([]);

      const result = await service.listForMunicipality(caller);

      expect(gisAuth.filterViewable).toHaveBeenCalledWith(caller, layers);
      expect(result).toEqual([]);
    });
  });

  describe('getById (Task 8 permission-checked)', () => {
    it('404s when the caller lacks VIEW permission — never leaks existence', async () => {
      prisma.gISWorkspace.findUnique.mockResolvedValue({ id: 'ws-a' });
      prisma.gISLayer.findFirst.mockResolvedValue({
        id: 'layer-1',
        ownershipType: 'DEPARTMENT',
        departmentId: 'dept-water',
      });
      gisAuth.canView.mockResolvedValue(false);

      await expect(
        service.getById(appUser('muni-a'), 'layer-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('exportLayer (Task 8 EXPORT permission)', () => {
    it('403s when the caller lacks EXPORT permission', async () => {
      prisma.gISWorkspace.findUnique.mockResolvedValue({ id: 'ws-a' });
      prisma.gISLayer.findFirst.mockResolvedValue({
        id: 'layer-1',
        code: 'ROADS',
        geoserverWorkspace: 'somnath_municipality',
        geoserverLayer: 'roads',
        ownershipType: 'DEPARTMENT',
        departmentId: 'dept-roads',
      });
      gisAuth.canExport.mockResolvedValue(false);

      await expect(
        service.exportLayer(appUser('muni-a'), 'layer-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(geoServer.getFeaturesAsGeoJson).not.toHaveBeenCalled();
    });

    it('fetches GeoJSON from GeoServer server-side when authorized', async () => {
      prisma.gISWorkspace.findUnique.mockResolvedValue({ id: 'ws-a' });
      prisma.gISLayer.findFirst.mockResolvedValue({
        id: 'layer-1',
        code: 'ROADS',
        geoserverWorkspace: 'somnath_municipality',
        geoserverLayer: 'roads',
        ownershipType: 'DEPARTMENT',
        departmentId: 'dept-roads',
      });
      gisAuth.canExport.mockResolvedValue(true);
      geoServer.getFeaturesAsGeoJson.mockResolvedValue(
        '{"type":"FeatureCollection","features":[]}',
      );

      const result = await service.exportLayer(appUser('muni-a'), 'layer-1');

      expect(geoServer.getFeaturesAsGeoJson).toHaveBeenCalledWith(
        'somnath_municipality',
        'roads',
      );
      expect(result.filename).toBe('roads.geojson');
    });
  });

  describe('deleteLayer', () => {
    const uploadedLayer = {
      id: 'layer-1',
      code: 'DRAINAGE',
      geoserverWorkspace: 'somnath_municipality',
      geoserverLayer: 'drainage',
      ownershipType: 'DEPARTMENT',
      departmentId: 'dept-water',
      postgisTable: `layer_${'a'.repeat(32)}`,
    };

    beforeEach(() => {
      prisma.gISWorkspace.findUnique.mockResolvedValue({ id: 'ws-a' });
      prisma.gISLayer.findFirst.mockResolvedValue(uploadedLayer);
    });

    it('403s for a non-owner and touches nothing', async () => {
      const deptHead = { ...OWNER, systemRole: 'DEPARTMENT_HEAD' as const };

      await expect(
        service.deleteLayer(deptHead, 'layer-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(geoServer.deleteFeatureType).not.toHaveBeenCalled();
      expect(prisma.gISLayer.delete).not.toHaveBeenCalled();
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('unpublishes the GeoServer feature type, deletes the row, then drops the layer table', async () => {
      await service.deleteLayer(appUser('muni-a'), 'layer-1');

      expect(geoServer.deleteFeatureType).toHaveBeenCalledWith(
        'somnath_municipality',
        'somnath_municipality_postgis',
        'drainage',
      );
      expect(prisma.gISLayer.delete).toHaveBeenCalledWith({
        where: { id: 'layer-1' },
      });
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
        `DROP TABLE IF EXISTS "layer_${'a'.repeat(32)}"`,
      );
    });

    it('aborts before the DB delete when GeoServer fails — stays retryable', async () => {
      geoServer.deleteFeatureType.mockRejectedValue(new Error('GeoServer down'));

      await expect(
        service.deleteLayer(appUser('muni-a'), 'layer-1'),
      ).rejects.toThrow('GeoServer down');
      expect(prisma.gISLayer.delete).not.toHaveBeenCalled();
    });

    it('never drops a table for a canonical/demo layer (no dedicated postgisTable)', async () => {
      prisma.gISLayer.findFirst.mockResolvedValue({
        ...uploadedLayer,
        ownershipType: 'CANONICAL',
        departmentId: null,
        postgisTable: null,
      });

      await service.deleteLayer(appUser('muni-a'), 'layer-1');

      expect(prisma.gISLayer.delete).toHaveBeenCalled();
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('still resolves when the post-delete table drop fails (best-effort)', async () => {
      prisma.$executeRawUnsafe.mockRejectedValue(new Error('table locked'));

      await expect(
        service.deleteLayer(appUser('muni-a'), 'layer-1'),
      ).resolves.toBeUndefined();
      expect(prisma.gISLayer.delete).toHaveBeenCalled();
    });
  });
});
