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

import threading

from fastapi import FastAPI, HTTPException, Request

from . import config, db, embeddings, llm, rag
from .metadata import use_layers
from .indexer import reindex_municipality
from .fastpath import fast_plan
from .guide import annotate, apply_instructions, converse, field_confidence, parse_instruction, is_small_talk, preflight, remember_near, suggestions
from .repair import carry_over, is_follow_up, repair_plan
from .schema import (
    IconTermsRequest,
    IconTermsResult,
    NarrateRequest,
    NarrateResult,
    PlanRequest,
    PlanResult,
    ReindexRequest,
    SearchHit,
    SearchRequest,
    SuggestRequest,
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


async def _watch_disconnect(request: Request, cancel: threading.Event) -> None:
    """Sets `cancel` when the backend closes this request (the user
    pressed Stop or left), so the model call stops streaming."""
    while not cancel.is_set():
        if await request.is_disconnected():
            cancel.set()
            return
        await asyncio.sleep(0.5)


@app.post("/plan", response_model=PlanResult)
async def plan(body: PlanRequest, request: Request) -> PlanResult:
    cancel = threading.Event()
    watcher = asyncio.create_task(_watch_disconnect(request, cancel))
    try:
        return await _plan(body, cancel)
    except llm.Cancelled:
        log.info("plan cancelled by the user: %s", body.message[:80])
        raise HTTPException(status_code=499, detail="Cancelled.")
    finally:
        cancel.set()
        watcher.cancel()


async def _plan(body: PlanRequest, cancel: threading.Event) -> PlanResult:
    # Field roles / aliases learned at upload (metadata.py) for this request.
    use_layers(body.layers)
    # Simple requests whose every word maps onto a plan piece need no model
    # call at all (~1 s instead of ~7-40 s on CPU). See fastpath.py.
    # Follow the conversation: a refinement ("which are in prabhag no C")
    # builds on the previous answer; a remembered "near" distance is reused.
    follow = is_follow_up(body.message, body.layers, body.previous_operation)
    previous = body.previous_operation if follow else None
    near_rule = next((r.near_m for r in reversed(body.instructions) if r.near_m), None)
    message, remembered_note, remembered_options = remember_near(body.message, body.history, near_rule)

    # "From now on only show working signals" / "forget my instructions".
    ruled = parse_instruction(body.message, body.layers)
    if ruled is not None:
        return ruled

    def finish(result: PlanResult) -> PlanResult:
        # Is each value really in the column the plan uses? Switch or ask.
        result = field_confidence(message, result, body.layers, previous)
        if result.answer_kind == "clarification":
            return result
        result = annotate(message, result, body.layers, previous)
        result = apply_instructions(result, body.instructions)
        if remembered_note:
            result = result.model_copy(update={
                "notes": [remembered_note, *result.notes],
                "options": [*result.options, *remembered_options],
            })
        return result

    # Conversation that is not a map query: greetings, help, questions about
    # the layers / fields / values, GIS terms — answered from the catalog.
    # Checked even right after an answer: "what can you do?" never refines it.
    talked = converse(message, body.layers)
    if talked is not None:
        return talked

    # Ask instead of guessing; refuse what would silently drop a condition.
    asked = preflight(message)
    if asked is not None:
        return asked
    quick = fast_plan(message, body.layers, previous)
    if quick is not None:
        log.info("fast path (%s): %s", message[:80], quick.explanation)
        return finish(quick)

    if body.instant_only:
        return PlanResult(
            answer_kind="unsupported",
            explanation=(
                "I couldn't answer that instantly. Rephrase it more simply, or turn off "
                "“Instant answers only” in the assistant settings to let the AI model read it."
            ),
            planner="fast",
        )

    if not llm.available():
        raise HTTPException(
            status_code=503,
            detail=(
                f"The local AI model '{config.LLM_MODEL}' is not ready yet "
                "(Ollama still starting or downloading the model). Try again shortly."
            ),
        )

    if not follow and is_small_talk(message, body.layers):
        try:
            reply = await asyncio.to_thread(llm.chat_reply, message, body.history, body.layers, body.municipality_name, cancel)
        except llm.LLMUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        return PlanResult(answer_kind="answer", explanation=reply or "I can help with questions about your GIS layers.", planner="model")

    try:
        if await rag_count(body.municipality_id) == 0:
            await reindex_municipality(body.municipality_id)
    except Exception:
        log.exception("lazy reindex failed; continuing without retrieval")

    try:
        snippets = await rag.retrieve(message, body.municipality_id)
    except Exception:
        log.exception("retrieval failed; continuing with empty context")
        snippets = []

    try:
        result = await asyncio.to_thread(
            llm.generate_plan,
            message,
            body.layers,
            snippets,
            body.history,
            body.municipality_name,
            previous,
            cancel,
        )
        # The small model often drops the newer operation fields; the
        # question's own words fill them (see repair.py).
        repaired = repair_plan(message, result, body.layers, follow_up=follow)
        if previous is not None:
            repaired = carry_over(previous, repaired, body.layers)
        return finish(repaired.model_copy(update={"planner": "model"}))
    except llm.LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except llm.Cancelled:
        raise
    except Exception as exc:
        log.exception("plan generation failed")
        raise HTTPException(status_code=502, detail=f"Local LLM error: {exc}")


@app.post("/suggest", response_model=list[str])
async def suggest(body: SuggestRequest) -> list[str]:
    """Example questions from the real layers, each one plannable."""
    use_layers(body.layers)
    return suggestions(body.layers)


@app.post("/warm")
async def warm(body: PlanRequest) -> dict:
    """Pre-loads this municipality's plan prompt into the model cache."""
    await asyncio.to_thread(llm.prime_plan_cache, body.layers, body.municipality_name)
    return {"ok": True}


@app.post("/icon-terms", response_model=IconTermsResult)
async def icon_terms(body: IconTermsRequest) -> IconTermsResult:
    """Icon search words for a layer (Layer Style → Point → Icon → AI)."""
    try:
        terms = await asyncio.to_thread(llm.icon_terms, body)
    except llm.LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        log.exception("icon terms failed")
        raise HTTPException(status_code=502, detail=f"Local LLM error: {exc}")
    return IconTermsResult(terms=terms)


@app.post("/narrate", response_model=NarrateResult)
async def narrate(body: NarrateRequest) -> NarrateResult:
    try:
        text, grounded = await asyncio.to_thread(
            llm.narrate, body.kind, body.question, body.facts, body.language
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
