import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { MongoClient, type Document } from 'mongodb';
import type { AppUser } from '../auth/types/app-user.type';
import type { ExternalDbConnectionDto, ExternalDbImportDto } from './dto/external-db.dto';
import { GisUploadsService } from './gis-uploads.service';
import { StorageService } from './storage.service';

const execFileAsync = promisify(execFile);

export interface ExternalField {
  name: string;
  type: string;
}

/** A table (SQL) or collection (MongoDB) the user can import. */
export interface ExternalDataset {
  name: string;
  schema: string | null;
  table: string;
  /** Geometry column / GeoJSON field, null for a plain table. */
  geometryField: string | null;
  geometryType: string | null;
  /** "EPSG:4326", or null when the CRS has no EPSG code / is unknown. */
  crs: string | null;
  featureCount: number | null;
  fields: ExternalField[];
}

export interface ExternalPreview {
  dataset: ExternalDataset;
  /** Attribute values, plus `__geometry` = the record's geometry type. */
  rows: Record<string, unknown>[];
}

const PREVIEW_ROWS = 20;
const MONGO_SAMPLE = 200;
const MAX_DATASETS = 500;

/**
 * Reads spatial data from a user's own database (PostgreSQL/PostGIS and
 * MySQL/MariaDB through GDAL, MongoDB through its official driver) and
 * hands the chosen table to GisUploadsService as a GeoJSON or CSV "file",
 * so it goes through exactly the same validation, column review, approval
 * and publish workflow as an uploaded file.
 *
 * Credentials arrive with each request and are never stored or logged.
 * GDAL is run with argv arrays (never a shell); PostgreSQL credentials go
 * through libpq environment variables so they stay out of the command
 * line. The platform's own database is refused.
 */
@Injectable()
export class ExternalDbService {
  private readonly logger = new Logger(ExternalDbService.name);
  private readonly maxFeatures: number;

  constructor(
    private readonly config: ConfigService,
    private readonly uploads: GisUploadsService,
    private readonly storage: StorageService,
  ) {
    this.maxFeatures = Number(this.config.get<string>('EXTERNAL_DB_MAX_FEATURES', '1000000'));
  }

  async test(conn: ExternalDbConnectionDto): Promise<{ message: string; datasetCount: number; spatialCount: number }> {
    const datasets = await this.datasets(conn);
    const spatial = datasets.filter((d) => d.geometryField).length;
    return {
      message: `Connected to ${conn.database} on ${conn.host}:${conn.port} — ${datasets.length} tables / collections, ${spatial} with geometry.`,
      datasetCount: datasets.length,
      spatialCount: spatial,
    };
  }

  async datasets(conn: ExternalDbConnectionDto): Promise<ExternalDataset[]> {
    await this.assertNotPlatformDb(conn);
    const list = conn.type === 'MONGODB' ? await this.mongoDatasets(conn) : await this.gdalDatasets(conn);
    // Spatial first, then by name.
    return list
      .sort((a, b) => Number(!a.geometryField) - Number(!b.geometryField) || a.name.localeCompare(b.name))
      .slice(0, MAX_DATASETS);
  }

  async preview(conn: ExternalDbConnectionDto, dataset: string): Promise<ExternalPreview> {
    await this.assertNotPlatformDb(conn);
    return conn.type === 'MONGODB' ? this.mongoPreview(conn, dataset) : this.gdalPreview(conn, dataset);
  }

  /** Extracts the dataset and creates an upload from it. */
  async import(appUser: AppUser, dto: ExternalDbImportDto) {
    const { connection: conn, dataset, geometryField, fields, limit, ...upload } = dto;
    await this.assertNotPlatformDb(conn);
    if (limit && limit > this.maxFeatures) {
      throw new BadRequestException(`Import at most ${this.maxFeatures.toLocaleString()} records at a time.`);
    }
    const byCoordinates = !!(upload.latitudeField || upload.longitudeField || upload.xField || upload.yField);
    if (byCoordinates && !((upload.latitudeField && upload.longitudeField) || (upload.xField && upload.yField))) {
      throw new BadRequestException('Choose both coordinate columns (latitude + longitude, or X + Y).');
    }
    const extracted =
      conn.type === 'MONGODB'
        ? await this.mongoExtract(conn, dataset, { geometryField, fields, limit, byCoordinates, upload })
        : await this.gdalExtract(conn, dataset, { fields, limit, byCoordinates, upload });

    const base = `${conn.type.toLowerCase()}_${conn.database}_${dataset}`.replace(/[^\w.-]+/g, '_').slice(0, 120);
    const file = {
      originalname: `${base}.${extracted.format}`,
      buffer: extracted.buffer,
      size: extracted.buffer.length,
      mimetype: extracted.format === 'csv' ? 'text/csv' : 'application/geo+json',
    } as Express.Multer.File;
    return this.uploads.create(appUser, upload, file);
  }

