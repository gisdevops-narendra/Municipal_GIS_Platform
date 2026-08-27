import { GeoServerService } from './geoserver.service';
import { ConfigService } from '@nestjs/config';

/**
 * GeoServer can serialize `latLonBoundingBox` values as JSON strings
 * (observed: scientific notation like "-9.02e-6") for a degenerate/empty
 * feature type — e.g. a freshly published layer over a table with no rows
 * yet for this municipality — rather than as JSON numbers. This was a real
 * bug caught via live testing (see docs/backend.md "GIS Layers"): a naive
 * type cast let a string flow into a Prisma Float column and throw. These
 * tests lock in the fix.
 */
describe('GeoServerService bounding box parsing', () => {
  let service: GeoServerService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    const config = {
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, string> = {
          GEOSERVER_URL: 'http://geoserver.test/geoserver',
          GEOSERVER_ADMIN_USER: 'admin',
          GEOSERVER_ADMIN_PASSWORD: 'secret',
        };
        return values[key];
      }),
    };
    service = new GeoServerService(config as unknown as ConfigService);

    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  function mockFeatureTypeExistsThenGet(featureTypeBody: unknown) {
    fetchMock
      // featureTypeExists() check
      .mockResolvedValueOnce({ ok: true, status: 200 })
      // getFeatureTypeBoundingBox() GET
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(featureTypeBody),
      });
  }

  it('coerces string-encoded bbox values (e.g. scientific notation) to numbers', async () => {
    mockFeatureTypeExistsThenGet({
      featureType: {
        latLonBoundingBox: {
          minx: 70.51124715629626,
          miny: '-9.019375809370808E-6',
          maxx: 70.51125611529294,
          maxy: 0,
        },
      },
    });

    const bbox = await service.ensureFeatureType('ws', 'ds', {
      name: 'roads',
      nativeName: 'gis_demo_roads',
      title: 'Roads',
      srs: 'EPSG:32643',
      cqlFilter: "gis_workspace_id = 'x'",
    });

    expect(bbox).toEqual({
      minX: 70.51124715629626,
      minY: -9.019375809370808e-6,
      maxX: 70.51125611529294,
      maxY: 0,
    });
    expect(typeof bbox?.minY).toBe('number');
  });

  it('returns null rather than a garbage bbox when a value cannot be parsed as a finite number', async () => {
    mockFeatureTypeExistsThenGet({
      featureType: {
        latLonBoundingBox: { minx: 'not-a-number', miny: 1, maxx: 2, maxy: 3 },
      },
    });

    const bbox = await service.ensureFeatureType('ws', 'ds', {
      name: 'roads',
      nativeName: 'gis_demo_roads',
      title: 'Roads',
      srs: 'EPSG:32643',
      cqlFilter: "gis_workspace_id = 'x'",
    });

    expect(bbox).toBeNull();
  });

  it('returns null when the feature type has no bounding box at all', async () => {
    mockFeatureTypeExistsThenGet({ featureType: {} });

    const bbox = await service.ensureFeatureType('ws', 'ds', {
      name: 'roads',
      nativeName: 'gis_demo_roads',
      title: 'Roads',
      srs: 'EPSG:32643',
      cqlFilter: "gis_workspace_id = 'x'",
    });

    expect(bbox).toBeNull();
  });
});
