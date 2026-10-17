import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';
import { GisLayersService } from './gis-layers.service';
import { GisAuthorizationService } from './gis-authorization.service';
import { GeoServerService } from './geoserver.service';
import { RasterService } from './raster.service';
import { AddressMatcher } from './address-matcher';
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
/** Numeric fields that are codes, not measurements — outliers there mean
 *  nothing (ward_no 37 is not "unusually high"). */
const IDENTIFIER_FIELD = /(^|_)(id|fid|gid|code|no|num|number|year|yr|zip|pin|pincode|phone|mobile|lat|lon|lng|latitude|longitude|x|y|srid|seq|sr|index|idx)$/i;
const MAX_OUTLIER_FIELDS = 12;
/** Fuzzy geocoding: genuine matches score ≥ ~0.7, partial / generic
 *  overlaps ("lane 3", "peth") ~0.4-0.5, unrelated text ≤ ~0.35. */
const GEOCODE_MIN_SCORE = 0.6;
const GEOCODE_MAX_REFERENCE_VALUES = 100_000;
const MAX_CSV_ROWS = 20_000;
const MAX_JOIN_COLUMNS = 50;
const ISSUE_LIMIT = 500;
const CHANGE_LIMIT = 1000;

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export interface TopologyIssue {
  check: 'invalid' | 'empty' | 'duplicate' | 'overlap' | 'gap' | 'dangle' | 'rule' | 'outlier';
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

  /** Matches each CSV address to a value of a field in one of the
   *  municipality's own layers — fuzzy, for Indian addresses: Indic
   *  scripts transliterated, abbreviations expanded, spelling variants
   *  folded, and the reference value found even inside a long address
   *  (see AddressMatcher). Publishes the matches as a new point layer at
   *  each matched value's location. Nothing leaves the server. */
  async geocode(appUser: AppUser, csv: Buffer, dto: GeocodeDto) {
    await this.vectorTools.requireModule(appUser, GEOCODE_MODULE_ID, 'Geocode Addresses');
    const reference = await this.gisLayers.vectorSource(appUser, dto.referenceLayerId, 'view');
    const field = (await this.vectorTools.columns(reference.table)).find((c) => c.name === dto.referenceField);
    if (!field) throw new BadRequestException(`"${reference.layer.name}" has no field "${dto.referenceField}".`);
    const { header, records } = this.readCsv(csv);
    const addressIndex = header.indexOf(dto.addressColumn);
    if (addressIndex < 0) throw new BadRequestException(`CSV has no column "${dto.addressColumn}".`);
    const minScore = dto.minScore ?? GEOCODE_MIN_SCORE;

    // One location per distinct reference value (all its features together).
    const values = await this.prisma.$queryRawUnsafe<{ v: string; lon: number; lat: number }[]>(
      `SELECT v, ST_X(p)::float8 AS lon, ST_Y(p)::float8 AS lat
         FROM (SELECT r.${q(field.name)}::text AS v,
                      ST_Transform(ST_PointOnSurface(ST_Collect(r.geom)), 4326) AS p
                 FROM ${reference.from} r
                WHERE r.${q(field.name)} IS NOT NULL AND trim(r.${q(field.name)}::text) <> '' AND r.geom IS NOT NULL
                GROUP BY 1
                LIMIT ${GEOCODE_MAX_REFERENCE_VALUES + 1}) s
        WHERE p IS NOT NULL`,
    );
    if (!values.length) {
      throw new BadRequestException(`"${reference.layer.name}.${field.name}" has no values to match against.`);
    }
    if (values.length > GEOCODE_MAX_REFERENCE_VALUES) {
      throw new BadRequestException(
        `"${field.name}" has more than ${GEOCODE_MAX_REFERENCE_VALUES} different values — choose a name field (road, locality, landmark) rather than an id.`,
      );
    }
    const matcher = new AddressMatcher(values.map((r) => ({ value: r.v, payload: [r.lon, r.lat] as [number, number] })));

    const output = await this.raster.prepareVectorOutput(appUser, dto.outputName);
    const srid = this.workspaceSrid(output.workspace.defaultCrs);
    const used = new Set(['ogc_fid', 'geom', 'row_no', 'matched_value', 'match_score']);
    const outCols = header.map((h, i) => ({ index: i, name: this.uniqueName(this.safeName(h), used) }));
    const matchedRows: { row: number; rec: string[]; value: string; score: number; lon: number; lat: number }[] = [];
    const unmatched: { row: number; address: string }[] = [];
    records.forEach((r, i) => {
      const address = r[addressIndex] ?? '';
      const m = address.trim() ? matcher.match(address, minScore) : null;
      if (m) {
        matchedRows.push({ row: i + 1, rec: header.map((_, c) => r[c] ?? ''), value: m.value, score: m.score, lon: m.payload[0], lat: m.payload[1] });
      } else {
        unmatched.push({ row: i + 1, address });
      }
    });
    if (!matchedRows.length) {
      throw new BadRequestException('No address could be matched — try a lower minimum score or another field.');
    }

    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE "${output.table}" AS
       SELECT (e->>'row')::int AS row_no${outCols.map((c) => `, e->'rec'->>${c.index} AS ${q(c.name)}`).join('')},
              e->>'value' AS matched_value, (e->>'score')::float8 AS match_score,
              ST_Multi(ST_Transform(ST_SetSRID(ST_MakePoint((e->>'lon')::float8, (e->>'lat')::float8), 4326), ${srid}))::geometry(MultiPoint, ${srid}) AS geom
         FROM jsonb_array_elements($1::jsonb) e`,
      JSON.stringify(matchedRows),
    );
    await this.prisma.$executeRawUnsafe(`ALTER TABLE "${output.table}" ADD COLUMN ogc_fid SERIAL PRIMARY KEY`);
    const layer = await this.raster.publishVectorTable(appUser, output, {
      name: dto.outputName,
      geometryType: 'POINT',
      description: `Geocoded from CSV against ${reference.layer.name}.${field.name}`,
      rasterAnalysis: false,
    });
    return { layer, matched: matchedRows.length, unmatchedCount: unmatched.length, unmatched: unmatched.slice(0, 100) };
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
                             WHERE ST_IsValid(a.geom) AND ST_IsValid(b.geom) AND NOT (a.geom = b.geom)
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

    // Statistical outliers — values far from what is typical for the layer
    // (or for their group, e.g. their ward): typos, unit mix-ups, slivers.
    if (dto.outliers !== false) {
      const group = dto.outlierGroupField ? columns.find((c) => c.name === dto.outlierGroupField) : undefined;
      if (dto.outlierGroupField && !group) throw new BadRequestException(`Unknown field "${dto.outlierGroupField}".`);
      const threshold = dto.outlierThreshold ?? 3.5;
      const measures = columns
        .filter((c) => NUMERIC_TYPES.has(c.dataType) && !IDENTIFIER_FIELD.test(c.name) && c.name !== group?.name)
        .map((c) => ({ expr: `a.${q(c.name)}`, label: c.name }));
      if (type === 'POLYGON') {
        measures.push({ expr: metric ? 'ST_Area(a.geom)' : 'ST_Area(ST_Transform(a.geom, 4326)::geography)', label: 'Area (m²)' });
      }
      if (type === 'LINE') {
        measures.push({ expr: metric ? 'ST_Length(a.geom)' : 'ST_Length(ST_Transform(a.geom, 4326)::geography)', label: 'Length (m)' });
      }
      for (const m of measures.slice(0, MAX_OUTLIER_FIELDS)) {
        await add('outlier', this.outlierSql(t, m.expr, m.label, group ? `a.${q(group.name)}` : null, group?.name ?? null, gj), threshold);
        await add('outlier', this.nonPositiveSql(t, m.expr, m.label, gj));
      }
    }

    const counts: Record<string, number> = {};
    issues.forEach((i) => (counts[i.check] = (counts[i.check] ?? 0) + 1));
    return { issues, counts, truncated: Object.values(counts).some((n) => n >= ISSUE_LIMIT) };
  }

  /**
   * Robust outliers of one numeric expression: the modified z-score
   * 0.6745·(x − median) / MAD (Iglewicz & Hoaglin; flagged above $1,
   * default 3.5), falling back to the mean absolute deviation when over
   * half the values are identical. Strongly skewed positive values (areas,
   * lengths, costs) are scored on a log scale, so big-but-plausible
   * features are not all flagged. With a group field each value is judged
   * against its own group (e.g. its ward); groups need ≥ 12 values and
   * the layer ≥ 20. Only continuous fields (≥ 20 distinct values) are
   * scored: on a coded field such as a pipe diameter (100, 150, 200 …)
   * the MAD collapses to 0 and every larger standard size would be
   * "unusual". At most 50 per measure, most extreme first.
   */
  private outlierSql(
    t: string,
    expr: string,
    label: string,
    groupExpr: string | null,
    groupName: string | null,
    gj: (expr: string) => string,
  ): string {
    const g = groupExpr ? `coalesce(${groupExpr}::text, '')` : `''`;
    return `WITH v AS (
              SELECT a.ogc_fid AS id, (${expr})::float8 AS x, ${g} AS g, a.geom
                FROM ${t} a WHERE (${expr}) IS NOT NULL AND a.geom IS NOT NULL),
            shape AS (
              SELECT count(*) >= 20 AND count(DISTINCT x) >= 20 AS enough,
                     min(x) > 0 AND percentile_cont(0.9) WITHIN GROUP (ORDER BY x)
                       > 10 * percentile_cont(0.1) WITHIN GROUP (ORDER BY x) AS use_log
                FROM v),
            y AS (
              SELECT v.*, CASE WHEN shape.use_log THEN ln(v.x) ELSE v.x END AS y FROM v, shape WHERE shape.enough),
            s AS (
              SELECT g, count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY y) AS med FROM y GROUP BY g),
            d AS (
              SELECT y.g, percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(y.y - s.med)) AS mad,
                     avg(abs(y.y - s.med)) AS meanad
                FROM y JOIN s ON s.g = y.g GROUP BY y.g),
            z AS (
              SELECT y.*, s.med,
                     CASE WHEN d.mad > 0 THEN 0.6745 * (y.y - s.med) / d.mad
                          WHEN d.meanad > 0 THEN (y.y - s.med) / (1.2533 * d.meanad) END AS z
                FROM y JOIN s ON s.g = y.g JOIN d ON d.g = y.g
               WHERE s.n >= ${groupExpr ? 12 : 20}),
            hit AS (
              SELECT z.*, (SELECT use_log FROM shape) AS use_log FROM z WHERE abs(z.z) > $1 ORDER BY abs(z.z) DESC LIMIT 50)
            SELECT ARRAY[hit.id] AS ids,
                   ${this.literal(label + ' ')} || round(hit.x::numeric, 2) || ' is unusually '
                     || CASE WHEN hit.z > 0 THEN 'high' ELSE 'low' END
                     || ${groupName ? `${this.literal(` (typical for ${groupName} = `)} || hit.g || ': '` : `' (typical: '`}
                     || round((CASE WHEN hit.use_log THEN exp(hit.med) ELSE hit.med END)::numeric, 2)
                     || ', score ' || round(abs(hit.z)::numeric, 1) || ')' AS detail,
                   ${gj('ST_PointOnSurface(hit.geom)')} AS geometry
              FROM hit`;
  }

  /** Zero / negative values in a field that is otherwise positive (≥ 90 %
   *  of ≥ 20 values above 0) — a pipe of diameter 0, a plot of area −5:
   *  almost always "unknown" typed as 0, or a sign error. Applies to coded
   *  fields too. At most 50. */
  private nonPositiveSql(t: string, expr: string, label: string, gj: (expr: string) => string): string {
    return `WITH v AS (
              SELECT a.ogc_fid AS id, (${expr})::float8 AS x, a.geom
                FROM ${t} a WHERE (${expr}) IS NOT NULL AND a.geom IS NOT NULL),
            s AS (SELECT count(*) AS n, count(*) FILTER (WHERE x > 0) AS pos FROM v)
            SELECT * FROM (SELECT ARRAY[v.id] AS ids,
                   ${this.literal(label + ' is ')} || round(v.x::numeric, 2)
                     || ', but ' || round(100.0 * s.pos / s.n) || ' % of values are above 0' AS detail,
                   ${gj('ST_PointOnSurface(v.geom)')} AS geometry
              FROM v, s
             WHERE s.n >= 20 AND s.pos >= 0.9 * s.n AND v.x <= 0
             ORDER BY v.id LIMIT 50) np`;
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
    // Attributes are compared on the columns both versions have — a field
    // added (Field Calculator, Table Join) or dropped since the snapshot
    // would otherwise mark every feature as modified.
    const oldNames = new Set(old.map((c) => c.name));
    const curNames = new Set(current.map((c) => c.name));
    const addedFields = current.filter((c) => !oldNames.has(c.name)).map((c) => c.name);
    const removedFields = old.filter((c) => !curNames.has(c.name)).map((c) => c.name);
    const textArray = (names: string[]) => `ARRAY[${names.map((n) => this.literal(n)).join(', ')}]::text[]`;
    const props = (alias: string) => {
      const extra = alias === 's' ? removedFields : addedFields;
      return `(to_jsonb(${alias}) - 'geom' - 'ogc_fid'${extra.length ? ` - ${textArray(extra)}` : ''})`;
    };
    const cur = `"${source.table}"`;
    const prev = `"${snap.postgisTable}"`;
    const gj = (expr: string) => `ST_AsGeoJSON(ST_Transform(${expr}, 4326), 7)::json`;
    const queries = {
      added: `FROM ${cur} c WHERE NOT EXISTS (SELECT 1 FROM ${prev} s WHERE s.${k} = c.${k})`,
      removed: `FROM ${prev} s WHERE NOT EXISTS (SELECT 1 FROM ${cur} c WHERE c.${k} = s.${k})`,
      modified: `FROM ${cur} c JOIN ${prev} s ON s.${k} = c.${k}
                 WHERE c.geom IS DISTINCT FROM s.geom OR ${props('c')} IS DISTINCT FROM ${props('s')}`,
    };
    const result: Record<string, unknown> = {
      snapshot: { id: snap.id, name: snap.name, createdAt: snap.createdAt },
      key,
      fields: { added: addedFields, removed: removedFields },
    };
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
