"""FastAPI entrypoint for the GIS AI / RAG service.

Pipeline:  LLM  <-  Prompt templates  <-  RAG/Retrieval  <-  Vector DB (pgvector)
                                                              ^
                                                    Embedding model (local)

Every component is open-source and self-hosted — no API key, no external
paid AI service:
  * LLM       — Ollama serving qwen2.5:3b-instruct (Apache-2.0)
  * Embedding — fastembed BAAI/bge-small-en-v1.5 (MIT), in-process
  * Vector DB — pgvector in the existing PostgreSQL/PostGIS database

Endpoints (called only by the Node.js backend, never the browser):
  GET  /health          liveness + capability flags
  POST /reindex         rebuild the RAG index for one municipality
  POST /plan            natural language -> validated structured GIS operation
  POST /narrate         verified result facts -> a short plain-language answer
  POST /search          semantic layer search ("drainage" -> storm_water_lines)
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from . import config, db, embeddings, llm, rag
from .indexer import reindex_municipality
from .schema import (
    NarrateRequest,
    NarrateResult,
    PlanRequest,
    PlanResult,
    ReindexRequest,
    SearchHit,
    SearchRequest,
)
from .vectorstore import count as rag_count, search_layer_docs

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("gis-ai")


async def _startup_tasks() -> None:
    try:
        await db.ensure_schema()
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("ensure_schema failed (migration may not be applied): %s", exc)
    try:
        await asyncio.to_thread(embeddings.warm)
        log.info("embedding model ready")
    except Exception as exc:  # pragma: no cover
        log.warning("embedding model warm-up failed: %s", exc)
    try:
        await asyncio.to_thread(llm.ensure_model)
    except Exception as exc:  # pragma: no cover
        log.warning("local LLM pull failed (will retry lazily): %s", exc)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await db.get_pool()
    # run the slow warm-ups in the background so /health comes up immediately
    task = asyncio.create_task(_startup_tasks())
    yield
    task.cancel()
    await db.close_pool()


app = FastAPI(title="Municipal GIS AI", lifespan=lifespan)


@app.get("/health")
async def health():
    ok_db = True
    try:
        async with db.acquire() as conn:
            await conn.fetchval("SELECT 1")
    except Exception:
        ok_db = False
    llm_reachable = llm.reachable()
    return {
        "status": "ok" if ok_db else "degraded",
        "database": ok_db,
        "llm_provider": "ollama",
        "llm_model": config.LLM_MODEL,
        "llm_reachable": llm_reachable,
        "llm_model_ready": llm_reachable and llm.model_present(),
        "embedding_model": config.EMBEDDING_MODEL,
    }


@app.post("/reindex")
async def reindex(body: ReindexRequest):
    try:
        return await reindex_municipality(body.municipality_id)
    except Exception as exc:
        log.exception("reindex failed")
        raise HTTPException(status_code=500, detail=f"Reindex failed: {exc}")


@app.post("/plan", response_model=PlanResult)
async def plan(body: PlanRequest) -> PlanResult:
    if not llm.available():
        raise HTTPException(
            status_code=503,
            detail=(
                f"The local AI model '{config.LLM_MODEL}' is not ready yet "
                "(Ollama still starting or downloading the model). Try again shortly."
            ),
        )

    try:
        if await rag_count(body.municipality_id) == 0:
            await reindex_municipality(body.municipality_id)
    except Exception:
        log.exception("lazy reindex failed; continuing without retrieval")

    try:
        snippets = await rag.retrieve(body.message, body.municipality_id)
    except Exception:
        log.exception("retrieval failed; continuing with empty context")
        snippets = []

    try:
        return await asyncio.to_thread(
            llm.generate_plan,
            body.message,
            body.layers,
            snippets,
            body.history,
            body.municipality_name,
        )
    except llm.LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        log.exception("plan generation failed")
        raise HTTPException(status_code=502, detail=f"Local LLM error: {exc}")


@app.post("/narrate", response_model=NarrateResult)
async def narrate(body: NarrateRequest) -> NarrateResult:
    try:
        text, grounded = await asyncio.to_thread(
            llm.narrate, body.kind, body.question, body.facts
        )
    except llm.LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        log.exception("narration failed")
        raise HTTPException(status_code=502, detail=f"Local LLM error: {exc}")
    return NarrateResult(text=text, grounded=grounded)


# bge-small separates weakly on short queries: related layer/field docs
# score ~0.66-0.76, unrelated ones ~0.55-0.64 (measured on real catalogs).
# So a hit needs both an absolute floor and to be close to the best hit.
_SEARCH_MIN_SCORE = 0.66
_SEARCH_MAX_GAP = 0.04


@app.post("/search", response_model=list[SearchHit])
async def search(body: SearchRequest) -> list[SearchHit]:
    query = body.query.strip()
    if len(query) < 2:
        return []
    vec = await asyncio.to_thread(embeddings.embed_query, query)
    rows = await search_layer_docs(vec, body.municipality_id, max(1, min(body.top_k, 30)))
    top = max((score for _, _, score in rows), default=0.0)
    best: dict[str, SearchHit] = {}
    for ref_key, title, score in rows:
        parts = ref_key.split(":", 2)  # layer:<id> | field:<id>:<column>
        if len(parts) < 2 or score < _SEARCH_MIN_SCORE or score < top - _SEARCH_MAX_GAP:
            continue
        layer_id = parts[1]
        field = parts[2] if parts[0] == "field" and len(parts) == 3 else None
        if layer_id not in best or score > best[layer_id].score:
            best[layer_id] = SearchHit(layer_id=layer_id, field=field, title=title, score=round(score, 4))
    return sorted(best.values(), key=lambda h: h.score, reverse=True)
