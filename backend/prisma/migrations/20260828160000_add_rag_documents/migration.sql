-- AI/RAG chatbot — pgvector extension + the embedding store.
--
-- Hand-written (same convention as the GIS migrations and
-- 20260828140000_add_user_settings): a plain `prisma migrate diff` against
-- this database also proposes dropping the unmanaged runtime tables
-- (`gis_demo_*`, GDAL-created `layer_<uuid>`, and now `rag_documents`) —
-- recurring false positives, omitted here. `rag_documents` is written only
-- by the Python AI service, never by Prisma, so it is deliberately NOT
-- modelled in schema.prisma (same as the gis_demo_* tables).

CREATE EXTENSION IF NOT EXISTS vector;

-- One row per RAG chunk: a GIS layer, an attribute field (with sampled
-- real values), a GIS-tool capability note, or a municipal planning
-- reference note. `municipality_id` is NULL for the global knowledge docs.
CREATE TABLE IF NOT EXISTS "rag_documents" (
    "id"              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "municipality_id" TEXT
        REFERENCES "municipalities"("id") ON DELETE CASCADE,
    "doc_type"        TEXT NOT NULL,   -- 'layer' | 'field' | 'tool' | 'rule'
    "ref_key"         TEXT NOT NULL,   -- stable key for idempotent re-index
    "title"           TEXT NOT NULL,
    "content"         TEXT NOT NULL,
    "embedding"       vector(384) NOT NULL,
    "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "rag_documents_ref_key"
    ON "rag_documents" ("municipality_id", "ref_key") NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS "rag_documents_scope_idx"
    ON "rag_documents" ("municipality_id", "doc_type");

-- Approximate-nearest-neighbour index for cosine similarity search.
CREATE INDEX IF NOT EXISTS "rag_documents_embedding_idx"
    ON "rag_documents" USING hnsw ("embedding" vector_cosine_ops);
