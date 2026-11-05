import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GisLayersService } from '../gis/gis-layers.service';
import { isSafeGeneratedTableName } from '../gis/layer-naming.util';
import type { AppUser } from '../auth/types/app-user.type';
import type { AiLayerInfo } from './ai-client.service';

/** Canonical demo layers share these tables (Task 6 migration) and are
 *  filtered by `gis_workspace_id` rather than owning a per-layer table. */
const DEMO_TABLE_BY_CODE: Record<string, string> = {
  MUNICIPAL_BOUNDARY: 'gis_demo_municipal_boundary',
  WARDS: 'gis_demo_wards',
  ROADS: 'gis_demo_roads',
};

export type FieldKind =
  | 'text'
  | 'integer'
  | 'number'
  | 'date'
  | 'boolean'
  | 'id'
  | 'geometry';

export interface CatalogColumn {
  name: string;
  dataType: string;
  kind: FieldKind;
  /** A text column whose values are numbers ("2052", "1,250"): treated as
   *  kind 'number' and read through a safe cast (see the query compiler). */
  numericText?: boolean;
  sampleValues: string[];
  /** From ai_field_metadata (profiled at upload, Owner-editable). */
  role?: string;
  unit?: string | null;
  description?: string | null;
  aliases?: string[];
  /** Profiled: each feature has its own value here (a "Pawna River"
   *  column); how often values contain spaces (names do, codes don't). */
  uniquePerFeature?: boolean;
  spaced?: number;
}

/** Everything the query compiler needs to safely build SQL for one layer. */
export interface LayerCatalogEntry {
  layerId: string;
  code: string;
  name: string;
  description: string | null;
  geometryType: string | null;
  /** Marked as a routing (road network) layer at upload. */
  routingEnabled: boolean;
  /** GeoServer workspace + layer: "{geoserverWorkspace}:{geoserverLayer}". */
  geoserverWorkspace: string;
  geoserverLayer: string;
  /** Physical PostGIS table — an app-generated `layer_<uuid>` or a fixed
   *  `gis_demo_*` name; never derived from user/LLM input. */
  table: string;
  geomColumn: string;
  pkColumn: string;
  srid: number;
  isDemo: boolean;
  workspaceId: string;
  columns: CatalogColumn[];
}

const NUMERIC = new Set([
  'smallint',
  'integer',
  'bigint',
  'numeric',
  'decimal',
  'real',
  'double precision',
  'money',
]);
const INTEGERISH = new Set(['smallint', 'integer', 'bigint']);
const TEXTISH = new Set([
  'character varying',
  'character',
  'text',
  'name',
  'uuid',
  'citext',
]);
const INTERNAL_COLUMNS = new Set(['ogc_fid', 'fid', 'gis_workspace_id']);
const MATCHES_PER_COLUMN = 15;
const DISTINCT_PER_COLUMN = 5000;
/** Above this many rows a full DISTINCT per text column is too slow (a
 *  653k-row table took ~60 s); look up only the question's words instead. */
const LARGE_TABLE_ROWS = 50_000;
/** Text fields nobody names a value by (ids, codes, flags, measures). */
const NON_VALUE_COLUMN =
  /(^|_)(id|fid|gid|uid|code|cd|status|sta|year|area|length|leng|shape|summer|month)(_|$)|^objectid|code$|_\d+$/i;
const LARGE_TABLE_COLUMNS = 12;
const DISTINCT_CACHE_MS = 10 * 60 * 1000;
/** A number written as text: "2052", "-3.5", "1,250". */
const NUMERIC_TEXT_SQL = '^-?[0-9][0-9,]*(\\.[0-9]+)?$';
const NUMERIC_PROFILE_ROWS = 5000;

/** Words common to every request — they would match half of any column. */
const QUESTION_STOPWORDS = new Set(
  ('show display list find get locate highlight all the and with that which are there where what how many ' +
    'count number total within from near nearest closest than more less into inside each every per for ' +
    'features feature layer layers map data metres meters metre meter only those these them now same ' +
    'have has not are was were been this').split(' '),
);

/** Distinctive words of a request, singular-ish ("signals" -> "signal"),
 *  at least 3 letters, no pure numbers. */
