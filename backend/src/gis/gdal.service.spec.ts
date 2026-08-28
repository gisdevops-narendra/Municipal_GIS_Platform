import { GdalError, GdalService } from './gdal.service';

// gdal.service.ts does `const execFileAsync = promisify(execFile);` at
// MODULE LOAD TIME (i.e. as soon as this spec file's `import ... from
// './gdal.service'` runs, since jest.mock() calls — including this one —
// are hoisted above it). Node's real child_process.execFile defines a
// `util.promisify.custom` implementation that resolves `{ stdout, stderr
// }`; a bare jest-mocked execFile has no such property, so promisify
// falls back to generic single-value resolution — the wrong shape for
// gdal.service.ts's `const { stdout } = await execFileAsync(...)`.
//
// The custom symbol therefore has to exist on `execFile` from the very
// first time it's required — created and returned entirely from within
// the (hoisted) factory itself, then retrieved afterward via
// jest.requireMock(), rather than closed over from an outer `const`
// (which would still be in its temporal dead zone when the hoisted
// factory actually runs).
jest.mock('child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- must run inside the hoisted mock factory, before any ES import binds
  const { promisify } = require('util') as typeof import('util');
  const execFileCustomMock = jest.fn();
  const execFileMock = jest.fn() as unknown as Record<symbol, unknown>;
  execFileMock[promisify.custom] = execFileCustomMock;
  return { execFile: execFileMock, __execFileCustomMock: execFileCustomMock };
});

const { __execFileCustomMock: execFileCustomMock } = jest.requireMock(
  'child_process',
) as unknown as { __execFileCustomMock: jest.Mock };

