import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { AttributeTableService } from './attribute-table.service';
import { GisLayer } from '../../../core/models/gis-layer.model';
import { GeoJsonGeometry } from '../models/attribute-table.model';

export interface QueryExecution {
  /** total features matching the filter (ignores the preview cap) */
  total: number;
  /** geometries (EPSG:4326) for the map highlight, capped at `previewLimit` */
  geometries: GeoJsonGeometry[];
  /** true when `total` exceeds what was fetched for the highlight */
  truncated: boolean;
}

interface WfsCollection {
  features?: { geometry?: GeoJsonGeometry | null }[];
  numberMatched?: number;
  totalFeatures?: number;
}

/**
 * Runs a compiled ECQL query (via the backend, straight from PostGIS): the matched-record total
 * plus a bounded batch of geometries for the map highlight. The Attribute
 * Table pages the same filter server-side, and the WMS layer renders it via
 * `CQL_FILTER` — so nothing here loads the full result set.
 */
@Injectable({ providedIn: 'root' })
export class QueryService {
  private readonly records = inject(AttributeTableService);

  /** highlight cap — enough to be useful, small enough to stay responsive */
  readonly previewLimit = 1000;

  execute(layer: GisLayer, cql: string): Observable<QueryExecution> {
    // Geometries only — the backend reads PostGIS after a permission check.
    return this.records.records(layer, { filter: cql, limit: this.previewLimit, properties: false }).pipe(
      map((collection: WfsCollection) => {
        const features = collection.features ?? [];
        const total = collection.numberMatched ?? collection.totalFeatures ?? features.length;
        const geometries = features
          .map((feature) => feature.geometry)
          .filter((geometry): geometry is GeoJsonGeometry => !!geometry);
        return { total, geometries, truncated: total > geometries.length };
      })
    );
  }

  /** All (up to `previewLimit`) geometries of a layer, EPSG:4326 — used as
   *  an operand for the Overlay tool ("this whole layer"). */
  layerGeometries(layer: GisLayer): Observable<GeoJsonGeometry[]> {
    return this.execute(layer, '').pipe(map((execution) => execution.geometries));
  }
}
