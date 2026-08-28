import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { PostgisConnectionParams } from './geoserver.service';

const execFileAsync = promisify(execFile);

export class GdalError extends Error {}

export interface GdalField {
  name: string;
  /** Raw OGR field type string, e.g. "String", "Integer", "Real", "Date". */
  type: string;
}

export interface GdalInspectResult {
  driverShortName: string;
  layerName: string;
  /** Raw OGR geometry type string, e.g. "Point", "3D Multi Polygon", or
   *  null if the layer has no geometry field at all. */
  geometryType: string | null;
  featureCount: number;
  fields: GdalField[];
  /** EPSG numeric code if GDAL could confidently determine one from the
   *  source (native .prj, GeoJSON crs member, or an explicit override
   *  passed via openOptions/-s_srs) — see docs/backend.md "CRS handling".
   *  Null means "could not be determined", which callers must never
   *  silently paper over (Task 7 §8). */
  epsgCode: number | null;
}

export interface InspectOptions {
  /** GDAL/OGR `-oo KEY=VALUE` open options — used for CSV lat/lon or X/Y
   *  column selection (X_POSSIBLE_NAMES, Y_POSSIBLE_NAMES,
   *  KEEP_GEOM_COLUMNS=NO). */
  openOptions?: string[];
}

export interface ImportToPostgisParams {
  sourcePath: string;
  /** Always an application-generated `layer_<uuid>` name — see
   *  layer-naming.util.ts. Never derived from user input. */
  tableName: string;
  /** Storage/projected CRS to reproject into, e.g. "EPSG:32643" — the
   *  destination workspace's own defaultCrs. */
  targetCrs: string;
  /** Forces the source CRS rather than trusting whatever GDAL
   *  auto-detected from the file (a user-confirmed CRS, or the only
   *  legitimate way to give a CSV X/Y source a CRS — see docs/backend.md
   *  "CRS handling": never assume X/Y means WGS84). */
  sourceCrsOverride?: string;
  openOptions?: string[];
  connection: PostgisConnectionParams;
}

/**
 * Thin, argv-array-only wrapper around the GDAL/OGR command-line tools
 * (ogrinfo, ogr2ogr) — Task 7's GIS processing engine. Every invocation
 * uses `child_process.execFile` with arguments passed as an array, NEVER
 * a shell string, so nothing in an uploaded filename or field value can
 * ever be interpreted as a shell command. GDAL is not used as an npm
 * binding; there is no shapefile/GeoJSON/CSV parser of our own here — see
 * Task 7 §2 "Do not implement your own Shapefile parser."
 */
@Injectable()
export class GdalService {
  private readonly logger = new Logger(GdalService.name);

  /** Runs `ogrinfo -json -al -so` against a source file and returns a
   *  parsed summary. Never writes anything — read-only inspection, safe
   *  to call as many times as needed (e.g. on a validate retry). */
  async inspect(
    filePath: string,
    options: InspectOptions = {},
  ): Promise<GdalInspectResult> {
    const args = ['-json', '-al', '-so'];
    for (const oo of options.openOptions ?? []) {
      args.push('-oo', oo);
    }
    args.push(filePath);

    const stdout = await this.run('ogrinfo', args);

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new GdalError(
        'GDAL did not return a readable result for this file.',
      );
    }
    const root = parsed as {
      driverShortName?: string;
      layers?: {
        name: string;
        featureCount?: number;
        fields?: { name: string; type: string }[];
        geometryFields?: {
          type?: string;
          coordinateSystem?: {
            projjson?: { id?: { authority?: string; code?: number } };
          };
        }[];
      }[];
    };

    const layer = root.layers?.[0];
    if (!layer) {
      throw new GdalError('No layers were found in the uploaded file.');
    }
    const geomField = layer.geometryFields?.[0];
    const projId = geomField?.coordinateSystem?.projjson?.id;
    const epsgCode =
      projId?.authority === 'EPSG' && typeof projId.code === 'number'
        ? projId.code
        : null;

