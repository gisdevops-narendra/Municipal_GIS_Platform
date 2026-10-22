import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import type { GISLayerUpload } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiClientService } from '../gis-ai/ai-client.service';
import { isSafeGeneratedTableName } from './layer-naming.util';
import type { ApplyUploadSchemaDto, UploadColumnChangeDto } from './dto/upload-schema.dto';

/** Column types an uploader can choose. */
export type ColumnKind = 'text' | 'integer' | 'number' | 'date' | 'boolean';
export const COLUMN_KINDS: ColumnKind[] = ['text', 'integer', 'number', 'date', 'boolean'];

/** What each column means to the AI assistant. */
export const COLUMN_ROLES = ['id', 'name', 'category', 'measure', 'free_text', 'date', 'flag', 'hidden'] as const;

const SQL_TYPE: Record<ColumnKind, string> = {
  text: 'text',
  integer: 'bigint',
  number: 'double precision',
  date: 'date',
  boolean: 'boolean',
};

/** Columns the import itself owns: never shown, renamed or retyped. */
const SYSTEM_COLUMNS = new Set(['ogc_fid', 'geom', 'gis_workspace_id']);
/** Names a column may not take: system columns and SQL words that break
 *  CQL filters / GeoServer attribute names. */
const RESERVED_NAMES = new Set([
  ...SYSTEM_COLUMNS,
  'all', 'and', 'or', 'not', 'null', 'true', 'false', 'select', 'from', 'where', 'group', 'order', 'by',
  'limit', 'offset', 'table', 'column', 'user', 'like', 'in', 'is', 'between', 'case', 'when', 'then',
  'else', 'end', 'as', 'on', 'join', 'union', 'create', 'drop', 'alter', 'insert', 'update', 'delete',
]);
const COLUMN_NAME = /^[a-z][a-z0-9_]{0,62}$/;
/** "28/08/2026", "28-08-2026", "28.08.2026" (day first, as used in India). */
const DMY = '^(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4})$';
const BOOLEAN_WORDS = ['yes', 'no', 'y', 'n', 'true', 'false', 't', 'f', '1', '0'];
const PREVIEW_ROWS = 10;
const SAMPLE_VALUES = 6;

export interface ColumnConversion {
  /** Non-empty values that cannot become this type (0 = safe). */
  failing: number;
  /** A few of the failing values, to show the user why. */
  examples: string[];
}

export interface UploadSchemaColumn {
  name: string;
  /** Postgres type as stored now. */
  dbType: string;
  kind: ColumnKind | 'other';
  stats: { rows: number; filled: number; distinct: number; min: string | null; max: string | null };
  /** Most frequent values, most common first. */
  samples: { value: string; count: number }[];
  /** Every other type, with how many values would not convert. */
  conversions: Partial<Record<ColumnKind, ColumnConversion>>;
  /** What the AI proposes the column means (null if unavailable). */
  proposal: { role: string; unit: string | null; description: string; aliases: string[] } | null;
  /** What the uploader approved earlier (revisiting the step). */
  approved: { role: string; unit: string | null; description: string | null; aliases: string[] } | null;
}

export interface UploadSchemaChange {
  column: string;
  renamedTo?: string;
  typeFrom?: string;
  typeTo?: string;
  at: string;
}

/**
 * The upload wizard's Columns step: shows the staging table as it really
 * is (records, types, values) with the AI's *proposed* meaning of each
 * column, and applies only the renames / type changes / meanings the
 * uploader approves. Conversions are checked against every value with
 * Postgres's own parser (`pg_input_is_valid`); one that would lose a
 * non-empty value is refused. Callers (GisUploadsService) do the access
 * and status checks.
 */
