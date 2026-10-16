import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';
import { GisLayersService } from './gis-layers.service';
import { GisAuthorizationService } from './gis-authorization.service';
import { GeoServerService } from './geoserver.service';
import { RasterService } from './raster.service';
import { VectorToolsService, type Column, type FieldRules } from './vector-tools.service';
import { compileFieldExpression, parseCsv } from './field-expression';
import { generateLayerTableName, isSafeGeneratedTableName } from './layer-naming.util';
import type {
  FieldCalcDto,
  FieldRulesDto,
  GeocodeDto,
  TableJoinDto,
  ValidateLayerDto,
} from './dto/data-tools.dto';

/** Module Access catalog ids (seed-modules.ts). */
export const FIELD_CALCULATOR_MODULE_ID = 1011;
export const TABLE_JOIN_MODULE_ID = 1012;
export const GEOCODE_MODULE_ID = 1013;
export const TOPOLOGY_MODULE_ID = 1014;
export const FIELD_RULES_MODULE_ID = 1015;
export const VERSIONS_MODULE_ID = 1016;

const NEW_FIELD_TYPES = ['text', 'double precision', 'integer', 'date', 'boolean'] as const;
const NUMERIC_TYPES = new Set(['integer', 'bigint', 'smallint', 'numeric', 'double precision', 'real']);
const MAX_CSV_ROWS = 20_000;
const MAX_JOIN_COLUMNS = 50;
const ISSUE_LIMIT = 500;
const CHANGE_LIMIT = 1000;

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export interface TopologyIssue {
  check: 'invalid' | 'empty' | 'duplicate' | 'overlap' | 'gap' | 'dangle' | 'rule';
  featureIds: number[];
  detail: string;
  /** GeoJSON, EPSG:4326 — where to look. */
  geometry: Record<string, unknown> | null;
}

type Source = Awaited<ReturnType<GisLayersService['vectorSource']>>;

/**
 * GIS Data Tools — Field Calculator, Table Join, Geocoding (against the
 * municipality's own address layer), Topology Validation, Field Rules and
 * layer Versions / Change Detection. Bulk attribute changes are written to
 * the feature edit history like single edits.
 */