  // ---------------------------------------------------------------- GDAL

  private async gdalDatasets(conn: ExternalDbConnectionDto): Promise<ExternalDataset[]> {
    const args = ['-json', '-so', '-ro', '-nomd'];
    let schemas: string[] = [];
    if (conn.type === 'POSTGRESQL') {
      args.push('-oo', 'LIST_ALL_TABLES=YES');
      schemas = (conn.schemas ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (schemas.length) args.push('-oo', `SCHEMAS=${schemas.join(',')}`);
    }
    const root = JSON.parse(await this.gdal('ogrinfo', [...args, this.dsn(conn)], conn, 90_000)) as {
      layers?: OgrLayer[];
    };
    // With a single schema GDAL drops the "schema." prefix — put it back,
    // since later calls (preview, import) are made without SCHEMAS.
    const only = schemas.length === 1 && schemas[0] !== 'public' ? schemas[0] : null;
    return (root.layers ?? [])
      .map((l) => (only && !l.name.includes('.') ? { ...l, name: `${only}.${l.name}` } : l))
      .filter((l) => conn.type !== 'POSTGRESQL' || !/^(pg_catalog|information_schema)\./.test(l.name))
      .map((l) => this.toDataset(l, conn.type === 'POSTGRESQL'));
  }

  private async gdalPreview(conn: ExternalDbConnectionDto, dataset: string): Promise<ExternalPreview> {
    const info = await this.gdalLayer(conn, dataset);
    const out = await this.gdal(
      'ogr2ogr',
      ['-f', 'GeoJSON', '/vsistdout/', this.dsn(conn), dataset, '-limit', String(PREVIEW_ROWS)],
      conn,
      60_000,
    );
    const fc = JSON.parse(out) as { features?: { geometry?: { type?: string } | null; properties?: Record<string, unknown> }[] };
    const rows = (fc.features ?? []).map((f) => ({
      ...(f.properties ?? {}),
      ...(info.geometryField ? { __geometry: f.geometry?.type ?? null } : {}),
    }));
    return { dataset: info, rows };
  }

  private async gdalExtract(
    conn: ExternalDbConnectionDto,
    dataset: string,
    opts: { fields?: string[]; limit?: number; byCoordinates: boolean; upload: Partial<ExternalDbImportDto> },
  ): Promise<{ buffer: Buffer; format: 'geojson' | 'csv' }> {
    const info = await this.gdalLayer(conn, dataset);
    const asCsv = !info.geometryField || opts.byCoordinates;
    if (asCsv && !opts.byCoordinates) {
      throw new BadRequestException(
        `"${dataset}" has no geometry column — choose its latitude / longitude or X / Y columns.`,
      );
    }
    this.checkCount(info.featureCount, opts.limit);
    const names = new Set(info.fields.map((f) => f.name));
    let fields = opts.fields?.length ? opts.fields : null;
    if (fields) {
      const unknown = fields.filter((f) => !names.has(f));
      if (unknown.length) throw new BadRequestException(`Unknown fields: ${unknown.join(', ')}.`);
      if (asCsv) {
        // The coordinate columns must survive the field selection.
        const u = opts.upload;
        const coords = [u.latitudeField, u.longitudeField, u.xField, u.yField].filter((c): c is string => !!c);
        fields = [...new Set([...fields, ...coords])];
      }
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extdb-'));
    const out = path.join(dir, asCsv ? 'data.csv' : 'data.geojson');
    try {
      const args = ['-f', asCsv ? 'CSV' : 'GeoJSON', out, this.dsn(conn), dataset];
      if (fields) args.push('-select', fields.join(','));
      args.push('-limit', String(opts.limit ?? this.maxFeatures));
      if (asCsv) args.push('-lco', 'GEOMETRY=NONE');
      await this.gdal('ogr2ogr', args, conn, 600_000);
      return { buffer: await this.readCapped(out), format: asCsv ? 'csv' : 'geojson' };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  private async gdalLayer(conn: ExternalDbConnectionDto, dataset: string): Promise<ExternalDataset> {
    const out = await this.gdal('ogrinfo', ['-json', '-so', '-ro', '-nomd', this.dsn(conn), dataset], conn, 60_000);
    const layer = (JSON.parse(out) as { layers?: OgrLayer[] }).layers?.[0];
    if (!layer) throw new BadRequestException(`Table "${dataset}" was not found.`);
    return this.toDataset(layer, conn.type === 'POSTGRESQL');
  }

  private toDataset(layer: OgrLayer, pg: boolean): ExternalDataset {
    const geom = layer.geometryFields?.[0];
    const id = geom?.coordinateSystem?.projjson?.id;
    const dot = layer.name.indexOf('.');
    const [schema, table] = dot > 0 ? [layer.name.slice(0, dot), layer.name.slice(dot + 1)] : [pg ? 'public' : null, layer.name];
    return {
      name: layer.name,
      schema,
      table,
      geometryField: geom ? geom.name || 'geometry' : null,
      geometryType: geom?.type ?? null,
      crs: id?.authority === 'EPSG' && id.code ? `EPSG:${id.code}` : null,
      featureCount: typeof layer.featureCount === 'number' && layer.featureCount >= 0 ? layer.featureCount : null,
      fields: (layer.fields ?? []).map((f) => ({ name: f.name, type: f.type })),
    };
  }

  /** The GDAL data source name. PostgreSQL takes everything from the libpq
   *  environment (see gdalEnv); MySQL needs it inline. */
  private dsn(conn: ExternalDbConnectionDto): string {
    if (conn.type === 'POSTGRESQL') return 'PG:';
    const parts = [conn.database, conn.host, String(conn.port), conn.username ?? '', conn.password ?? ''];
    if (parts.some((p) => /[,=]/.test(p))) {
      throw new BadRequestException('For MySQL, the database name, user name and password cannot contain "," or "=".');
    }
    return `MYSQL:${conn.database},host=${conn.host},port=${conn.port}` +
      (conn.username ? `,user=${conn.username}` : '') + (conn.password ? `,password=${conn.password}` : '');
  }

  private gdalEnv(conn: ExternalDbConnectionDto): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Never inherit the platform's own libpq settings.
    for (const key of Object.keys(env)) if (key.startsWith('PG')) delete env[key];
    if (conn.type === 'POSTGRESQL') {
      Object.assign(env, {
        PGHOST: conn.host,
        PGPORT: String(conn.port),
        PGDATABASE: conn.database,
        PGUSER: conn.username ?? '',
        PGPASSWORD: conn.password ?? '',
        PGSSLMODE: conn.sslMode ?? 'prefer',
        PGCONNECT_TIMEOUT: '10',
        PGAPPNAME: 'municipal-gis-import',
      });
    }
    return env;
  }

  private async gdal(
    command: 'ogrinfo' | 'ogr2ogr',
    args: string[],
    conn: ExternalDbConnectionDto,
    timeoutMs: number,
  ): Promise<string> {
    try {
      const { stdout } = await execFileAsync(command, args, {
        env: this.gdalEnv(conn),
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const err = error as { stderr?: string; message: string; killed?: boolean };
      if (err.killed) throw new BadRequestException('The database took too long to respond.');
      throw new BadRequestException(this.explain(err.stderr || err.message, conn));
    }
  }

  // ------------------------------------------------------------- MongoDB

  private async mongo<T>(conn: ExternalDbConnectionDto, fn: (client: MongoClient) => Promise<T>): Promise<T> {
    const auth = conn.username
      ? `${encodeURIComponent(conn.username)}:${encodeURIComponent(conn.password ?? '')}@`
      : '';
    const uri = conn.srv ? `mongodb+srv://${auth}${conn.host}/` : `mongodb://${auth}${conn.host}:${conn.port}/`;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
      socketTimeoutMS: 300_000,
      tls: conn.tls || conn.srv ? true : undefined,
      authSource: conn.username ? conn.authSource || 'admin' : undefined,
      appName: 'municipal-gis-import',
      directConnection: conn.srv ? undefined : true,
      readPreference: 'secondaryPreferred',
    });
    try {
      await client.connect();
      return await fn(client);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(this.explain((error as Error).message, conn));
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private mongoDatasets(conn: ExternalDbConnectionDto): Promise<ExternalDataset[]> {
    return this.mongo(conn, async (client) => {
      const db = client.db(conn.database);
      const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
        .filter((c) => !c.name.startsWith('system.'))
        .slice(0, MAX_DATASETS);
      return Promise.all(collections.map((c) => this.mongoDescribe(db.collection(c.name), c.name)));
    });
  }

  private async mongoDescribe(collection: import('mongodb').Collection, name: string): Promise<ExternalDataset> {
    const [count, sample, indexes] = await Promise.all([
      collection.estimatedDocumentCount().catch(() => null),
      collection.find({}).limit(MONGO_SAMPLE).toArray(),
      collection.indexes().catch(() => [] as Document[]),
    ]);
    // A geometry field: one with a 2dsphere index, else the first field
    // whose sampled values are GeoJSON geometries.
    const indexed = indexes
      .flatMap((i) => Object.entries((i.key ?? {}) as Record<string, unknown>))
      .find(([, v]) => v === '2dsphere')?.[0];
    const geometryField = indexed ?? this.findGeoField(sample);
    const types = new Set<string>();
    if (geometryField) {
      for (const doc of sample) {
        const g = getPath(doc, geometryField);
        if (isGeometry(g)) types.add(g.type.replace(/^Multi/, ''));
      }
    }
    const fieldTypes = new Map<string, string>();
    for (const doc of sample) {
      for (const [key, value] of Object.entries(flatten(doc, geometryField))) {
        if (!fieldTypes.has(key) || fieldTypes.get(key) === 'Null') fieldTypes.set(key, typeName(value));
      }
    }
    return {
      name,
      schema: null,
      table: name,
      geometryField: geometryField ?? null,
      geometryType: geometryField ? (types.size === 1 ? [...types][0] : types.size ? 'Mixed' : 'Unknown') : null,
      crs: geometryField ? 'EPSG:4326' : null,
      featureCount: count,
      fields: [...fieldTypes].map(([n, type]) => ({ name: n, type })),
    };
  }

  private findGeoField(docs: Document[]): string | undefined {
    for (const doc of docs) {
      for (const [key, value] of Object.entries(doc)) {
        if (isGeometry(value)) return key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          for (const [sub, v] of Object.entries(value as Record<string, unknown>)) {
            if (isGeometry(v)) return `${key}.${sub}`;
          }
        }
      }
    }
    return undefined;
  }

  private mongoPreview(conn: ExternalDbConnectionDto, dataset: string): Promise<ExternalPreview> {
    return this.mongo(conn, async (client) => {
      const collection = await this.mongoCollection(client, conn, dataset);
      const info = await this.mongoDescribe(collection, dataset);
      const docs = await collection.find({}).limit(PREVIEW_ROWS).toArray();
      const rows = docs.map((doc) => {
        const g = info.geometryField ? getPath(doc, info.geometryField) : undefined;
        return {
          ...flatten(doc, info.geometryField),
          ...(info.geometryField ? { __geometry: isGeometry(g) ? g.type : null } : {}),
        };
      });
      return { dataset: info, rows };
    });
  }

  private mongoExtract(
    conn: ExternalDbConnectionDto,
    dataset: string,
    opts: {
      geometryField?: string;
      fields?: string[];
      limit?: number;
      byCoordinates: boolean;
      upload: Partial<ExternalDbImportDto>;
    },
  ): Promise<{ buffer: Buffer; format: 'geojson' | 'csv' }> {
    return this.mongo(conn, async (client) => {
      const collection = await this.mongoCollection(client, conn, dataset);
      const info = await this.mongoDescribe(collection, dataset);
      const geometryField = opts.byCoordinates ? undefined : opts.geometryField || info.geometryField || undefined;
      if (!geometryField && !opts.byCoordinates) {
        throw new BadRequestException(
          `No GeoJSON geometry field was found in "${dataset}" — choose its latitude / longitude or X / Y fields.`,
        );
      }
      const count = await collection.estimatedDocumentCount().catch(() => null);
      this.checkCount(count, opts.limit);
      const wanted = opts.fields?.length ? new Set(opts.fields) : null;
      const u = opts.upload;
      for (const c of [u.latitudeField, u.longitudeField, u.xField, u.yField]) if (c && wanted) wanted.add(c);

      const chunks: string[] = [];
      let bytes = 0;
      const push = (s: string) => {
        bytes += Buffer.byteLength(s);
        if (bytes > this.storage.maxUploadBytes) {
          throw new BadRequestException(
            `The data exceeds the ${Math.round(this.storage.maxUploadBytes / 1024 / 1024)} MB import limit — set a record limit or import fewer fields.`,
          );
        }
        chunks.push(s);
      };
      const cursor = collection.find({}).limit(opts.limit ?? this.maxFeatures);
      let written = 0;

      if (geometryField) {
        push('{"type":"FeatureCollection","features":[\n');
        for await (const doc of cursor) {
          const geometry = getPath(doc, geometryField);
          if (!isGeometry(geometry)) continue;
          const props = pick(flatten(doc, geometryField), wanted);
          push(`${written++ ? ',\n' : ''}${JSON.stringify({ type: 'Feature', geometry, properties: props })}`);
        }
        push('\n]}\n');
        if (!written) throw new BadRequestException(`No record in "${dataset}" has a geometry in "${geometryField}".`);
        return { buffer: Buffer.from(chunks.join('')), format: 'geojson' as const };
      }

      // Point data from coordinate fields → CSV through the CSV pipeline.
      const rows: Record<string, unknown>[] = [];
      const columns = new Set<string>();
      for await (const doc of cursor) {
        const row = pick(flatten(doc), wanted);
        Object.keys(row).forEach((k) => columns.add(k));
        rows.push(row);
      }
      if (!rows.length) throw new BadRequestException(`"${dataset}" has no records.`);
      const header = [...columns];
      push(header.map(csvCell).join(',') + '\n');
      for (const row of rows) push(header.map((h) => csvCell(row[h])).join(',') + '\n');
      return { buffer: Buffer.from(chunks.join('')), format: 'csv' as const };
    });
  }

  private async mongoCollection(client: MongoClient, conn: ExternalDbConnectionDto, name: string) {
    const db = client.db(conn.database);
    const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
    if (!exists) throw new BadRequestException(`Collection "${name}" was not found.`);
    return db.collection(name);
  }

  // -------------------------------------------------------------- shared

  private checkCount(count: number | null, limit?: number): void {
    if (!limit && count != null && count > this.maxFeatures) {
      throw new BadRequestException(
        `This table has ${count.toLocaleString()} records — more than the ${this.maxFeatures.toLocaleString()} that can be imported at once. Set a record limit.`,
      );
    }
  }

  private async readCapped(file: string): Promise<Buffer> {
    const { size } = await fs.stat(file);
    if (size > this.storage.maxUploadBytes) {
      throw new BadRequestException(
        `The data exceeds the ${Math.round(this.storage.maxUploadBytes / 1024 / 1024)} MB import limit — set a record limit or import fewer fields.`,
      );
    }
    return fs.readFile(file);
  }

  /** Refuses any database of this platform (its own, or another
   *  instance's): tenants must not read each other's layers through this
   *  connector. Recognised by its tables, so no host / port alias of the
   *  server gets around it. */
  private async assertNotPlatformDb(conn: ExternalDbConnectionDto): Promise<void> {
    if (conn.type !== 'POSTGRESQL') return;
    const isPlatform = await execFileAsync(
      'ogrinfo',
      ['-so', '-ro', '-q', '-nomd', '-oo', 'LIST_ALL_TABLES=YES', 'PG:', 'gis_workspaces', 'gis_layer_uploads'],
      { env: this.gdalEnv(conn), timeout: 30_000 },
    ).then(
      () => true,
      () => false,
    );
    if (isPlatform) {
      throw new BadRequestException("This is a Municipal GIS Platform database — connect to your own database instead.");
    }
  }

  /** One readable line, never echoing the password. GDAL's first line
   *  is often generic ("PQconnectdb failed."), so the whole output is
   *  matched and the most specific line kept. */
  private explain(raw: string, conn: ExternalDbConnectionDto): string {
    const mask = (text: string) => {
      let t = conn.password ? text.split(conn.password).join('••••') : text;
      t = t.replace(/password=[^,\s]*/gi, 'password=••••');
      return t;
    };
    this.logger.warn(`External ${conn.type} ${conn.host}:${conn.port}/${conn.database}: ${mask(raw).replace(/\s+/g, ' ').slice(0, 500)}`);
    if (/password authentication failed|Authentication failed|Access denied|denied for user|no password supplied|bad auth/i.test(raw)) {
      return 'Sign-in failed — check the user name and password.';
    }
    if (/could not translate host|ENOTFOUND|EAI_AGAIN|Unknown (MySQL|MariaDB) server host|getaddrinfo|Name or service not known/i.test(raw)) {
      return `Host "${conn.host}" could not be found.`;
    }
    if (/Connection refused|ECONNREFUSED|Can't connect/i.test(raw)) {
      return `Nothing is accepting connections at ${conn.host}:${conn.port}.`;
    }
    if (/timed out|timeout expired|Server selection timed out/i.test(raw)) {
      return `No response from ${conn.host}:${conn.port} — check the host, port and firewall.`;
    }
    if (/database "[^"]*" does not exist|Unknown database/i.test(raw)) {
      return `Database "${conn.database}" does not exist on this server.`;
    }
    if (/SSL|certificate/i.test(raw) && /connect/i.test(raw)) {
      return 'The secure (SSL / TLS) connection failed — check the SSL setting.';
    }
    const lines = raw
      .split('\n')
      .map((l) => l.replace(/^ERROR \d+:\s*/, '').trim())
      .filter((l) => l && !/^(PQconnectdb failed\.?|ogr\w+ failed - unable to open .*|FAILURE:.*)$/i.test(l));
    const line = mask(lines[0] ?? 'The database could not be read.');
    return line.length > 300 ? line.slice(0, 300) + '…' : line;
  }
}

interface OgrLayer {
  name: string;
  featureCount?: number;
  fields?: { name: string; type: string }[];
  geometryFields?: {
    name?: string;
    type?: string;
    coordinateSystem?: { projjson?: { id?: { authority?: string; code?: number } } };
  }[];
}

const GEOMETRY_TYPES = new Set([
  'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection',
]);

function isGeometry(value: unknown): value is { type: string } {
  if (!value || typeof value !== 'object') return false;
  const g = value as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  return typeof g.type === 'string' && GEOMETRY_TYPES.has(g.type) && (Array.isArray(g.coordinates) || Array.isArray(g.geometries));
}

function getPath(doc: Document, field: string): unknown {
  return field.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), doc);
}

/** Top-level and one nested level of a document as flat attributes
 *  ("address.city"); deeper values and arrays as JSON text. */
function flatten(doc: Document, skip?: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown, depth: number) => {
    if (key === skip) return;
    if (value === null || value === undefined) out[key] = null;
    else if (value instanceof Date) out[key] = value.toISOString();
    else if (typeof value === 'object' && '_bsontype' in (value as object)) out[key] = String(value);
    else if (Array.isArray(value)) out[key] = JSON.stringify(value);
    else if (typeof value === 'object') {
      if (depth > 0 || isGeometry(value)) out[key] = JSON.stringify(value);
      else for (const [k, v] of Object.entries(value as Record<string, unknown>)) put(`${key}.${k}`, v, depth + 1);
    } else out[key] = value;
  };
  for (const [k, v] of Object.entries(doc)) put(k, v, 0);
  return out;
}

function pick(row: Record<string, unknown>, wanted: Set<string> | null): Record<string, unknown> {
  if (!wanted) return row;
  return Object.fromEntries(Object.entries(row).filter(([k]) => wanted.has(k)));
}

function typeName(value: unknown): string {
  if (value === null || value === undefined) return 'Null';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Integer' : 'Real';
  if (typeof value === 'boolean') return 'Boolean';
  return 'String';
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
