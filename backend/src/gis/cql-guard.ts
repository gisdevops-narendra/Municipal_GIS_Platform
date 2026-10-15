import { BadRequestException } from '@nestjs/common';

/**
 * Function-style ECQL tokens a client-supplied filter may contain — exactly
 * what the app's own Query Builder / Buffer / Selection tools emit: spatial
 * predicates, the IN list, logical grouping and WKT geometry literals.
 *
 * Everything else is refused, most importantly GeoServer's cross-layer
 * functions (`queryCollection`, `querySingle`, …): the backend talks to
 * GeoServer with admin credentials, so such a call inside a filter on a
 * layer the user CAN view would read a layer they can't.
 */
const ALLOWED_CALLS = new Set([
  'INTERSECTS',
  'DISJOINT',
  'CONTAINS',
  'WITHIN',
  'TOUCHES',
  'CROSSES',
  'OVERLAPS',
  'EQUALS',
  'DWITHIN',
  'BEYOND',
  'BBOX',
  'IN',
  'NOT',
  'AND',
  'OR',
  'POINT',
  'MULTIPOINT',
  'LINESTRING',
  'MULTILINESTRING',
  'POLYGON',
  'MULTIPOLYGON',
  'GEOMETRYCOLLECTION',
]);

const MAX_CQL_LENGTH = 8000;

/** Throws 400 unless `cql` only uses allow-listed function-style tokens. */
export function assertSafeCql(cql: string): void {
  if (cql.length > MAX_CQL_LENGTH) {
    throw new BadRequestException('The filter is too long.');
  }
  // Quoted string literals and "quoted identifiers" can contain anything —
  // drop them before looking for calls. An unbalanced quote is rejected.
  const unquoted = cql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"[^"]*"/g, '""');
  if (/['"]/.test(unquoted.replace(/''|""/g, ''))) {
    throw new BadRequestException('The filter has an unterminated quote.');
  }
  for (const match of unquoted.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (!ALLOWED_CALLS.has(match[1].toUpperCase())) {
      throw new BadRequestException(
        `The filter uses an unsupported function: ${match[1]}.`,
      );
    }
  }
}
