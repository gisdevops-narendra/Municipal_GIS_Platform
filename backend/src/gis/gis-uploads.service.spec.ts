import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GisUploadsService } from './gis-uploads.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage.service';
import { GdalService } from './gdal.service';
import { GeoServerService } from './geoserver.service';
import {
  GisAuthorizationService,
  ALL_PERMISSIONS,
} from './gis-authorization.service';
import type { AppUser } from '../auth/types/app-user.type';

const OWNER: AppUser = {
  id: 'owner-1',
  keycloakUserId: 'kc-owner',
  municipalityId: 'muni-a',
  systemRole: 'MUNICIPALITY_OWNER',
  status: 'ACTIVE',
};

/** A disabled account: may not upload (canUpload → false). */
const DISABLED: AppUser = { ...OWNER, id: 'owner-2', status: 'DISABLED' };

function buildService() {
  const prisma = {
    gISWorkspace: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
    gISLayerUpload: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    gISLayer: { findUnique: jest.fn(), aggregate: jest.fn() },
    $transaction: jest.fn(),
    $executeRawUnsafe: jest.fn(),
    $queryRawUnsafe: jest.fn(),
  };
  const storage = {
    saveRawFile: jest.fn(),
    rawDir: jest.fn(),
    extractZipSafely: jest.fn(),
    cleanupTemporary: jest.fn(),
  };
  const gdal = { inspect: jest.fn(), importToPostgis: jest.fn() };
  const geoServer = {
    ensureFeatureType: jest.fn(),
    deleteFeatureType: jest.fn(),
    deleteStyle: jest.fn().mockResolvedValue(undefined),
  };
  const styleService = { applyStyle: jest.fn(), removeStyle: jest.fn() };
  const fieldStats = { attributes: jest.fn(), fieldStats: jest.fn() };
  const config = { getOrThrow: jest.fn((k: string) => `cfg-${k}`) };
  // Defaults to "fully allowed" so every pre-existing (pre-Task-8) test
  // keeps exercising the behavior it was written for, not permission
  // denial — tests that specifically care about permission outcomes
  // override these per-case.
  const gisAuth = {
    canUpload: jest.fn().mockResolvedValue(true),
    getPermissions: jest.fn().mockResolvedValue(new Set(ALL_PERMISSIONS)),
    getDefaultPermissions: jest.fn().mockReturnValue(new Set(ALL_PERMISSIONS)),
  };

  const service = new GisUploadsService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    gdal as unknown as GdalService,
    geoServer as unknown as GeoServerService,
    config as unknown as ConfigService,
    gisAuth as unknown as GisAuthorizationService,
    styleService as never,
    fieldStats as never,
  );

  return { service, prisma, storage, gdal, geoServer, gisAuth, styleService };
}

