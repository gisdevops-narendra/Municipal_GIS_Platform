import { BadRequestException } from '@nestjs/common';
import { CqlContext, cqlToSql } from './cql-to-sql';

const ctx: CqlContext = {
  columns: new Map([
    ['name', { type: 'character varying' }],
    ['pop', { type: 'integer' }],
    ['area', { type: 'double precision' }],
    ['code', { type: 'character varying' }],
    ['built', { type: 'date' }],
    ['active', { type: 'boolean' }],
    ['id', { type: 'integer' }],
  ]),
  geometryColumn: 'geom',
  srid: 32643,
  fidColumn: 'feat_id',
  alias: 't',
};
const q = (cql: string) => cqlToSql(cql, ctx);

describe('cqlToSql', () => {
  it('empty filter matches everything', () => {
    expect(q('  ')).toEqual({ sql: 'TRUE', params: [] });
  });

  it('attribute table search (ILIKE OR exact id)', () => {
    const r = q(`"name" ILIKE '%ab''c%' OR "id" = 12`);
    expect(r.sql).toBe(`(t."name"::text ILIKE $1 OR t."id" = $2::numeric)`);
    expect(r.params).toEqual(["%ab'c%", 12]);
  });

  it('query builder groups, IN, BETWEEN, IS NULL, NOT LIKE', () => {
    const r = q(`("pop" IN (1, 2, 3)) AND ("area" BETWEEN 1.5 AND 10) AND ("built" IS NOT NULL) OR ("name" NOT LIKE 'x%')`);
    expect(r.sql).toContain('t."pop" IN ($1::numeric, $2::numeric, $3::numeric)');
    expect(r.sql).toContain('t."area" BETWEEN $4::numeric AND $5::numeric');
    expect(r.sql).toContain('t."built" IS NOT NULL');
    expect(r.sql).toContain(`(NOT t."name"::text LIKE $6)`);
  });

  it('string literals are cast to the column type', () => {
    const r = q(`"built" >= '2024-01-01' AND "active" = true`);
    expect(r.sql).toBe(`(t."built" >= CAST($1 AS date) AND t."active" = $2::boolean)`);
  });

  it('numbers against a text column compare numerically', () => {
    expect(q(`"code" > 10`).sql).toMatch(/CASE WHEN t\."code" ~ .* THEN t\."code"::numeric END\) > \$1::numeric/);
  });

  it('feature id filter', () => {
    const r = q(`IN ('roads.1', 'roads.7')`);
    expect(r.sql).toBe(`t."feat_id" = ANY($1::bigint[])`);
    expect(r.params).toEqual([[1, 7]]);
  });

  it('spatial predicates with SRID WKT', () => {
    const r = q(`INTERSECTS("geom", SRID=4326;POLYGON((72 21, 73 21, 73 22, 72 21)))`);
    expect(r.sql).toBe(`ST_Intersects(t."geom", ST_Transform(ST_GeomFromEWKT($1), 32643))`);
    expect(r.params).toEqual(['SRID=4326;POLYGON((72 21, 73 21, 73 22, 72 21))']);
  });

  it('DWITHIN in metres and kilometres', () => {
    expect(q(`DWITHIN("geom", SRID=4326;POINT(72.5 21.1), 50, meters)`).params).toEqual(['SRID=4326;POINT(72.5 21.1)', 50]);
    expect(q(`DWITHIN(geom, POINT(72.5 21.1), 2, kilometers)`).params).toEqual(['SRID=4326;POINT(72.5 21.1)', 2000]);
  });

  it('BBOX with CRS', () => {
    const r = q(`BBOX("geom", 72, 21, -73.5, 22, 'EPSG:4326')`);
    expect(r.sql).toContain('ST_MakeEnvelope($1, $2, $3, $4, $5::int)');
    expect(r.params).toEqual([72, 21, -73.5, 22, 4326]);
  });

  it('combined (filter AND selection) with offset numbering', () => {
    const r = cqlToSql(`("pop" > 5) AND (IN ('x.3'))`, ctx, 3);
    expect(r.sql).toBe(`((t."pop" > $3::numeric) AND (t."feat_id" = ANY($4::bigint[])))`);
  });

  it.each([
    [`"nope" = 1`, 'unknown column'],
    [`"name" = 'a'; DROP TABLE x`, 'unexpected'],
    [`queryCollection('x','y','z')`, 'unknown column'],
    [`"name" = 'unterminated`, 'unterminated'],
    [`INTERSECTS("geom", POLYGON((1 1, 2 2); DROP))`, 'geometry'],
    [`INTERSECTS("name", POINT(1 1))`, 'not the geometry column'],
    [`DWITHIN("geom", POINT(1 1), 5, parsecs)`, 'unit'],
  ])('rejects %s', (cql, msg) => {
    expect(() => q(cql)).toThrow(BadRequestException);
    expect(() => q(cql)).toThrow(new RegExp(msg, 'i'));
  });
});