@Injectable()
export class UploadSchemaService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly ai?: AiClientService,
  ) {}

  async describe(upload: GISLayerUpload, srid: number) {
    const table = this.table(upload);
    const columns = await this.columns(table);
    const rows = await this.prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}"`);
    const total = rows[0]?.n ?? 0;

    const described: UploadSchemaColumn[] = [];
    for (const c of columns) described.push(await this.describeColumn(table, c.name, c.dataType, total));

    // Column meanings are not asked for at upload: the AI assistant works
    // them out after publishing (ai_field_metadata, source 'auto').
    const proposals = null as { name: string; role: string; unit: string | null; description: string; aliases: string[] }[] | null;
    const approved = new Map(
      ((upload.fieldMetadata as unknown as ApprovedMeaning[] | null) ?? []).map((m) => [m.name, m]),
    );
    for (const c of described) {
      const p = proposals?.find((x) => x.name === c.name);
      c.proposal = p ? { role: p.role, unit: p.unit, description: p.description, aliases: p.aliases } : null;
      const a = approved.get(c.name);
      c.approved = a ? { role: a.role, unit: a.unit ?? null, description: a.description ?? null, aliases: a.aliases ?? [] } : null;
    }

    const records = described.length
      ? await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT ${described.map((c) => `"${c.name}"::text AS "${c.name}"`).join(', ')} FROM "${table}" ORDER BY ogc_fid LIMIT ${PREVIEW_ROWS}`,
        )
      : [];

    return {
      table: { rows: total },
      columns: described,
      records,
      proposalsAvailable: proposals != null,
      confirmedAt: upload.schemaConfirmedAt,
      changes: (upload.schemaChanges as unknown as UploadSchemaChange[] | null) ?? [],
    };
  }

  /** Validates every change against the real data, then applies them all
   *  in one transaction (all or nothing). Returns the change log entries
   *  and the approved meanings under the final column names. */
  async apply(upload: GISLayerUpload, dto: ApplyUploadSchemaDto) {
    const table = this.table(upload);
    const current = await this.columns(table);
    const byName = new Map(current.map((c) => [c.name, c]));

    const seen = new Set<string>();
    for (const change of dto.columns) {
      if (!byName.has(change.name)) throw new BadRequestException(`"${change.name}" is not a column of this upload.`);
      if (seen.has(change.name)) throw new BadRequestException(`"${change.name}" is listed twice.`);
      seen.add(change.name);
    }

    // Final names: unique, safe, not reserved.
    const finalName = new Map(current.map((c) => [c.name, c.name]));
    for (const change of dto.columns) {
      if (change.newName == null || change.newName === change.name) continue;
      const name = change.newName;
      if (!COLUMN_NAME.test(name)) {
        throw new BadRequestException(
          `"${name}" is not a valid column name: use lowercase letters, digits and _, starting with a letter (max 63).`,
        );
      }
      if (RESERVED_NAMES.has(name)) throw new BadRequestException(`"${name}" is reserved; choose another name.`);
      finalName.set(change.name, name);
    }
    const finals = [...finalName.values()];
    const duplicate = finals.find((n, i) => finals.indexOf(n) !== i);
    if (duplicate) throw new BadRequestException(`Two columns would both be called "${duplicate}".`);

    // Type changes: each must keep every non-empty value.
    const total = (await this.prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}"`))[0]?.n ?? 0;
    const retype: { change: UploadColumnChangeDto; from: ColumnKind | 'other' }[] = [];
    for (const change of dto.columns) {
      if (!change.type) continue;
      const from = kindOf(byName.get(change.name)!.dataType);
      if (from === change.type) continue;
      const check = await this.conversion(table, change.name, from, change.type, total);
      if (!check) throw new BadRequestException(`"${change.name}" cannot be changed from ${from} to ${change.type}.`);
      if (check.failing > 0) {
        throw new BadRequestException(
          `"${change.name}" cannot become ${change.type}: ${check.failing} value(s) would be lost (e.g. ${check.examples
            .map((e) => `"${e}"`)
            .join(', ')}). Fix the data or keep the type.`,
        );
      }
      retype.push({ change, from });
    }

    const at = new Date().toISOString();
    const log: UploadSchemaChange[] = [];
    await this.prisma.$transaction(async (tx) => {
      // Renames in two passes (via temporary names) so swaps work.
      const renames = dto.columns.filter((c) => finalName.get(c.name) !== c.name);
      for (const [i, c] of renames.entries()) {
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" RENAME COLUMN "${c.name}" TO "__mgp_tmp_${i}"`);
      }
      for (const [i, c] of renames.entries()) {
        const to = finalName.get(c.name)!;
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" RENAME COLUMN "__mgp_tmp_${i}" TO "${to}"`);
        log.push({ column: c.name, renamedTo: to, at });
      }
      for (const { change, from } of retype) {
        const col = finalName.get(change.name)!;
        await tx.$executeRawUnsafe(
          `ALTER TABLE "${table}" ALTER COLUMN "${col}" TYPE ${SQL_TYPE[change.type!]} USING ${usingExpression(`"${col}"`, from, change.type!)}`,
        );
        log.push({ column: col, typeFrom: from, typeTo: change.type!, at });
      }
    });

    const meanings: ApprovedMeaning[] = dto.columns
      .filter((c) => c.role)
      .map((c) => ({
        name: finalName.get(c.name)!,
        role: c.role!,
        unit: c.unit?.trim() || null,
        description: c.description?.trim() || null,
        aliases: [...new Set((c.aliases ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean))].slice(0, 12),
      }));
    return { log, meanings, renamed: new Map([...finalName].filter(([a, b]) => a !== b)) };
  }

  // ---------------------------------------------------------------------

  private table(upload: GISLayerUpload): string {
    if (!upload.postgisTable || !isSafeGeneratedTableName(upload.postgisTable)) {
      throw new BadRequestException('This upload has not been validated successfully yet.');
    }
    return upload.postgisTable;
  }

  private async columns(table: string): Promise<{ name: string; dataType: string }[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ column_name: string; data_type: string }[]>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      table,
    );
    return rows
      .filter((r) => !SYSTEM_COLUMNS.has(r.column_name) && r.data_type !== 'USER-DEFINED')
      .map((r) => ({ name: r.column_name, dataType: r.data_type }));
  }

  private async describeColumn(table: string, name: string, dataType: string, total: number): Promise<UploadSchemaColumn> {
    const col = `"${name}"`;
    const kind = kindOf(dataType);
    const ordered = kind === 'integer' || kind === 'number' || kind === 'date';
    const [stats] = await this.prisma.$queryRawUnsafe<
      { filled: number; distinct: number; min: string | null; max: string | null }[]
    >(
      `SELECT count(NULLIF(trim(${col}::text), ''))::int AS filled, count(DISTINCT ${col})::int AS distinct,
              ${ordered ? `min(${col})::text` : 'NULL'} AS min, ${ordered ? `max(${col})::text` : 'NULL'} AS max
         FROM "${table}"`,
    );
    const samples = await this.prisma.$queryRawUnsafe<{ value: string; count: number }[]>(
      `SELECT ${col}::text AS value, count(*)::int AS count FROM "${table}"
        WHERE NULLIF(trim(${col}::text), '') IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${SAMPLE_VALUES}`,
    );
    const conversions: UploadSchemaColumn['conversions'] = {};
    for (const to of COLUMN_KINDS) {
      if (to === kind) continue;
      const check = await this.conversion(table, name, kind, to, total);
      if (check) conversions[to] = check;
    }
    return {
      name,
      dbType: dataType,
      kind,
      stats: { rows: total, ...stats },
      samples,
      conversions,
      proposal: null,
      approved: null,
    };
  }

  /** How many non-empty values of `column` would not survive becoming
   *  `to` (null: that conversion is not offered at all). */
  private async conversion(
    table: string,
    column: string,
    from: ColumnKind | 'other',
    to: ColumnKind,
    total: number,
  ): Promise<ColumnConversion | null> {
    if (to === 'text') return { failing: 0, examples: [] };
    const col = `"${column}"`;
    const v = `trim(${col}::text)`;
    let bad: string;
    switch (to) {
      case 'integer':
        if (from === 'number') bad = `${col} <> trunc(${col})`;
        else if (from === 'text') bad = `NOT pg_input_is_valid(${v}, 'bigint')`;
        else return null;
        break;
      case 'number':
        if (from === 'integer') return { failing: 0, examples: [] };
        if (from !== 'text') return null;
        bad = `NOT pg_input_is_valid(${v}, 'float8')`;
        break;
      case 'date':
        if (from !== 'text') return null;
        bad = `NOT pg_input_is_valid(${dmyToIso(v)}, 'date')`;
        break;
      case 'boolean':
        if (from === 'integer') bad = `${col} NOT IN (0, 1)`;
        else if (from === 'text') bad = `lower(${v}) NOT IN (${BOOLEAN_WORDS.map((w) => `'${w}'`).join(', ')})`;
        else return null;
        break;
    }
    if (total === 0) return { failing: 0, examples: [] };
    const where = `NULLIF(${v}, '') IS NOT NULL AND (${bad})`;
    const [row] = await this.prisma.$queryRawUnsafe<{ failing: number; examples: string[] | null }[]>(
      `SELECT count(*)::int AS failing,
              (SELECT array_agg(x) FROM (SELECT DISTINCT ${col}::text AS x FROM "${table}" WHERE ${where} LIMIT 3) e) AS examples
         FROM "${table}" WHERE ${where}`,
    );
    return { failing: row?.failing ?? 0, examples: row?.examples ?? [] };
  }
}

