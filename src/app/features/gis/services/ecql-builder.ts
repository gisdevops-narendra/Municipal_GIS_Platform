import { AttributeField } from '../models/attribute-table.model';
import {
  ATTR_OPERATORS,
  AttrCondition,
  ConditionGroup,
  EcqlResult,
  QueryDefinition,
  SpatialClause
} from '../models/query-builder.model';

/**
 * Pure ECQL compiler for the Query Builder. No Angular, no HTTP — every
 * branch is unit-testable, and adding an operator or spatial relation is a
 * localised change here plus the model list.
 *
 * ECQL notes for GeoServer:
 *  - identifiers are double-quoted so a column named "id" isn't read as the
 *    feature-id keyword;
 *  - geometry literals are prefixed `SRID=4326;` (the drawn shape is in
 *    EPSG:4326), which GeoServer's ECQL parser accepts.
 */

const FIELD_TYPE_NUMERIC = new Set(['integer', 'number', 'id']);

export function compileQuery(
  def: QueryDefinition,
  fields: AttributeField[],
  geometryField: string
): EcqlResult {
  const issues: string[] = [];
  const parts: string[] = [];

  const attr = buildAttributeEcql(def.groups, fields);
  issues.push(...attr.issues);
  if (attr.cql) {
    parts.push(attr.cql);
  }

  if (def.spatial.enabled) {
    const spatial = buildSpatialEcql(def.spatial, geometryField);
    issues.push(...spatial.issues);
    if (spatial.cql) {
      parts.push(spatial.cql);
    }
  }

  if (issues.length > 0) {
    return { cql: null, issues };
  }
  if (parts.length === 0) {
    return { cql: null, issues: ['Add at least one attribute condition or a spatial filter.'] };
  }
  return { cql: parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(' AND '), issues: [] };
}

// ---------------------------------------------------------------------------

export function buildAttributeEcql(groups: ConditionGroup[], fields: AttributeField[]): EcqlResult {
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  const issues: string[] = [];
  const groupParts: { connector: string; text: string }[] = [];

  for (const group of groups) {
    const conditionTexts: string[] = [];
    for (const condition of group.conditions) {
      const hasValue = condition.value.trim() !== '' || condition.value2.trim() !== '';
      if (!condition.field && !hasValue) {
        continue; // an untouched condition row — ignore it
      }
      const field = fieldByName.get(condition.field);
      if (!condition.field || !field) {
        issues.push('Choose a field for every condition.');
        continue;
      }
      if (isBlankCondition(condition)) {
        continue;
      }
      const compiled = conditionToEcql(condition, field);
      if ('error' in compiled) {
        issues.push(compiled.error);
      } else {
        conditionTexts.push(compiled.text);
      }
    }

    if (conditionTexts.length === 0) {
      continue;
    }
    let text = conditionTexts.join(` ${group.innerConnector} `);
    if (conditionTexts.length > 1) {
      text = `(${text})`;
    }
    if (group.not) {
      text = `NOT (${text})`;
    }
    groupParts.push({ connector: group.connector, text });
  }

  if (issues.length > 0) {
    return { cql: null, issues: dedupe(issues) };
  }
  if (groupParts.length === 0) {
    return { cql: null, issues: [] };
  }

  let cql = groupParts[0].text;
  for (let i = 1; i < groupParts.length; i++) {
    cql = `(${cql}) ${groupParts[i].connector} (${groupParts[i].text})`;
  }
  return { cql, issues: [] };
}