    return {
      driverShortName: root.driverShortName ?? 'unknown',
      layerName: layer.name,
      geometryType: geomField?.type ?? null,
      featureCount: layer.featureCount ?? 0,
      fields: (layer.fields ?? []).map((f) => ({ name: f.name, type: f.type })),
      epsgCode,
    };
  }

  /**
   * Runs `ogr2ogr` to import a source file into a fresh PostGIS table,
   * reprojecting to `targetCrs`. Always `-overwrite`s the destination
   * table — safe because `tableName` is always a brand-new,
   * application-generated name (see layer-naming.util.ts), never an
   * existing published layer's table. Geometries are promoted to their
   * Multi* equivalent (PROMOTE_TO_MULTI) for a consistent, predictable
   * PostGIS geometry type per layer. Column/table identifiers are quoted
   * and escaped internally by GDAL's PostgreSQL driver — this is what
   * satisfies Task 7 §10's "do not directly use uploaded field names to
   * construct SQL without sanitization" without us hand-writing any SQL.
   */
  async importToPostgis(params: ImportToPostgisParams): Promise<void> {
    const pgConnString = this.buildPgConnectionString(params.connection);
    const args = [
      '-f',
      'PostgreSQL',
      pgConnString,
      params.sourcePath,
      '-nln',
      params.tableName,
      '-lco',
      'GEOMETRY_NAME=geom',
      // Let GDAL create/manage its own synthetic primary key (the default
      // `ogc_fid`). We deliberately do NOT force `-lco FID=id`: real-world
      // municipal shapefiles very often carry their own attribute column
      // named `id` (of String/Real type), and forcing the target FID column
      // to `id` makes ogr2ogr try to populate the FID from that column and
      // abort the whole import with "ERROR 1: Wrong field type for id".
      // With the default, any source `id` column is imported as an ordinary
      // attribute (no data lost) and GeoServer still auto-detects the PK.
      // Shapefile DBF numeric fields declare a fixed width/precision (e.g.
      // 24 digits, 15 decimal places) that the PostgreSQL driver otherwise
      // maps straight to NUMERIC(23,15) — whose range tops out around 1e8,
      // far below what the declared width implies. Real-world municipal
      // data regularly has wide-but-imprecise Real fields (e.g. a
      // "total capacity" column) that overflow that NUMERIC and fail the
      // import with "numeric field overflow" even though the value is a
      // perfectly ordinary number. PRECISION=NO uses an unconstrained
      // numeric/double column instead, which both accepts the value and
      // loses no precision GDAL wasn't already storing.
      '-lco',
      'PRECISION=NO',
      '-nlt',
      'PROMOTE_TO_MULTI',
      '-t_srs',
      params.targetCrs,
      '-overwrite',
    ];
    if (params.sourceCrsOverride) {
      args.push('-s_srs', params.sourceCrsOverride);
    }
    for (const oo of params.openOptions ?? []) {
      args.push('-oo', oo);
    }

    await this.run('ogr2ogr', args, 120_000);
  }

  private async run(
    command: 'ogrinfo' | 'ogr2ogr',
    args: string[],
    timeoutMs = 30_000,
  ): Promise<string> {
    try {
      const { stdout } = await execFileAsync(command, args, {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const err = error as { stderr?: string; message: string };
      this.logger.warn(`${command} failed: ${err.stderr ?? err.message}`);
      throw new GdalError(this.summarizeGdalError(err.stderr ?? err.message));
    }
  }

  /** GDAL's raw stderr is verbose and can echo back file paths — reduce it
   *  to a single readable line for the upload's errorMessage/warnings. */
  private summarizeGdalError(raw: string): string {
    const firstLine = raw
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return firstLine ?? 'GDAL processing failed.';
  }

  private buildPgConnectionString(connection: PostgisConnectionParams): string {
    const quote = (value: string) =>
      `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    return [
      'PG:host=' + quote(connection.host),
      'port=' + quote(connection.port),
      'dbname=' + quote(connection.database),
      'user=' + quote(connection.user),
      'password=' + quote(connection.password),
      'active_schema=' + quote(connection.schema ?? 'public'),
    ].join(' ');
  }
}