interface ApprovedMeaning {
  name: string;
  role: string;
  unit?: string | null;
  description?: string | null;
  aliases?: string[];
}

export function kindOf(dataType: string): ColumnKind | 'other' {
  const t = dataType.toLowerCase();
  if (['smallint', 'integer', 'bigint'].includes(t)) return 'integer';
  if (['numeric', 'real', 'double precision'].includes(t)) return 'number';
  if (t === 'date') return 'date';
  if (t === 'boolean') return 'boolean';
  if (['text', 'character varying', 'character'].includes(t)) return 'text';
  return 'other';
}

/** "28/08/2026" -> "2026-08-28" (other values unchanged). */
function dmyToIso(v: string): string {
  return `regexp_replace(${v}, '${DMY}', '\\3-\\2-\\1')`;
}

/** The ALTER ... USING expression; empty text becomes NULL. Only called
 *  after `conversion` reported no failing value. */
function usingExpression(col: string, from: ColumnKind | 'other', to: ColumnKind): string {
  const v = `NULLIF(trim(${col}::text), '')`;
  switch (to) {
    case 'text':
      return `${col}::text`;
    case 'integer':
      return from === 'number' ? `${col}::bigint` : `${v}::bigint`;
    case 'number':
      return from === 'integer' ? `${col}::double precision` : `${v}::double precision`;
    case 'date':
      return `${dmyToIso(v)}::date`;
    case 'boolean':
      return from === 'integer'
        ? `(${col} = 1)`
        : `CASE WHEN lower(${v}) IN ('yes','y','true','t','1') THEN true WHEN lower(${v}) IN ('no','n','false','f','0') THEN false END`;
  }
}

