import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { GeoJsonGeometry } from '../models/attribute-table.model';

export type OverlayOp = 'intersection' | 'union' | 'difference';
export type BufferCap = 'round' | 'flat' | 'square';

/**
 * Thin client for GeoServer's WPS (Web Processing Service) — the stack's
 * server-side GIS processing engine. All geometry maths (buffer, overlay)
 * runs in GeoServer / JTS, never in the browser.
 *
 * Geometry in / out is WKT / GeoJSON in **EPSG:3857** (the map projection),
 * so the caller works in one CRS end to end. Buffer distances are corrected
 * for Web-Mercator scale at the geometry's latitude so the result is a true
 * ground-distance buffer.
 *
 * Adding another process (e.g. `JTS:simplify`, convex hull, voronoi) is one
 * method here — the panel never touches WPS XML.
 */
@Injectable({ providedIn: 'root' })
export class WpsService {
  private readonly http = inject(HttpClient);
  private readonly endpoint = `${environment.geoserverUrl}/wps`;

  /**
   * Buffers a geometry by `groundMetres`. `latitudeDeg` is the geometry's
   * approximate latitude — used to convert the ground distance into
   * EPSG:3857 units (`d / cos(lat)`).
   */
  buffer(
    wkt3857: string,
    groundMetres: number,
    latitudeDeg: number,
    capStyle: BufferCap = 'round'
  ): Observable<GeoJsonGeometry> {
    const cos = Math.max(Math.cos((latitudeDeg * Math.PI) / 180), 1e-6);
    const distance3857 = groundMetres / cos;
    const xml = wpsExecute('JTS:buffer', [
      complexInput('geom', wkt3857),
      literalInput('distance', String(distance3857)),
      literalInput('quadrantSegments', '24'),
      literalInput('capStyle', capStyle)
    ]);
    return this.run(xml).pipe(map((geometry) => geometry ?? emptyPolygon()));
  }

  /**
   * Runs a boolean overlay of two geometries. Returns `null` for an empty
   * result (e.g. an intersection of geometries that don't overlap).
   * "Clip" is the same operation as intersection.
   */
  overlay(op: OverlayOp, wktA3857: string, wktB3857: string): Observable<GeoJsonGeometry | null> {
    const xml =
      op === 'union'
        ? wpsExecute('JTS:union', [complexInput('geom', wktA3857), complexInput('geom', wktB3857)])
        : wpsExecute(`JTS:${op}`, [complexInput('a', wktA3857), complexInput('b', wktB3857)]);
    return this.run(xml);
  }

  /** Dissolves several geometries into one (EPSG:3857 WKT in / GeoJSON out).
   *  Used to turn "a whole layer" into a single overlay operand. */
  union(wkts3857: string[]): Observable<GeoJsonGeometry | null> {
    if (wkts3857.length === 0) {
      return new Observable((subscriber) => {
        subscriber.next(null);
        subscriber.complete();
      });
    }
    if (wkts3857.length === 1) {
      const xml = wpsExecute('JTS:union', [
        complexInput('geom', wkts3857[0]),
        complexInput('geom', wkts3857[0])
      ]);
      return this.run(xml);
    }
    const xml = wpsExecute(
      'JTS:union',
      wkts3857.map((wkt) => complexInput('geom', wkt))
    );
    return this.run(xml);
  }

  // ---------------------------------------------------------------------

  private run(xml: string): Observable<GeoJsonGeometry | null> {
    return this.http
      .post(this.endpoint, xml, {
        headers: new HttpHeaders({ 'Content-Type': 'application/xml' }),
        responseType: 'text'
      })
      .pipe(map((body) => parseWpsResult(body)));
  }
}

// ---------- WKT helpers ----------

/** OL geometry-collection style union operand for many geometries. */
export function geometryCollectionWkt(members: string[]): string {
  return `GEOMETRYCOLLECTION(${members.join(', ')})`;
}

// ---------- pure XML build / parse (exported for tests) ----------

export function wpsExecute(identifier: string, inputs: string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<wps:Execute version="1.0.0" service="WPS" ` +
    `xmlns:wps="http://www.opengis.net/wps/1.0.0" xmlns:ows="http://www.opengis.net/ows/1.1">` +
    `<ows:Identifier>${identifier}</ows:Identifier>` +
    `<wps:DataInputs>${inputs.join('')}</wps:DataInputs>` +
    `<wps:ResponseForm>` +
    `<wps:RawDataOutput mimeType="application/json"><ows:Identifier>result</ows:Identifier></wps:RawDataOutput>` +
    `</wps:ResponseForm></wps:Execute>`
  );
}

function complexInput(name: string, wkt: string): string {
  return (
    `<wps:Input><ows:Identifier>${name}</ows:Identifier><wps:Data>` +
    `<wps:ComplexData mimeType="application/wkt"><![CDATA[${wkt}]]></wps:ComplexData>` +
    `</wps:Data></wps:Input>`
  );
}

function literalInput(name: string, value: string): string {
  return `<wps:Input><ows:Identifier>${name}</ows:Identifier><wps:Data><wps:LiteralData>${value}</wps:LiteralData></wps:Data></wps:Input>`;
}

export function parseWpsResult(body: string): GeoJsonGeometry | null {
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const geometry = JSON.parse(trimmed) as GeoJsonGeometry;
    return isEmptyGeometry(geometry) ? null : geometry;
  }
  const match = /<ows:ExceptionText>([\s\S]*?)<\/ows:ExceptionText>/.exec(trimmed);
  throw new Error(match ? match[1].trim() : 'The GIS processing service returned an unexpected response.');
}

export function isEmptyGeometry(geometry: GeoJsonGeometry | null | undefined): boolean {
  if (!geometry) return true;
  const type = geometry['type'] as string;
  if (type === 'GeometryCollection') {
    const parts = (geometry['geometries'] as unknown[]) ?? [];
    return parts.length === 0;
  }
  const coords = flatten(geometry['coordinates']);
  return coords.length === 0;
}

function flatten(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(flatten);
  return [];
}

function emptyPolygon(): GeoJsonGeometry {
  return { type: 'Polygon', coordinates: [] };
}
