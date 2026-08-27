import { GeoJsonGeometry } from './attribute-table.model';

/**
 * Query Builder domain model — deliberately declarative and framework-free so
 * the ECQL compiler, the panel UI, saved queries and any later query tools
 * (join queries, temporal filters, expression columns) all share it.
 *
 * Extension points: add operators to `ATTR_OPERATORS`, spatial relations to
 * `SPATIAL_RELATIONS`, and one `case` each in `ecql-builder.ts`. The nesting
 * model (`groups[]` of `conditions[]`) already compiles to arbitrarily
 * parenthesised ECQL — a future UI can expose deeper trees without changing
 * the compiler.
 */

export type LogicalOp = 'AND' | 'OR';

export type AttrOperator =
  | '='
  | '<>'
  | '>'
  | '<'
  | '>='
  | '<='
  | 'LIKE'
  | 'ILIKE'
  | 'IN'
  | 'BETWEEN'
  | 'IS NULL'
  | 'IS NOT NULL';

export type SpatialRelation =
  | 'INTERSECTS'
  | 'WITHIN'
  | 'CONTAINS'
  | 'OVERLAPS'
  | 'TOUCHES'
  | 'CROSSES'
  | 'DWITHIN';

export interface AttrOperatorDef {
  op: AttrOperator;
  label: string;
  /** how many value inputs the operator needs */
  arity: 0 | 1 | 2;
  /** operator only makes sense for these field types (empty = any) */
  types?: ('text' | 'integer' | 'number' | 'date' | 'boolean' | 'id')[];
}

export const ATTR_OPERATORS: AttrOperatorDef[] = [
  { op: '=', label: '=  equals', arity: 1 },
  { op: '<>', label: '≠  not equal', arity: 1 },
  { op: '>', label: '>  greater than', arity: 1, types: ['integer', 'number', 'date', 'id'] },
  { op: '<', label: '<  less than', arity: 1, types: ['integer', 'number', 'date', 'id'] },
  { op: '>=', label: '≥  at least', arity: 1, types: ['integer', 'number', 'date', 'id'] },
  { op: '<=', label: '≤  at most', arity: 1, types: ['integer', 'number', 'date', 'id'] },
  { op: 'LIKE', label: 'LIKE  (case-sensitive)', arity: 1, types: ['text'] },
  { op: 'ILIKE', label: 'ILIKE  (case-insensitive)', arity: 1, types: ['text'] },
  { op: 'IN', label: 'IN  (list)', arity: 1 },
  { op: 'BETWEEN', label: 'BETWEEN', arity: 2, types: ['integer', 'number', 'date', 'id'] },
  { op: 'IS NULL', label: 'is empty', arity: 0 },
  { op: 'IS NOT NULL', label: 'is not empty', arity: 0 }
];

export interface SpatialRelationDef {
  relation: SpatialRelation;
  label: string;
  hint: string;
  /** geometry kinds the user may supply for this relation */
  geometry: SpatialGeometryKind[];
}

export type SpatialGeometryKind = 'Point' | 'Line' | 'Rectangle' | 'Polygon';

export const SPATIAL_RELATIONS: SpatialRelationDef[] = [
  { relation: 'INTERSECTS', label: 'Intersects', hint: 'Features that touch or overlap the drawn shape', geometry: ['Rectangle', 'Polygon', 'Line', 'Point'] },
  { relation: 'WITHIN', label: 'Within', hint: 'Features completely inside the drawn shape', geometry: ['Rectangle', 'Polygon'] },
  { relation: 'CONTAINS', label: 'Contains', hint: 'Features that completely contain the drawn shape', geometry: ['Rectangle', 'Polygon', 'Point'] },
  { relation: 'OVERLAPS', label: 'Overlaps', hint: 'Features that partly cover the drawn shape', geometry: ['Rectangle', 'Polygon'] },
  { relation: 'TOUCHES', label: 'Touches', hint: 'Features that touch the boundary only', geometry: ['Rectangle', 'Polygon', 'Line'] },
  { relation: 'CROSSES', label: 'Crosses', hint: 'Features that cross the drawn line/shape', geometry: ['Line', 'Polygon'] },
  { relation: 'DWITHIN', label: 'Within distance', hint: 'Features within a set distance of the drawn shape', geometry: ['Point', 'Line', 'Polygon', 'Rectangle'] }
];

export interface AttrCondition {
  uid: string;
  field: string;
  operator: AttrOperator;
  /** raw text; for IN a comma list, for BETWEEN the lower bound */
  value: string;
  /** BETWEEN upper bound */
  value2: string;
}

export interface ConditionGroup {
  uid: string;
  /** how this group joins the previous one (ignored for the first group) */
  connector: LogicalOp;
  not: boolean;
  /** AND / OR between the conditions inside this group */
  innerConnector: LogicalOp;
  conditions: AttrCondition[];
}

export interface SpatialClause {
  enabled: boolean;
  relation: SpatialRelation;
  geometryKind: SpatialGeometryKind;
  source: 'draw' | 'selection';
  /** GeoJSON geometry, EPSG:4326 */
  geometry: GeoJsonGeometry | null;
  distance: number;
  distanceUnits: 'meters' | 'kilometers';
}

export interface QueryDefinition {
  layerId: string | null;
  groups: ConditionGroup[];
  spatial: SpatialClause;
}

export interface SavedQuery {
  id: string;
  name: string;
  createdAt: string;
  definition: QueryDefinition;
}

/** Result of compiling a QueryDefinition to ECQL. */
export interface EcqlResult {
  /** null when there is nothing to filter by (and no issues) */
  cql: string | null;
  issues: string[];
}

let uidSeq = 0;
export function nextUid(prefix = 'q'): string {
  uidSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidSeq}`;
}

export function emptyCondition(): AttrCondition {
  return { uid: nextUid('c'), field: '', operator: '=', value: '', value2: '' };
}

export function emptyGroup(connector: LogicalOp = 'AND'): ConditionGroup {
  return { uid: nextUid('g'), connector, not: false, innerConnector: 'AND', conditions: [emptyCondition()] };
}

export function emptySpatialClause(): SpatialClause {
  return {
    enabled: false,
    relation: 'INTERSECTS',
    geometryKind: 'Rectangle',
    source: 'draw',
    geometry: null,
    distance: 500,
    distanceUnits: 'meters'
  };
}

export function emptyQueryDefinition(layerId: string | null = null): QueryDefinition {
  return { layerId, groups: [emptyGroup()], spatial: emptySpatialClause() };
}
