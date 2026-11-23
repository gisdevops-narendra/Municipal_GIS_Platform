import { GisDashboardService } from './gis-dashboard.service';
import { PrismaService } from '../prisma/prisma.service';
import { GisAuthorizationService } from './gis-authorization.service';
import { AiClientService } from '../gis-ai/ai-client.service';
import { FuzzySearchService } from './fuzzy-search.service';
import type { AppUser } from '../auth/types/app-user.type';

describe('GisDashboardService', () => {
  let service: GisDashboardService;
  let prisma: {
    gISWorkspace: { findUnique: jest.Mock };
    gISLayer: { findMany: jest.Mock };
  };
  let gisAuth: { filterViewable: jest.Mock };
  let ai: { searchLayers: jest.Mock };
  const fuzzy = { search: jest.fn().mockResolvedValue([]) } as unknown as FuzzySearchService;

  const owner: AppUser = {
    id: 'owner-1',
    keycloakUserId: 'kc-owner-1',
    municipalityId: 'muni-1',
    systemRole: 'MUNICIPALITY_OWNER',
    status: 'ACTIVE',
  };


  beforeEach(() => {
    prisma = {
      gISWorkspace: { findUnique: jest.fn() },
      gISLayer: { findMany: jest.fn() },
    };
    gisAuth = { filterViewable: jest.fn().mockResolvedValue([]) };
    ai = { searchLayers: jest.fn().mockResolvedValue([]) };
    service = new GisDashboardService(
      prisma as unknown as PrismaService,
      gisAuth as unknown as GisAuthorizationService,
      ai as unknown as AiClientService,
      fuzzy,
    );
  });

  describe('search (semantic layer matches)', () => {
    const layer = (id: string, name: string) => ({
      id,
      name,
      code: name.toUpperCase().replace(/ /g, '_'),
      layerType: 'VECTOR',
      ownershipType: 'CANONICAL',
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
        gisAuth as unknown as GisAuthorizationService,
        ai as unknown as AiClientService,
        fuzzy,
      );
    });

    it('adds viewable semantic hits after name matches, never a layer the caller cannot view', async () => {
      ai.searchLayers.mockResolvedValue([
        { layer_id: 'l-hidden', field: null, title: 'Layer · Sewer Mains', score: 0.9 },
        { layer_id: 'l-storm', field: 'pipe_dia', title: 'Field · Storm Water Lines.pipe_dia', score: 0.8 },
        { layer_id: 'l-drain', field: null, title: 'Layer · Drainage Points', score: 0.75 },
      ]);

      const result = await service.search(owner, 'drainage');

      expect(ai.searchLayers).toHaveBeenCalledWith('muni-1', 'drainage');
      expect(result.layers.map((l) => [l.id, l.match])).toEqual([
        ['l-drain', 'name'],
        ['l-storm', 'semantic'],
      ]);
      expect(result.layers[1].matchedField).toBe('pipe_dia');
    });

    it('skips the semantic lookup for very short queries', async () => {
      await service.search(owner, 'dr');
      expect(ai.searchLayers).not.toHaveBeenCalled();
    });
  });
});
