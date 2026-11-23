-- Every layer table's feature id becomes `feat_id`: the integer primary key
-- GDAL created as `ogc_fid` (1, 2, 3 … in upload order) is renamed, keeping
-- every number, so nothing that points at a feature breaks. New rows keep
-- taking the next number from the same sequence (never reused).
-- A source attribute already called `feat_id` is kept as `feat_id_source`.
-- Runtime layer tables aren't Prisma models, so they're found here by shape.
DO $$
DECLARE
  t record;
  target text;
  n int;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
     WHERE c.table_schema = current_schema()
       AND c.column_name = 'ogc_fid'
       AND c.data_type IN ('integer', 'bigint', 'smallint')
       AND EXISTS (
             SELECT 1 FROM pg_index i
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
              WHERE i.indrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
                AND i.indisprimary AND a.attname = 'ogc_fid'
                AND array_length(i.indkey::int2[], 1) = 1)
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = t.table_name AND column_name = 'feat_id') THEN
      target := 'feat_id_source';
      n := 2;
      WHILE EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema() AND table_name = t.table_name AND column_name = target) LOOP
        target := 'feat_id_source_' || n;
        n := n + 1;
      END LOOP;
      EXECUTE format('ALTER TABLE %I RENAME COLUMN feat_id TO %I', t.table_name, target);
    END IF;
    EXECUTE format('ALTER TABLE %I RENAME COLUMN ogc_fid TO feat_id', t.table_name);
  END LOOP;
END $$;

-- The AI assistant's notes about columns / layers use the new name too.
UPDATE ai_field_metadata
   SET field = 'feat_id',
       description = replace(description, 'ogc_fid', 'feat_id')
 WHERE field = 'ogc_fid'
   AND NOT EXISTS (SELECT 1 FROM ai_field_metadata m2
                    WHERE m2.layer_id = ai_field_metadata.layer_id AND m2.field = 'feat_id');
UPDATE rag_documents SET content = replace(content, 'ogc_fid', 'feat_id') WHERE content LIKE '%ogc_fid%';
