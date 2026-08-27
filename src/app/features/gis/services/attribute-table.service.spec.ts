import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { AttributeTableService } from './attribute-table.service';
import { GisLayer } from '../../../core/models/gis-layer.model';
import { DEFAULT_ATTRIBUTE_QUERY } from '../models/attribute-table.model';
import { environment } from '../../../../environments/environment';

const LAYER: GisLayer = {
  id: 'layer-1',
  name: 'Wards',
  code: 'WARDS',
  description: null,
  layerType: 'VECTOR',
  geoserverWorkspace: 'demo_city',
  geoserverLayer: 'wards',
  geometryType: 'POLYGON',
  visibleByDefault: true,
  displayOrder: 0,
  ownershipType: 'CANONICAL',
  departmentId: null,
  departmentName: null,
  version: 1,
  bbox: null
};

const WFS_PAGE = {
  type: 'FeatureCollection',
  numberMatched: 42,
  numberReturned: 2,
  features: [
    {
      type: 'Feature',
      id: 'wards.5',
      geometry: { type: 'Point', coordinates: [75, 20] },
      properties: {
        id: 5,
        gis_workspace_id: 'ws-abc',
        name: 'Ward 1',
        ward_number: 1,
        area_sqkm: 12.5,
        surveyed_on: '2026-01-15',
        active: true
      }
    },
    {
      type: 'Feature',
      id: 'wards.6',
      geometry: { type: 'Point', coordinates: [75.1, 20.1] },
      properties: {
        id: 6,
        gis_workspace_id: 'ws-abc',
        name: 'Ward 2',
        ward_number: null,
        area_sqkm: 8,
        surveyed_on: '2026-02-01',
        active: false
      }
    }
  ]
};

describe('AttributeTableService', () => {
  let service: AttributeTableService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [AttributeTableService, provideHttpClient(), provideHttpClientTesting()]
    });
    service = TestBed.inject(AttributeTableService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('paginates, sorts and requests EPSG:4326 geometry from WFS', () => {
    service
      .fetchPage(LAYER, { ...DEFAULT_ATTRIBUTE_QUERY, page: 2, pageSize: 25, sortField: 'name', sortDir: 'desc' })
      .subscribe();

    const req = httpMock.expectOne((r) => r.url === `${environment.geoserverUrl}/demo_city/wfs`);
    expect(req.request.params.get('typeNames')).toBe('demo_city:wards');
    expect(req.request.params.get('count')).toBe('25');
    expect(req.request.params.get('startIndex')).toBe('50');
    expect(req.request.params.get('srsName')).toBe('EPSG:4326');
    expect(req.request.params.get('sortBy')).toBe('name DESC');
    req.flush(WFS_PAGE);
  });

  it('maps rows, keeps the total, and hides internal fields', (done) => {
    service.fetchPage(LAYER, DEFAULT_ATTRIBUTE_QUERY).subscribe((page) => {
      expect(page.total).toBe(42);
      expect(page.rows.length).toBe(2);
      expect(page.rows[0].featureId).toBe('wards.5');
      expect(page.rows[0].geometry).toEqual({ type: 'Point', coordinates: [75, 20] });
      expect(page.fields.map((f) => f.name)).not.toContain('gis_workspace_id');
      done();
    });
    httpMock.expectOne((r) => r.url.endsWith('/wfs')).flush(WFS_PAGE);
  });

  it('infers field types from values', (done) => {
    service.fetchPage(LAYER, DEFAULT_ATTRIBUTE_QUERY).subscribe((page) => {
      const byName = Object.fromEntries(page.fields.map((f) => [f.name, f]));
      expect(byName['id'].type).toBe('id');
      expect(byName['name'].type).toBe('text');
      expect(byName['ward_number'].type).toBe('integer');
      expect(byName['ward_number'].nullable).toBe(true);
      expect(byName['area_sqkm'].type).toBe('number');
      expect(byName['surveyed_on'].type).toBe('date');
      expect(byName['active'].type).toBe('boolean');
      done();
    });
    httpMock.expectOne((r) => r.url.endsWith('/wfs')).flush(WFS_PAGE);
  });

  it('builds a quoted CQL filter over text and numeric columns for a search term', () => {
    // prime the field cache
    service.fetchPage(LAYER, DEFAULT_ATTRIBUTE_QUERY).subscribe();
    httpMock.expectOne((r) => r.url.endsWith('/wfs')).flush(WFS_PAGE);

    service.fetchPage(LAYER, { ...DEFAULT_ATTRIBUTE_QUERY, search: '2' }).subscribe();
    const req = httpMock.expectOne((r) => r.params.has('cql_filter'));
    const cql = req.request.params.get('cql_filter') ?? '';
    expect(cql).toContain(`"name" ILIKE '%2%'`);
    expect(cql).toContain(`"id" = 2`);
    expect(cql).toContain(`"ward_number" = 2`);
    req.flush(WFS_PAGE);
  });

  it('fetchByIds requests the given features with geometry', (done) => {
    service.fetchByIds(LAYER, ['wards.5', 'wards.6']).subscribe((rows) => {
      expect(rows.map((r) => r.featureId)).toEqual(['wards.5', 'wards.6']);
      done();
    });
    const req = httpMock.expectOne((r) => r.params.get('featureID') === 'wards.5,wards.6');
    expect(req.request.params.get('srsName')).toBe('EPSG:4326');
    req.flush(WFS_PAGE);
  });
});
