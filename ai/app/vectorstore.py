"""pgvector-backed document store for RAG.

Lives in the SAME PostgreSQL database as the rest of the platform (table
`rag_documents`). Only embeddings + short metadata/knowledge text are
stored here — never GIS feature data.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence

from . import db


@dataclass
class RagDoc:
    municipality_id: Optional[str]
    doc_type: str            # 'layer' | 'field' | 'tool' | 'rule'
    ref_key: str             # stable key, used for idempotent upsert
    title: str
    content: str


@dataclass
class Retrieved:
    doc_type: str
    title: str
    content: str
    score: float


async def replace_scope(
    municipality_id: Optional[str],
    doc_types: Sequence[str],
    docs: List[RagDoc],
    embeddings: List[List[float]],
) -> int:
    """Atomically replace every doc in (municipality_id, doc_types) with `docs`."""
    async with db.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                DELETE FROM rag_documents
                WHERE municipality_id IS NOT DISTINCT FROM $1
                  AND doc_type = ANY($2::text[])
                """,
                municipality_id,
                list(doc_types),
            )
            if docs:
                await conn.executemany(
                    """
                    INSERT INTO rag_documents
                        (municipality_id, doc_type, ref_key, title, content, embedding)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    """,
                    [
                        (
                            d.municipality_id,
                            d.doc_type,
                            d.ref_key,
                            d.title,
                            d.content,
                            emb,
                        )
                        for d, emb in zip(docs, embeddings)
                    ],
                )
    return len(docs)


async def search(
    query_embedding: List[float],
    municipality_id: Optional[str],
    top_k: int,
) -> List[Retrieved]:
    """Cosine-similarity search, scoped to this municipality + global docs."""
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT doc_type, title, content,
                   1 - (embedding <=> $1) AS score
            FROM rag_documents
            WHERE municipality_id IS NULL
               OR municipality_id = $2
            ORDER BY embedding <=> $1
            LIMIT $3
            """,
            query_embedding,
            municipality_id,
            top_k,
        )
    return [
        Retrieved(
            doc_type=r["doc_type"],
            title=r["title"],
            content=r["content"],
            score=float(r["score"]),
        )
        for r in rows
    ]


async def count(municipality_id: Optional[str]) -> int:
    async with db.acquire() as conn:
        return await conn.fetchval(
            """
            SELECT count(*) FROM rag_documents
            WHERE municipality_id IS NULL OR municipality_id = $1
            """,
            municipality_id,
        )
