"""Retrieval step."""
from __future__ import annotations

from typing import List

from . import config, embeddings
from .vectorstore import Retrieved, search


async def retrieve(query: str, municipality_id: str) -> List[Retrieved]:
    vec = embeddings.embed_query(query)
    return await search(vec, municipality_id, config.RAG_TOP_K)
