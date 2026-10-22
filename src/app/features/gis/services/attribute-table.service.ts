import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map, of } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { GisLayer } from '../../../core/models/gis-layer.model';
import {
  AttributeField,
  AttributeFieldType,
  AttributePage,
  AttributeQuery,
  AttributeRow,
  GeoJsonGeometry,
  HIDDEN_ATTRIBUTE_FIELDS
} from '../models/attribute-table.model';

interface WfsFeature {
  id?: string;
  geometry?: GeoJsonGeometry | null;
  geometry_name?: string;
  properties?: Record<string, unknown> | null;
}

interface WfsFeatureCollection {
  features?: WfsFeature[];
  numberMatched?: number;
  totalFeatures?: number;
  numberReturned?: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;
const ID_FIELD = /^(id|fid|gid|objectid|feature_id)$|_id$/i;

/**
 * Reads real attribute data for a published GIS layer straight from
 * GeoServer's public WFS endpoint (which serves it live from PostGIS).
 *
 * All heavy lifting is server-side so the table stays fast on large layers:
 * paging via `count`/`startIndex`, ordering via `sortBy`, text search via a
 * CQL `ILIKE` filter, and the matched-row total from `numberMatched`.
 *
 * `providedIn: 'root'` — stateless apart from a per-layer field cache; the
 * OpenLayers map instance stays in the component-scoped `MapService`.
 */
@Injectable({ providedIn: 'root' })
export class AttributeTableService {
  private readonly http = inject(HttpClient);

  /** field metadata per layer id, so re-paging / sorting doesn't re-infer */
  private readonly fieldCache = new Map<string, AttributeField[]>();
  private readonly geometryFieldCache = new Map<string, string>();

  getFields(layerId: string): AttributeField[] | undefined {
    return this.fieldCache.get(layerId);
  }

  getGeometryField(layerId: string): string {
    return this.geometryFieldCache.get(layerId) ?? 'geom';
  }

  clearCache(layerId: string): void {
    this.fieldCache.delete(layerId);
    this.geometryFieldCache.delete(layerId);
  }

  /** Field + geometry metadata for a layer, inferred from a sample of real
   *  rows (GeoServer's cached schema is not reliable here). Cached, so the
   *  Query Builder and Attribute Table share one describe call per layer. */
  loadMetadata(layer: GisLayer): Observable<{ fields: AttributeField[]; geometryField: string }> {
    const cachedFields = this.fieldCache.get(layer.id);
    if (cachedFields && cachedFields.length > 0) {
      return of({ fields: cachedFields, geometryField: this.getGeometryField(layer.id) });
    }
    const url = `${environment.geoserverUrl}/${layer.geoserverWorkspace}/wfs`;
    const params = new HttpParams()
      .set('service', 'WFS')
      .set('version', '2.0.0')
      .set('request', 'GetFeature')
      .set('typeNames', `${layer.geoserverWorkspace}:${layer.geoserverLayer}`)
      .set('outputFormat', 'application/json')
      .set('srsName', 'EPSG:4326')
      .set('count', '100');

    return this.http.get<WfsFeatureCollection>(url, { params }).pipe(
      map((collection) => {
        const fields = this.resolveFields(layer.id, collection.features ?? []);
        return { fields, geometryField: this.getGeometryField(layer.id) };
      })
    );
  }

  fetchPage(
    layer: GisLayer,
    query: AttributeQuery,
    options: { baseFilter?: string | null; featureIds?: string[] | null } = {}
  ): Observable<AttributePage> {
    const url = `${environment.geoserverUrl}/${layer.geoserverWorkspace}/wfs`;
    const typeName = `${layer.geoserverWorkspace}:${layer.geoserverLayer}`;

    let params = new HttpParams()
      .set('service', 'WFS')
      .set('version', '2.0.0')
      .set('request', 'GetFeature')
      .set('typeNames', typeName)
      .set('outputFormat', 'application/json')
      .set('srsName', 'EPSG:4326')
      .set('count', String(query.pageSize))
      .set('startIndex', String(query.page * query.pageSize));

    if (query.sortField) {
      // WFS 2.0: "<field> ASC|DESC" (space-separated). HttpParams encodes the
      // space; a literal "+" would be read as part of the property name.
      params = params.set('sortBy', `${query.sortField} ${query.sortDir === 'desc' ? 'DESC' : 'ASC'}`);
    }

    const cql = combineCql(
      options.featureIds ? featureIdFilter(options.featureIds) : null,
      this.recordFilter(layer.id, query.search, options.baseFilter)
    );
    if (cql) {
      params = params.set('cql_filter', cql);
    }

    return this.wfs(url, params).pipe(map((collection) => this.toPage(layer.id, collection)));
  }