@Injectable()
export class DataToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gisLayers: GisLayersService,
    private readonly gisAuth: GisAuthorizationService,
    private readonly geoServer: GeoServerService,
    private readonly raster: RasterService,
    private readonly vectorTools: VectorToolsService,
  ) {}

  // ----- Field Calculator -----

  async fieldCalculate(appUser: AppUser, layerId: string, dto: FieldCalcDto) {
    await this.vectorTools.requireModule(appUser, FIELD_CALCULATOR_MODULE_ID, 'Field Calculator');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    const columns = await this.vectorTools.columns(source.table);
    const { sql, params } = compileFieldExpression(dto.expression, columns.map((c) => c.name), 1);

    if (dto.preview) {
      const rows = await this.prisma.$queryRawUnsafe<{ id: number; value: unknown }[]>(
        `SELECT t.ogc_fid AS id, (${sql})::text AS value FROM "${source.table}" t ORDER BY t.ogc_fid LIMIT 5`,
        ...params,
      );
      return { preview: rows };
    }

    let column = columns.find((c) => c.name === dto.field);
    if (!column) {
      if (!dto.newFieldType) throw new BadRequestException(`Field "${dto.field}" does not exist — choose a type to create it.`);
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(dto.field)) {
        throw new BadRequestException('New field names use letters, digits and _ only, starting with a letter.');
      }
      await this.prisma.$executeRawUnsafe(`ALTER TABLE "${source.table}" ADD COLUMN ${q(dto.field)} ${dto.newFieldType}`);
      column = { name: dto.field, dataType: dto.newFieldType };
      await this.refreshLayer(source);
    }
    const changed = await this.bulkUpdate(appUser, layerId, source.table, {
      columns: [column.name],
      set: `${q(column.name)} = CAST((${sql}) AS ${column.dataType})`,
      params,
    });
    return { field: column.name, changed };
  }

  // ----- Table Join -----

  async joinTable(appUser: AppUser, layerId: string, csv: Buffer, dto: TableJoinDto) {
    await this.vectorTools.requireModule(appUser, TABLE_JOIN_MODULE_ID, 'Table Join');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    const columns = await this.vectorTools.columns(source.table);
    const layerKey = columns.find((c) => c.name === dto.layerKey);
    if (!layerKey) throw new BadRequestException(`Layer has no field "${dto.layerKey}".`);

    const { header, records } = this.readCsv(csv);
    const keyIndex = header.indexOf(dto.tableKey);
    if (keyIndex < 0) throw new BadRequestException(`CSV has no column "${dto.tableKey}".`);
    const wanted = (dto.columns?.length ? dto.columns : header).filter((h) => h !== dto.tableKey);
    if (!wanted.length) throw new BadRequestException('Choose at least one CSV column to bring in.');
    if (wanted.length > MAX_JOIN_COLUMNS) throw new BadRequestException(`At most ${MAX_JOIN_COLUMNS} columns per join.`);

    // CSV column → layer column (existing one reused, else created).
    const used = new Set(columns.map((c) => c.name.toLowerCase()));
    const targets: { csv: string; index: number; column: Column }[] = [];
    for (const name of wanted) {
      const index = header.indexOf(name);
      if (index < 0) throw new BadRequestException(`CSV has no column "${name}".`);
      const existing = columns.find((c) => c.name === name || c.name === this.safeName(name));
      if (existing && existing !== layerKey) {
        targets.push({ csv: name, index, column: existing });
        continue;
      }
      const numeric = records.every((r) => !r[index]?.trim() || Number.isFinite(Number(r[index].trim())));
      const column = { name: this.uniqueName(this.safeName(name), used), dataType: numeric ? 'double precision' : 'text' };
      await this.prisma.$executeRawUnsafe(`ALTER TABLE "${source.table}" ADD COLUMN ${q(column.name)} ${column.dataType}`);
      targets.push({ csv: name, index, column });
    }
    if (targets.some((t) => !columns.includes(t.column))) await this.refreshLayer(source);

    const rows = records.map((r) => [r[keyIndex]?.trim() ?? '', ...targets.map((t) => r[t.index]?.trim() || null)]);
    const join =
      `(SELECT DISTINCT ON (k) e->>0 AS k${targets.map((t, i) => `, e->>${i + 1} AS c${i}`).join('')}
          FROM jsonb_array_elements($1::jsonb) e ORDER BY k) j`;
    const where = `trim(t.${q(layerKey.name)}::text) = j.k`;
    const [{ matched }] = await this.prisma.$queryRawUnsafe<{ matched: number }[]>(
      `SELECT count(*)::int AS matched FROM "${source.table}" t JOIN ${join} ON ${where}`,
      JSON.stringify(rows),
    );
    const changed = await this.bulkUpdate(appUser, layerId, source.table, {
      columns: targets.map((t) => t.column.name),
      set: targets.map((t, i) => `${q(t.column.name)} = CAST(j.c${i} AS ${t.column.dataType})`).join(', '),
      from: join,
      where,
      params: [JSON.stringify(rows)],
    });
    return {
      matchedFeatures: matched,
      changedFeatures: changed,
      csvRows: records.length,
      fields: targets.map((t) => t.column.name),
    };
  }

  // ----- Geocoding -----

  /** Matches each CSV address to the most similar value of a field in one
   *  of the municipality's own layers (trigram similarity) and publishes
   *  the matches as a new point layer. Nothing leaves the server. */
  async geocode(appUser: AppUser, csv: Buffer, dto: GeocodeDto) {
    await this.vectorTools.requireModule(appUser, GEOCODE_MODULE_ID, 'Geocode Addresses');
    const reference = await this.gisLayers.vectorSource(appUser, dto.referenceLayerId, 'view');
    const field = (await this.vectorTools.columns(reference.table)).find((c) => c.name === dto.referenceField);
    if (!field) throw new BadRequestException(`"${reference.layer.name}" has no field "${dto.referenceField}".`);
    const { header, records } = this.readCsv(csv);
    const addressIndex = header.indexOf(dto.addressColumn);
    if (addressIndex < 0) throw new BadRequestException(`CSV has no column "${dto.addressColumn}".`);
    const minScore = dto.minScore ?? 0.4;

    // Trigram index on the reference field (uploaded layers) keeps this fast.
    if (isSafeGeneratedTableName(reference.table)) {
      const indexName = `${reference.table}_trgm_${createHash('md5').update(field.name).digest('hex').slice(0, 8)}`;
      await this.prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${reference.table}" USING gin (lower(${q(field.name)}::text) gin_trgm_ops)`,
      );
    }

    const output = await this.raster.prepareVectorOutput(appUser, dto.outputName);
    const srid = this.workspaceSrid(output.workspace.defaultCrs);
    const used = new Set(['ogc_fid', 'geom', 'row_no', 'matched_value', 'match_score']);
    const outCols = header.map((h, i) => ({ index: i, name: this.uniqueName(this.safeName(h), used) }));
    const rows = records.map((r) => header.map((_, i) => r[i] ?? ''));
    const refField = `lower(r.${q(field.name)}::text)`;

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL pg_trgm.similarity_threshold = ${Math.max(0.1, Math.min(minScore, 1))}`);
      await tx.$executeRawUnsafe(
        `CREATE TABLE "${output.table}" AS
         WITH src AS (
           SELECT e.ordinality::int AS row_no, e.value AS rec
             FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY e)
         SELECT src.row_no${outCols.map((c) => `, src.rec->>${c.index} AS ${q(c.name)}`).join('')},
                best.matched_value, round(best.score::numeric, 3)::float8 AS match_score,
                ST_Multi(ST_Transform(best.g, ${srid}))::geometry(MultiPoint, ${srid}) AS geom
           FROM src
           JOIN LATERAL (
             SELECT r.${q(field.name)}::text AS matched_value,
                    similarity(${refField}, lower(src.rec->>${addressIndex})) AS score,
                    ST_PointOnSurface(r.geom) AS g
               FROM ${reference.from} r
              WHERE ${refField} % lower(src.rec->>${addressIndex})
              ORDER BY score DESC
              LIMIT 1) best ON best.score >= $2`,
        JSON.stringify(rows),
        minScore,
      );
    });
    await this.prisma.$executeRawUnsafe(`ALTER TABLE "${output.table}" ADD COLUMN ogc_fid SERIAL PRIMARY KEY`);
    const matchedRows = await this.prisma.$queryRawUnsafe<{ row_no: number }[]>(
      `SELECT row_no FROM "${output.table}"`,
    );
    if (!matchedRows.length) {
      await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${output.table}"`);
      throw new BadRequestException('No address could be matched — try a lower minimum score or another field.');
    }
    const matched = new Set(matchedRows.map((r) => r.row_no));
    const unmatched = records
      .map((r, i) => ({ row: i + 1, address: r[addressIndex] ?? '' }))
      .filter((r) => !matched.has(r.row));
    const layer = await this.raster.publishVectorTable(appUser, output, {
      name: dto.outputName,
      geometryType: 'POINT',
      description: `Geocoded from CSV against ${reference.layer.name}.${field.name}`,
      rasterAnalysis: false,
    });
    return { layer, matched: matched.size, unmatchedCount: unmatched.length, unmatched: unmatched.slice(0, 100) };
  }

  // ----- Topology validation -----

  async validate(appUser: AppUser, layerId: string, dto: ValidateLayerDto) {
    await this.vectorTools.requireModule(appUser, TOPOLOGY_MODULE_ID, 'Topology Validation');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'view');
    const type = source.layer.geometryType;
    const t = source.from;
    const metric = await this.isMetric(await this.vectorTools.srid(source.table));
    const tolerance = metric ? 0.5 : 0.000005;
    const issues: TopologyIssue[] = [];
    const gj = (expr: string) => `ST_AsGeoJSON(ST_Transform(${expr}, 4326), 7)::json`;
    const add = async (check: TopologyIssue['check'], sql: string, ...params: unknown[]) => {
      const rows = await this.prisma.$queryRawUnsafe<{ ids: number[]; detail: string; geometry: Record<string, unknown> | null }[]>(
        `${sql} LIMIT ${ISSUE_LIMIT}`,
        ...params,
      );
      rows.forEach((r) => issues.push({ check, featureIds: r.ids, detail: r.detail, geometry: r.geometry }));
    };

    await add('empty', `SELECT ARRAY[a.ogc_fid] AS ids, 'Missing or empty geometry' AS detail, NULL::json AS geometry
                          FROM ${t} a WHERE a.geom IS NULL OR ST_IsEmpty(a.geom)`);
    await add('invalid', `SELECT ARRAY[a.ogc_fid] AS ids, ST_IsValidReason(a.geom) AS detail,
                                 ${gj('coalesce((ST_IsValidDetail(a.geom)).location, ST_PointOnSurface(a.geom))')} AS geometry
                            FROM ${t} a WHERE a.geom IS NOT NULL AND NOT ST_IsEmpty(a.geom) AND NOT ST_IsValid(a.geom)`);
    await add('duplicate', `SELECT ARRAY[a.ogc_fid, b.ogc_fid] AS ids, 'Identical geometry' AS detail, ${gj('a.geom')} AS geometry
                              FROM ${t} a JOIN ${t} b ON a.ogc_fid < b.ogc_fid AND a.geom && b.geom AND a.geom = b.geom`);
    if (type === 'POLYGON') {
      await add('overlap', `SELECT ARRAY[a.ogc_fid, b.ogc_fid] AS ids,
                                   'Overlap of ' || round(ST_Area(ST_Transform(ST_Intersection(a.geom, b.geom), 4326)::geography)::numeric, 2) || ' m²' AS detail,
                                   ${gj('ST_Intersection(a.geom, b.geom)')} AS geometry
                              FROM ${t} a JOIN ${t} b ON a.ogc_fid < b.ogc_fid AND a.geom && b.geom
                             WHERE ST_IsValid(a.geom) AND ST_IsValid(b.geom) AND a.geom <> b.geom
                               AND ST_Relate(a.geom, b.geom, '2********')`);
      await add('gap', `SELECT ARRAY[]::int[] AS ids,
                               'Gap of ' || round(ST_Area(ST_Transform(h.g, 4326)::geography)::numeric, 2) || ' m²' AS detail,
                               ${gj('h.g')} AS geometry
                          FROM (SELECT ST_MakePolygon(ST_InteriorRingN(p.g, n)) AS g
                                  FROM (SELECT (ST_Dump(ST_Union(ST_MakeValid(geom)))).geom AS g FROM ${t} x) p,
                                       generate_series(1, ST_NumInteriorRings(p.g)) n) h
                         WHERE ST_Area(ST_Transform(h.g, 4326)::geography) <= $1`,
        dto.maxGapArea ?? 100);
    }
    if (type === 'LINE') {
      await add('dangle', `WITH parts AS (SELECT a.ogc_fid, (ST_Dump(a.geom)).geom AS g FROM ${t} a),
                               ends AS (SELECT ogc_fid, ST_StartPoint(g) AS p FROM parts
                                        UNION ALL SELECT ogc_fid, ST_EndPoint(g) FROM parts)
                          SELECT ARRAY[e.ogc_fid] AS ids, 'Dangling end (dead end or undershoot)' AS detail, ${gj('e.p')} AS geometry
                            FROM ends e
                           WHERE NOT EXISTS (SELECT 1 FROM parts o WHERE o.ogc_fid <> e.ogc_fid AND ST_DWithin(o.g, e.p, ${tolerance}))`);
    }

    // Field rule violations.
    const rules = (source.layer.fieldRules as FieldRules | null) ?? {};
    const columns = await this.vectorTools.columns(source.table);
    for (const [name, rule] of Object.entries(rules)) {
      const col = columns.find((c) => c.name === name);
      if (!col) continue;
      const f = `a.${q(col.name)}`;
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (rule.required) conditions.push(`(${f} IS NULL OR trim(${f}::text) = '')`);
      if (rule.values?.length) {
        params.push(rule.values);
        conditions.push(`(${f} IS NOT NULL AND trim(${f}::text) <> '' AND NOT (${f}::text = ANY($${params.length}::text[])))`);
      }
      if (NUMERIC_TYPES.has(col.dataType) && rule.min !== undefined && rule.min !== null) {
        params.push(rule.min);
        conditions.push(`${f} < $${params.length}::float8`);
      }
      if (NUMERIC_TYPES.has(col.dataType) && rule.max !== undefined && rule.max !== null) {
        params.push(rule.max);
        conditions.push(`${f} > $${params.length}::float8`);
      }
      if (!conditions.length) continue;
      await add('rule', `SELECT ARRAY[a.ogc_fid] AS ids, ${this.literal(`${name}: `)} || coalesce(${f}::text, '∅') || ' breaks the field rule' AS detail,
                                ${gj('ST_PointOnSurface(a.geom)')} AS geometry
                           FROM ${t} a WHERE ${conditions.join(' OR ')}`, ...params);
    }

    const counts: Record<string, number> = {};
    issues.forEach((i) => (counts[i.check] = (counts[i.check] ?? 0) + 1));
    return { issues, counts, truncated: Object.values(counts).some((n) => n >= ISSUE_LIMIT) };
  }

  /** One-click repairs (edit permission), recorded in the edit history. */
  async fix(appUser: AppUser, layerId: string, kind: 'invalid' | 'duplicates' | 'empty') {
    await this.vectorTools.requireModule(appUser, TOPOLOGY_MODULE_ID, 'Topology Validation');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    const type = source.layer.geometryType;
    if (kind === 'invalid') {
      const dim = type === 'POINT' ? 1 : type === 'LINE' ? 2 : 3;
      return {
        fixed: await this.bulkUpdate(appUser, layerId, source.table, {
          columns: [],
          geometry: true,
          set: `geom = ST_Multi(ST_CollectionExtract(ST_MakeValid(t.geom), ${dim}))`,
          where: `t.geom IS NOT NULL AND NOT ST_IsValid(t.geom)`,
          params: [],
        }),
      };
    }
    const where =
      kind === 'empty'
        ? `t.geom IS NULL OR ST_IsEmpty(t.geom)`
        : `EXISTS (SELECT 1 FROM "${source.table}" o WHERE o.ogc_fid < t.ogc_fid AND o.geom && t.geom AND o.geom = t.geom)`;
    return { fixed: await this.bulkDelete(appUser, layerId, source.table, where) };
  }

  // ----- Field rules -----

  async getFieldRules(appUser: AppUser, layerId: string) {
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'view');
    return {
      rules: (source.layer.fieldRules as FieldRules | null) ?? {},
      fields: (await this.vectorTools.columns(source.table)).map((c) => ({ name: c.name, type: c.dataType })),
    };
  }

  async setFieldRules(appUser: AppUser, layerId: string, dto: FieldRulesDto) {
    await this.vectorTools.requireModule(appUser, FIELD_RULES_MODULE_ID, 'Field Rules');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'view');
    if (!(await this.gisAuth.canManage(appUser, source.layer))) {
      throw new ForbiddenException('Only layer managers can change field rules.');
    }
    const names = new Set((await this.vectorTools.columns(source.table)).map((c) => c.name));
    const rules: FieldRules = {};
    for (const rule of dto.rules) {
      if (!names.has(rule.field)) throw new BadRequestException(`Unknown field "${rule.field}".`);
      const values = rule.values?.map((v) => v.trim()).filter(Boolean);
      const clean = {
        ...(rule.required ? { required: true } : {}),
        ...(values?.length ? { values } : {}),
        ...(rule.min !== undefined && rule.min !== null ? { min: rule.min } : {}),
        ...(rule.max !== undefined && rule.max !== null ? { max: rule.max } : {}),
      };
      if (Object.keys(clean).length) rules[rule.field] = clean;
    }
    await this.prisma.gISLayer.update({ where: { id: source.layer.id }, data: { fieldRules: rules as Prisma.InputJsonObject } });
    return { rules };
  }

  // ----- Versions & change detection -----

  async listSnapshots(appUser: AppUser, layerId: string) {
    await this.vectorTools.requireModule(appUser, VERSIONS_MODULE_ID, 'Versions');
    await this.gisLayers.vectorSource(appUser, layerId, 'view');
    return this.prisma.gISLayerSnapshot.findMany({
      where: { layerId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, featureCount: true, createdAt: true },
    });
  }

  async createSnapshot(appUser: AppUser, layerId: string, name: string) {
    await this.vectorTools.requireModule(appUser, VERSIONS_MODULE_ID, 'Versions');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    return this.snapshot(appUser, source, name);
  }

  async deleteSnapshot(appUser: AppUser, layerId: string, snapshotId: string) {
    await this.vectorTools.requireModule(appUser, VERSIONS_MODULE_ID, 'Versions');
    await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    const snap = await this.findSnapshot(layerId, snapshotId);
    await this.prisma.gISLayerSnapshot.delete({ where: { id: snap.id } });
    await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${snap.postgisTable}"`);
    return { success: true as const };
  }

  /** Features added, removed and modified since a snapshot, matched by
   *  `keyField` (default the feature id — pick a real id field to compare
   *  across re-uploads, whose feature ids are new). */
  async compareSnapshot(appUser: AppUser, layerId: string, snapshotId: string, keyField?: string) {
    await this.vectorTools.requireModule(appUser, VERSIONS_MODULE_ID, 'Versions');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'view');
    const snap = await this.findSnapshot(layerId, snapshotId);
    const current = await this.vectorTools.columns(source.table);
    const old = await this.vectorTools.columns(snap.postgisTable);
    let key = 'ogc_fid';
    if (keyField && keyField !== 'ogc_fid') {
      if (!current.some((c) => c.name === keyField) || !old.some((c) => c.name === keyField)) {
        throw new BadRequestException(`"${keyField}" is not in both versions.`);
      }
      key = keyField;
    }
    const k = q(key);
    const props = (alias: string) => `(to_jsonb(${alias}) - 'geom' - 'ogc_fid')`;
    const cur = `"${source.table}"`;
    const prev = `"${snap.postgisTable}"`;
    const gj = (expr: string) => `ST_AsGeoJSON(ST_Transform(${expr}, 4326), 7)::json`;
    const queries = {
      added: `FROM ${cur} c WHERE NOT EXISTS (SELECT 1 FROM ${prev} s WHERE s.${k} = c.${k})`,
      removed: `FROM ${prev} s WHERE NOT EXISTS (SELECT 1 FROM ${cur} c WHERE c.${k} = s.${k})`,
      modified: `FROM ${cur} c JOIN ${prev} s ON s.${k} = c.${k}
                 WHERE c.geom IS DISTINCT FROM s.geom OR ${props('c')} IS DISTINCT FROM ${props('s')}`,
    };
    const result: Record<string, unknown> = { snapshot: { id: snap.id, name: snap.name, createdAt: snap.createdAt }, key };
    for (const [kind, from] of Object.entries(queries)) {
      const alias = kind === 'removed' ? 's' : 'c';
      const [{ n }] = await this.prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n ${from}`);
      const rows = await this.prisma.$queryRawUnsafe<
        { key: unknown; geometry: unknown; before: Record<string, unknown> | null; after: Record<string, unknown> | null; geometryChanged: boolean }[]
      >(
        `SELECT ${alias}.${k}::text AS key, ${gj(`${alias}.geom`)} AS geometry,
                ${kind === 'added' ? 'NULL::jsonb' : props('s')} AS before,
                ${kind === 'removed' ? 'NULL::jsonb' : props('c')} AS after,
                ${kind === 'modified' ? 'c.geom IS DISTINCT FROM s.geom' : 'false'} AS "geometryChanged"
         ${from} LIMIT ${CHANGE_LIMIT}`,
      );
      result[kind] = {
        count: n,
        features: rows.map((r) => ({
          key: r.key,
          geometry: r.geometry,
          geometryChanged: r.geometryChanged,
          changedFields:
            kind === 'modified'
              ? Object.keys({ ...r.before, ...r.after }).filter(
                  (f) => JSON.stringify(r.before?.[f]) !== JSON.stringify(r.after?.[f]),
                )
              : [],
        })),
      };
    }
    return result;
  }

  /** Puts a snapshot's features back (a "Before restore" snapshot of the
   *  current data is taken first, so a restore can itself be undone). */
  async restoreSnapshot(appUser: AppUser, layerId: string, snapshotId: string) {
    await this.vectorTools.requireModule(appUser, VERSIONS_MODULE_ID, 'Versions');
    const source = await this.gisLayers.vectorSource(appUser, layerId, 'edit');
    const snap = await this.findSnapshot(layerId, snapshotId);
    await this.snapshot(appUser, source, `Before restoring "${snap.name}"`);
    const current = new Set((await this.vectorTools.columns(source.table)).map((c) => c.name));
    const shared = ['ogc_fid', 'geom', ...(await this.vectorTools.columns(snap.postgisTable)).map((c) => c.name).filter((n) => current.has(n))]
      .map(q)
      .join(', ');
    await this.prisma.$transaction([
      this.prisma.$executeRawUnsafe(`DELETE FROM "${source.table}"`),
      this.prisma.$executeRawUnsafe(`INSERT INTO "${source.table}" (${shared}) SELECT ${shared} FROM "${snap.postgisTable}"`),
      this.prisma.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('"${source.table}"', 'ogc_fid'), coalesce(max(ogc_fid), 1)) FROM "${source.table}"`,
      ),
    ]);
    await this.refreshLayer(source);
    return { success: true as const };
  }

  // ----- internals -----

  private async snapshot(appUser: AppUser, source: Source, name: string) {
    if (!isSafeGeneratedTableName(source.table)) throw new BadRequestException('Only uploaded layers have versions.');
    const table = generateLayerTableName();
    await this.prisma.$executeRawUnsafe(`CREATE TABLE "${table}" AS SELECT * FROM "${source.table}"`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX "${table}_fid_idx" ON "${table}" (ogc_fid)`);
    const [{ n }] = await this.prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}"`);
    return this.prisma.gISLayerSnapshot.create({
      data: {
        layerId: source.layer.id,
        name: name.trim().slice(0, 120) || 'Snapshot',
        postgisTable: table,
        featureCount: n,
        createdById: appUser.id,
      },
      select: { id: true, name: true, featureCount: true, createdAt: true },
    });
  }

  private async findSnapshot(layerId: string, snapshotId: string) {
    const snap = await this.prisma.gISLayerSnapshot.findFirst({ where: { id: snapshotId, layerId } });
    if (!snap || !isSafeGeneratedTableName(snap.postgisTable)) throw new NotFoundException('Version not found.');
    return snap;
  }

  /**
   * UPDATE … RETURNING joined to the pre-update rows, writing one history
   * row per feature that actually changed (only the touched columns, plus
   * the geometry when `geometry`). Returns how many features changed.
   */
  private async bulkUpdate(
    appUser: AppUser,
    layerId: string,
    table: string,
    opts: { columns: string[]; set: string; params: unknown[]; from?: string; where?: string; geometry?: boolean },
  ): Promise<number> {
    const n = opts.params.length;
    const pick = (alias: string) =>
      `jsonb_build_object('properties', jsonb_build_object(${opts.columns
        .map((c) => `${this.literal(c)}, ${alias}.p->${this.literal(c)}`)
        .join(', ')})${opts.geometry ? `, 'geometry', ${alias}.g` : ''})`;
    const geo = `ST_AsGeoJSON(ST_Transform(t.geom, 4326))::jsonb`;
    return this.prisma.$executeRawUnsafe(
      `WITH old AS (SELECT t.ogc_fid, to_jsonb(t) - 'geom' AS p, ${opts.geometry ? geo : 'NULL::jsonb'} AS g FROM "${table}" t),
            upd AS (UPDATE "${table}" t SET ${opts.set} ${opts.from ? `FROM ${opts.from}` : ''} ${opts.where ? `WHERE ${opts.where}` : ''}
                    RETURNING t.ogc_fid, to_jsonb(t) - 'geom' AS p, ${opts.geometry ? geo : 'NULL::jsonb'} AS g)
       INSERT INTO gis_feature_history (id, layer_id, feature_id, action, old_data, new_data, user_id, user_name)
       SELECT gen_random_uuid()::text, $${n + 1}, upd.ogc_fid, 'UPDATE'::"GisFeatureAction", ${pick('old')}, ${pick('upd')}, $${n + 2}, $${n + 3}
         FROM upd JOIN old USING (ogc_fid)
        WHERE ${pick('old')} IS DISTINCT FROM ${pick('upd')}`,
      ...opts.params,
      layerId,
      appUser.id,
      await this.vectorTools.userName(appUser),
    );
  }

  private async bulkDelete(appUser: AppUser, layerId: string, table: string, where: string): Promise<number> {
    return this.prisma.$executeRawUnsafe(
      `WITH del AS (DELETE FROM "${table}" t WHERE ${where}
                    RETURNING t.ogc_fid, to_jsonb(t) - 'geom' - 'ogc_fid' AS p,
                              ST_AsGeoJSON(ST_Transform(t.geom, 4326))::jsonb AS g)
       INSERT INTO gis_feature_history (id, layer_id, feature_id, action, old_data, new_data, user_id, user_name)
       SELECT gen_random_uuid()::text, $1, del.ogc_fid, 'DELETE'::"GisFeatureAction",
              jsonb_build_object('properties', del.p, 'geometry', del.g), NULL, $2, $3
         FROM del`,
      layerId,
      appUser.id,
      await this.vectorTools.userName(appUser),
    );
  }

  /** GeoServer picks up new columns / a new extent. Best effort. */
  private async refreshLayer(source: Source) {
    await this.geoServer
      .refreshFeatureType(
        source.layer.geoserverWorkspace,
        `${source.layer.geoserverWorkspace}_postgis`,
        source.layer.geoserverLayer,
      )
      .catch(() => undefined);
  }

  private readCsv(csv: Buffer) {
    const rows = parseCsv(csv.toString('utf8'));
    if (rows.length < 2) throw new BadRequestException('The CSV needs a header row and at least one data row.');
    if (rows.length - 1 > MAX_CSV_ROWS) throw new BadRequestException(`At most ${MAX_CSV_ROWS} rows per file.`);
    return { header: rows[0].map((h) => h.trim()), records: rows.slice(1) };
  }

  private safeName(name: string): string {
    const clean = name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60);
    return /^[a-z]/.test(clean) ? clean : `f_${clean || 'field'}`;
  }

  private uniqueName(name: string, used: Set<string>): string {
    let candidate = name;
    for (let n = 2; used.has(candidate); n++) candidate = `${name.slice(0, 56)}_${n}`;
    used.add(candidate);
    return candidate;
  }

  /** SQL string literal for a value that came from information_schema. */
  private literal(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private workspaceSrid(crs: string): number {
    const match = /^EPSG:(\d+)$/i.exec(crs);
    if (!match) throw new BadRequestException(`Unsupported workspace CRS ${crs}.`);
    return Number(match[1]);
  }

  private async isMetric(srid: number): Promise<boolean> {
    const [row] = await this.prisma.$queryRawUnsafe<{ metric: boolean }[]>(
      `SELECT coalesce(proj4text LIKE '%+units=m%', false) AS metric FROM spatial_ref_sys WHERE srid = $1`,
      srid,
    );
    return !!row?.metric;
  }
}
