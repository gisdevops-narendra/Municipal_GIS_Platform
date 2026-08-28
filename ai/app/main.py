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
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from . import config, db, embeddings, llm, rag
from .indexer import reindex_municipality
from .schema import PlanRequest, PlanResult, ReindexRequest
from .vectorstore import count as rag_count

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
