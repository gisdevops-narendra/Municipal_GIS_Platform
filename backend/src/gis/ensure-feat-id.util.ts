import type { PrismaClient } from '@prisma/client';

type Sql = Pick<PrismaClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

/** Name of every layer table's feature id: an integer primary key, 1, 2, 3 …
 *  in upload order, never reused (new rows take the next number). Used
 *  everywhere a feature is identified — queries, filters, edits, selection,
 *  GeoServer. Shown to users read-only. */
export const FEAT_ID = 'feat_id';

/**
 * Guarantees a layer table has an integer `feat_id` primary key.
 *
 * ogr2ogr creates its own key column (`ogc_fid`, numbered 1…N) — that one
 * simply becomes `feat_id`. When the source brought its own key instead (a
 * GeoJSON feature `id`, a database primary key, a GeoPackage fid…), that
 * column is kept as an ordinary attribute and a fresh `feat_id` 1…N becomes
 * the key. A source attribute that is itself called `feat_id` (but isn't the
 * key) is kept as `feat_id_source`. Idempotent; `table` must be a
 * generated, already-validated table name.
 */
export async function ensureFeatId(db: Sql, table: string): Promise<void> {
  const keyInfo = (column: string) =>
    db.$queryRawUnsafe<{ data_type: string; is_pk: boolean }[]>(
      `SELECT c.data_type,
              EXISTS (
                SELECT 1 FROM pg_index i
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
                WHERE i.indrelid = format('%I', c.table_name)::regclass
                  AND i.indisprimary AND a.attname = c.column_name
                  AND array_length(i.indkey::int2[], 1) = 1
              ) AS is_pk
         FROM information_schema.columns c
        WHERE c.table_schema = current_schema() AND c.table_name = $1 AND c.column_name = $2`,
      table,
      column,
    );
  const usableKey = (c?: { data_type: string; is_pk: boolean }) =>
    !!c && c.is_pk && /integer|bigint|smallint/.test(c.data_type);

  const feat = (await keyInfo(FEAT_ID))[0];
  if (usableKey(feat)) return;
  if (feat) {
    let target = 'feat_id_source';
    for (let n = 2; await hasColumn(db, table, target); n++) target = `feat_id_source_${n}`;
    await db.$executeRawUnsafe(`ALTER TABLE "${table}" RENAME COLUMN "${FEAT_ID}" TO "${target}"`);
  }

  // GDAL's own 1…N key → feat_id (keeps every number as it is).
  if (usableKey((await keyInfo('ogc_fid'))[0])) {
    await db.$executeRawUnsafe(`ALTER TABLE "${table}" RENAME COLUMN "ogc_fid" TO "${FEAT_ID}"`);
    return;
  }

  const pk = await db.$queryRawUnsafe<{ conname: string }[]>(
    `SELECT conname FROM pg_constraint WHERE conrelid = format('%I', $1::text)::regclass AND contype = 'p'`,
    table,
  );
  if (pk[0]) await db.$executeRawUnsafe(`ALTER TABLE "${table}" DROP CONSTRAINT "${pk[0].conname}"`);
  await db.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${FEAT_ID}" serial PRIMARY KEY`);
}

async function hasColumn(db: Sql, table: string, column: string): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<unknown[]>(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    table,
    column,
  );
  return rows.length > 0;
}

/**
 * Cleans column names a source left unusable: leading / trailing
 * whitespace or control characters (e.g. a trailing newline — common in
 * data exported from spreadsheets) and inner control characters. Those
 * break GeoServer's XML, filters and queries. A cleaned name that clashes
 * with an existing column gets a _2, _3… suffix. Idempotent; `table` must
 * be a generated, already-validated table name.
 */
export async function normalizeColumnNames(db: Sql, table: string): Promise<void> {
  const cols = await db.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
    table,
  );
  const clean = (n: string) =>
    n.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().replace(/\s+/g, '_').slice(0, 63) || 'column';
  const taken = new Set(cols.map((c) => c.column_name).filter((n) => clean(n) === n));
  for (const { column_name: name } of cols) {
    const base = clean(name);
    if (base === name) continue;
    let target = base;
    for (let n = 2; taken.has(target); n++) target = `${base.slice(0, 60)}_${n}`;
    taken.add(target);
    await db.$executeRawUnsafe(
      `ALTER TABLE "${table}" RENAME COLUMN "${name.replace(/"/g, '""')}" TO "${target.replace(/"/g, '""')}"`,
    );
  }
}