  /** The CQL for the records the table currently lists: the locked query
   *  filter AND the free-text search (null = every record). */
  recordFilter(layerId: string, search: string, baseFilter?: string | null): string | null {
    return combineCql(baseFilter, this.buildSearchFilter(layerId, search));
  }

  /** Ids + geometry of every feature matching `cql` (null = all), capped at
   *  `limit` — used by Switch Selection. `total` is the full match count. */
  fetchIds(
    layer: GisLayer,
    geometryField: string,
    cql: string | null,
    limit: number
  ): Observable<{ rows: AttributeRow[]; total: number }> {
    const url = `${environment.geoserverUrl}/${layer.geoserverWorkspace}/wfs`;
    let params = new HttpParams()
      .set('service', 'WFS')
      .set('version', '2.0.0')
      .set('request', 'GetFeature')
      .set('typeNames', `${layer.geoserverWorkspace}:${layer.geoserverLayer}`)
      .set('outputFormat', 'application/json')
      .set('srsName', 'EPSG:4326')
      .set('propertyName', geometryField)
      .set('count', String(limit));
    if (cql) params = params.set('cql_filter', cql);

    return this.wfs(url, params).pipe(
      map((collection) => {
        const rows = (collection.features ?? [])
          .filter((feature): feature is WfsFeature & { id: string } => typeof feature.id === 'string')
          .map((feature) => ({ featureId: feature.id, values: {}, geometry: feature.geometry ?? null }));
        return { rows, total: collection.numberMatched ?? collection.totalFeatures ?? rows.length };
      })
    );
  }

  /** GET, or a form POST when the query is too long for a URL (a filter
   *  listing many selected feature ids). GeoServer reads both alike. */
  private wfs(url: string, params: HttpParams): Observable<WfsFeatureCollection> {
    const body = params.toString();
    return body.length > 1800
      ? this.http.post<WfsFeatureCollection>(url, body, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        })
      : this.http.get<WfsFeatureCollection>(url, { params });
  }

  /** Selection Tool: features of `layer` intersecting a drawn shape
   *  (EPSG:4326 WKT). Only the geometry column is requested — the ids and
   *  geometries are all a selection needs — capped at `limit`;
   *  `total` reports the full match count so callers can flag truncation. */
  fetchIdsInShape(
    layer: GisLayer,
    geometryField: string,
    wkt4326: string,
    limit: number
  ): Observable<{ rows: AttributeRow[]; total: number }> {
    return this.fetchIds(layer, geometryField, `INTERSECTS("${geometryField}", SRID=4326;${wkt4326})`, limit);
  }

  /** Fetches specific features by their WFS id — used to backfill geometry
   *  for selections made on the map whose row isn't on the current page. */
  fetchByIds(layer: GisLayer, featureIds: string[]): Observable<AttributeRow[]> {
    if (featureIds.length === 0) {
      return of([]);
    }
    const url = `${environment.geoserverUrl}/${layer.geoserverWorkspace}/wfs`;
    const params = new HttpParams()
      .set('service', 'WFS')
      .set('version', '2.0.0')
      .set('request', 'GetFeature')
      .set('typeNames', `${layer.geoserverWorkspace}:${layer.geoserverLayer}`)
      .set('outputFormat', 'application/json')
      .set('srsName', 'EPSG:4326')
      .set('featureID', featureIds.join(','));

    return this.wfs(url, params).pipe(
      map((collection) =>
        (collection.features ?? [])
          .filter((feature): feature is WfsFeature & { id: string } => typeof feature.id === 'string')
          .map((feature) => ({
            featureId: feature.id,
            values: feature.properties ?? {},
            geometry: feature.geometry ?? null
          }))
      )
    );
  }

  // ---------------------------------------------------------------------

