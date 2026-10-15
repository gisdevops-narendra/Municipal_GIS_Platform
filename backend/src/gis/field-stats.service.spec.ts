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

  describe('summary (analytics)', () => {
    /** Typed view of the n-th raw query call: [sql, ...params]. */
    const call = (n: number) =>
      queryRaw.mock.calls[n] as [string, ...unknown[]];

    it('returns numeric stats and a 10-bin histogram, clamping the max into the last bin', async () => {
      columns([{ column_name: 'dia', data_type: 'double precision' }]);
      queryRaw.mockResolvedValueOnce([
        {
          total: 12n,
          non_null: 10n,
          min: 0,
          max: 100,
          mean: 40,
          sum: 400,
          median: 35,
        },
      ]);
      queryRaw.mockResolvedValueOnce([
        { bin: 1, count: 4n },
        { bin: 10, count: 6n },
      ]);

      const result = await service.summary(SAFE_TABLE, 'dia', null);

      expect(result).toMatchObject({ kind: 'number', total: 12, nonNull: 10 });
      expect(result.numeric?.histogram).toHaveLength(10);
      expect(result.numeric?.histogram[0]).toEqual({
        from: 0,
        to: 10,
        count: 4,
      });
      expect(result.numeric?.histogram[9]).toEqual({
        from: 90,
        to: 100,
        count: 6,
      });
      expect(result.numeric?.histogram[5].count).toBe(0);
      const binSql = call(2)[0];
      expect(binSql).toContain(
        'LEAST(width_bucket("dia"::float8, 0, 100, 10), 10)',
      );
    });

    it('uses a single bin when every value is equal', async () => {
      columns([{ column_name: 'dia', data_type: 'integer' }]);
      queryRaw.mockResolvedValueOnce([
        {
          total: 3n,
          non_null: 3n,
          min: 5,
          max: 5,
          mean: 5,
          sum: 15,
          median: 5,
        },
      ]);
      queryRaw.mockResolvedValueOnce([{ bin: 1, count: 3n }]);

      const result = await service.summary(SAFE_TABLE, 'dia', null);

      expect(result.numeric?.histogram).toEqual([{ from: 5, to: 5, count: 3 }]);
    });

    it('returns top categories and folds the rest into otherCount', async () => {
      columns([{ column_name: 'status', data_type: 'character varying' }]);
      queryRaw.mockResolvedValueOnce([
        { total: 20n, non_null: 18n, distinct_count: 14n },
      ]);
      queryRaw.mockResolvedValueOnce([
        { value: 'Working', count: 10n },
        { value: 'Leaking', count: 5n },
      ]);

      const result = await service.summary(SAFE_TABLE, 'status', null);

      expect(result).toMatchObject({
        kind: 'string',
        total: 20,
        nonNull: 18,
        distinctCount: 14,
        otherCount: 3,
        categories: [
          { value: 'Working', count: 10 },
          { value: 'Leaking', count: 5 },
        ],
      });
    });

    it('scopes the shared demo tables to the workspace', async () => {
      columns([{ column_name: 'name', data_type: 'text' }]);
      queryRaw.mockResolvedValueOnce([
        { total: 4n, non_null: 4n, distinct_count: 4n },
      ]);
      queryRaw.mockResolvedValueOnce([]);

      await service.summary('gis_demo_wards', 'name', 'ws-1');

      expect(call(1)[0]).toContain('WHERE gis_workspace_id = $1');
      expect(call(1)[1]).toBe('ws-1');
      expect(call(2)[0]).toContain(
        'WHERE gis_workspace_id = $1 AND "name" IS NOT NULL',
      );
    });

    it('rejects a field that is not an attribute of the layer', async () => {
      columns([{ column_name: 'name', data_type: 'text' }]);

      await expect(
        service.summary(SAFE_TABLE, 'name; DROP TABLE x', null),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
