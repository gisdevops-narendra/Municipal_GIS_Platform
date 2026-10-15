import { BadRequestException } from '@nestjs/common';
import { assertSafeCql } from './cql-guard';

describe('assertSafeCql', () => {
  it.each([
    `"status" = 'Leaking'`,
    `"dia" BETWEEN 100 AND 300 AND "zone" IN ('A', 'B')`,
    `("name" ILIKE '%road%' OR "id" = 5) AND NOT ("x" IS NULL)`,
    `INTERSECTS("geom", SRID=4326;POLYGON((70.4 21.5, 70.5 21.5, 70.5 21.6, 70.4 21.5)))`,
    `DWITHIN("geom", SRID=4326;POINT(70.4 21.5), 250, meters)`,
    `"note" = 'text with queryCollection(x) inside a literal'`,
    `"querySingle" = 1`,
  ])('accepts what the app generates: %s', (cql) => {
    expect(() => assertSafeCql(cql)).not.toThrow();
  });

  it.each([
    `INTERSECTS("geom", queryCollection('ws:secret', 'geom', 'INCLUDE'))`,
    `"a" = querySingle('ws:secret', 'name', 'INCLUDE')`,
    `strToLowerCase("name") = 'x'`,
    `"a" = env('GEOSERVER_DATA_DIR')`,
    `"a" = 'unterminated`,
  ])('rejects: %s', (cql) => {
    expect(() => assertSafeCql(cql)).toThrow(BadRequestException);
  });

  it('rejects an oversized filter', () => {
    expect(() => assertSafeCql(`"a" = '${'x'.repeat(9000)}'`)).toThrow(
      BadRequestException,
    );
  });
});