  private toPage(layerId: string, collection: WfsFeatureCollection): AttributePage {
    const features = collection.features ?? [];
    const fields = this.resolveFields(layerId, features);

    const rows: AttributeRow[] = features
      .filter((feature): feature is WfsFeature & { id: string } => typeof feature.id === 'string')
      .map((feature) => ({
        featureId: feature.id,
        values: feature.properties ?? {},
        geometry: feature.geometry ?? null
      }));

    const total =
      collection.numberMatched ?? collection.totalFeatures ?? rows.length + (rows.length === 0 ? 0 : 0);

    return { rows, total, fields };
  }

  /** Cached field metadata wins; otherwise infer from this page and cache.
   *  A page with rows always yields the full property set (GeoServer emits
   *  every column, nulls included), so the first non-empty page is enough. */
  private resolveFields(layerId: string, features: WfsFeature[]): AttributeField[] {
    const geometryName = features.find((f) => f.geometry_name)?.geometry_name;
    if (geometryName) {
      this.geometryFieldCache.set(layerId, geometryName);
    }
    const cached = this.fieldCache.get(layerId);
    if (cached && cached.length > 0) {
      return cached;
    }
    if (features.length === 0) {
      return cached ?? [];
    }
    const fields = this.inferFields(features);
    this.fieldCache.set(layerId, fields);
    return fields;
  }

  private inferFields(features: WfsFeature[]): AttributeField[] {
    const keys: string[] = [];
    for (const feature of features) {
      for (const key of Object.keys(feature.properties ?? {})) {
        if (!HIDDEN_ATTRIBUTE_FIELDS.has(key) && !keys.includes(key)) {
          keys.push(key);
        }
      }
    }

    const fields = keys.map<AttributeField>((name) => {
      const present = features.map((feature) => feature.properties?.[name]);
      const values = present.filter((value) => value !== null && value !== undefined && value !== '');
      return {
        name,
        label: this.humanize(name),
        type: this.inferType(name, values),
        nullable: present.some((value) => value === null || value === undefined)
      };
    });

    // id-like fields first (ArcGIS convention), rest in source order
    return fields.sort((a, b) => Number(b.type === 'id') - Number(a.type === 'id'));
  }

  private inferType(name: string, values: unknown[]): AttributeFieldType {
    if (values.length === 0) {
      return 'text';
    }

    const numeric = values.every(
      (value) =>
        typeof value === 'number' ||
        (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)))
    );
    if (numeric) {
      const integer = values.every((value) => Number.isInteger(Number(value)));
      if (integer && ID_FIELD.test(name)) {
        return 'id';
      }
      return integer ? 'integer' : 'number';
    }

    const boolean = values.every(
      (value) => typeof value === 'boolean' || value === 'true' || value === 'false'
    );
    if (boolean) {
      return 'boolean';
    }

    const date = values.every(
      (value) => typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))
    );
    if (date) {
      return 'date';
    }

    return 'text';
  }

  private buildSearchFilter(layerId: string, search: string): string | null {
    const term = search.trim();
    if (term.length < 1) {
      return null;
    }
    const fields = this.fieldCache.get(layerId) ?? [];
    const clauses: string[] = [];

    // free text over string columns. Field names are double-quoted so a
    // column called "id" isn't read as ECQL's feature-id keyword.
    const literal = term.replace(/'/g, "''");
    for (const field of fields) {
      if (field.type === 'text') {
        clauses.push(`"${field.name}" ILIKE '%${literal}%'`);
      }
    }

    // a bare number also matches id / integer columns exactly
    if (/^-?\d+$/.test(term)) {
      for (const field of fields) {
        if (field.type === 'id' || field.type === 'integer') {
          clauses.push(`"${field.name}" = ${term}`);
        }
      }
    }

    return clauses.length > 0 ? clauses.join(' OR ') : null;
  }

  private humanize(key: string): string {
    return key
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
      .trim();
  }
}

/** ECQL feature-id filter: `IN ('roads.1', 'roads.7')`. */
export function featureIdFilter(ids: string[]): string {
  return `IN (${ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')})`;
}

/** AND-combines two optional CQL fragments. */
export function combineCql(a?: string | null, b?: string | null): string | null {
  const parts = [a, b].filter((p): p is string => !!p && p.trim().length > 0);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return parts.map((p) => `(${p})`).join(' AND ');
}
