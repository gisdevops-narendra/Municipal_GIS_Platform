import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FieldStatsService } from './field-stats.service';

const SAFE_TABLE = `layer_${'a'.repeat(32)}`;

describe('FieldStatsService', () => {
  let service: FieldStatsService;
  let queryRaw: jest.Mock;

  beforeEach(() => {
    queryRaw = jest.fn();
    service = new FieldStatsService({
      $queryRawUnsafe: queryRaw,
    } as unknown as PrismaService);
  });

  function columns(
    rows: { column_name: string; data_type: string; udt_name?: string }[],
  ) {
    queryRaw.mockResolvedValueOnce(
      rows.map((r) => ({ udt_name: r.data_type, ...r })),
    );
  }

  describe('attributes', () => {
    it('classifies column types and hides ogc_fid / geometry / tenant column', async () => {
      columns([
        { column_name: 'ogc_fid', data_type: 'integer' },
        {
          column_name: 'geom',
          data_type: 'USER-DEFINED',
          udt_name: 'geometry',
        },
        { column_name: 'name', data_type: 'character varying' },
        { column_name: 'pop', data_type: 'double precision' },
        { column_name: 'gis_workspace_id', data_type: 'text' },
      ]);

      const attrs = await service.attributes('gis_demo_wards', 'ws-1');

      expect(attrs.map((a) => a.name)).toEqual(['name', 'pop']);
      expect(attrs.find((a) => a.name === 'pop')?.kind).toBe('number');
      expect(attrs.find((a) => a.name === 'name')?.kind).toBe('string');
    });

    it('rejects a table that is neither a safe layer_<uuid> nor a demo table', async () => {
      await expect(service.attributes('users', null)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('fieldStats', () => {
    it('rejects a field that is not an attribute of the layer', async () => {
      columns([{ column_name: 'name', data_type: 'text' }]);
      await expect(
        service.fieldStats(SAFE_TABLE, 'evil"; DROP TABLE x; --', {}, null),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('numeric field, equal interval → min/max/count + arithmetic breaks', async () => {
      columns([{ column_name: 'pop', data_type: 'integer' }]);
      queryRaw.mockResolvedValueOnce([{ min: 0, max: 100, count: 40n }]);

      const stats = await service.fieldStats(
        SAFE_TABLE,
        'pop',
        { method: 'equalInterval', classes: 4 },
        null,
      );

      expect(stats.numeric).toEqual({
        min: 0,
        max: 100,
        count: 40,
        breaks: [0, 25, 50, 75, 100],
      });
    });

    it('numeric field, quantile → breaks from percentile_cont', async () => {
      columns([{ column_name: 'pop', data_type: 'integer' }]);
      queryRaw.mockResolvedValueOnce([{ min: 0, max: 100, count: 40n }]);
      queryRaw.mockResolvedValueOnce([{ q: [0, 12, 40, 71, 100] }]);

      const stats = await service.fieldStats(
        SAFE_TABLE,
        'pop',
        { method: 'quantile', classes: 4 },
        null,
      );

      expect(stats.numeric?.breaks).toEqual([0, 12, 40, 71, 100]);
      const calls = queryRaw.mock.calls as unknown[][];
      expect(String(calls[2][0])).toContain(
        'percentile_cont(ARRAY[0,0.25,0.5,0.75,1])',
      );
    });

    it('string field → distinct values, flagged truncated past the cap', async () => {
      columns([{ column_name: 'zone', data_type: 'text' }]);
      queryRaw.mockResolvedValueOnce(
        Array.from({ length: 51 }, (_, i) => ({ v: `z${i}` })),
      );

      const stats = await service.fieldStats(SAFE_TABLE, 'zone', {}, null);

      expect(stats.distinct).toHaveLength(50);
      expect(stats.distinctTruncated).toBe(true);
    });

    it('adds the workspace filter for a shared demo table', async () => {
      columns([{ column_name: 'zone', data_type: 'text' }]);
      queryRaw.mockResolvedValueOnce([{ v: 'A' }]);

      await service.fieldStats('gis_demo_wards', 'zone', {}, 'ws-9');

      const distinctCall = queryRaw.mock.calls[1] as unknown[];
      expect(String(distinctCall[0])).toContain('WHERE gis_workspace_id = $1');
      expect(distinctCall[1]).toBe('ws-9');
    });
  });
});
