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
  sampleValues: string[];
}

/** Everything the query compiler needs to safely build SQL for one layer. */
export interface LayerCatalogEntry {
  layerId: string;
  code: string;
  name: string;
  description: string | null;
  geometryType: string | null;
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
const DISTINCT_CACHE_MS = 10 * 60 * 1000;

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
        geoserverLayer: true,
        postgisTable: true,
      },
      orderBy: { displayOrder: 'asc' },
    });

    const wsSrid = this.parseSrid(workspace.defaultCrs) ?? 32643;
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

      out.push({
        layerId: row.id,
        code: row.code,
        name: row.name,
        description: row.description,
        geometryType: row.geometryType,
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
        const distinct = await this.distinctValues(entry, textCols);
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
        })),
    }));
  }

  private parseSrid(crs: string | null | undefined): number | null {
    if (!crs) return null;
    const n = Number(String(crs).split(':').pop());
    return Number.isFinite(n) ? n : null;
  }

  private async describeTable(
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
    return { columns, geomColumn, srid };
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
