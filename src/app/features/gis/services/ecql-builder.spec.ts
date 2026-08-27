import { AttributeField } from '../models/attribute-table.model';
import {
  buildAttributeEcql,
  buildSpatialEcql,
  compileQuery,
  conditionToEcql,
  geoJsonToWkt
} from './ecql-builder';
import {
  ConditionGroup,
  QueryDefinition,
  SpatialClause,
  emptySpatialClause,
  nextUid
} from '../models/query-builder.model';

const FIELDS: AttributeField[] = [
  { name: 'id', label: 'Id', type: 'id', nullable: false },
  { name: 'population', label: 'Population', type: 'integer', nullable: true },
  { name: 'ward', label: 'Ward', type: 'text', nullable: false },
  { name: 'area', label: 'Area', type: 'number', nullable: true },
  { name: 'surveyed_on', label: 'Surveyed On', type: 'date', nullable: true }
];

const field = (name: string) => FIELDS.find((f) => f.name === name)!;

function group(partial: Partial<ConditionGroup>): ConditionGroup {
  return {
    uid: nextUid('g'),
    connector: 'AND',
    not: false,
    innerConnector: 'AND',
    conditions: [],
    ...partial
  };
}

function cond(f: string, operator: string, value = '', value2 = '') {
  return { uid: nextUid('c'), field: f, operator: operator as never, value, value2 };
}

describe('ecql-builder', () => {
  describe('conditionToEcql', () => {
    it('quotes identifiers and string literals', () => {
      expect(conditionToEcql(cond('ward', '=', '1'), field('ward'))).toEqual({ text: `"ward" = '1'` });
    });

    it('leaves numeric values unquoted', () => {
      expect(conditionToEcql(cond('population', '>', '100000'), field('population'))).toEqual({
        text: `"population" > 100000`
      });
    });

    it('rejects a non-numeric value on a numeric field', () => {
      expect(conditionToEcql(cond('population', '>', 'lots'), field('population'))).toEqual({
        error: '"Population" only takes numbers.'
      });
    });

    it('auto-wraps LIKE patterns and escapes quotes', () => {
      expect(conditionToEcql(cond('ward', 'ILIKE', "O'Brien"), field('ward'))).toEqual({
        text: `"ward" ILIKE '%O''Brien%'`
      });
    });

    it('builds IN lists', () => {
      expect(conditionToEcql(cond('ward', 'IN', '1, 2, 3'), field('ward'))).toEqual({
        text: `"ward" IN ('1', '2', '3')`
      });
    });

    it('builds BETWEEN with two bounds', () => {
      expect(conditionToEcql(cond('population', 'BETWEEN', '10', '20'), field('population'))).toEqual({
        text: `"population" BETWEEN 10 AND 20`
      });
    });

    it('handles IS NULL with no value', () => {
      expect(conditionToEcql(cond('area', 'IS NULL'), field('area'))).toEqual({ text: `"area" IS NULL` });
    });
  });

  describe('buildAttributeEcql', () => {
    it('produces Population > 100000 AND (Ward = 1 OR Ward = 2)', () => {
      const groups: ConditionGroup[] = [
        group({ conditions: [cond('population', '>', '100000')] }),
        group({
          connector: 'AND',
          innerConnector: 'OR',
          conditions: [cond('ward', '=', '1'), cond('ward', '=', '2')]
        })
      ];
      const result = buildAttributeEcql(groups, FIELDS);
      expect(result.issues).toEqual([]);
      expect(result.cql).toBe(`("population" > 100000) AND (("ward" = '1' OR "ward" = '2'))`);
    });

    it('applies NOT to a group', () => {
      const groups = [group({ not: true, conditions: [cond('ward', '=', '9')] })];
      expect(buildAttributeEcql(groups, FIELDS).cql).toBe(`NOT ("ward" = '9')`);
    });

    it('surfaces a validation issue for a blank field', () => {
      const groups = [group({ conditions: [cond('', '=', 'x')] })];
      const result = buildAttributeEcql(groups, FIELDS);
      expect(result.cql).toBeNull();
      expect(result.issues.length).toBeGreaterThan(0);
    });
  });

  describe('buildSpatialEcql', () => {
    const polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [75, 20],
          [76, 20],
          [76, 21],
          [75, 20]
        ]
      ]
    };

    it('is a no-op when disabled', () => {
      expect(buildSpatialEcql(emptySpatialClause(), 'geom')).toEqual({ cql: null, issues: [] });
    });

    it('requires a geometry when enabled', () => {
      const clause: SpatialClause = { ...emptySpatialClause(), enabled: true };
      expect(buildSpatialEcql(clause, 'geom').issues.length).toBe(1);
    });

    it('builds an INTERSECTS predicate with an SRID-tagged WKT literal', () => {
      const clause: SpatialClause = {
        ...emptySpatialClause(),
        enabled: true,
        relation: 'INTERSECTS',
        geometry: polygon
      };
      expect(buildSpatialEcql(clause, 'geom').cql).toBe(
        `INTERSECTS("geom", SRID=4326;POLYGON((75 20, 76 20, 76 21, 75 20)))`
      );
    });

    it('builds DWITHIN with distance + units', () => {
      const clause: SpatialClause = {
        ...emptySpatialClause(),
        enabled: true,
        relation: 'DWITHIN',
        geometry: { type: 'Point', coordinates: [75, 20] },
        distance: 500,
        distanceUnits: 'meters'
      };
      expect(buildSpatialEcql(clause, 'geom').cql).toBe(
        `DWITHIN("geom", SRID=4326;POINT(75 20), 500, meters)`
      );
    });
  });

  describe('compileQuery', () => {
    it('AND-joins attribute and spatial parts', () => {
      const def: QueryDefinition = {
        layerId: 'L',
        groups: [group({ conditions: [cond('population', '>=', '1000')] })],
        spatial: {
          ...emptySpatialClause(),
          enabled: true,
          relation: 'WITHIN',
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }
        }
      };
      const result = compileQuery(def, FIELDS, 'geom');
      expect(result.issues).toEqual([]);
      expect(result.cql).toBe(
        `("population" >= 1000) AND (WITHIN("geom", SRID=4326;POLYGON((0 0, 1 0, 1 1, 0 0))))`
      );
    });

    it('reports when nothing has been entered', () => {
      const def: QueryDefinition = { layerId: 'L', groups: [group({ conditions: [cond('', '=')] })], spatial: emptySpatialClause() };
      expect(compileQuery(def, FIELDS, 'geom').cql).toBeNull();
    });
  });

  describe('geoJsonToWkt', () => {
    it('rounds coordinates and formats rings', () => {
      expect(
        geoJsonToWkt({ type: 'LineString', coordinates: [[75.123456789, 20.1], [75.2, 20.2]] })
      ).toBe('LINESTRING(75.12345679 20.1, 75.2 20.2)');
    });
  });
});
