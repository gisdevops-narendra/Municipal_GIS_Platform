"""asyncpg connection pool.

This service touches the database for exactly two purposes:
  1. reading the layer / field catalog (read-only) to build the RAG index;
  2. reading and writing its own `rag_documents` (embeddings) table.

It never queries spatial feature tables and never executes an
LLM-generated statement — all natural-language GIS operations are compiled
to parameterised SQL and executed by the Node.js backend, not here.
"""
from __future__ import annotations

import contextlib
from typing import AsyncIterator, Optional

import asyncpg
from pgvector.asyncpg import register_vector

from . import config

_pool: Optional[asyncpg.Pool] = None


async def _init_connection(conn: asyncpg.Connection) -> None:
    await conn.execute(f'SET search_path TO "{config.DB_SCHEMA}"')
    # Cheap no-op after the first connection / the Prisma migration; ensures
    # every pooled connection can register the pgvector codec below.
    with contextlib.suppress(Exception):
        await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
    with contextlib.suppress(Exception):
        await register_vector(conn)


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            dsn=config.DATABASE_URL,
            min_size=1,
            max_size=8,
            command_timeout=30,
            init=_init_connection,
        )
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


@contextlib.asynccontextmanager
async def acquire() -> AsyncIterator[asyncpg.Connection]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        yield conn


async def ensure_schema() -> None:
    """Idempotently ensure pgvector + the rag_documents table exist.

    The authoritative definition lives in the Prisma migration
    `20260828160000_add_rag_documents`; this is a defensive fallback so the
    service still works if run against a database where that migration
    hasn't been applied yet.
    """
    async with acquire() as conn:
        await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        await conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS rag_documents (
                id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                municipality_id TEXT,
                doc_type        TEXT NOT NULL,
                ref_key         TEXT NOT NULL,
                title           TEXT NOT NULL,
                content         TEXT NOT NULL,
                embedding       vector({config.EMBEDDING_DIM}) NOT NULL,
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        await conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS rag_documents_ref_key
            ON rag_documents (municipality_id, ref_key) NULLS NOT DISTINCT
            """
        )
        await conn.execute(
            """
            CREATE INDEX IF NOT EXISTS rag_documents_embedding_idx
            ON rag_documents USING hnsw (embedding vector_cosine_ops)
            """
        )
        # re-register the type now that the extension definitely exists
        await register_vector(conn)