export function conditionToEcql(
  condition: AttrCondition,
  field: AttributeField
): { text: string } | { error: string } {
  const col = quoteIdent(field.name);
  const numeric = FIELD_TYPE_NUMERIC.has(field.type);
  const def = ATTR_OPERATORS.find((o) => o.op === condition.operator);
  const arity = def?.arity ?? 1;

  if (arity === 0) {
    return { text: `${col} ${condition.operator}` };
  }

  const raw = condition.value.trim();
  if (raw === '') {
    return { error: `Enter a value for "${field.label}".` };
  }

  switch (condition.operator) {
    case 'IN': {
      const items = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (items.length === 0) {
        return { error: `"${field.label}" IN needs at least one value.` };
      }
      if (numeric && !items.every(isNumeric)) {
        return { error: `"${field.label}" only takes numbers.` };
      }
      const list = items.map((v) => (numeric ? v : quoteLiteral(v))).join(', ');
      return { text: `${col} IN (${list})` };
    }

    case 'BETWEEN': {
      const lo = raw;
      const hi = condition.value2.trim();
      if (hi === '') {
        return { error: `"${field.label}" BETWEEN needs an upper value.` };
      }
      if (numeric && (!isNumeric(lo) || !isNumeric(hi))) {
        return { error: `"${field.label}" only takes numbers.` };
      }
      const a = numeric ? lo : quoteLiteral(lo);
      const b = numeric ? hi : quoteLiteral(hi);
      return { text: `${col} BETWEEN ${a} AND ${b}` };
    }

    case 'LIKE':
    case 'ILIKE': {
      const pattern = raw.includes('%') ? raw : `%${raw}%`;
      return { text: `${col} ${condition.operator} ${quoteLiteral(pattern)}` };
    }

    default: {
      if (numeric) {
        if (!isNumeric(raw)) {
          return { error: `"${field.label}" only takes numbers.` };
        }
        return { text: `${col} ${condition.operator} ${raw}` };
      }
      if (field.type === 'boolean') {
        const truthy = /^(true|yes|1)$/i.test(raw);
        return { text: `${col} ${condition.operator} ${truthy}` };
      }
      return { text: `${col} ${condition.operator} ${quoteLiteral(raw)}` };
    }
  }
}

// ---------------------------------------------------------------------------

export function buildSpatialEcql(spatial: SpatialClause, geometryField: string): EcqlResult {
  if (!spatial.enabled) {
    return { cql: null, issues: [] };
  }
  if (!spatial.geometry) {
    return { cql: null, issues: ['Draw a shape on the map for the spatial filter.'] };
  }

  const wkt = geoJsonToWkt(spatial.geometry);
  if (!wkt) {
    return { cql: null, issues: ['The spatial geometry could not be read.'] };
  }
  const literal = `SRID=4326;${wkt}`;
  const col = quoteIdent(geometryField);

  if (spatial.relation === 'DWITHIN') {
    if (!(spatial.distance > 0)) {
      return { cql: null, issues: ['Enter a distance greater than zero.'] };
    }
    return { cql: `DWITHIN(${col}, ${literal}, ${spatial.distance}, ${spatial.distanceUnits})`, issues: [] };
  }
  return { cql: `${spatial.relation}(${col}, ${literal})`, issues: [] };
}

// ---------------------------------------------------------------------------

export function combineEcql(...parts: (string | null | undefined)[]): string | null {
  const valid = parts.filter((p): p is string => !!p && p.trim().length > 0);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];
  return valid.map((p) => `(${p})`).join(' AND ');
}

export function isBlankCondition(condition: AttrCondition): boolean {
  const def = ATTR_OPERATORS.find((o) => o.op === condition.operator);
  if (!condition.field) return true;
  if ((def?.arity ?? 1) === 0) return false;
  return condition.value.trim() === '';
}

// ---------- helpers ----------

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isNumeric(value: string): boolean {
  return value.trim() !== '' && !Number.isNaN(Number(value));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Minimal GeoJSON → WKT for the geometry kinds the map draw tool produces. */
export function geoJsonToWkt(geometry: Record<string, unknown>): string | null {
  const type = geometry['type'] as string;
  const coords = geometry['coordinates'] as unknown;
  const n = (v: number) => Number(v.toFixed(8));

  const ring = (r: number[][]) => r.map((c) => `${n(c[0])} ${n(c[1])}`).join(', ');

  switch (type) {
    case 'Point': {
      const c = coords as number[];
      return `POINT(${n(c[0])} ${n(c[1])})`;
    }
    case 'LineString': {
      const c = coords as number[][];
      return `LINESTRING(${ring(c)})`;
    }
    case 'Polygon': {
      const c = coords as number[][][];
      return `POLYGON(${c.map((r) => `(${ring(r)})`).join(', ')})`;
    }
    case 'MultiPolygon': {
      const c = coords as number[][][][];
      return `MULTIPOLYGON(${c.map((poly) => `(${poly.map((r) => `(${ring(r)})`).join(', ')})`).join(', ')})`;
    }
    default:
      return null;
  }
}
