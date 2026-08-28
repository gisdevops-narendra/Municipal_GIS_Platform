"""Local open-source LLM integration (Ollama).

Natural language -> structured GIS operation. The model runs entirely
self-hosted (Ollama serving an Apache-2.0 Qwen2.5 instruct model); there is
no API key and no external service. Ollama's structured-output `format`
(JSON schema) plus a strict prompt keep the response a single JSON object
matching `PlanResult`. The model has no tools and cannot execute anything.
"""
from __future__ import annotations

import json
import logging
from typing import List, Optional

import httpx

from . import config, prompts
from .schema import ChatTurn, LayerInfo, PLAN_JSON_SCHEMA, PlanResult
from .vectorstore import Retrieved

log = logging.getLogger("gis-ai.llm")

_client: Optional[httpx.Client] = None


class LLMUnavailable(RuntimeError):
    pass


def _http() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(
            base_url=config.OLLAMA_URL, timeout=config.LLM_TIMEOUT_S
        )
    return _client


def reachable() -> bool:
    try:
        r = _http().get("/api/tags", timeout=5)
        return r.status_code == 200
    except Exception:
        return False


def model_present() -> bool:
    try:
        r = _http().get("/api/tags", timeout=5)
        r.raise_for_status()
        names = {m.get("name", "") for m in r.json().get("models", [])}
        want = config.LLM_MODEL
        return want in names or f"{want}:latest" in names or any(
            n.split(":")[0] == want.split(":")[0] for n in names
        )
    except Exception:
        return False


def ensure_model() -> None:
    """Pull the configured model if missing, then warm it into memory."""
    if config.LLM_AUTO_PULL and not model_present():
        log.info("pulling local LLM %s (first run — downloads ~1-2 GB)…", config.LLM_MODEL)
        with _http().stream(
            "POST",
            "/api/pull",
            json={"model": config.LLM_MODEL, "stream": True},
            timeout=None,
        ) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                try:
                    status = json.loads(line).get("status", "")
                except json.JSONDecodeError:
                    continue
                if status == "success" or status.startswith("verifying"):
                    log.info("pull: %s", status)
        log.info("local LLM %s downloaded", config.LLM_MODEL)

    # Warm: a 1-token generate loads the weights into RAM so the first real
    # request isn't paying the cold-start cost.
    try:
        _http().post(
            "/api/generate",
            json={
                "model": config.LLM_MODEL,
                "prompt": "ok",
                "stream": False,
                "keep_alive": -1,
                "options": {"num_predict": 1, "num_ctx": config.LLM_NUM_CTX},
            },
            timeout=180,
        )
        log.info("local LLM %s warmed and ready", config.LLM_MODEL)
    except Exception as exc:  # pragma: no cover
        log.warning("LLM warm-up failed: %s", exc)


def available() -> bool:
    return reachable() and model_present()


def generate_plan(
    message: str,
    layers: List[LayerInfo],
    snippets: List[Retrieved],
    history: List[ChatTurn],
    municipality_name: Optional[str],
) -> PlanResult:
    if not reachable():
        raise LLMUnavailable(
            f"The local LLM service (Ollama at {config.OLLAMA_URL}) is not reachable."
        )
    if not model_present():
        raise LLMUnavailable(
            f"The local model '{config.LLM_MODEL}' is still downloading. Try again shortly."
        )

    messages: list[dict] = [{"role": "system", "content": prompts.SYSTEM_PROMPT}]
    messages.extend(prompts.FEWSHOT)
    for turn in history[-6:]:
        messages.append({"role": turn.role, "content": turn.content})
    messages.append(
        {
            "role": "user",
            "content": prompts.build_user_message(
                message, layers, snippets, municipality_name
            ),
        }
    )

    def _chat(fmt) -> str:
        payload = {
            "model": config.LLM_MODEL,
            "messages": messages,
            "stream": False,
            "keep_alive": -1,  # keep the model resident between requests
            "options": {"temperature": config.LLM_TEMPERATURE, "num_ctx": config.LLM_NUM_CTX},
        }
        if fmt is not None:
            payload["format"] = fmt
        try:
            resp = _http().post("/api/chat", json=payload)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise LLMUnavailable(f"Local LLM request failed: {exc}") from exc
        return (resp.json().get("message", {}) or {}).get("content", "").strip()

    mode = config.LLM_FORMAT_MODE
    primary = (
        PLAN_JSON_SCHEMA if mode == "schema" else ("json" if mode == "json" else None)
    )
    content = _chat(primary)
    data = _parse_json(content)
    if data is None and primary is not None:
        log.warning("constrained decode unparseable, retrying prompt-only")
        data = _parse_json(_chat(None))
    if data is None:
        return PlanResult(
            answer_kind="unsupported",
            explanation="I couldn't turn that into a GIS operation. Try rephrasing "
            "with the layer names and a distance.",
        )
    try:
        return PlanResult.model_validate(data)
    except Exception:
        return PlanResult(
            answer_kind="unsupported",
            explanation=str(data.get("explanation") or "")
            or "I couldn't produce a valid GIS operation for that request.",
        )


def _parse_json(text: str) -> Optional[dict]:
    if text.startswith("```"):
        text = text.strip("`")
        text = text[4:] if text.lower().startswith("json") else text
        text = text.strip("`").strip()
    for candidate in (text, _slice_braces(text)):
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return None


def _slice_braces(text: str) -> str:
    start, end = text.find("{"), text.rfind("}")
    return text[start : end + 1] if 0 <= start < end else ""