describe('GisUploadsService — authorization', () => {
  describe('create() upload rules', () => {
    it('rejects an upload from an account without upload permission', async () => {
      const { service, prisma, gisAuth } = buildService();
      gisAuth.canUpload.mockResolvedValue(false);
      prisma.gISWorkspace.findUnique.mockResolvedValue({
        id: 'ws-a',
        status: 'ACTIVE',
        defaultCrs: 'EPSG:32643',
      });

      await expect(
        service.create(
          DISABLED,
          { layerName: 'Boundary', ownershipType: 'CANONICAL' } as never,
          {
            originalname: 'a.geojson',
            size: 10,
            buffer: Buffer.from('{}'),
          } as never,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows the owner to create a CANONICAL layer', async () => {
      const { service, prisma, storage } = buildService();
      prisma.gISWorkspace.findUnique.mockResolvedValue({
        id: 'ws-a',
        status: 'ACTIVE',
        defaultCrs: 'EPSG:32643',
      });
      prisma.gISLayerUpload.create.mockResolvedValue({ id: 'up-1' });
      storage.saveRawFile.mockResolvedValue({ storedFilename: 'x.geojson' });
      prisma.gISLayerUpload.update.mockResolvedValue({});
      prisma.gISLayerUpload.findUniqueOrThrow.mockResolvedValue({
        id: 'up-1',
        status: 'FAILED',
        municipalityId: 'muni-a',
        storedFilename: 'x.geojson',
        fileFormat: 'GEOJSON',
      });
      storage.rawDir.mockReturnValue('/tmp/raw');

      await expect(
        service.create(
          OWNER,
          {
            layerName: 'Municipality Boundary',
            ownershipType: 'CANONICAL',
          } as never,
          {
            originalname: 'a.geojson',
            size: 10,
            buffer: Buffer.from('{}'),
          } as never,
        ),
      ).resolves.toBeDefined();

    });

    it('rejects CSV X/Y columns with no sourceCrs before ever touching GDAL', async () => {
      const { service, prisma, gdal } = buildService();
      prisma.gISWorkspace.findUnique.mockResolvedValue({
        id: 'ws-a',
        status: 'ACTIVE',
        defaultCrs: 'EPSG:32643',
      });

      await expect(
        service.create(
          OWNER,
          {
            layerName: 'Assets',
            xField: 'x',
            yField: 'y',
          } as never,
          {
            originalname: 'a.csv',
            size: 10,
            buffer: Buffer.from('x,y\n1,2'),
          } as never,
        ),
      ).rejects.toThrow('sourceCrs is required');
      expect(gdal.inspect).not.toHaveBeenCalled();
    });
  });

  describe('tenant/visibility scoping (findScoped, via getById)', () => {
    it('404s for an upload belonging to another municipality — never leaks existence', async () => {
      const { service, prisma } = buildService();
      prisma.gISLayerUpload.findFirst.mockResolvedValue(null);

      await expect(
        service.getById('up-in-muni-b', OWNER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.gISLayerUpload.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'up-in-muni-b', municipalityId: 'muni-a' },
        }),
      );
    });

    it("shows any upload of the caller's own account, whoever uploaded it", async () => {
      const { service, prisma } = buildService();
      prisma.gISLayerUpload.findFirst.mockResolvedValue({
        id: 'up-1',
        uploadedById: 'someone-else',
      });

      await expect(service.getById('up-1', OWNER)).resolves.toBeDefined();
    });
  });

  describe('publish() version-replacement decision', () => {
    it('deletes the old feature type before publishing a new version, and drops the old dedicated table afterward', async () => {
      const { service, prisma, geoServer } = buildService();
      prisma.gISLayerUpload.findFirst.mockResolvedValue({
        id: 'up-2',
        municipalityId: 'muni-a',
        uploadedById: OWNER.id,
        status: 'APPROVED',
        postgisTable: 'layer_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
        layerCode: 'ROADS',
        layerName: 'Roads',
        targetCrs: 'EPSG:32643',
        gisWorkspaceId: 'ws-a',
      });
      prisma.gISWorkspace.findUniqueOrThrow.mockResolvedValue({
        id: 'ws-a',
        geoserverWorkspace: 'somnath_municipality',
        defaultCrs: 'EPSG:32643',
      });
      prisma.gISLayer.findUnique.mockResolvedValue({
        id: 'layer-1',
        geoserverLayer: 'roads',
        postgisTable: 'layer_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
      });
      geoServer.ensureFeatureType.mockResolvedValue({
        minX: 0,
        minY: 0,
        maxX: 1,
        maxY: 1,
      });
      geoServer.deleteFeatureType.mockResolvedValue(undefined);
      prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({
          gISLayer: {
            update: jest.fn().mockResolvedValue({ id: 'layer-1' }),
          },
          gISLayerUpload: { update: jest.fn().mockResolvedValue({}) },
        }),
      );
      prisma.gISLayerUpload.findUniqueOrThrow.mockResolvedValue({
        id: 'up-2',
        status: 'PUBLISHED',
      });
      prisma.$executeRawUnsafe.mockResolvedValue(undefined);

      await service.publish('up-2', OWNER);

      // Old feature type torn down BEFORE the replacement publish call.
      const deleteCallOrder =
        geoServer.deleteFeatureType.mock.invocationCallOrder[0];
      const ensureCallOrder =
        geoServer.ensureFeatureType.mock.invocationCallOrder[0];
      expect(deleteCallOrder).toBeLessThan(ensureCallOrder);
      expect(geoServer.deleteFeatureType).toHaveBeenCalledWith(
        'somnath_municipality',
        'somnath_municipality_postgis',
        'roads',
      );
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining(
          'DROP TABLE IF EXISTS "layer_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"',
        ),
      );
    });

    it('never drops a shared demo table (null postgisTable) when replacing a canonical layer', async () => {
      const { service, prisma, geoServer } = buildService();
      prisma.gISLayerUpload.findFirst.mockResolvedValue({
        id: 'up-3',
        municipalityId: 'muni-a',
        uploadedById: OWNER.id,
        status: 'APPROVED',
        postgisTable: 'layer_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
        layerCode: 'ROADS',
        layerName: 'Roads',
        targetCrs: 'EPSG:32643',
        gisWorkspaceId: 'ws-a',
      });
      prisma.gISWorkspace.findUniqueOrThrow.mockResolvedValue({
        id: 'ws-a',
        geoserverWorkspace: 'somnath_municipality',
        defaultCrs: 'EPSG:32643',
      });
      prisma.gISLayer.findUnique.mockResolvedValue({
        id: 'layer-1',
        geoserverLayer: 'roads',
        postgisTable: null, // Task 6 demo layer — shared gis_demo_roads table
      });
      geoServer.ensureFeatureType.mockResolvedValue(null);
      geoServer.deleteFeatureType.mockResolvedValue(undefined);
      prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({
          gISLayer: {
            update: jest.fn().mockResolvedValue({ id: 'layer-1' }),
          },
          gISLayerUpload: { update: jest.fn().mockResolvedValue({}) },
        }),
      );
      prisma.gISLayerUpload.findUniqueOrThrow.mockResolvedValue({
        id: 'up-3',
        status: 'PUBLISHED',
      });

      await service.publish('up-3', OWNER);

      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalledWith(
        expect.stringContaining('DROP TABLE'),
      );
    });

    it('marks PUBLISH_FAILED (never PUBLISHED) when GeoServer publishing fails', async () => {
      const { service, prisma, geoServer } = buildService();
      prisma.gISLayerUpload.findFirst.mockResolvedValue({
        id: 'up-4',
        municipalityId: 'muni-a',
        uploadedById: OWNER.id,
        status: 'APPROVED',
        postgisTable: 'layer_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
        layerCode: 'ROADS',
        layerName: 'Roads',
        targetCrs: 'EPSG:32643',
        gisWorkspaceId: 'ws-a',
      });
      prisma.gISWorkspace.findUniqueOrThrow.mockResolvedValue({
        id: 'ws-a',
        geoserverWorkspace: 'somnath_municipality',
        defaultCrs: 'EPSG:32643',
      });
      prisma.gISLayer.findUnique.mockResolvedValue(null);
      geoServer.ensureFeatureType.mockRejectedValue(
        new Error('GeoServer is unavailable'),
      );
      prisma.gISLayerUpload.update.mockResolvedValue({});

      await expect(service.publish('up-4', OWNER)).rejects.toThrow(
        'GeoServer is unavailable',
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.gISLayerUpload.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'up-4' },
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest.Mock's default typing is `any`
          data: expect.objectContaining({ status: 'PUBLISH_FAILED' }),
        }),
      );
    });
  });
});
