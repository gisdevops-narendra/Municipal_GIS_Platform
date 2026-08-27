import { isEmptyGeometry, parseWpsResult, wpsExecute, geometryCollectionWkt } from './wps.service';

describe('wps.service pure helpers', () => {
  describe('wpsExecute', () => {
    it('builds a WPS 1.0.0 Execute document with the given identifier and inputs', () => {
      const xml = wpsExecute('JTS:buffer', ['<in/>', '<in2/>']);
      expect(xml).toContain('<wps:Execute version="1.0.0" service="WPS"');
      expect(xml).toContain('<ows:Identifier>JTS:buffer</ows:Identifier>');
      expect(xml).toContain('<wps:DataInputs><in/><in2/></wps:DataInputs>');
      expect(xml).toContain('RawDataOutput mimeType="application/json"');
    });
  });

  describe('geometryCollectionWkt', () => {
    it('wraps members in a GEOMETRYCOLLECTION', () => {
      expect(geometryCollectionWkt(['POINT(1 2)', 'POINT(3 4)'])).toBe(
        'GEOMETRYCOLLECTION(POINT(1 2), POINT(3 4))'
      );
    });
  });

  describe('parseWpsResult', () => {
    it('parses a GeoJSON geometry body', () => {
      const geometry = parseWpsResult('{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}');
      expect(geometry).toEqual({
        type: 'Polygon',
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]
      });
    });

    it('returns null for an empty geometry', () => {
      expect(parseWpsResult('{"type":"Polygon","coordinates":[[]]}')).toBeNull();
      expect(parseWpsResult('{"type":"GeometryCollection","geometries":[]}')).toBeNull();
    });

    it('throws with the service exception text for an OWS ExceptionReport', () => {
      const body =
        '<ows:ExceptionReport><ows:Exception><ows:ExceptionText>Bad geom</ows:ExceptionText></ows:Exception></ows:ExceptionReport>';
      expect(() => parseWpsResult(body)).toThrowError('Bad geom');
    });

    it('throws a generic message for an unrecognised body', () => {
      expect(() => parseWpsResult('<html>gateway timeout</html>')).toThrowError(
        /unexpected response/
      );
    });
  });

  describe('isEmptyGeometry', () => {
    it('treats null / undefined / empty coordinate sets as empty', () => {
      expect(isEmptyGeometry(null)).toBe(true);
      expect(isEmptyGeometry(undefined)).toBe(true);
      expect(isEmptyGeometry({ type: 'Polygon', coordinates: [] })).toBe(true);
      expect(isEmptyGeometry({ type: 'Polygon', coordinates: [[]] })).toBe(true);
      expect(isEmptyGeometry({ type: 'GeometryCollection', geometries: [] })).toBe(true);
    });

    it('treats a geometry with coordinates as non-empty', () => {
      expect(isEmptyGeometry({ type: 'Point', coordinates: [1, 2] })).toBe(false);
      expect(
        isEmptyGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] })
      ).toBe(false);
    });
  });
});
