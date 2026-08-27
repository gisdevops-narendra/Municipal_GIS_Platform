import { NotFoundException } from '@nestjs/common';
import { GisWorkspaceService } from './gis-workspace.service';
import { PrismaService } from '../prisma/prisma.service';
import { GeoServerService } from './geoserver.service';
import { GisLayersService } from './gis-layers.service';
import { ConfigService } from '@nestjs/config';

describe('GisWorkspaceService', () => {
  let service: GisWorkspaceService;
  let prisma: {
    gISWorkspace: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    municipality: { findUniqueOrThrow: jest.Mock };
  };
  let geoServer: {
    ensureWorkspace: jest.Mock;
    ensurePostgisDatastore: jest.Mock;
    checkDatastoreConnection: jest.Mock;
    checkHealth: jest.Mock;
  };
  let config: { getOrThrow: jest.Mock; get: jest.Mock };
  let gisLayers: { ensureDemoLayers: jest.Mock };

  const baseWorkspace = {
    id: 'ws-1',
    municipalityId: 'muni-a',
    name: 'Somnath Municipality GIS',
    code: 'SOMNATH_MUNICIPALITY_GIS',
    description: null,
    status: 'PROVISIONING',
    defaultCrs: 'EPSG:32643',
    displayCrs: 'EPSG:4326',
    geoserverWorkspace: 'somnath_municipality',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    prisma = {
      gISWorkspace: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      municipality: { findUniqueOrThrow: jest.fn() },
    };
    geoServer = {
      ensureWorkspace: jest.fn().mockResolvedValue(undefined),
      ensurePostgisDatastore: jest.fn().mockResolvedValue(undefined),
      checkDatastoreConnection: jest.fn().mockResolvedValue(true),
      checkHealth: jest.fn(),
    };
    config = {
      getOrThrow: jest.fn((key: string) => `test-${key}`),
      get: jest.fn(),
    };
    gisLayers = { ensureDemoLayers: jest.fn().mockResolvedValue(undefined) };

    service = new GisWorkspaceService(
      prisma as unknown as PrismaService,
      geoServer as unknown as GeoServerService,
      config as unknown as ConfigService,
      gisLayers as unknown as GisLayersService,
    );
  });

  describe('tenant isolation', () => {
    it('getForMunicipality scopes strictly by the given municipalityId and never another', async () => {
      prisma.gISWorkspace.findUnique.mockImplementation(
        ({ where }: { where: { municipalityId: string } }) => {
          const byMunicipality: Record<string, typeof baseWorkspace> = {
            'muni-a': {
              ...baseWorkspace,
              id: 'ws-a',
              municipalityId: 'muni-a',
              geoserverWorkspace: 'somnath',
              status: 'ACTIVE',
            },
            'muni-b': {
              ...baseWorkspace,
              id: 'ws-b',
              municipalityId: 'muni-b',
              geoserverWorkspace: 'veraval',
              status: 'ACTIVE',
            },
          };
          return Promise.resolve(byMunicipality[where.municipalityId] ?? null);
        },
      );

      const resultA = await service.getForMunicipality('muni-a');
      const resultB = await service.getForMunicipality('muni-b');

      expect(resultA.geoserverWorkspace).toBe('somnath');
      expect(resultB.geoserverWorkspace).toBe('veraval');
    });

    it('backfills a workspace row for a municipality registered before Task 5, scoped to that municipality only', async () => {
      prisma.gISWorkspace.findUnique.mockResolvedValue(null);
      prisma.municipality.findUniqueOrThrow.mockResolvedValue({
        id: 'muni-legacy',
        name: 'Legacy Municipality',
      });
      prisma.gISWorkspace.create.mockResolvedValue({
        ...baseWorkspace,
        id: 'ws-legacy',
        municipalityId: 'muni-legacy',
      });
      prisma.gISWorkspace.findUniqueOrThrow.mockResolvedValue({
        ...baseWorkspace,
        id: 'ws-legacy',
        municipalityId: 'muni-legacy',
      });
      prisma.gISWorkspace.update.mockResolvedValue({
        ...baseWorkspace,
        id: 'ws-legacy',
        municipalityId: 'muni-legacy',
        status: 'ACTIVE',
      });

      const result = await service.getForMunicipality('muni-legacy');

      expect(prisma.gISWorkspace.create).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest.Mock's default typing is `any`
          data: expect.objectContaining({ municipalityId: 'muni-legacy' }),
        }),
      );
      expect(result.status).toBe('ACTIVE');
      expect(geoServer.ensureWorkspace).toHaveBeenCalled();
    });
  });

  describe('provisionWorkspace', () => {
    it('marks the workspace ACTIVE when GeoServer provisioning succeeds', async () => {
      prisma.gISWorkspace.findUniqueOrThrow.mockResolvedValue(baseWorkspace);
      prisma.gISWorkspace.update.mockResolvedValue({
        ...baseWorkspace,
        status: 'ACTIVE',
      });

      const result = await service.provisionWorkspace('ws-1');

      expect(geoServer.ensureWorkspace).toHaveBeenCalledWith(
        'somnath_municipality',
      );
      expect(geoServer.ensurePostgisDatastore).toHaveBeenCalledWith(
        'somnath_municipality',
        'somnath_municipality_postgis',
        expect.objectContaining({ host: 'test-POSTGIS_HOST' }),
      );
      expect(prisma.gISWorkspace.update).toHaveBeenCalledWith({
        where: { id: 'ws-1' },
        data: { status: 'ACTIVE' },
      });
      expect(result.status).toBe('ACTIVE');
      expect(gisLayers.ensureDemoLayers).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ws-1', status: 'ACTIVE' }),
      );
    });

    it('marks the workspace PROVISIONING_FAILED instead of throwing when GeoServer is unreachable, and never attempts demo layers', async () => {
      prisma.gISWorkspace.findUniqueOrThrow.mockResolvedValue(baseWorkspace);
      geoServer.ensureWorkspace.mockRejectedValue(
        new Error('GeoServer is unavailable'),
      );
      prisma.gISWorkspace.update.mockResolvedValue({
        ...baseWorkspace,
        status: 'PROVISIONING_FAILED',
      });

      const result = await service.provisionWorkspace('ws-1');

      expect(prisma.gISWorkspace.update).toHaveBeenCalledWith({
        where: { id: 'ws-1' },
        data: { status: 'PROVISIONING_FAILED' },
      });
      expect(result.status).toBe('PROVISIONING_FAILED');
      expect(gisLayers.ensureDemoLayers).not.toHaveBeenCalled();
    });

    it('marks PROVISIONING_FAILED when the datastore connection check fails, even though workspace/datastore creation succeeded', async () => {
      prisma.gISWorkspace.findUniqueOrThrow.mockResolvedValue(baseWorkspace);
      geoServer.checkDatastoreConnection.mockResolvedValue(false);
      prisma.gISWorkspace.update.mockResolvedValue({
        ...baseWorkspace,
        status: 'PROVISIONING_FAILED',
      });

      await service.provisionWorkspace('ws-1');

      expect(prisma.gISWorkspace.update).toHaveBeenCalledWith({
        where: { id: 'ws-1' },
        data: { status: 'PROVISIONING_FAILED' },
      });
    });
  });

  describe('update (owner-editable fields only)', () => {
    it('only writes name/description/defaultCrs/displayCrs — never municipalityId/geoserverWorkspace/code', async () => {
      prisma.gISWorkspace.findUnique.mockResolvedValue(baseWorkspace);
      prisma.gISWorkspace.update.mockResolvedValue({
        ...baseWorkspace,
        name: 'New Name',
      });

      await service.update(
        'muni-a',
        { name: 'New Name', defaultCrs: 'EPSG:32644' },
        'owner-1',
      );

      expect(prisma.gISWorkspace.update).toHaveBeenCalledWith({
        where: { id: 'ws-1' },
        data: {
          name: 'New Name',
          defaultCrs: 'EPSG:32644',
          updatedById: 'owner-1',
        },
      });
    });

    it('404s rather than creating a workspace when none exists for this municipality', async () => {
      prisma.gISWorkspace.findUnique.mockResolvedValue(null);

      await expect(
        service.update('muni-a', { name: 'X' }, 'owner-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.gISWorkspace.update).not.toHaveBeenCalled();
    });
  });

  describe('geoserverWorkspace uniqueness', () => {
    it('appends a numeric suffix when the base slug is already taken', async () => {
      const tx = {
        gISWorkspace: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce({ id: 'existing' }) // "somnath_municipality" taken
            .mockResolvedValueOnce(null), // "somnath_municipality_2" free
          create: jest.fn().mockResolvedValue(baseWorkspace),
        },
      };

      await service.createWorkspaceRecord(
        tx as never,
        'muni-a',
        'Somnath Municipality',
        'owner-1',
      );

      expect(tx.gISWorkspace.create).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest.Mock's default typing is `any`
          data: expect.objectContaining({
            geoserverWorkspace: 'somnath_municipality_2',
          }),
        }),
      );
    });
  });
});
