import type { PrismaClient } from '@prisma/client';

type Sql = Pick<PrismaClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

/**
 * Guarantees a layer table has an integer `ogc_fid` primary key — the
 * platform's queries, edits and GeoServer publishing all key on it.
 *
 * ogr2ogr normally creates it, but names the FID column after the source's
 * own key when it has one (a GeoJSON feature `id`, a database primary key,
 * a GeoPackage fid…), leaving e.g. `id` instead. Any such column is kept as
 * an ordinary attribute; a fresh `ogc_fid` becomes the primary key. A source
 * attribute that happens to be called `ogc_fid` but is not a usable key is
 * renamed out of the way first. Idempotent; `table` must be a generated,
 * already-validated table name.
 */
export async function ensureOgcFid(db: Sql, table: string): Promise<void> {
  const cols = await db.$queryRawUnsafe<{ data_type: string; is_pk: boolean }[]>(
    `SELECT c.data_type,
            EXISTS (
              SELECT 1 FROM pg_index i
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
              WHERE i.indrelid = format('%I', c.table_name)::regclass
                AND i.indisprimary AND a.attname = c.column_name
                AND array_length(i.indkey::int2[], 1) = 1
            ) AS is_pk
       FROM information_schema.columns c
      WHERE c.table_schema = current_schema() AND c.table_name = $1 AND c.column_name = 'ogc_fid'`,
    table,
  );
  const existing = cols[0];
  if (existing && existing.is_pk && /integer|bigint|smallint/.test(existing.data_type)) return;

  if (existing) {
    let target = 'ogc_fid_source';
    for (let n = 2; await hasColumn(db, table, target); n++) target = `ogc_fid_source_${n}`;
    await db.$executeRawUnsafe(`ALTER TABLE "${table}" RENAME COLUMN "ogc_fid" TO "${target}"`);
  }

  const pk = await db.$queryRawUnsafe<{ conname: string }[]>(
    `SELECT conname FROM pg_constraint WHERE conrelid = format('%I', $1::text)::regclass AND contype = 'p'`,
    table,
  );
  if (pk[0]) await db.$executeRawUnsafe(`ALTER TABLE "${table}" DROP CONSTRAINT "${pk[0].conname}"`);
  await db.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "ogc_fid" serial PRIMARY KEY`);
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
