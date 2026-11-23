import { BadRequestException } from '@nestjs/common';
import { LayerReportService } from './layer-report.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GisLayersService } from './gis-layers.service';
import type { LayerRecordsService } from './layer-records.service';
import type { AppUser } from '../auth/types/app-user.type';

const OWNER: AppUser = {
  id: 'owner-1',
  keycloakUserId: 'kc-owner',
  municipalityId: 'muni-a',
  systemRole: 'MUNICIPALITY_OWNER',
  status: 'ACTIVE',
};

const LAYER = {
  id: 'layer-1',
  name: 'Valves',
  code: 'VALVES',
  geoserverWorkspace: 'somnath_municipality',
  geoserverLayer: 'valves',
  geometryType: 'POINT',
  ownershipType: 'DEPARTMENT',
  department: { id: 'dept-ww', name: 'Water Works' },
};

function build(
  features: { id: string; properties: Record<string, unknown> }[],
  numberMatched = features.length,
) {
  const gisLayers = {
    reportSource: jest.fn().mockResolvedValue({
      layer: LAYER,
      attributes: [
        { name: 'valve_id', type: 'text', kind: 'string' },
        { name: 'valve_dia', type: 'double precision', kind: 'number' },
      ],
    }),
  };
  const records = {
    query: jest.fn().mockResolvedValue({ features, numberMatched }),
  };
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ fullName: 'Somnath Owner' }),
    },
    municipality: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Somnath Municipality' }),
    },
  };
  const service = new LayerReportService(
    prisma as unknown as PrismaService,
    gisLayers as unknown as GisLayersService,
    records as unknown as LayerRecordsService,
  );
  return { service, records, gisLayers };
}

const ROWS = [
  { id: 'valves.1', properties: { feat_id: 1, valve_id: 'VLV-1', valve_dia: 100, secret_note: 'x' } },
  { id: 'valves.2', properties: { feat_id: 2, valve_id: 'VLV-2', valve_dia: 150, secret_note: 'y' } },
];

describe('LayerReportService', () => {
  it('builds a PDF for the whole layer with only the requested columns', async () => {
    const { service, records } = build(ROWS);

    const result = await service.buildReport(OWNER, 'layer-1', {
      fields: ['valve_id', 'valve_dia'],
      scope: 'layer',
    });

    expect(result.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(result.filename).toMatch(/^valves-report-\d{8}\.pdf$/);
    // Read from the database (records), never GeoServer.
    expect(records.query).toHaveBeenCalledWith(
      OWNER,
      'layer-1',
      expect.objectContaining({ filter: undefined, featureIds: undefined, limit: 5000, geometry: false }),
    );
  });

  it('rejects a column that is not an attribute of the layer', async () => {
    const { service, records } = build(ROWS);

    await expect(
      service.buildReport(OWNER, 'layer-1', {
        fields: ['secret'],
        scope: 'layer',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(records.query).not.toHaveBeenCalled();
  });

  it('passes the query filter to the database records query', async () => {
    const { service, records } = build(ROWS);

    await service.buildReport(OWNER, 'layer-1', {
      fields: ['valve_id'],
      scope: 'query',
      cqlFilter: `"valve_dia" > 100`,
    });
    // (unsafe / unknown filters are refused by the CQL→SQL translator —
    //  see cql-to-sql.spec.ts)
    expect(records.query).toHaveBeenCalledWith(
      OWNER,
      'layer-1',
      expect.objectContaining({ filter: `"valve_dia" > 100` }),
    );
  });

  it("only accepts selected ids that belong to this layer's feature type", async () => {
    const { service, records } = build(ROWS);

    await service.buildReport(OWNER, 'layer-1', {
      fields: ['valve_id'],
      scope: 'selection',
      featureIds: ['valves.1', 'valves.2'],
    });
    expect(records.query).toHaveBeenCalledWith(
      OWNER,
      'layer-1',
      expect.objectContaining({ featureIds: ['valves.1', 'valves.2'] }),
    );

    await expect(
      service.buildReport(OWNER, 'layer-1', {
        fields: ['valve_id'],
        scope: 'selection',
        featureIds: ['valves.1', 'secret_layer.9'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still renders when the report is capped below the full match count', async () => {
    const { service } = build(ROWS, 12000);

    const result = await service.buildReport(OWNER, 'layer-1', {
      fields: ['valve_id', 'valve_dia'],
      scope: 'layer',
    });

    expect(result.body.length).toBeGreaterThan(1000);
  });
});
