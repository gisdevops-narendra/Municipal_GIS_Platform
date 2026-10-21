-- AI Assistant: what each layer column means, learned on upload.
-- `role`/`unit`/`description`/`aliases` are profiled from the data by the AI
-- service at every re-index unless `source` = 'owner' (an Owner edit is
-- never overwritten); `learned_aliases` come from users' clarification
-- answers and survive re-profiling.
CREATE TABLE IF NOT EXISTS "ai_field_metadata" (
    "layer_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "municipality_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "unit" TEXT,
    "description" TEXT,
    "aliases" TEXT[] NOT NULL DEFAULT '{}',
    "learned_aliases" TEXT[] NOT NULL DEFAULT '{}',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'auto',
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_field_metadata_pkey" PRIMARY KEY ("layer_id", "field")
);
CREATE INDEX IF NOT EXISTS "ai_field_metadata_municipality_id_idx" ON "ai_field_metadata"("municipality_id");
