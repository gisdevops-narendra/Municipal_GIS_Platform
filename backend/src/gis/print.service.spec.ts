import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { GisLayersService } from './gis-layers.service';
import { PrintService } from './print.service';
import type { PrintReportDto } from './dto/print-report.dto';
import type { AppUser } from '../auth/types/app-user.type';

const OWNER: AppUser = {
  id: 'user-1',
  keycloakUserId: 'kc-1',
  municipalityId: 'muni-1',
  departmentId: null,
  systemRole: 'MUNICIPALITY_OWNER',
  status: 'ACTIVE',
};

const CONFIG: Record<string, string> = {
  MAPFISH_PRINT_URL: 'http://mapfish-print:8080/print',
  MAPFISH_PRINT_APP: 'municipal-gis',
  MAPFISH_GEOSERVER_URL: 'http://geoserver:8080/geoserver',
};

interface LayerRow {
  id: string;
  name: string;
  geoserverWorkspace: string;
  geoserverLayer: string;
}

function layerRow(over: Partial<LayerRow> = {}): LayerRow {
  return {
    id: 'layer-a',
    name: 'Wards',
    geoserverWorkspace: 'somnath',
    geoserverLayer: 'wards',
    ...over,
  };
}

const RESOLVED = {
  name: 'Wards',
  geoserverWorkspace: 'somnath',
  geoserverLayer: 'wards',
  opacity: 1,
};

function baseDto(over: Partial<PrintReportDto> = {}): PrintReportDto {
  return {
    pageSize: 'A4',
    orientation: 'landscape',
    format: 'pdf',
    dpi: 150,
    title: 'My Map',
    metadata: 'notes',
    includeLegend: true,
    includeScalebar: true,
    includeNorthArrow: true,
    includeDate: true,
    basemapId: 'osm',
    map: {
      center: [7841000, 1976000],
      scale: 50000,
      rotation: 0,
      projection: 'EPSG:3857',
    },
    layers: [{ layerId: 'layer-a' }],
    ...over,
  };
}

describe('PrintService', () => {
  let service: PrintService;
  let gisLayers: { listForMunicipality: jest.Mock };
  let prisma: { municipality: { findUnique: jest.Mock } };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    gisLayers = {
      listForMunicipality: jest.fn().mockResolvedValue([layerRow()]),
    };
    prisma = {
      municipality: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Somnath' }),
      },
    };
    const config = {
      get: jest.fn((key: string, dflt?: string) => CONFIG[key] ?? dflt),
      getOrThrow: jest.fn((key: string) => {
        if (!CONFIG[key]) throw new Error(`missing ${key}`);
        return CONFIG[key];
      }),
    };
    fetchMock = jest.fn();
    global.fetch = fetchMock;

    service = new PrintService(
      config as unknown as ConfigService,
      gisLayers as unknown as GisLayersService,
      prisma as unknown as PrismaService,
    );
  });

  describe('buildSpec', () => {
    it('maps pageSize + orientation to the MapFish layout name', () => {
      const spec = service.buildSpec(
        baseDto({ pageSize: 'A3', orientation: 'portrait' }),
        [],
        'Somnath',
      );
      expect(spec.layout).toBe('A3 portrait');
      expect(spec.outputFormat).toBe('pdf');
    });

    it('uses center + scale (never bbox) and the requested dpi/rotation', () => {
      const { map } = service.buildSpec(baseDto(), [], 'Somnath').attributes;
      expect(map.center).toEqual([7841000, 1976000]);
      expect(map.scale).toBe(50000);
      expect(map.dpi).toBe(150);
      expect(map).not.toHaveProperty('bbox');
    });

    it('builds WMS layers against the compose-internal GeoServer, never localhost:8600', () => {
      const spec = service.buildSpec(
        baseDto(),
        [{ ...RESOLVED, opacity: 0.5, cqlFilter: 'zone_no = 3' }],
        'Somnath',
      );
      const wms = spec.attributes.map.layers[0];
      expect(wms.type).toBe('wms');
      expect(wms.baseURL).toBe('http://geoserver:8080/geoserver/somnath/wms');
      expect(wms.layers).toEqual(['somnath:wards']);
      expect(wms.opacity).toBe(0.5);
      expect(wms.customParams?.CQL_FILTER).toBe('zone_no = 3');
      expect(JSON.stringify(spec)).not.toContain('localhost:8600');
    });

    it('omits CQL_FILTER when no filter is set', () => {
      const spec = service.buildSpec(baseDto(), [RESOLVED], 'Somnath');
      expect(spec.attributes.map.layers[0].customParams).not.toHaveProperty(
        'CQL_FILTER',
      );
    });

    it('appends the allowlisted basemap last, and skips it for basemapId "none"', () => {
      const withOsm = service.buildSpec(
        baseDto({ basemapId: 'osm' }),
        [RESOLVED],
        'Somnath',
      );
      const last = withOsm.attributes.map.layers.at(-1);
      expect(last?.type).toBe('osm');
      expect(last?.baseURL).toBe('https://tile.openstreetmap.org');

      const none = service.buildSpec(
        baseDto({ basemapId: 'none' }),
        [RESOLVED],
        'Somnath',
      );
      expect(
        none.attributes.map.layers.every((layer) => layer.type === 'wms'),
      ).toBe(true);
    });

    it('builds legend classes only when includeLegend is true', () => {
      const on = service.buildSpec(
        baseDto({ includeLegend: true }),
        [RESOLVED],
        'Somnath',
      );
      expect(on.attributes.legend.classes).toHaveLength(1);
      expect(on.attributes.legend.classes[0].icons[0]).toContain(
        'REQUEST=GetLegendGraphic',
      );
      expect(on.attributes.showLegend).toBe(true);

      const off = service.buildSpec(
        baseDto({ includeLegend: false }),
        [RESOLVED],
        'Somnath',
      );
      expect(off.attributes.legend.classes).toHaveLength(0);
      expect(off.attributes.showLegend).toBe(false);
    });

    it('leaves printDate blank when includeDate is false', () => {
      const spec = service.buildSpec(
        baseDto({ includeDate: false }),
        [],
        'Somnath',
      );
      expect(spec.attributes.printDate).toBe('');
    });
  });

  describe('buildReport', () => {
    it("rejects with 403 when a requested layer is not in the caller's viewable list", async () => {
      gisLayers.listForMunicipality.mockResolvedValue([
        layerRow({ id: 'other' }),
      ]);

      await expect(
        service.buildReport(
          OWNER,
          baseDto({ layers: [{ layerId: 'layer-a' }] }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('POSTs the spec to buildreport.<format> and returns the binary', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        arrayBuffer: () =>
          Promise.resolve(new TextEncoder().encode('%PDF-1.7').buffer),
      });

      const result = await service.buildReport(OWNER, baseDto());

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'http://mapfish-print:8080/print/municipal-gis/buildreport.pdf',
      );
      expect(init.method).toBe('POST');
      expect(result.contentType).toBe('application/pdf');
      expect(result.filename).toMatch(/^somnath-map-\d{4}-\d{2}-\d{2}\.pdf$/);
      expect(result.body.toString()).toBe('%PDF-1.7');
    });

    it('maps a MapFish 500 to 503', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('boom'),
      });

      await expect(
        service.buildReport(OWNER, baseDto()),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('maps a network failure to 503', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.buildReport(OWNER, baseDto()),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
