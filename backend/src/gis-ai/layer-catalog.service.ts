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