function questionWords(question: string): string[] {
  const out = new Set<string>();
  for (const raw of question.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || /^\d+$/.test(raw) || QUESTION_STOPWORDS.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return [...out].slice(0, 8);
}

/** Letter-triple sets, padded so word starts/ends count: "road" -> " ro", "roa", "oad", "ad ". */
function trigrams(word: string): Set<string> {
  const padded = `  ${word} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Trigram (Jaccard) similarity of two words, 0..1 — the same idea as
 *  PostgreSQL's pg_trgm, used here for typo tolerance ("aalandi"/"alandi"). */
function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/** How many question words a stored value contains, exactly or as a close
 *  spelling (words of 5+ letters only, so short words never match loosely). */
function matchScore(value: string, words: string[]): number {
  const lower = value.toLowerCase();
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
  let n = 0;
  for (const w of words) {
    if (lower.includes(w)) n++;
    else if (w.length >= 5 && tokens.some((t) => similarity(w, t) >= 0.5)) n++;
  }
  return n;
}
const SAMPLE_LIMIT = 25;

@Injectable()
export class LayerCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gisLayers: GisLayersService,
  ) {}

  private classify(dataType: string): FieldKind {
    const t = dataType.toLowerCase();
    if (t.includes('geometry') || t.includes('geography')) return 'geometry';
    if (INTEGERISH.has(t)) return 'integer';
    if (NUMERIC.has(t)) return 'number';
    if (t.includes('bool')) return 'boolean';
    if (t.includes('date') || t.includes('time')) return 'date';
    if (TEXTISH.has(t)) return 'text';
    return 'text';
  }

  /** The caller's authorised, ACTIVE layers, each fully described. */
  async buildForUser(appUser: AppUser): Promise<LayerCatalogEntry[]> {
    const authorised = await this.gisLayers.listForMunicipality(appUser);
    const authorisedIds = authorised
      .filter((l) => l.layerType === 'VECTOR')
      .map((l) => l.id);
    if (authorisedIds.length === 0) return [];

    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId: appUser.municipalityId },
      select: { id: true, defaultCrs: true },
    });
    if (!workspace) return [];

    const rows = await this.prisma.gISLayer.findMany({
      where: { id: { in: authorisedIds }, status: 'ACTIVE' },
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        geometryType: true,
        routingEnabled: true,
        geoserverWorkspace: true,
        geoserverLayer: true,
        postgisTable: true,
      },
      orderBy: { displayOrder: 'asc' },
    });

    const wsSrid = this.parseSrid(workspace.defaultCrs) ?? 32643;
    const metadata = await this.fieldMetadata(rows.map((r) => r.id));
    const out: LayerCatalogEntry[] = [];
    for (const row of rows) {
      const isDemo = !row.postgisTable;
      const table = row.postgisTable ?? DEMO_TABLE_BY_CODE[row.code];
      if (!table) continue;
      if (!isDemo && !isSafeGeneratedTableName(table)) continue;
      if (isDemo && !Object.values(DEMO_TABLE_BY_CODE).includes(table)) continue;

      const described = await this.describeTable(
        table,
        isDemo,
        workspace.id,
        wsSrid,
      );
      if (!described) continue;
      for (const col of described.columns) {
        const meta = metadata.get(`${row.id}:${col.name}`);
        if (meta) Object.assign(col, meta);
      }

      out.push({
        layerId: row.id,
        code: row.code,
        name: row.name,
        description: row.description,
        geometryType: row.geometryType,
        routingEnabled: row.routingEnabled,
        geoserverWorkspace: row.geoserverWorkspace,
        geoserverLayer: row.geoserverLayer,
        table,
        geomColumn: described.geomColumn,
        pkColumn: isDemo ? 'id' : 'ogc_fid',
        srid: described.srid,
        isDemo,
        workspaceId: workspace.id,
        columns: described.columns,
      });
    }
    return out;
  }

  /** What each column means, learned by the AI service at upload; keyed
   *  `layerId:field`. Empty when the table is missing (not migrated yet). */
  private async fieldMetadata(
    layerIds: string[],
  ): Promise<Map<string, Pick<CatalogColumn, 'role' | 'unit' | 'description' | 'aliases' | 'uniquePerFeature' | 'spaced'>>> {
    const out = new Map<
      string,
      Pick<CatalogColumn, 'role' | 'unit' | 'description' | 'aliases' | 'uniquePerFeature' | 'spaced'>
    >();
    if (layerIds.length === 0) return out;
    try {
      const rows = await this.prisma.aiFieldMetadata.findMany({ where: { layerId: { in: layerIds } } });
      for (const r of rows) {
        const st = (r.stats ?? {}) as { rows?: number; filled?: number; distinct?: number; spaced?: number };
        const filled = st.filled ?? 0;
        out.set(`${r.layerId}:${r.field}`, {
          role: r.role,
          unit: r.unit,
          description: r.description,
          aliases: [...new Set([...r.learnedAliases, ...r.aliases])],
          uniquePerFeature: filled > 0 && filled >= 0.9 * (st.rows ?? 0) && (st.distinct ?? 0) >= 0.95 * filled,
          spaced: st.spaced ?? 0,
        });
      }
    } catch {
      // best effort — the planner falls back to column-name rules
    }
    return out;
  }

  /** Remembers that users call `field` of `layerId` by `alias` (their
   *  answer to "which field did you mean?"), so the next question needs
   *  no clarification. Survives re-profiling. */
  async learnAlias(layerId: string, field: string, alias: string): Promise<void> {
    const words = alias.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (words.length < 3 || words === field.toLowerCase().replace(/_/g, ' ')) return;
    await this.prisma.$executeRaw`
      UPDATE ai_field_metadata
         SET learned_aliases = array_append(learned_aliases, ${words}), updated_at = now()
       WHERE layer_id = ${layerId} AND field = ${field}
         AND NOT (${words} = ANY(learned_aliases))`.catch(() => undefined);
  }

  /** Distinct text values per layer table, cached so a question does not
   *  scan every table. Uploaded tables are created at publish time, so a
   *  per-column database index is not an option; a short TTL keeps edits
   *  visible within minutes. Keyed by table (+ workspace for demo tables). */
  private readonly distinctCache = new Map<string, { at: number; values: Map<string, string[]> }>();

  /**
   * Per-question value lookup. The catalog only samples the first 25
   * distinct values of each text column (alphabetically), so "signals on
   * Dehu Alandi Road" names a value the model never sees. This finds the
   * values of the caller's own layers that contain the question's words —
   * or a close spelling of them ("Aalandi" -> Alandi) — and puts them first
   * in each column's sample list; the AI service's value matching, fast
   * path and prompt hints then use the exact stored value.
   * Mutates `entries` (a fresh catalog built for this request).
   */
  async addMatchingValues(entries: LayerCatalogEntry[], question: string): Promise<void> {
    const words = questionWords(question);
    if (words.length === 0) return;
    await Promise.all(
      entries.map(async (entry) => {
        const textCols = entry.columns.filter(
          (c) => c.kind === 'text' && !INTERNAL_COLUMNS.has(c.name),
        );
        if (textCols.length === 0) return;
        const distinct = (await this.isLargeTable(entry))
          ? await this.questionValues(entry, textCols, words)
          : await this.distinctValues(entry, textCols);
        for (const col of textCols) {
          const hits = (distinct.get(col.name) ?? [])
            .map((v) => ({ v, n: matchScore(v, words) }))
            .filter((h) => h.n > 0)
            .sort((a, b) => b.n - a.n || a.v.length - b.v.length)
            .slice(0, MATCHES_PER_COLUMN)
            .map((h) => h.v);
          if (hits.length) {
            col.sampleValues = [...hits, ...col.sampleValues.filter((v) => !hits.includes(v))];
          }
        }
      }),
    );
  }

  private readonly rowCountCache = new Map<string, { at: number; rows: number }>();

  private async isLargeTable(entry: LayerCatalogEntry): Promise<boolean> {
    if (entry.isDemo) return false;
    const hit = this.rowCountCache.get(entry.table);
    if (hit && Date.now() - hit.at < DISTINCT_CACHE_MS) return hit.rows >= LARGE_TABLE_ROWS;
    const [row] = await this.prisma
      .$queryRawUnsafe<{ rows: number }[]>(
        `SELECT GREATEST(reltuples, 0)::float8 AS rows FROM pg_class WHERE relname = $1 AND relkind = 'r'`,
        entry.table,
      )
      .catch(() => [] as { rows: number }[]);
    const rows = Number(row?.rows ?? 0);
    this.rowCountCache.set(entry.table, { at: Date.now(), rows });
    return rows >= LARGE_TABLE_ROWS;
  }

  /**
   * Large tables: only values that contain one of the question's words (or
   * a close spelling, via pg_trgm), in the table's value-bearing text
   * columns — indexed by the search service's trigram indexes. Per
   * question, not cached; bounded by a statement timeout.
   */
  private async questionValues(
    entry: LayerCatalogEntry,
    textCols: CatalogColumn[],
    words: string[],
  ): Promise<Map<string, string[]>> {
    const useful = textCols.filter((c) => !NON_VALUE_COLUMN.test(c.name));
    const cols = (useful.length ? useful : textCols)
      .sort((a, b) => Number(!/name/i.test(a.name)) - Number(!/name/i.test(b.name)))
      .slice(0, LARGE_TABLE_COLUMNS);
    const values = new Map<string, string[]>();
    if (!cols.length || !words.length) return values;
    const patterns = words.map((w) => `%${w.replace(/[\\%_]/g, '')}%`);
    const union = cols
      .map((c) => {
        const col = `"${c.name.replace(/"/g, '""')}"`;
        const match = words.map((_, i) => `$${i + 2} <% ${col}`).join(' OR ');
        return (
          `(SELECT '${c.name.replace(/'/g, "''")}' AS c, v FROM (SELECT DISTINCT ${col}::text AS v ` +
          `FROM "${entry.table}" WHERE ${col} ILIKE ANY($1) OR ${match} LIMIT ${MATCHES_PER_COLUMN * 2}) d)`
        );
      })
      .join(' UNION ALL ');
    try {
      const rows = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = 4000`);
        await tx.$executeRawUnsafe(`SET LOCAL pg_trgm.word_similarity_threshold = 0.5`);
        return tx.$queryRawUnsafe<{ c: string; v: string }[]>(union, patterns, ...words);
      });
      for (const r of rows) {
        if (!r.v) continue;
        const list = values.get(r.c) ?? [];
        list.push(r.v);
        values.set(r.c, list);
      }
    } catch {
      // best effort — the plan still works without the hint
    }
    return values;
  }

  private async distinctValues(
    entry: LayerCatalogEntry,
    textCols: CatalogColumn[],
  ): Promise<Map<string, string[]>> {
    const key = entry.isDemo ? `${entry.table}:${entry.workspaceId}` : entry.table;
    const cached = this.distinctCache.get(key);
    if (cached && Date.now() - cached.at < DISTINCT_CACHE_MS) return cached.values;

    // `table` is whitelisted at catalog build; column names come from
    // information_schema; nothing here comes from the question.
    const scope = entry.isDemo ? `AND "gis_workspace_id" = $1` : '';
    const union = textCols
      .map((c) => {
        const col = c.name.replace(/"/g, '');
        return (
          `(SELECT '${c.name.replace(/'/g, "''")}' AS c, v FROM (SELECT DISTINCT "${col}"::text AS v ` +
          `FROM "${entry.table}" WHERE "${col}" IS NOT NULL ${scope} LIMIT ${DISTINCT_PER_COLUMN}) d)`
        );
      })
      .join(' UNION ALL ');
    const values = new Map<string, string[]>();
    try {
      const rows: { c: string; v: string }[] = entry.isDemo
        ? await this.prisma.$queryRawUnsafe(union, entry.workspaceId)
        : await this.prisma.$queryRawUnsafe(union);
      for (const r of rows) {
        if (!r.v) continue;
        const list = values.get(r.c) ?? [];
        list.push(r.v);
        values.set(r.c, list);
      }
    } catch {
      return values; // best effort — the plan still works without the hint
    }
    this.distinctCache.set(key, { at: Date.now(), values });
    return values;
  }

  toAiLayerInfo(entries: LayerCatalogEntry[]): AiLayerInfo[] {
    return entries.map((e) => ({
      id: e.layerId,
      code: e.code,
      name: e.name,
      geometry_type: e.geometryType,
      description: e.description,
      fields: e.columns
        .filter((c) => c.kind !== 'geometry')
        .map((c) => ({
          name: c.name,
          type: c.kind,
          sample_values: c.sampleValues,
          role: c.role,
          unit: c.unit,
          description: c.description,
          aliases: c.aliases ?? [],
        })),
    }));
  }

  private parseSrid(crs: string | null | undefined): number | null {
    if (!crs) return null;
    const n = Number(String(crs).split(':').pop());
    return Number.isFinite(n) ? n : null;
  }

  /** describeTable results per table — sampling every text column of a
   *  large table took 20–40 s, so it must not run on every question. */
  private readonly describeCache = new Map<
    string,
    { at: number; result: Promise<Awaited<ReturnType<LayerCatalogService['describeTableUncached']>>> }
  >();

  private async describeTable(
    table: string,
    isDemo: boolean,
    workspaceId: string,
    fallbackSrid: number,
  ) {
    const key = isDemo ? `${table}:${workspaceId}` : table;
    let hit = this.describeCache.get(key);
    if (!hit || Date.now() - hit.at >= DISTINCT_CACHE_MS) {
      const result = this.describeTableUncached(table, isDemo, workspaceId, fallbackSrid);
      result.catch(() => this.describeCache.delete(key));
      hit = { at: Date.now(), result };
      this.describeCache.set(key, hit);
    }
    const described = await hit.result;
    return described ? structuredClone(described) : null;
  }

  private async describeTableUncached(
    table: string,
    isDemo: boolean,
    workspaceId: string,
    fallbackSrid: number,
  ): Promise<{
    columns: CatalogColumn[];
    geomColumn: string;
    srid: number;
  } | null> {
    const columnRows = await this.prisma.$queryRawUnsafe<
      { column_name: string; data_type: string }[]
    >(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      table,
    );
    if (columnRows.length === 0) return null;

    let geomColumn = 'geom';
    let srid = fallbackSrid;
    const geomMeta = await this.prisma.$queryRawUnsafe<
      { f_geometry_column: string; srid: number }[]
    >(
      `SELECT f_geometry_column, srid
         FROM geometry_columns
        WHERE f_table_schema = 'public' AND f_table_name = $1
        LIMIT 1`,
      table,
    );
    if (geomMeta[0]) {
      geomColumn = geomMeta[0].f_geometry_column || 'geom';
      if (geomMeta[0].srid) srid = Number(geomMeta[0].srid);
    }

    const columns: CatalogColumn[] = [];
    for (const col of columnRows) {
      const kind = this.classify(col.data_type);
      if (kind === 'geometry' || col.column_name === geomColumn) continue;
      const entry: CatalogColumn = {
        name: col.column_name,
        dataType: col.data_type,
        kind: col.column_name === 'ogc_fid' ? 'id' : kind,
        sampleValues: [],
      };
      if (kind === 'text' && !INTERNAL_COLUMNS.has(col.column_name)) {
        entry.sampleValues = await this.sampleDistinct(
          table,
          col.column_name,
          isDemo,
          workspaceId,
        );
      }
      columns.push(entry);
    }
    await this.markNumericText(table, columns, isDemo, workspaceId);
    return { columns, geomColumn, srid };
  }

  /**
   * Uploads often store numbers as text (shapefile/CSV): a text column is
   * numeric when ≥ 95 % of its non-empty values (over the first rows) are
   * numbers. One pass over all text columns; any data, no names assumed.
   */
  private async markNumericText(
    table: string,
    columns: CatalogColumn[],
    isDemo: boolean,
    workspaceId: string,
  ): Promise<void> {
    const text = columns.filter((c) => c.kind === 'text' && !INTERNAL_COLUMNS.has(c.name));
    if (!text.length) return;
    const scope = isDemo ? 'WHERE gis_workspace_id = $1' : '';
    const parts = text.map((c, i) => {
      const v = `btrim("${c.name.replace(/"/g, '')}"::text)`;
      return (
        `count(nullif(${v}, '')) AS n${i}, ` +
        `count(*) FILTER (WHERE ${v} ~ '${NUMERIC_TEXT_SQL}') AS k${i}`
      );
    });
    const sql = `SELECT ${parts.join(', ')} FROM (SELECT * FROM "${table}" ${scope} LIMIT ${NUMERIC_PROFILE_ROWS}) s`;
    try {
      const [row] = isDemo
        ? await this.prisma.$queryRawUnsafe<Record<string, bigint>[]>(sql, workspaceId)
        : await this.prisma.$queryRawUnsafe<Record<string, bigint>[]>(sql);
      text.forEach((c, i) => {
        const n = Number(row?.[`n${i}`] ?? 0);
        const k = Number(row?.[`k${i}`] ?? 0);
        if (n > 0 && k / n >= 0.95) {
          c.kind = 'number';
          c.numericText = true;
        }
      });
    } catch {
      // best effort — columns stay text
    }
  }

  private async sampleDistinct(
    table: string,
    column: string,
    isDemo: boolean,
    workspaceId: string,
  ): Promise<string[]> {
    // `table` is whitelisted (isSafeGeneratedTableName / fixed demo names)
    // and `column` comes from information_schema — never user/LLM input.
    const safeCol = column.replace(/"/g, '');
    const scope = isDemo ? 'WHERE gis_workspace_id = $1' : '';
    const guard = isDemo ? 'AND' : 'WHERE';
    const sql = `SELECT DISTINCT "${safeCol}"::text AS v
                   FROM "${table}" ${scope}
                  ${guard} "${safeCol}" IS NOT NULL
                  ORDER BY 1
                  LIMIT ${SAMPLE_LIMIT + 1}`;
    try {
      const rows = isDemo
        ? await this.prisma.$queryRawUnsafe<{ v: string }[]>(sql, workspaceId)
        : await this.prisma.$queryRawUnsafe<{ v: string }[]>(sql);
      const values = rows.map((r) => r.v).filter((v): v is string => v != null);
      return values.length > SAMPLE_LIMIT
        ? [...values.slice(0, SAMPLE_LIMIT), '…(more)']
        : values;
    } catch {
      return [];
    }
  }
}