describe('GdalService', () => {
  let service: GdalService;

  beforeEach(() => {
    execFileCustomMock.mockReset();
    service = new GdalService();
  });

  describe('inspect', () => {
    it('parses ogrinfo JSON into a normalized result, including the EPSG code from projjson', async () => {
      const ogrinfoJson = JSON.stringify({
        driverShortName: 'GeoJSON',
        layers: [
          {
            name: 'test',
            featureCount: 3,
            fields: [{ name: 'name', type: 'String' }],
            geometryFields: [
              {
                type: 'Point',
                coordinateSystem: {
                  projjson: { id: { authority: 'EPSG', code: 4326 } },
                },
              },
            ],
          },
        ],
      });
      execFileCustomMock.mockResolvedValueOnce({
        stdout: ogrinfoJson,
        stderr: '',
      });

      const result = await service.inspect('/tmp/test.geojson');

      expect(result).toEqual({
        driverShortName: 'GeoJSON',
        layerName: 'test',
        geometryType: 'Point',
        featureCount: 3,
        fields: [{ name: 'name', type: 'String' }],
        epsgCode: 4326,
      });
      expect(execFileCustomMock).toHaveBeenCalledWith(
        'ogrinfo',
        expect.arrayContaining(['-json', '-al', '-so', '/tmp/test.geojson']),
        expect.any(Object),
      );
    });

    it('returns a null epsgCode when the CRS cannot be determined, rather than guessing', async () => {
      const ogrinfoJson = JSON.stringify({
        driverShortName: 'ESRI Shapefile',
        layers: [
          {
            name: 'x',
            featureCount: 1,
            fields: [],
            geometryFields: [{ type: 'Point' }],
          },
        ],
      });
      execFileCustomMock.mockResolvedValueOnce({
        stdout: ogrinfoJson,
        stderr: '',
      });

      const result = await service.inspect('/tmp/no-crs.shp');
      expect(result.epsgCode).toBeNull();
    });

    it('passes -oo open options through to ogrinfo (used for CSV lat/lon column selection)', async () => {
      const ogrinfoJson = JSON.stringify({
        driverShortName: 'CSV',
        layers: [
          {
            name: 'x',
            featureCount: 1,
            fields: [],
            geometryFields: [{ type: 'Point' }],
          },
        ],
      });
      execFileCustomMock.mockResolvedValueOnce({
        stdout: ogrinfoJson,
        stderr: '',
      });

      await service.inspect('/tmp/points.csv', {
        openOptions: ['X_POSSIBLE_NAMES=lon', 'Y_POSSIBLE_NAMES=lat'],
      });

      expect(execFileCustomMock).toHaveBeenCalledWith(
        'ogrinfo',
        expect.arrayContaining([
          '-oo',
          'X_POSSIBLE_NAMES=lon',
          '-oo',
          'Y_POSSIBLE_NAMES=lat',
        ]),
        expect.any(Object),
      );
    });

    it('throws a GdalError (not a raw parse exception) when ogrinfo output is not valid JSON', async () => {
      execFileCustomMock.mockResolvedValueOnce({
        stdout: 'not json at all',
        stderr: '',
      });
      await expect(service.inspect('/tmp/x')).rejects.toBeInstanceOf(GdalError);
    });

    it('throws a GdalError with a readable message when the subprocess itself fails', async () => {
      const error = new Error('spawn failed') as Error & { stderr?: string };
      error.stderr = 'ERROR 1: Unsupported file format.\nExtra detail line';
      execFileCustomMock.mockRejectedValueOnce(error);

      await expect(service.inspect('/tmp/bad')).rejects.toThrow(
        'ERROR 1: Unsupported file format.',
      );
    });

    it('throws a GdalError when the file has no layers at all', async () => {
      execFileCustomMock.mockResolvedValueOnce({
        stdout: JSON.stringify({ driverShortName: 'GeoJSON', layers: [] }),
        stderr: '',
      });
      await expect(
        service.inspect('/tmp/empty.geojson'),
      ).rejects.toBeInstanceOf(GdalError);
    });
  });

  describe('importToPostgis', () => {
    it('builds a quoted PG: connection string and forces -overwrite / PROMOTE_TO_MULTI', async () => {
      execFileCustomMock.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await service.importToPostgis({
        sourcePath: '/tmp/roads.shp',
        tableName: 'layer_abc123',
        targetCrs: 'EPSG:32643',
        connection: {
          host: 'postgres',
          port: '5432',
          database: 'municipal_gis',
          user: 'municipal_gis',
          password: "pa'ss\\word",
        },
      });

      const [command, args] = execFileCustomMock.mock.calls[0] as [
        string,
        string[],
      ];
      expect(command).toBe('ogr2ogr');
      expect(args).toEqual(
        expect.arrayContaining([
          '-f',
          'PostgreSQL',
          '-nln',
          'layer_abc123',
          '-t_srs',
          'EPSG:32643',
          '-overwrite',
          '-nlt',
          'PROMOTE_TO_MULTI',
        ]),
      );
      const connString = args.find((a) => a.startsWith('PG:'));
      expect(connString).toContain("password='pa\\'ss\\\\word'");
    });

    it('does not force the FID column to `id` (a source `id` attribute must not break the import)', async () => {
      execFileCustomMock.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await service.importToPostgis({
        sourcePath: '/tmp/zones.shp',
        tableName: 'layer_abc123',
        targetCrs: 'EPSG:32643',
        connection: {
          host: 'h',
          port: '5432',
          database: 'd',
          user: 'u',
          password: 'p',
        },
      });

      const [, args] = execFileCustomMock.mock.calls[0] as [string, string[]];
      expect(args).not.toContain('FID=id');
      expect(args).toEqual(
        expect.arrayContaining(['-lco', 'GEOMETRY_NAME=geom']),
      );
    });

    it('passes -s_srs only when an explicit source CRS override is given', async () => {
      execFileCustomMock.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await service.importToPostgis({
        sourcePath: '/tmp/points.csv',
        tableName: 'layer_xyz',
        targetCrs: 'EPSG:32643',
        sourceCrsOverride: 'EPSG:4326',
        connection: {
          host: 'h',
          port: '5432',
          database: 'd',
          user: 'u',
          password: 'p',
        },
      });

      const [, args] = execFileCustomMock.mock.calls[0] as [string, string[]];
      expect(args).toEqual(expect.arrayContaining(['-s_srs', 'EPSG:4326']));
    });
  });
});
